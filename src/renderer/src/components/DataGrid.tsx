import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Cell, ResultField, StatementResult } from '@shared/types'
import { api } from '../api'
import { displayValue, toTsvRow } from '../lib/format'

const ROW_HEIGHT = 26
const HEADER_HEIGHT = 44
const OVERSCAN = 12
const MAX_CELL_CHARS = 400
// Wider grids (a transposed result has a column per row) only render the columns in view.
const MAX_FULL_COLUMNS = 60
const COL_OVERSCAN = 4

type Selection = { row: number; col: number | null } | null

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
function rowHeadWidth(result: StatementResult, transposed: boolean): number {
  if (!transposed) return Math.max(44, String(result.rows.length).length * 8 + 24)
  const font = fonts()
  const widest = Math.max(...result.fields.map((f) => textWidth(f.name, font.header) + textWidth(f.type, font.type)))
  return Math.round(Math.min(280, Math.max(96, widest + 34)))
}

function cellText(value: string): string {
  const flat = value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) + '…' : value
  return flat.replace(/\s*\r?\n\s*/g, ' ↵ ')
}

/** Shows a result's rows, or with `transposed` its columns as rows and each row as a column. */
export function DataGrid({
  result,
  transposed = false,
  onOpenValue
}: {
  result: StatementResult
  transposed?: boolean
  onOpenValue(value: string, field: ResultField): void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<number[]>(() => initialWidths(result, transposed))
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewport, setViewport] = useState(600)
  const [viewportWidth, setViewportWidth] = useState(1200)
  const [selection, setSelection] = useState<Selection>(null)

  useEffect(() => {
    setWidths(initialWidths(result, transposed))
    setSelection(null)
    scroller.current?.scrollTo({ top: 0, left: 0 })
  }, [result, transposed])

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
  const rowCount = transposed ? result.fields.length : result.rows.length
  const colCount = transposed ? result.rows.length : result.fields.length
  const valueAt = (r: number, c: number) => (transposed ? result.rows[c][r] : result.rows[r][c])
  const fieldAt = (r: number, c: number) => result.fields[transposed ? r : c]

  const headWidth = useMemo(() => rowHeadWidth(result, transposed), [result, transposed])
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

  const scrollIntoView = (row: number) => {
    const el = scroller.current
    if (!el) return
    const top = row * ROW_HEIGHT
    const visibleTop = el.scrollTop
    const visibleBottom = el.scrollTop + el.clientHeight - HEADER_HEIGHT
    if (top < visibleTop) el.scrollTop = top
    else if (top + ROW_HEIGHT > visibleBottom) el.scrollTop = top + ROW_HEIGHT - (el.clientHeight - HEADER_HEIGHT)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!selection) return
    const { row, col } = selection
    const rows = rowCount
    const cols = colCount
    const move = (r: number, c: number | null) => {
      const next = { row: Math.max(0, Math.min(rows - 1, r)), col: c === null ? null : Math.max(0, Math.min(cols - 1, c)) }
      setSelection(next)
      scrollIntoView(next.row)
      e.preventDefault()
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      if (col === null) {
        const all = Array.from({ length: colCount }, (_, c) => c)
        void api.copyText(toTsvRow(all.map((c) => valueAt(row, c)), all.map((c) => fieldAt(row, c))))
      } else void api.copyText(displayValue(valueAt(row, col) ?? '', fieldAt(row, col)))
      e.preventDefault()
    } else if (e.key === 'ArrowDown') move(row + 1, col)
    else if (e.key === 'ArrowUp') move(row - 1, col)
    else if (e.key === 'ArrowRight') move(row, (col ?? -1) + 1)
    else if (e.key === 'ArrowLeft') move(row, col === null ? null : col - 1)
    else if (e.key === 'PageDown') move(row + Math.floor(viewport / ROW_HEIGHT) - 1, col)
    else if (e.key === 'PageUp') move(row - Math.floor(viewport / ROW_HEIGHT) + 1, col)
    else if (e.key === 'Enter' && col !== null) {
      const v = valueAt(row, col)
      if (v !== null) onOpenValue(v, fieldAt(row, col))
    } else if (e.key === 'Escape') setSelection(null)
  }

  const rows = []
  for (let r = first; r < last; r++) {
    const rowSelected = selection?.row === r
    const rowField = result.fields[r]
    rows.push(
      <div
        key={r}
        className={`grid-row${rowSelected && selection?.col === null ? ' row-selected' : ''}${r % 2 ? ' odd' : ''}`}
        style={{ top: HEADER_HEIGHT + r * ROW_HEIGHT, gridTemplateColumns: template, width: totalWidth }}
      >
        <div
          className={`grid-rownum${transposed ? ' grid-rowhead' : ''}`}
          style={{ gridColumn: 1 }}
          onMouseDown={() => setSelection({ row: r, col: null })}
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
          const selected = rowSelected && selection?.col === c
          return (
            <div
              key={c}
              className={`grid-cell${field.numeric ? ' num' : ''}${selected ? ' selected' : ''}`}
              style={windowed ? { gridColumn: c + 2 } : undefined}
              onMouseDown={() => setSelection({ row: r, col: c })}
              onDoubleClick={() => value !== null && onOpenValue(value, field)}
            >
              {value === null ? (
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
      {result.fields.length > 0 && result.rows.length === 0 && <div className="grid-empty">No rows</div>}
    </div>
  )
}
