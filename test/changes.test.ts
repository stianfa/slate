import { describe, expect, it } from 'vitest'
import {
  changeStatements,
  countChanges,
  deleteSql,
  describeChanges,
  editTarget,
  insertSql,
  readOnlyReason,
  rowsAfter,
  updateSql,
  withEdit,
  withReverted,
  type GridChanges
} from '../src/shared/changes'
import type { ColumnInfo, ResultField, SchemaInfo, TableInfo } from '../src/shared/types'

const column = (num: number, name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  num,
  name,
  type: 'text',
  nullable: true,
  default: null,
  pk: false,
  fk: null,
  ...extra
})

const table = (oid: number, name: string, columns: ColumnInfo[], extra: Partial<TableInfo> = {}): TableInfo => ({
  oid,
  schema: 'public',
  name,
  kind: 'table',
  estimatedRows: 0,
  columns,
  ...extra
})

const schema: SchemaInfo = {
  tables: [
    table(100, 'users', [column(1, 'id', { pk: true, default: "nextval('users_id_seq'::regclass)" }), column(2, 'email'), column(3, 'order')]),
    table(200, 'orders', [column(1, 'id'), column(2, 'user_id')]),
    table(300, 'stats', [column(1, 'n')], { kind: 'view' }),
    table(400, 'events', [column(1, 'name')], { schema: 'analytics' }),
    table(500, 'order_items', [column(1, 'order_id', { pk: true }), column(2, 'product_id', { pk: true }), column(3, 'quantity')])
  ],
  enums: []
}

const field = (name: string, table: number, col: number): ResultField => ({ name, type: 'text', numeric: false, table, column: col })

describe('editTarget', () => {
  it('finds the primary key among the fields, or none when part of it is missing', () => {
    expect(editTarget([field('email', 100, 2), field('id', 100, 1)], schema)?.key).toEqual([1])
    expect(editTarget([field('email', 100, 2)], schema)?.key).toBeNull()
    expect(editTarget([field('q', 500, 3), field('p', 500, 2), field('o', 500, 1)], schema)?.key).toEqual([2, 1])
    expect(editTarget([field('q', 500, 3), field('o', 500, 1)], schema)?.key).toBeNull()
    expect(editTarget([field('id', 200, 1)], schema)?.key).toBeNull()
  })

  it('says why rows are read-only', () => {
    expect(readOnlyReason(editTarget([field('email', 100, 2)], schema)!)).toMatch(/^Add id to the query/)
    expect(readOnlyReason(editTarget([field('id', 200, 1)], schema)!)).toMatch(/^orders has no primary key/)
    expect(readOnlyReason(editTarget([field('id', 100, 1)], schema)!)).toBeNull()
  })

  it('finds the table behind the columns, renamed or reordered', () => {
    const into = editTarget([field('mail', 100, 2), field('id', 100, 1)], schema)
    expect(into?.table.name).toBe('users')
    expect(into?.columns.map((c) => c?.name)).toEqual(['email', 'id'])
  })

  it('leaves computed fields out', () => {
    const into = editTarget([field('id', 100, 1), field('?column?', 0, 0)], schema)
    expect(into?.columns.map((c) => c?.name ?? null)).toEqual(['id', null])
  })

  it('refuses joins, views, repeated columns, computed-only results and stale schemas', () => {
    expect(editTarget([field('id', 100, 1), field('user_id', 200, 2)], schema)).toBeNull()
    expect(editTarget([field('n', 300, 1)], schema)).toBeNull()
    expect(editTarget([field('id', 100, 1), field('id', 100, 1)], schema)).toBeNull()
    expect(editTarget([field('one', 0, 0)], schema)).toBeNull()
    expect(editTarget([field('added_later', 100, 9)], schema)).toBeNull()
    expect(editTarget([field('id', 100, 1)], undefined)).toBeNull()
  })
})

