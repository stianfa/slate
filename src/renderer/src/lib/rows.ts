// Sorting and filtering a result's loaded rows in the grid. Nothing is run again: a cut-off result
// is sorted and filtered as far as it was loaded.
import type { Cell, ResultField, StatementResult } from '@shared/types'
import { displayValue } from './format'

export interface RowSort {
  column: number
  desc: boolean
}

/** Keeps the rows whose value in a column is one of `values`, or with `exclude` none of them. */
export interface ColumnFilter {
  values: Cell[]
  exclude: boolean
}

/** Columns with this many different values or more get no list of values to pick from. */
export const MAX_PICK_VALUES = 50

export interface DistinctValue {
  value: Cell
  count: number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareValues(a: string, b: string, field: ResultField): number {
  if (field.numeric) {
    const x = Number(a)
    const y = Number(b)
    if (x !== y && !Number.isNaN(x) && !Number.isNaN(y)) return x - y
  }
  return collator.compare(a, b)
}

/**
 * The different values in a column of the loaded rows, sorted, with how many rows have each; null
 * when there are MAX_PICK_VALUES or more.
 */
export function distinctValues(result: StatementResult, column: number): DistinctValue[] | null {
  const counts = new Map<Cell, number>()
  for (const row of result.rows) {
    counts.set(row[column], (counts.get(row[column]) ?? 0) + 1)
    if (counts.size >= MAX_PICK_VALUES) return null
  }
  const field = result.fields[column]
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (a.value === null || b.value === null ? (a.value === null ? 1 : -1) : compareValues(a.value, b.value, field)))
}

/** Ascending, descending, then back to the order Postgres returned. */
export function nextSort(sort: RowSort | null | undefined, column: number): RowSort | null {
  if (sort?.column !== column) return { column, desc: false }
  return sort.desc ? null : { column, desc: true }
}

/**
 * Indexes of the result's rows in the order to show them: the rows with a value that contains the
 * filter text (ignoring case) and that pass every column filter, sorted by a column with NULLs last
 * either way. Null when every row shows in its own order.
 */
export function rowOrder(
  result: StatementResult,
  sort: RowSort | null | undefined,
  filter: string | undefined,
  columns?: Record<number, ColumnFilter>
): number[] | null {
  const needle = filter?.trim().toLowerCase()
  const picks = Object.entries(columns ?? {})
    .filter(([c, f]) => f.values.length && Number(c) < result.fields.length)
    .map(([c, f]) => ({ column: Number(c), values: new Set(f.values), exclude: f.exclude }))
  if (!needle && !sort && !picks.length) return null
  let order = result.rows.map((_, i) => i)
  if (picks.length) {
    order = order.filter((i) => picks.every((p) => p.values.has(result.rows[i][p.column]) !== p.exclude))
  }
  if (needle) {
    const matches = (v: Cell, f: ResultField) => v !== null && displayValue(v, f).toLowerCase().includes(needle)
    order = order.filter((i) => result.rows[i].some((v, c) => matches(v, result.fields[c])))
  }
  if (sort && sort.column < result.fields.length) {
    const field = result.fields[sort.column]
    const dir = sort.desc ? -1 : 1
    order.sort((i, j) => {
      const a = result.rows[i][sort.column]
      const b = result.rows[j][sort.column]
      if (a === null || b === null) return a === b ? i - j : a === null ? 1 : -1
      return dir * compareValues(a, b, field) || i - j
    })
  }
  return order
}
