import { describe, expect, it } from 'vitest'
import { insertSql, insertTarget } from '../src/shared/insert'
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
    table(400, 'events', [column(1, 'name')], { schema: 'analytics' })
  ],
  enums: []
}

const field = (name: string, table: number, col: number): ResultField => ({ name, type: 'text', numeric: false, table, column: col })

describe('insertTarget', () => {
  it('finds the table behind the columns, renamed or reordered', () => {
    const into = insertTarget([field('mail', 100, 2), field('id', 100, 1)], schema)
    expect(into?.table.name).toBe('users')
    expect(into?.columns.map((c) => c?.name)).toEqual(['email', 'id'])
  })

  it('leaves computed fields out', () => {
    const into = insertTarget([field('id', 100, 1), field('?column?', 0, 0)], schema)
    expect(into?.columns.map((c) => c?.name ?? null)).toEqual(['id', null])
  })

  it('refuses joins, views, repeated columns, computed-only results and stale schemas', () => {
    expect(insertTarget([field('id', 100, 1), field('user_id', 200, 2)], schema)).toBeNull()
    expect(insertTarget([field('n', 300, 1)], schema)).toBeNull()
    expect(insertTarget([field('id', 100, 1), field('id', 100, 1)], schema)).toBeNull()
    expect(insertTarget([field('one', 0, 0)], schema)).toBeNull()
    expect(insertTarget([field('added_later', 100, 9)], schema)).toBeNull()
    expect(insertTarget([field('id', 100, 1)], undefined)).toBeNull()
  })
})

describe('insertSql', () => {
  it('writes DEFAULT, NULL and quoted literals, and returns the result fields', () => {
    const into = insertTarget([field('id', 100, 1), field('email', 100, 2), field('x', 0, 0), field('order', 100, 3)], schema)!
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
    const into = insertTarget([field('name', 400, 1)], schema)!
    expect(insertSql(into, [['signup']])).toContain('INSERT INTO analytics.events (name)')
  })
})
