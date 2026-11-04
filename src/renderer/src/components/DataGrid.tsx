import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref
} from 'react'
import { ArrowDown, ArrowUp, Filter } from 'lucide-react'
import { NO_CHANGES, editedValue, withEdit, withReverted, type Draft, type GridChanges } from '@shared/changes'
import type { Cell, ColumnInfo, ResultField, StatementResult } from '@shared/types'
import { api } from '../api'
import { displayValue, parseTsv, toTsvRow } from '../lib/format'
import type { RowSort } from '../lib/rows'

const ROW_HEIGHT = 26
const HEADER_HEIGHT = 44
const OVERSCAN = 12
const MAX_CELL_CHARS = 400
// Wider grids (a transposed result has a column per row) only render the columns in view.
const MAX_FULL_COLUMNS = 60
const COL_OVERSCAN = 4
// Cell text is cut to one line; a double-click shows the whole value in a field you can select from.
const MAX_OPEN_WIDTH = 560
const MAX_OPEN_HEIGHT = 260

/** The focused cell and the corner the selection started from. A null column selects whole rows. */
type Selection = { row: number; col: number | null; anchorRow: number; anchorCol: number | null } | null

/** Changes to the table a result's columns come from: added rows, edited cells and deleted rows. */
export interface GridEditor {
  /** The table column behind each field; null for computed fields, which can't be edited. */
  columns: (ColumnInfo | null)[]
  /** Why the result's own rows can't be edited or deleted (new rows still can be); null when they can. */
  readOnly: string | null
  changes: GridChanges
  change(changes: GridChanges): void
  submit(): void
  /** A save or a query is running. */
  busy: boolean
}

export interface DataGridHandle {
  /** Adds an empty row at the bottom and selects its first cell. */
  addRow(): void
  focus(): void
}

/** A value to show in full; `set` is there when the cell can be edited. */
export interface OpenValue {
  value: Draft
  field: ResultField
  set?(value: Cell): void
}

// What the grid last put on the clipboard, with NULLs, tabs and line breaks intact. Pasting that
// same text uses these cells instead of the flattened text.
let lastCopy: { text: string; cells: Cell[][] } | null = null

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

let measureContext: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string): number {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return text.length * 7.5
  measureContext.font = font
  return measureContext.measureText(text).width
}

function fonts() {
  const style = getComputedStyle(document.documentElement)
  const mono = style.getPropertyValue('--font-mono') || 'monospace'
  return { cell: `12.5px ${mono}`, type: `10.5px ${mono}`, header: `600 12px ${style.getPropertyValue('--font-ui')}` }
}

const sampleText = (v: Cell, f: ResultField) => (v === null ? 'NULL' : displayValue(v.slice(0, 80), f))
const clampWidth = (widest: number) => Math.round(Math.min(Math.max(widest + 24, 72), 420))

function initialWidths(result: StatementResult, transposed: boolean): number[] {
  const font = fonts()
  if (transposed) {
    // A column per row of the result, as wide as its widest value.
    return result.rows.map((row, r) =>
      clampWidth(row.reduce((widest, v, i) => Math.max(widest, textWidth(sampleText(v, result.fields[i]), font.cell)), textWidth(`Row ${r + 1}`, font.header) + 18))
    )
  }
  const sample = result.rows.slice(0, 200)
  return result.fields.map((f, i) => {
    let widest = Math.max(textWidth(f.name, font.header) + 18, textWidth(f.type, font.cell) * 0.9)
    for (const row of sample) widest = Math.max(widest, textWidth(sampleText(row[i], f), font.cell))
    return clampWidth(widest)
  })
}

/** Width of the sticky left column: row numbers, or field names when transposed. */
function rowHeadWidth(result: StatementResult, transposed: boolean, rowCount: number): number {
  if (!transposed) return Math.max(44, String(rowCount).length * 8 + 24)
  const font = fonts()
  const widest = Math.max(...result.fields.map((f) => textWidth(f.name, font.header) + textWidth(f.type, font.type)))
  return Math.round(Math.min(280, Math.max(96, widest + 34)))
}

