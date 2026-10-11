import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { ResultField, StatementResult } from '@shared/types'
import { api } from '../api'
import { displayValue, toTsvRow } from '../lib/format'

const ROW_HEIGHT = 26
const HEADER_HEIGHT = 44
const OVERSCAN = 12
const MAX_CELL_CHARS = 400

type Selection = { row: number; col: number | null } | null

let measureContext: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string): number {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return text.length * 7.5
  measureContext.font = font
  return measureContext.measureText(text).width
}

function initialWidths(result: StatementResult): number[] {
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace'
  const cellFont = `12.5px ${mono}`
  const headerFont = `600 12px ${getComputedStyle(document.documentElement).getPropertyValue('--font-ui')}`
  const sample = result.rows.slice(0, 200)
  return result.fields.map((f, i) => {
    let widest = Math.max(textWidth(f.name, headerFont) + 18, textWidth(f.type, cellFont) * 0.9)
    for (const row of sample) {
      const v = row[i]
      const text = v === null ? 'NULL' : displayValue(v.slice(0, 80), f)
      widest = Math.max(widest, textWidth(text, cellFont))
    }
    return Math.round(Math.min(Math.max(widest + 24, 72), 420))
  })
}

function cellText(value: string): string {
  const flat = value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) + '…' : value
  return flat.replace(/\s*\r?\n\s*/g, ' ↵ ')
}

export function DataGrid({
  result,
  onOpenValue
}: {
  result: StatementResult
  onOpenValue(value: string, field: ResultField): void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<number[]>(() => initialWidths(result))
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  const [selection, setSelection] = useState<Selection>(null)

  useEffect(() => {
    setWidths(initialWidths(result))
    setSelection(null)
    scroller.current?.scrollTo({ top: 0, left: 0 })
  }, [result])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const rowNumberWidth = Math.max(44, String(result.rows.length).length * 8 + 24)
  const totalWidth = rowNumberWidth + widths.reduce((a, b) => a + b, 0)
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(result.rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  const template = useMemo(() => `${rowNumberWidth}px ${widths.map((w) => `${w}px`).join(' ')}`, [widths, rowNumberWidth])

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
    const rows = result.rows.length
    const cols = result.fields.length
    const move = (r: number, c: number | null) => {
      const next = { row: Math.max(0, Math.min(rows - 1, r)), col: c === null ? null : Math.max(0, Math.min(cols - 1, c)) }
      setSelection(next)
      scrollIntoView(next.row)
      e.preventDefault()
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      const text = col === null ? toTsvRow(result.rows[row], result.fields) : (result.rows[row][col] ?? '')
      void api.copyText(col === null ? text : displayValue(text, result.fields[col]))
      e.preventDefault()
    } else if (e.key === 'ArrowDown') move(row + 1, col)
    else if (e.key === 'ArrowUp') move(row - 1, col)
    else if (e.key === 'ArrowRight') move(row, (col ?? -1) + 1)
    else if (e.key === 'ArrowLeft') move(row, col === null ? null : col - 1)
    else if (e.key === 'PageDown') move(row + Math.floor(viewport / ROW_HEIGHT) - 1, col)
    else if (e.key === 'PageUp') move(row - Math.floor(viewport / ROW_HEIGHT) + 1, col)
    else if (e.key === 'Enter' && col !== null) {
      const v = result.rows[row][col]
      if (v !== null) onOpenValue(v, result.fields[col])
    } else if (e.key === 'Escape') setSelection(null)
  }

  const rows = []
  for (let r = first; r < last; r++) {
    const row = result.rows[r]
    const rowSelected = selection?.row === r
    rows.push(
      <div
        key={r}
        className={`grid-row${rowSelected && selection?.col === null ? ' row-selected' : ''}${r % 2 ? ' odd' : ''}`}
        style={{ top: HEADER_HEIGHT + r * ROW_HEIGHT, gridTemplateColumns: template, width: totalWidth }}
      >
        <div className="grid-rownum" onMouseDown={() => setSelection({ row: r, col: null })}>
          {r + 1}
        </div>
        {row.map((value, c) => {
          const field = result.fields[c]
          const selected = rowSelected && selection?.col === c
          return (
            <div
              key={c}
              className={`grid-cell${field.numeric ? ' num' : ''}${selected ? ' selected' : ''}`}
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
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="grid-canvas" style={{ height: HEADER_HEIGHT + result.rows.length * ROW_HEIGHT, width: totalWidth }}>
        <div className="grid-header" style={{ gridTemplateColumns: template, width: totalWidth }}>
          <div className="grid-rownum grid-corner" />
          {result.fields.map((f, c) => (
            <div key={c} className={`grid-head${f.numeric ? ' num' : ''}`} title={`${f.name} · ${f.type}`}>
              <span className="grid-head-name">{f.name}</span>
              <span className="grid-head-type">{f.type}</span>
              <span className="grid-resize" onPointerDown={(e) => startResize(c, e)} />
            </div>
          ))}
        </div>
        {rows}
      </div>
      {result.fields.length > 0 && result.rows.length === 0 && <div className="grid-empty">No rows</div>}
    </div>
  )
}