describe('insertSql', () => {
  it('writes DEFAULT, NULL and quoted literals, and returns the result fields', () => {
    const into = editTarget([field('id', 100, 1), field('email', 100, 2), field('x', 0, 0), field('order', 100, 3)], schema)!
    const sql = insertSql(into, [
      [undefined, "o'brien@example.com", 'ignored', null],
      ['7', 'a\\b', undefined, '']
    ])
    expect(sql).toBe(
      'INSERT INTO users (id, email, "order")\n' +
        'VALUES\n' +
        "  (DEFAULT, 'o''brien@example.com', NULL),\n" +
        "  ('7', E'a\\\\b', '')\n" +
        'RETURNING id, email, NULL, "order"'
    )
  })

  it('qualifies tables outside public', () => {
    const into = editTarget([field('name', 400, 1)], schema)!
    expect(insertSql(into, [['signup']])).toContain('INSERT INTO analytics.events (name)')
  })
})

describe('updates and deletes', () => {
  const users = editTarget([field('id', 100, 1), field('email', 100, 2), field('x', 0, 0)], schema)!
  const items = editTarget([field('order_id', 500, 1), field('product_id', 500, 2), field('quantity', 500, 3)], schema)!
  const rows = [
    ['1', 'a@example.com', 'x1'],
    ['2', 'b@example.com', 'x2'],
    ['3', 'c@example.com', 'x3']
  ]

  it('updates a row found by its key as loaded', () => {
    expect(updateSql(users, rows[0], { 0: '10', 1: null })).toBe(
      "UPDATE users\nSET id = '10', email = NULL\nWHERE id = '1'\nRETURNING id, email, NULL"
    )
    expect(updateSql(items, ['7', '8', '1'], { 2: '5' })).toContain("WHERE order_id = '7' AND product_id = '8'")
  })

  it('deletes rows by key, with IN for a single-column key', () => {
    expect(deleteSql(users, [rows[0], rows[2]])).toBe("DELETE FROM users\nWHERE id IN ('1', '3')")
    expect(deleteSql(items, [['7', '8', '1'], ['7', '9', '2']])).toBe(
      "DELETE FROM order_items\nWHERE (order_id = '7' AND product_id = '8')\n   OR (order_id = '7' AND product_id = '9')"
    )
  })

  it('plans deletes, then updates, then the insert, skipping edits of deleted rows', () => {
    const changes: GridChanges = {
      added: [[undefined, 'd@example.com', null]],
      edited: { 2: { 1: 'C@example.com' }, 0: { 1: 'gone' } },
      deleted: [0]
    }
    const planned = changeStatements(users, rows, changes)
    expect(planned.map((c) => [c.kind, c.rows, c.of])).toEqual([
      ['delete', 1, [0]],
      ['update', 1, [2]],
      ['insert', 1, []]
    ])
    expect(countChanges(changes)).toBe(3)
    expect(describeChanges(planned, false)).toBe('updates 1 row, deletes 1 and inserts 1')
    expect(describeChanges(planned.slice(0, 1), true)).toBe('deleted 1 row')

    const after = rowsAfter(users, rows, planned, [[], [['3', 'C@example.com', null]], [['4', 'd@example.com', null]]])
    expect(after).toEqual([
      ['2', 'b@example.com', 'x2'],
      ['3', 'C@example.com', 'x3'],
      ['4', 'd@example.com', null]
    ])
  })

  it('plans only inserts when rows have no key', () => {
    const noKey = editTarget([field('email', 100, 2)], schema)!
    const planned = changeStatements(noKey, [['a']], { added: [['b']], edited: { 0: { 0: 'z' } }, deleted: [0] })
    expect(planned.map((c) => c.kind)).toEqual(['insert'])
  })

  it('drops an edit that goes back to the loaded value, and reverts rows or cells', () => {
    let changes: GridChanges = { added: [], edited: {}, deleted: [] }
    changes = withEdit(changes, rows, 1, 1, 'new')
    changes = withEdit(changes, rows, 1, 0, '20')
    expect(changes.edited).toEqual({ 1: { 0: '20', 1: 'new' } })
    changes = withEdit(changes, rows, 1, 1, 'b@example.com')
    expect(changes.edited).toEqual({ 1: { 0: '20' } })
    changes = { ...withEdit(changes, rows, 2, 1, null), deleted: [0, 2] }
    expect(withReverted(changes, [1], [1]).edited).toEqual(changes.edited)
    expect(withReverted(changes, [1], [0]).edited).toEqual({ 2: { 1: null } })
    expect(withReverted(changes, [2])).toEqual({ added: [], edited: { 1: { 0: '20' } }, deleted: [0] })
  })
})
