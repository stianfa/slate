import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, X } from 'lucide-react'
import type { Cell, StatementResult } from '@shared/types'
import { displayValue } from '../lib/format'
import { MAX_PICK_VALUES, distinctValues, type ColumnFilter, type RowSort } from '../lib/rows'

/**
 * Opened by right-clicking a column header: sorts by the column, and for a column with fewer than
 * MAX_PICK_VALUES different values, shows or hides the rows with the values ticked in a list.
 * Changes apply as they are made; the menu stays open for more ticks.
 */
export function ColumnMenu({
  result,
  column,
  x,
  y,
  sort,
  filter,
  onSort,
  onFilter,
  onClose
}: {
  result: StatementResult
  column: number
  /** Where the menu opens, in window coordinates. */
  x: number
  y: number
  sort: RowSort | null | undefined
  filter: ColumnFilter | undefined
  onSort(sort: RowSort | null): void
  /** null drops the column's filter. */
  onFilter(filter: ColumnFilter | null): void
  onClose(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const field = result.fields[column]
  const values = useMemo(() => distinctValues(result, column), [result, column])
  const picked = filter?.values ?? []
  const exclude = filter?.exclude ?? false
  const sorted = sort?.column === column ? sort : null

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8))
    })
  }, [x, y, values])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const pick = (next: Cell[]) => onFilter(next.length ? { values: next, exclude } : null)
  const toggle = (value: Cell) => pick(picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value])
  const allPicked = values !== null && values.length > 0 && values.every((v) => picked.includes(v.value))

  const sortItem = (desc: boolean) => {
    const active = sorted?.desc === desc
    return (
      <button
        className={`menu-item${active ? ' selected' : ''}`}
        onClick={() => {
          onSort(active ? null : { column, desc })
          onClose()
        }}
      >
        {desc ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
        {desc ? 'Sort descending' : 'Sort ascending'}
        {active && <Check size={13} className="menu-check" />}
      </button>
    )
  }

  return (
    <div
      className="column-menu menu"
      ref={root}
      style={position}
      role="menu"
      aria-label={`${field.name} column`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="menu-label">
        <span className="column-menu-name">{field.name}</span>
        <span className="column-menu-type">{field.type}</span>
      </div>
      {sortItem(false)}
      {sortItem(true)}
      <div className="menu-sep" />
      {values === null ? (
        <div className="column-menu-note">
          {MAX_PICK_VALUES} or more different values{result.truncated ? ' in the loaded rows' : ''}. Use Filter rows to search them.
        </div>
      ) : (
        <>
          <div className="column-menu-mode" role="group" aria-label="Ticked values">
            <button className={exclude ? '' : 'active'} aria-pressed={!exclude} onClick={() => onFilter(picked.length ? { values: picked, exclude: false } : null)}>
              Show ticked
            </button>
            <button className={exclude ? 'active' : ''} aria-pressed={exclude} onClick={() => onFilter(picked.length ? { values: picked, exclude: true } : null)}>
              Hide ticked
            </button>
          </div>
          <label className="column-menu-value all">
            <input type="checkbox" checked={allPicked} onChange={() => pick(allPicked ? [] : values.map((v) => v.value))} />
            <span className="column-menu-text">All values</span>
          </label>
          <div className="column-menu-values">
            {values.map(({ value, count }) => (
              <label key={value ?? '\0null'} className="column-menu-value">
                <input type="checkbox" checked={picked.includes(value)} onChange={() => toggle(value)} />
                <span className={`column-menu-text${value === null || value === '' ? ' null' : ''}`}>
                  {value === null ? 'NULL' : value === '' ? '(empty)' : displayValue(value, field)}
                </span>
                <span className="column-menu-count">{count.toLocaleString('en-US')}</span>
              </label>
            ))}
          </div>
          {picked.length > 0 && (
            <button className="menu-item" onClick={() => onFilter(null)}>
              <X size={13} /> Clear filter
            </button>
          )}
        </>
      )}
    </div>
  )
}
