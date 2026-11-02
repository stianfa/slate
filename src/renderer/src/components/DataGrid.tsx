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
import type { Draft } from '@shared/insert'
import type { Cell, ColumnInfo, ResultField, StatementResult } from '@shared/types'
import { api } from '../api'
import { displayValue, parseTsv, toTsvRow } from '../lib/format'

const ROW_HEIGHT = 26
const HEADER_HEIGHT = 44
const OVERSCAN = 12
const MAX_CELL_CHARS = 400
// Wider grids (a transposed result has a column per row) only render the columns in view.
const MAX_FULL_COLUMNS = 60
const COL_OVERSCAN = 4

/** The focused cell and the corner the selection started from. A null column selects whole rows. */
type Selection = { row: number; col: number | null; anchorRow: number; anchorCol: number | null } | null

/** Rows added under a result whose columns come from one table, waiting to be inserted. */
export interface NewRowsEditor {
  /** The table column behind each field; null for computed fields, which new rows leave empty. */
  columns: (ColumnInfo | null)[]
  rows: Draft[][]
  change(rows: Draft[][]): void
  submit(): void
  /** An insert is running. */
  busy: boolean
}

export interface DataGridHandle {
  /** Adds an empty row at the bottom and selects its first cell. */
  addRow(): void
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

function cellText(value: string): string {
  const flat = value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) + '…' : value
  return flat.replace(/\s*\r?\n\s*/g, ' ↵ ')
}

/**
 * Shows a result's rows, or with `transposed` its columns as rows and each row as a column. With
 * `newRows`, rows typed or pasted under the result are shown and edited below it.
 */