const isMultiline = (v: Draft) => typeof v === 'string' && /[\r\n]/.test(v)

function cellText(value: string): string {
  const flat = value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) + '…' : value
  return flat.replace(/\s*\r?\n\s*/g, ' ↵ ')
}

/**
 * Shows a result's rows, or with `transposed` its columns as rows and each row as a column. `order`
 * picks and orders the result's rows to show (sorted or filtered). With `editor`, cells of a table's
 * rows can be edited, rows deleted, and new rows typed or pasted under the result.
 */
export function DataGrid({
  result,
  transposed = false,
  order = null,
  sort = null,
  onSort,
  onColumnMenu,
  filtered,
  onFind,
  onOpenValue,
  onReadOnly,
  editor,
  ref
}: {
  result: StatementResult
  transposed?: boolean
  /** Indexes of the result's rows to show, in order; null shows them all as returned. */
  order?: number[] | null
  sort?: RowSort | null
  onSort?(column: number): void
  /** Right-click on a column header (or a click on its filter mark), at a point in the window. */
  onColumnMenu?(column: number, x: number, y: number): void
  /** Columns with a value filter, marked in their header. */
  filtered?: number[]
  /** Cmd+F in the grid, to filter its rows. */
  onFind?(): void
  onOpenValue(value: OpenValue): void
  /** Someone tried to change a row that can't be changed; the message says why. */
  onReadOnly?(message: string): void
  editor?: GridEditor
  ref?: Ref<DataGridHandle>
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<number[]>(() => initialWidths(result, transposed))
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewport, setViewport] = useState(600)
  const [viewportWidth, setViewportWidth] = useState(1200)
  const [selection, setSelection] = useState<Selection>(null)
  const [editing, setEditing] = useState<{ row: number; col: number; text: string; dirty: boolean } | null>(null)
  // Mirrors `editing`, so the blur that follows Enter or Escape doesn't finish the edit a second time.
  const editingRef = useRef(editing)
  // A cell that can't be edited, showing its whole value over the grid.
  const [opened, setOpened] = useState<{ row: number; col: number } | null>(null)
  // A row to scroll to once it has been drawn, e.g. one just added.
  const reveal = useRef<number | null>(null)

  // Keyed on the fields: rows added to the result by a save keep widths, selection and scroll.
  useEffect(() => {
    setWidths(initialWidths(result, transposed))
    setSelection(null)
    editingRef.current = null
    setEditing(null)
    setOpened(null)
    scroller.current?.scrollTo({ top: 0, left: 0 })
  }, [result.fields, transposed])

  // Sorting or filtering moves rows out from under the selection.
  useEffect(() => {
    setSelection(null)
    setOpened(null)
  }, [order])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setViewport(el.clientHeight)
      setViewportWidth(el.clientWidth)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // In grid terms: rows and columns as shown, which are swapped when transposed. `shown` maps the
  // result's rows on screen to their index in the result; new rows come after them.
  const shown = useMemo(() => order ?? result.rows.map((_, i) => i), [order, result.rows])
  const changes = editor?.changes ?? NO_CHANGES
  const added = !transposed && editor ? changes.added : []
  const deleted = useMemo(() => new Set(changes.deleted), [changes.deleted])
  const base = shown.length
  const rowCount = transposed ? result.fields.length : base + added.length
  const colCount = transposed ? base : result.fields.length
  const valueAt = (r: number, c: number): Draft =>
    transposed
      ? editedValue(changes, result.rows, shown[c], r)
      : r < base
        ? editedValue(changes, result.rows, shown[r], c)
        : added[r - base][c]
  const fieldAt = (r: number, c: number) => result.fields[transposed ? r : c]
  const isNew = (r: number) => !transposed && r >= base
  const canEdit = (r: number, c: number) => {
    if (!editor || editor.busy || transposed || !editor.columns[c]) return false
    return isNew(r) || (!editor.readOnly && !deleted.has(shown[r]))
  }

  // New rows can go away under the selection, when they are discarded.
  useEffect(() => {
    if (selection && Math.max(selection.row, selection.anchorRow) >= rowCount) setSelection(null)
    if (editingRef.current && editingRef.current.row >= rowCount) {
      editingRef.current = null
      setEditing(null)
    }
  }, [rowCount])

  // Transposed, a column is a row of the result, and keeps that row's width when rows are filtered.
  const colWidths = useMemo(() => (transposed ? shown.map((i) => widths[i] ?? 72) : widths), [transposed, shown, widths])
  const headWidth = useMemo(() => rowHeadWidth(result, transposed, rowCount), [result, transposed, rowCount])
  const offsets = useMemo(() => colWidths.reduce((out, w) => (out.push(out[out.length - 1] + w), out), [0]), [colWidths])
  const totalWidth = headWidth + offsets[offsets.length - 1]
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  const template = useMemo(() => `${headWidth}px ${colWidths.map((w) => `${w}px`).join(' ')}`, [colWidths, headWidth])

  // The column under horizontal position x, measured from the first data column.
  const columnAt = (x: number) => {
    let lo = 0
    let hi = colWidths.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= x) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const windowed = colCount > MAX_FULL_COLUMNS
  const firstCol = windowed ? Math.max(0, columnAt(scrollLeft) - COL_OVERSCAN) : 0
  const lastCol = windowed ? Math.min(colCount, columnAt(scrollLeft + viewportWidth - headWidth) + 1 + COL_OVERSCAN) : colCount
  const columns: number[] = []
  for (let c = firstCol; c < lastCol; c++) columns.push(c)

  const startResize = (col: number, e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const key = transposed ? shown[col] : col
    const startX = e.clientX
    const start = colWidths[col]
    const move = (ev: globalThis.PointerEvent) => {
      const next = Math.max(48, start + ev.clientX - startX)
      setWidths((w) => w.map((v, i) => (i === key ? next : v)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useLayoutEffect(() => {
    if (reveal.current === null) return
    scrollIntoView(reveal.current)
    reveal.current = null
  })

  const scrollIntoView = (row: number) => {
    const el = scroller.current
    if (!el) return
    const top = row * ROW_HEIGHT
    const visibleTop = el.scrollTop
    const visibleBottom = el.scrollTop + el.clientHeight - HEADER_HEIGHT
    if (top < visibleTop) el.scrollTop = top
    else if (top + ROW_HEIGHT > visibleBottom) el.scrollTop = top + ROW_HEIGHT - (el.clientHeight - HEADER_HEIGHT)
  }

  // Rows top..bottom; columns left..right, or every column when whole rows are selected.
  const bounds = selection && {
    top: Math.min(selection.row, selection.anchorRow),
    bottom: Math.max(selection.row, selection.anchorRow),
    wholeRows: selection.col === null || selection.anchorCol === null,
    left: selection.col === null || selection.anchorCol === null ? 0 : Math.min(selection.col, selection.anchorCol),
    right: selection.col === null || selection.anchorCol === null ? colCount - 1 : Math.max(selection.col, selection.anchorCol)
  }
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

  const select = (row: number, col: number | null, e: MouseEvent) => {
    if (editingRef.current?.row === row && editingRef.current.col === col) return
    if (e.shiftKey && selection) {
      const wholeRows = col === null || selection.anchorCol === null
      setSelection({ ...selection, row, col: wholeRows ? null : col, anchorCol: wholeRows ? null : selection.anchorCol })
    } else setSelection({ row, col, anchorRow: row, anchorCol: col })
  }

  const copy = () => {
    if (!bounds) return
    const cols = range(bounds.left, bounds.right)
    const cells: Cell[][] = []
    const lines: string[] = []
    for (let r = bounds.top; r <= bounds.bottom; r++) {
      const row = cols.map((c) => valueAt(r, c) ?? null)
      cells.push(row)
      lines.push(toTsvRow(row, cols.map((c) => fieldAt(r, c))))
    }
    // A single cell copies its value as it is; anything more copies tab-separated rows.
    const single = !bounds.wholeRows && cells.length === 1 && cols.length === 1
    const text = single ? displayValue(cells[0][0] ?? '', fieldAt(bounds.top, bounds.left)) : lines.join('\n')
    lastCopy = { text, cells }
    void api.copyText(text)
  }

  /**
   * Sets cells that can be edited: a new row's value (undefined is DEFAULT), or an edit of one of the
   * result's rows. Returns whether a cell was left alone because the result's rows are read-only.
   */
  const setCells = (cells: { r: number; c: number; value: Draft }[]) => {
    if (!editor) return false
    let next = changes
    let rows: Draft[][] | null = null
    let refused = false
    for (const { r, c, value } of cells) {
      if (!canEdit(r, c)) {
        refused ||= !isNew(r) && Boolean(editor.readOnly && editor.columns[c])
        continue
      }
      if (isNew(r)) (rows ??= added.map((row) => [...row]))[r - base][c] = value
      else if (value !== undefined) next = withEdit(next, result.rows, shown[r], c, value)
    }
    if (rows || next !== changes) editor.change(rows ? { ...next, added: rows } : next)
    return refused
  }

  const changeAdded = (edit: (rows: Draft[][]) => void) => {
    if (!editor) return
    const rows = added.map((row) => [...row])
    edit(rows)
    editor.change({ ...changes, added: rows })
  }

  /** Fills new rows from `start` (an index into the new rows) and column `col`, adding rows as needed. */
  const pasteCells = (cells: Cell[][], start: number, col: number) => {
    if (!editor || !cells.length) return
    changeAdded((rows) =>
      cells.forEach((values, i) => {
        const row = (rows[start + i] ??= result.fields.map(() => undefined))
        // Computed fields keep their place, so copied rows line up with the result's columns.
        values.forEach((v, j) => {
          if (editor.columns[col + j]) row[col + j] = v
        })
      })
    )
    const width = Math.max(...cells.map((r) => r.length))
    setSelection({
      anchorRow: base + start,
      anchorCol: col,
      row: base + start + cells.length - 1,
      col: clamp(col + width - 1, col, colCount - 1)
    })
    reveal.current = base + start
  }

  /** Overwrites cells of the result's rows: one copied value fills the selection, more fill from its corner. */
  const pasteOver = (cells: Cell[][], b: NonNullable<typeof bounds>) => {
    const fill = cells.length === 1 && cells[0].length === 1
    const targets: { r: number; c: number; value: Draft }[] = []
    if (fill) {
      for (const r of range(b.top, b.bottom)) for (const c of range(b.left, b.right)) targets.push({ r, c, value: cells[0][0] })
    } else {
      cells.forEach((values, i) =>
        values.forEach((value, j) => {
          const r = b.top + i
          const c = b.left + j
          if (r < rowCount && c < colCount) targets.push({ r, c, value })
        })
      )
    }
    if (setCells(targets) && editor?.readOnly) onReadOnly?.(editor.readOnly)
    if (!fill && cells.length) {
      const bottom = Math.min(rowCount - 1, b.top + cells.length - 1)
      const right = Math.min(colCount - 1, b.left + Math.max(...cells.map((r) => r.length)) - 1)
      setSelection({ anchorRow: b.top, anchorCol: b.left, row: bottom, col: right })
    }
  }

  /**
   * Pastes into the selected new rows, over the selected cells of the result's rows, or as new rows at
   * the bottom when whole rows of the result (or nothing) are selected.
   */
  const paste = async () => {
    const text = await api.readClipboard()
    const cells = lastCopy?.text === text ? lastCopy.cells : parseTsv(text)
    if (bounds && isNew(bounds.top)) pasteCells(cells, bounds.top - base, bounds.wholeRows ? 0 : bounds.left)
    else if (bounds && !bounds.wholeRows) pasteOver(cells, bounds)
    else pasteCells(cells, added.length, 0)
  }

  const addRow = () => {
    if (!editor || transposed || editor.busy) return
    const row = base + added.length
    editor.change({ ...changes, added: [...added, result.fields.map(() => undefined)] })
    setSelection({ row, col: 0, anchorRow: row, anchorCol: 0 })
    reveal.current = row
    scroller.current?.focus()
  }

  useImperativeHandle(ref, () => ({ addRow, focus: () => scroller.current?.focus() }))

  /** Shows a value in full, in an editor when the cell can be edited. */
  const openValue = (r: number, c: number) => {
    const value = valueAt(r, c)
    const field = fieldAt(r, c)
    if (canEdit(r, c)) onOpenValue({ value, field, set: (v) => void setCells([{ r, c, value: v }]) })
    else if (value !== null && value !== undefined) onOpenValue({ value, field })
  }

  /** Shows a value that can't be edited in full over its cell, where part of it can be selected and copied. */
  const showValue = (r: number, c: number) => {
    const value = valueAt(r, c)
    if (value !== null && value !== undefined) setOpened({ row: r, col: c })
  }

  /**
   * Edits a cell in place. JSON and values with line breaks open in the value editor instead, which
   * shows JSON laid out and keeps line breaks.
   */
  const startEdit = (row: number, col: number, typed?: string) => {
    const value = valueAt(row, col)
    const type = fieldAt(row, col).type
    if (typed === undefined && (isMultiline(value) || type === 'json' || type === 'jsonb')) return openValue(row, col)
    const text = typed ?? (value === null || value === undefined ? '' : displayValue(value, fieldAt(row, col)))
    editingRef.current = { row, col, text, dirty: typed !== undefined }
    setEditing(editingRef.current)
    setSelection({ row, col, anchorRow: row, anchorCol: col })
  }

  const finishEdit = (save: boolean, refocus = true) => {
    const current = editingRef.current
    if (!current) return
    editingRef.current = null
    setEditing(null)
    if (save && current.dirty) {
      const { row, col, text } = current
      if (isNew(row)) changeAdded((rows) => (rows[row - base][col] = text))
      else if (editor) {
        // Text that reads as the loaded value (true for t) leaves it as it was.
        const original = result.rows[shown[row]][col]
        const value = original !== null && text === displayValue(original, fieldAt(row, col)) ? original : text
        editor.change(withEdit(changes, result.rows, shown[row], col, value))
      }
    }
    if (refocus) scroller.current?.focus()
  }

  const onEditorKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const current = editingRef.current
    if (!current) return
    const mod = e.ctrlKey || e.metaKey
    const moveTo = (row: number, col: number) => {
      e.preventDefault()
      finishEdit(true)
      const next = { row: clamp(row, 0, rowCount - 1), col: clamp(col, 0, colCount - 1) }
      setSelection({ ...next, anchorRow: next.row, anchorCol: next.col })
      reveal.current = next.row
    }
    if (e.key === 'Enter' && mod) {
      // Before the app-wide Cmd+Enter, which would run the query instead.
      e.preventDefault()
      finishEdit(true)
      editor?.submit()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      finishEdit(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finishEdit(false)
    } else if (e.key === 'Tab') moveTo(current.row, current.col + (e.shiftKey ? -1 : 1))
    else if (e.key === 'ArrowDown') moveTo(current.row + 1, current.col)
    else if (e.key === 'ArrowUp') moveTo(current.row - 1, current.col)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Keys typed into the cell editor bubble up here; it handles them itself.
    if (e.target !== e.currentTarget || editingRef.current) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const pending = changes.added.length + Object.keys(changes.edited).length + changes.deleted.length
    if (mod && key === 'enter' && pending && editor && !editor.busy) {
      // Save the changes rather than run the query, which would drop them.
      e.preventDefault()
      editor.submit()
      return
    }
    if (mod && key === 'f' && !e.shiftKey && onFind) {
      e.preventDefault()
      onFind()
      return
    }
    if (mod && key === 'v' && editor && !transposed) {
      e.preventDefault()
      if (!editor.busy) void paste()
      return
    }
    if (mod && key === 'a') {
      e.preventDefault()
      if (rowCount) setSelection({ row: rowCount - 1, col: null, anchorRow: 0, anchorCol: null })
      return
    }
    if (!selection || !bounds) return
    const { row, col } = selection
    const rows = rowCount
    const cols = colCount
    const move = (r: number, c: number | null) => {
      const next = { row: clamp(r, 0, rows - 1), col: c === null ? null : clamp(c, 0, cols - 1) }
      if (e.shiftKey) setSelection({ ...selection, ...next, col: selection.anchorCol === null ? null : next.col })
      else setSelection({ ...next, anchorRow: next.row, anchorCol: next.col })
      scrollIntoView(next.row)
      e.preventDefault()
    }
    const selectedRows = range(bounds.top, bounds.bottom)
    const resultRows = selectedRows.filter((r) => !isNew(r)).map((r) => shown[r])
    if (mod && key === 'c') {
      copy()
      e.preventDefault()
    } else if (mod && key === 'z' && !e.shiftKey && editor && !editor.busy && !transposed) {
      // Undo the edits and deletions of the selected rows, or of the selected cells.
      e.preventDefault()
      editor.change(withReverted(changes, resultRows, bounds.wholeRows ? undefined : range(bounds.left, bounds.right)))
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editor && !editor.busy && !transposed) {
      // Cmd+Backspace would otherwise delete the whole query from the history.
      e.preventDefault()
      if (bounds.wholeRows || mod) {
        // New rows go away; the result's own rows are marked, and deleted when the changes are saved.
        if (resultRows.length && editor.readOnly) onReadOnly?.(editor.readOnly)
        const drop = new Set(selectedRows.filter(isNew).map((r) => r - base))
        editor.change({
          ...changes,
          added: added.filter((_, i) => !drop.has(i)),
          deleted: editor.readOnly ? changes.deleted : [...new Set([...changes.deleted, ...resultRows])]
        })
        if (drop.size) {
          const next = Math.max(0, bounds.top - 1)
          setSelection(rowCount > drop.size ? { row: next, col, anchorRow: next, anchorCol: col } : null)
        }
      } else {
        // A new row's cells go back to their DEFAULT, the result's cells to NULL.
        const cells = selectedRows.flatMap((r) => range(bounds.left, bounds.right).map((c) => ({ r, c, value: isNew(r) ? undefined : null })))
        if (setCells(cells) && editor.readOnly) onReadOnly?.(editor.readOnly)
      }
    } else if (e.key === 'ArrowDown') move(row + 1, col)
    else if (e.key === 'ArrowUp') move(row - 1, col)
    else if (e.key === 'ArrowRight') move(row, (col ?? -1) + 1)
    else if (e.key === 'ArrowLeft') move(row, col === null ? null : col - 1)
    else if (e.key === 'PageDown') move(row + Math.floor(viewport / ROW_HEIGHT) - 1, col)
    else if (e.key === 'PageUp') move(row - Math.floor(viewport / ROW_HEIGHT) + 1, col)
    else if (e.key === 'Enter' && e.shiftKey && col !== null) {
      e.preventDefault()
      openValue(row, col)
    } else if ((e.key === 'Enter' || e.key === 'F2') && col !== null && canEdit(row, col)) {
      e.preventDefault()
      startEdit(row, col)
    } else if (e.key === 'Enter' && col !== null) {
      openValue(row, col)
    } else if (e.key.length === 1 && !mod && col !== null) {
      // Typing into a cell replaces its value, as in a spreadsheet.
      if (canEdit(row, col)) {
        e.preventDefault()
        startEdit(row, col, e.key)
      } else if (editor?.readOnly && !isNew(row) && editor.columns[col]) onReadOnly?.(editor.readOnly)
    } else if (e.key === 'Escape') setSelection(null)
  }

  const rowEls = []
  for (let r = first; r < last; r++) {
    const inRows = bounds !== null && r >= bounds.top && r <= bounds.bottom
    const fresh = isNew(r)
    const gone = !fresh && !transposed && deleted.has(shown[r])
    const edits = !fresh && !transposed ? changes.edited[shown[r]] : undefined
    const rowField = result.fields[r]
    rowEls.push(
      <div
        key={r}
        className={`grid-row${inRows && bounds.wholeRows ? ' row-selected' : ''}${fresh ? ' new' : ''}${gone ? ' deleted' : ''}${r % 2 ? ' odd' : ''}`}
        style={{ top: HEADER_HEIGHT + r * ROW_HEIGHT, gridTemplateColumns: template, width: totalWidth }}
      >
        <div
          className={`grid-rownum${transposed ? ' grid-rowhead' : ''}`}
          style={{ gridColumn: 1 }}
          onMouseDown={(e) => select(r, null, e)}
          title={transposed ? `${rowField.name} · ${rowField.type}` : gone ? 'Deleted when you save the changes' : undefined}
        >
          {transposed ? (
            <>
              <span className="grid-head-name">{rowField.name}</span>
              <span className="grid-head-type">{rowField.type}</span>
            </>
          ) : (
            r + 1
          )}
        </div>
        {columns.map((c) => {
          const value = valueAt(r, c)
          const field = fieldAt(r, c)
          const focused = selection?.row === r && selection.col === c
          const inRange = inRows && !bounds.wholeRows && c >= bounds.left && c <= bounds.right
          const computed = fresh && !editor?.columns[c]
          const changed = Boolean(edits && c in edits)
          const edited = editing?.row === r && editing.col === c
          return (
            <div
              key={c}
              className={`grid-cell${field.numeric ? ' num' : ''}${focused ? ' selected' : inRange ? ' in-range' : ''}${computed ? ' computed' : ''}${changed ? ' changed' : ''}${edited ? ' editing' : ''}`}
              style={windowed ? { gridColumn: c + 2 } : undefined}
              onMouseDown={(e) => select(r, c, e)}
              onDoubleClick={() => (canEdit(r, c) ? startEdit(r, c) : showValue(r, c))}
            >
              {edited ? (
                <input
                  className="grid-input"
                  autoFocus
                  value={editing.text}
                  onChange={(e) => {
                    editingRef.current = { ...editing, text: e.target.value, dirty: true }
                    setEditing(editingRef.current)
                  }}
                  onKeyDown={onEditorKeyDown}
                  onBlur={() => finishEdit(true, false)}
                  onPaste={(e) => {
                    // Rows of values fill the cells from here instead of going into this one.
                    const text = e.clipboardData.getData('text/plain')
                    if (!/[\t\n]/.test(text)) return
                    e.preventDefault()
                    finishEdit(false)
                    const cells = lastCopy?.text === text ? lastCopy.cells : parseTsv(text)
                    if (fresh) pasteCells(cells, r - base, c)
                    else pasteOver(cells, { top: r, bottom: r, left: c, right: c, wholeRows: false })
                  }}
                />
              ) : computed ? null : value === undefined ? (
                <span className="null">DEFAULT</span>
              ) : value === null ? (
                <span className="null">NULL</span>
              ) : field.type === 'bool' ? (
                <span className={value === 't' ? 'bool-true' : 'bool-false'}>{displayValue(value, field)}</span>
              ) : (
                cellText(value)
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const sortTitle = result.truncated ? `Sort the ${result.rows.length.toLocaleString('en-US')} loaded rows` : 'Sort'

  return (
    <div
      className="grid"
      ref={scroller}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop)
        if (windowed) setScrollLeft(e.currentTarget.scrollLeft)
      }}
    >
      <div className="grid-canvas" style={{ height: HEADER_HEIGHT + rowCount * ROW_HEIGHT, width: totalWidth }}>
        <div className="grid-header" style={{ gridTemplateColumns: template, width: totalWidth }}>
          <div className="grid-rownum grid-corner" style={{ gridColumn: 1 }} />
          {columns.map((c) => {
            const f = transposed ? null : result.fields[c]
            const sorted = f && sort?.column === c ? sort : null
            const picked = Boolean(f && filtered?.includes(c))
            return (
              <div
                key={c}
                className={`grid-head${f?.numeric ? ' num' : ''}${f && onSort ? ' sortable' : ''}${sorted ? ' sorted' : ''}${picked ? ' filtered' : ''}`}
                style={windowed ? { gridColumn: c + 2 } : undefined}
                title={f ? `${f.name} · ${f.type}${onSort ? `\n${sortTitle}` : ''}${onColumnMenu ? '\nRight-click to filter' : ''}` : undefined}
                onClick={() => f && onSort?.(c)}
                onContextMenu={(e) => {
                  if (!f || !onColumnMenu) return
                  e.preventDefault()
                  onColumnMenu(c, e.clientX, e.clientY)
                }}
              >
                <span className="grid-head-title">
                  <span className="grid-head-name">{f ? f.name : `Row ${c + 1}`}</span>
                  {sorted && (sorted.desc ? <ArrowDown size={11} aria-label="descending" /> : <ArrowUp size={11} aria-label="ascending" />)}
                  {picked && (
                    <span
                      className="grid-head-filter"
                      aria-label="filtered"
                      onClick={(e) => {
                        e.stopPropagation()
                        const box = e.currentTarget.getBoundingClientRect()
                        onColumnMenu?.(c, box.left, box.bottom + 4)
                      }}
                    >
                      <Filter size={10} />
                    </span>
                  )}
                </span>
                <span className="grid-head-type">{f?.type}</span>
                <span className="grid-resize" onPointerDown={(e) => startResize(c, e)} onClick={(e) => e.stopPropagation()} />
              </div>
            )
          })}
        </div>
        {rowEls}
        {opened && opened.row < rowCount && opened.col < colCount && (
          <OpenCell
            key={`${opened.row}/${opened.col}`}
            text={displayValue(valueAt(opened.row, opened.col) ?? '', fieldAt(opened.row, opened.col))}
            top={HEADER_HEIGHT + opened.row * ROW_HEIGHT}
            left={headWidth + offsets[opened.col]}
            width={colWidths[opened.col]}
            onClose={(refocus) => {
              setOpened(null)
              if (refocus) scroller.current?.focus()
            }}
          />
        )}
      </div>
      {result.fields.length > 0 && rowCount === 0 && (
        <div className="grid-empty">{result.rows.length ? 'No rows match the filter' : 'No rows'}</div>
      )}
    </div>
  )
}

/** A cell's whole value over the cell, read-only, so part of it can be selected and copied. */
function OpenCell({
  text,
  top,
  left,
  width,
  onClose
}: {
  text: string
  top: number
  left: number
  width: number
  onClose(refocus: boolean): void
}) {
  const field = useRef<HTMLTextAreaElement>(null)
  const longest = Math.max(...text.split('\n').map((line) => textWidth(line, fonts().cell)))
  // Padding and border take 23px; a little more keeps a line that just fits from wrapping.
  const fieldWidth = Math.round(Math.max(width, Math.min(MAX_OPEN_WIDTH, longest + 30)))

  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = `${Math.min(MAX_OPEN_HEIGHT, Math.max(ROW_HEIGHT, el.scrollHeight + 3))}px`
    el.focus()
    el.select()
  }, [])

  return (
    <textarea
      ref={field}
      className="grid-open-cell"
      style={{ top, left, width: fieldWidth }}
      value={text}
      rows={1}
      readOnly
      spellCheck={false}
      // The grid's own keys (arrows, Cmd+C for the whole cell) would get in the way here.
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault()
          onClose(true)
        }
      }}
      onBlur={() => onClose(false)}
    />
  )
}
