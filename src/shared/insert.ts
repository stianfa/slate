// New rows typed or pasted under a result, inserted into the table its columns come from.
import { qualifiedName, quoteIdent } from './sql'
import type { Cell, ColumnInfo, RelationKind, ResultField, SchemaInfo, TableInfo } from './types'
import { quoteLiteral } from './variables'

/** A value in a new row: undefined leaves the column to its DEFAULT. */
export type Draft = Cell | undefined

export interface InsertTarget {
  table: TableInfo
  /** The table column behind each result field, or null for a computed field. */
  columns: (ColumnInfo | null)[]
}

const INSERTABLE: RelationKind[] = ['table', 'partitioned table', 'foreign table']

/**
 * The table a result's columns come from, if new rows can go into it: every table column in the
 * result belongs to one table (computed fields are fine), and no column shows up twice.
 */
export function insertTarget(fields: ResultField[], schema: SchemaInfo | undefined): InsertTarget | null {
  const oids = new Set(fields.map((f) => f.table).filter(Boolean))
  if (oids.size !== 1 || !schema) return null
  const [oid] = oids
  const table = schema.tables.find((t) => t.oid === oid)
  if (!table || !INSERTABLE.includes(table.kind)) return null
  const columns: (ColumnInfo | null)[] = []
  const seen = new Set<number>()
  for (const f of fields) {
    if (!f.table) {
      columns.push(null)
      continue
    }
    // Missing means the schema is older than the result (a column was added since it loaded).
    const column = table.columns.find((c) => c.num === f.column)
    if (!column || seen.has(column.num)) return null
    seen.add(column.num)
    columns.push(column)
  }
  return { table, columns }
}

/**
 * INSERT for the new rows, returning the result's own fields so the inserted rows can join the grid
 * with their defaults filled in. Values go in as quoted literals, so Postgres reads them as the
 * column's type, the same as text typed into psql.
 */
export function insertSql({ table, columns }: InsertTarget, rows: Draft[][]): string {
  const used = columns.flatMap((column, i) => (column ? [{ column, i }] : []))
  const literal = (v: Draft) => (v === undefined ? 'DEFAULT' : v === null ? 'NULL' : quoteLiteral(v))
  const values = rows.map((row) => `  (${used.map(({ i }) => literal(row[i])).join(', ')})`)
  const returning = columns.map((c) => (c ? quoteIdent(c.name) : 'NULL')).join(', ')
  return (
    `INSERT INTO ${qualifiedName(table.schema, table.name)} (${used.map(({ column }) => quoteIdent(column.name)).join(', ')})\n` +
    `VALUES\n${values.join(',\n')}\nRETURNING ${returning}`
  )
}