export function DataGrid({
  result,
  transposed = false,
  onOpenValue,
  newRows,
  ref
}: {
  result: StatementResult
  transposed?: boolean
  onOpenValue(value: string, field: ResultField): void
  newRows?: NewRowsEditor
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
  // A row to scroll to once it has been drawn, e.g. one just added.
  const reveal = useRef<number | null>(null)

  // Keyed on the fields: rows added to the result by an insert keep widths, selection and scroll.
  useEffect(() => {
    setWidths(initialWidths(result, transposed))
    setSelection(null)
    editingRef.current = null
    setEditing(null)
    scroller.current?.scrollTo({ top: 0, left: 0 })
  }, [result.fields, transposed])

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

  // In grid terms: rows and columns as shown, which are swapped when transposed.
  // New rows come after the result's own rows.
  const drafts = !transposed && newRows ? newRows.rows : []
  const base = result.rows.length
  const rowCount = transposed ? result.fields.length : base + drafts.length
  const colCount = transposed ? result.rows.length : result.fields.length
  const valueAt = (r: number, c: number): Draft =>
    transposed ? result.rows[c][r] : r < base ? result.rows[r][c] : drafts[r - base][c]
  const fieldAt = (r: number, c: number) => result.fields[transposed ? r : c]
  const isNew = (r: number) => !transposed && r >= base
  const editable = (r: number, c: number) => isNew(r) && Boolean(newRows && !newRows.busy && newRows.columns[c])

  // New rows can go away under the selection, when they are discarded.
  useEffect(() => {
    if (selection && Math.max(selection.row, selection.anchorRow) >= rowCount) setSelection(null)
    if (editingRef.current && editingRef.current.row >= rowCount) {
      editingRef.current = null
      setEditing(null)
    }
  }, [rowCount])

  const headWidth = useMemo(() => rowHeadWidth(result, transposed, rowCount), [result, transposed, rowCount])
  const offsets = useMemo(() => widths.reduce((out, w) => (out.push(out[out.length - 1] + w), out), [0]), [widths])
  const totalWidth = headWidth + offsets[offsets.length - 1]
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  const template = useMemo(() => `${headWidth}px ${widths.map((w) => `${w}px`).join(' ')}`, [widths, headWidth])

  // The column under horizontal position x, measured from the first data column.
  const columnAt = (x: number) => {
    let lo = 0
    let hi = widths.length - 1
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
    const startX = e.clientX
    const start = widths[col]
    const move = (ev: globalThis.PointerEvent) => {
      const next = Math.max(48, start + ev.clientX - startX)
      setWidths((w) => w.map((v, i) => (i === col ? next : v)))
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

  const select = (row: number, col: number | null, e: MouseEvent) => {
    if (editingRef.current?.row === row && editingRef.current.col === col) return
    if (e.shiftKey && selection) {
      const wholeRows = col === null || selection.anchorCol === null
      setSelection({ ...selection, row, col: wholeRows ? null : col, anchorCol: wholeRows ? null : selection.anchorCol })
    } else setSelection({ row, col, anchorRow: row, anchorCol: col })
  }

  const copy = () => {
    if (!bounds) return
    const cols = Array.from({ length: bounds.right - bounds.left + 1 }, (_, i) => bounds.left + i)
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

  const changeDrafts = (edit: (rows: Draft[][]) => void) => {
    if (!newRows) return
    const next = drafts.map((row) => [...row])
    edit(next)
    newRows.change(next)
  }

  /** Fills new rows from `start` (an index into the new rows) and column `col`, adding rows as needed. */
  const pasteCells = (cells: Cell[][], start: number, col: number) => {
    if (!newRows || !cells.length) return
    changeDrafts((rows) =>
      cells.forEach((values, i) => {
        const row = (rows[start + i] ??= result.fields.map(() => undefined))
        // Computed fields keep their place, so copied rows line up with the result's columns.
        values.forEach((v, j) => {
          if (newRows.columns[col + j]) row[col + j] = v
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

  /** Pastes into the selected new rows, or as new rows at the bottom when the selection is elsewhere. */
  const paste = async () => {
    const text = await api.readClipboard()
    const cells = lastCopy?.text === text ? lastCopy.cells : parseTsv(text)
    if (bounds && isNew(bounds.top)) pasteCells(cells, bounds.top - base, bounds.wholeRows ? 0 : bounds.left)
    else pasteCells(cells, drafts.length, 0)
  }

  const addRow = () => {
    if (!newRows || transposed || newRows.busy) return
    const row = base + drafts.length
    newRows.change([...drafts, result.fields.map(() => undefined)])
    setSelection({ row, col: 0, anchorRow: row, anchorCol: 0 })
    reveal.current = row
    scroller.current?.focus()
  }

  useImperativeHandle(ref, () => ({ addRow }))

  const startEdit = (row: number, col: number, text: string, dirty: boolean) => {
    editingRef.current = { row, col, text, dirty }
    setEditing(editingRef.current)
    setSelection({ row, col, anchorRow: row, anchorCol: col })
  }

  const finishEdit = (save: boolean, refocus = true) => {
    const current = editingRef.current
    if (!current) return
    editingRef.current = null
    setEditing(null)
    if (save && current.dirty) changeDrafts((rows) => (rows[current.row - base][current.col] = current.text))
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
      newRows?.submit()
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
    if (mod && key === 'enter' && drafts.length && newRows && !newRows.busy) {
      // Insert the new rows rather than run the query, which would drop them.
      e.preventDefault()
      newRows.submit()
      return
    }
    if (mod && key === 'v' && newRows && !transposed) {
      e.preventDefault()
      if (!newRows.busy) void paste()
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
    const onlyNewRows = isNew(bounds.top) && newRows && !newRows.busy
    if (mod && key === 'c') {
      copy()
      e.preventDefault()
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && onlyNewRows) {
      // Cmd+Backspace would otherwise delete the whole query from the history.
      e.preventDefault()
      if (bounds.wholeRows || mod) {
        changeDrafts((rows) => rows.splice(bounds.top - base, bounds.bottom - bounds.top + 1))
        const next = Math.max(0, bounds.top - 1)
        setSelection(rowCount > bounds.bottom - bounds.top + 1 ? { row: next, col, anchorRow: next, anchorCol: col } : null)
      } else {
        // Back to the column's default.
        changeDrafts((rows) => {
          for (let r = bounds.top; r <= bounds.bottom; r++) {
            for (let c = bounds.left; c <= bounds.right; c++) rows[r - base][c] = undefined
          }
        })
      }
    } else if (e.key === 'ArrowDown') move(row + 1, col)
    else if (e.key === 'ArrowUp') move(row - 1, col)
    else if (e.key === 'ArrowRight') move(row, (col ?? -1) + 1)
    else if (e.key === 'ArrowLeft') move(row, col === null ? null : col - 1)
    else if (e.key === 'PageDown') move(row + Math.floor(viewport / ROW_HEIGHT) - 1, col)
    else if (e.key === 'PageUp') move(row - Math.floor(viewport / ROW_HEIGHT) + 1, col)
    else if ((e.key === 'Enter' || e.key === 'F2') && col !== null && editable(row, col)) {
      e.preventDefault()
      startEdit(row, col, valueAt(row, col) ?? '', false)
    } else if (e.key === 'Enter' && col !== null) {
      const v = valueAt(row, col)
      if (v !== null && v !== undefined) onOpenValue(v, fieldAt(row, col))
    } else if (e.key.length === 1 && !mod && col !== null && editable(row, col)) {
      // Typing into a new cell replaces its value, as in a spreadsheet.
      e.preventDefault()
      startEdit(row, col, e.key, true)
    } else if (e.key === 'Escape') setSelection(null)
  }

  const rows = []
  for (let r = first; r < last; r++) {
    const inRows = bounds !== null && r >= bounds.top && r <= bounds.bottom
    const fresh = isNew(r)
    const rowField = result.fields[r]
    rows.push(
      <div
        key={r}
        className={`grid-row${inRows && bounds.wholeRows ? ' row-selected' : ''}${fresh ? ' new' : ''}${r % 2 ? ' odd' : ''}`}
        style={{ top: HEADER_HEIGHT + r * ROW_HEIGHT, gridTemplateColumns: template, width: totalWidth }}
      >
        <div
          className={`grid-rownum${transposed ? ' grid-rowhead' : ''}`}
          style={{ gridColumn: 1 }}
          onMouseDown={(e) => select(r, null, e)}
          title={transposed ? `${rowField.name} · ${rowField.type}` : undefined}
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
          const computed = fresh && !newRows?.columns[c]
          const edited = editing?.row === r && editing.col === c
          return (
            <div
              key={c}
              className={`grid-cell${field.numeric ? ' num' : ''}${focused ? ' selected' : inRange ? ' in-range' : ''}${computed ? ' computed' : ''}${edited ? ' editing' : ''}`}
              style={windowed ? { gridColumn: c + 2 } : undefined}
              onMouseDown={(e) => select(r, c, e)}
              onDoubleClick={() => {
                if (editable(r, c)) startEdit(r, c, value ?? '', false)
                else if (value !== null && value !== undefined) onOpenValue(value, field)
              }}
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
                    pasteCells(lastCopy?.text === text ? lastCopy.cells : parseTsv(text), r - base, c)
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
            return (
              <div
                key={c}
                className={`grid-head${f?.numeric ? ' num' : ''}`}
                style={windowed ? { gridColumn: c + 2 } : undefined}
                title={f ? `${f.name} · ${f.type}` : undefined}
              >
                <span className="grid-head-name">{f ? f.name : `Row ${c + 1}`}</span>
                <span className="grid-head-type">{f?.type}</span>
                <span className="grid-resize" onPointerDown={(e) => startResize(c, e)} />
              </div>
            )
          })}
        </div>
        {rows}
      </div>
      {result.fields.length > 0 && rowCount === 0 && <div className="grid-empty">No rows</div>}
    </div>
  )
}
