import { describe, expect, it } from 'vitest'
import { MAX_PICK_VALUES, distinctValues, nextSort, rowOrder } from '../src/renderer/src/lib/rows'
import type { StatementResult } from '../src/shared/types'

const result: StatementResult = {
  statement: 'select',
  command: 'SELECT',
  rowCount: 5,
  fields: [
    { name: 'n', type: 'int4', numeric: true, table: 0, column: 0 },
    { name: 'name', type: 'text', numeric: false, table: 0, column: 0 },
    { name: 'ok', type: 'bool', numeric: false, table: 0, column: 0 }
  ],
  rows: [
    ['10', 'item10', 't'],
    ['9', 'Item2', 'f'],
    [null, 'none', null],
    ['-1', null, 't'],
    ['100', 'item1', 'f']
  ],
  truncated: false,
  durationMs: 1
}

describe('rowOrder', () => {
  it('leaves the order alone without a sort or filter', () => {
    expect(rowOrder(result, null, '  ')).toBeNull()
  })

  it('sorts numbers as numbers and text naturally, NULLs last either way', () => {
    expect(rowOrder(result, { column: 0, desc: false }, '')).toEqual([3, 1, 0, 4, 2])
    expect(rowOrder(result, { column: 0, desc: true }, '')).toEqual([4, 0, 1, 3, 2])
    expect(rowOrder(result, { column: 1, desc: false }, '')).toEqual([4, 1, 0, 2, 3])
  })

  it('filters on any value, ignoring case, as the grid shows it', () => {
    expect(rowOrder(result, null, 'ITEM')).toEqual([0, 1, 4])
    expect(rowOrder(result, null, 'true')).toEqual([0, 3])
    expect(rowOrder(result, { column: 0, desc: true }, 'item1')).toEqual([4, 0])
  })
})

describe('column filters', () => {
  it('keeps the picked values, or all but them, NULL included', () => {
    expect(rowOrder(result, null, '', { 2: { values: ['t'], exclude: false } })).toEqual([0, 3])
    expect(rowOrder(result, null, '', { 2: { values: ['t', null], exclude: true } })).toEqual([1, 4])
    expect(rowOrder(result, null, '', { 0: { values: [null], exclude: false } })).toEqual([2])
  })

  it('combines with the text filter, the sort and each other, and ignores empty picks', () => {
    const columns = { 2: { values: ['f'], exclude: false }, 1: { values: ['Item2'], exclude: true } }
    expect(rowOrder(result, null, '', columns)).toEqual([4])
    expect(rowOrder(result, { column: 0, desc: true }, 'item', { 2: { values: ['t', 'f'], exclude: false } })).toEqual([4, 0, 1])
    expect(rowOrder(result, null, '', { 2: { values: [], exclude: false } })).toBeNull()
  })

  it('lists a column\'s values with their counts, NULL last, or none when there are too many', () => {
    expect(distinctValues(result, 2)).toEqual([
      { value: 'f', count: 2 },
      { value: 't', count: 2 },
      { value: null, count: 1 }
    ])
    const many = { ...result, rows: Array.from({ length: MAX_PICK_VALUES }, (_, i) => [String(i), 'x', 't']) }
    expect(distinctValues(many, 0)).toBeNull()
    expect(distinctValues({ ...many, rows: many.rows.slice(1) }, 0)).toHaveLength(MAX_PICK_VALUES - 1)
  })
})

describe('nextSort', () => {
  it('goes ascending, descending, then off', () => {
    expect(nextSort(null, 1)).toEqual({ column: 1, desc: false })
    expect(nextSort({ column: 1, desc: false }, 1)).toEqual({ column: 1, desc: true })
    expect(nextSort({ column: 1, desc: true }, 1)).toBeNull()
    expect(nextSort({ column: 1, desc: true }, 2)).toEqual({ column: 2, desc: false })
  })
})
