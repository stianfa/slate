// Changes made in the grid to the table a result's columns come from: rows added under the result,
// edited cells and deleted rows, saved as DELETE, UPDATE and INSERT statements.
import { qualifiedName, quoteIdent } from './sql'
import type { Cell, ColumnInfo, RelationKind, ResultField, SchemaInfo, TableInfo } from './types'
import { quoteLiteral } from './variables'

/** A value in a new row: undefined leaves the column to its DEFAULT. */
export type Draft = Cell | undefined

export interface EditTarget {
  table: TableInfo
  /** The table column behind each result field, or null for a computed field. */
  columns: (ColumnInfo | null)[]
  /**
   * The fields holding the table's primary key, which find a row again to update or delete it. Null
   * when the table has no primary key or the result leaves part of it out: then rows can only be added.
   */
  key: number[] | null
}

/** Changes to a result that are waiting to be saved. */
export interface GridChanges {
  /** Rows added under the result. */
  added: Draft[][]
  /** New values for cells of the result's own rows, by row index and then field index. */
  edited: Record<number, Record<number, Cell>>
  /** Indexes of the result's rows to delete. Deleting a row drops its edits. */
  deleted: number[]
}

/** A statement and the number of rows it has to touch; any other count undoes every change. */
export interface ChangeStatement {
  sql: string
  rows: number
}

/** A statement for one kind of change, with the indexes of the result's rows it updates or deletes. */
export interface PlannedChange extends ChangeStatement {
  kind: 'delete' | 'update' | 'insert'
  of: number[]
}

export const NO_CHANGES: GridChanges = { added: [], edited: {}, deleted: [] }

const EDITABLE: RelationKind[] = ['table', 'partitioned table', 'foreign table']

/**
 * The table a result's columns come from, if its rows can be changed: every table column in the
 * result belongs to one table (computed fields are fine), and no column shows up twice.
 */
export function editTarget(fields: ResultField[], schema: SchemaInfo | undefined): EditTarget | null {
  const oids = new Set(fields.map((f) => f.table).filter(Boolean))
  if (oids.size !== 1 || !schema) return null
  const [oid] = oids
  const table = schema.tables.find((t) => t.oid === oid)
  if (!table || !EDITABLE.includes(table.kind)) return null
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
  const key = table.columns.filter((c) => c.pk).map((c) => columns.indexOf(c))
  return { table, columns, key: key.length && !key.includes(-1) ? key : null }
}

/** Why a target's existing rows can't be edited, or null when they can. */
export function readOnlyReason(target: EditTarget): string | null {
  if (target.key) return null
  const name = qualifiedName(target.table.schema, target.table.name)
  const pk = target.table.columns.filter((c) => c.pk).map((c) => c.name)
  if (!pk.length) return `${name} has no primary key, so only new rows can be added`
  return `Add ${pk.join(', ')} to the query to edit rows of ${name}`
}

export function countChanges(changes: GridChanges): number {
  const deleted = new Set(changes.deleted)
  const edited = Object.keys(changes.edited).filter((r) => !deleted.has(Number(r))).length
  return changes.added.length + edited + deleted.size
}

/** The value a cell of the result shows, with its edit applied. */
export function editedValue(changes: GridChanges, rows: Cell[][], row: number, col: number): Cell {
  const edits = changes.edited[row]
  return edits && col in edits ? edits[col] : rows[row][col]
}

/** Sets a cell of one of the result's rows; going back to the loaded value drops the edit. */
export function withEdit(changes: GridChanges, rows: Cell[][], row: number, col: number, value: Cell): GridChanges {
  const edits = { ...changes.edited[row] }
  if (value === rows[row][col]) delete edits[col]
  else edits[col] = value
  const edited = { ...changes.edited }
  if (Object.keys(edits).length) edited[row] = edits
  else delete edited[row]
  return { ...changes, edited }
}

/** Drops the edits and deletions of the given rows of the result, or of some of their cells. */
export function withReverted(changes: GridChanges, rows: number[], cols?: number[]): GridChanges {
  const edited = { ...changes.edited }
  for (const r of rows) {
    if (!edited[r]) continue
    if (!cols) delete edited[r]
    else {
      const edits = { ...edited[r] }
      for (const c of cols) delete edits[c]
      if (Object.keys(edits).length) edited[r] = edits
      else delete edited[r]
    }
  }
  const deleted = cols ? changes.deleted : changes.deleted.filter((r) => !rows.includes(r))
  return { ...changes, edited, deleted }
}

const literal = (v: Draft) => (v === undefined ? 'DEFAULT' : v === null ? 'NULL' : quoteLiteral(v))
const tableName = ({ table }: EditTarget) => qualifiedName(table.schema, table.name)
// The result's own fields, so changed rows can take their place in the grid.
const returning = ({ columns }: EditTarget) => columns.map((c) => (c ? quoteIdent(c.name) : 'NULL')).join(', ')

/** Finds a row by its primary key as it was loaded. */
function whereKey(target: EditTarget, row: Cell[]): string {
  return target.key!.map((i) => `${quoteIdent(target.columns[i]!.name)} = ${literal(row[i])}`).join(' AND ')
}

/**
 * INSERT for the new rows, returning the result's own fields so the inserted rows can join the grid
 * with their defaults filled in. Values go in as quoted literals, so Postgres reads them as the
 * column's type, the same as text typed into psql.
 */
export function insertSql(target: EditTarget, rows: Draft[][]): string {
  const used = target.columns.flatMap((column, i) => (column ? [{ column, i }] : []))
  const values = rows.map((row) => `  (${used.map(({ i }) => literal(row[i])).join(', ')})`)
  return (
    `INSERT INTO ${tableName(target)} (${used.map(({ column }) => quoteIdent(column.name)).join(', ')})\n` +
    `VALUES\n${values.join(',\n')}\nRETURNING ${returning(target)}`
  )
}

export function updateSql(target: EditTarget, row: Cell[], values: Record<number, Cell>): string {
  const sets = Object.entries(values).map(([i, v]) => `${quoteIdent(target.columns[Number(i)]!.name)} = ${literal(v)}`)
  return `UPDATE ${tableName(target)}\nSET ${sets.join(', ')}\nWHERE ${whereKey(target, row)}\nRETURNING ${returning(target)}`
}

export function deleteSql(target: EditTarget, rows: Cell[][]): string {
  const key = target.key!
  const where =
    key.length === 1
      ? `${quoteIdent(target.columns[key[0]]!.name)} IN (${rows.map((row) => literal(row[key[0]])).join(', ')})`
      : rows.map((row) => `(${whereKey(target, row)})`).join('\n   OR ')
  return `DELETE FROM ${tableName(target)}\nWHERE ${where}`
}

/**
 * The statements that save the changes. Deletes go first, so an edited or new row can take the key
 * or unique value of a deleted one.
 */
export function changeStatements(target: EditTarget, rows: Cell[][], changes: GridChanges): PlannedChange[] {
  const out: PlannedChange[] = []
  const deleted = [...new Set(changes.deleted)].sort((a, b) => a - b)
  if (deleted.length && target.key) {
    out.push({ kind: 'delete', sql: deleteSql(target, deleted.map((r) => rows[r])), rows: deleted.length, of: deleted })
  }
  if (target.key) {
    for (const [r, values] of Object.entries(changes.edited)) {
      const row = Number(r)
      if (deleted.includes(row) || !Object.keys(values).length) continue
      out.push({ kind: 'update', sql: updateSql(target, rows[row], values), rows: 1, of: [row] })
    }
  }
  if (changes.added.length) {
    out.push({ kind: 'insert', sql: insertSql(target, changes.added), rows: changes.added.length, of: [] })
  }
  return out
}

/**
 * The result's rows once the changes are saved: updated rows take what their UPDATE returned (computed
 * fields keep their values), deleted rows go, and inserted rows join at the bottom.
 */
export function rowsAfter(target: EditTarget, rows: Cell[][], planned: PlannedChange[], returned: Cell[][][]): Cell[][] {
  const updated = new Map<number, Cell[]>()
  const deleted = new Set<number>()
  let inserted: Cell[][] = []
  planned.forEach((change, i) => {
    if (change.kind === 'update' && returned[i]?.[0]) updated.set(change.of[0], returned[i][0])
    else if (change.kind === 'delete') change.of.forEach((r) => deleted.add(r))
    else if (change.kind === 'insert') inserted = returned[i] ?? []
  })
  return rows
    .map((row, r) => {
      const fresh = updated.get(r)
      return fresh ? row.map((v, c) => (target.columns[c] ? fresh[c] : v)) : row
    })
    .filter((_, r) => !deleted.has(r))
    .concat(inserted)
}

/** "updates 2 rows, deletes 1 and inserts 3", or with `past` "updated 2 rows, …". */
export function describeChanges(planned: PlannedChange[], past: boolean): string {
  const verbs = { update: ['updates', 'updated'], delete: ['deletes', 'deleted'], insert: ['inserts', 'inserted'] } as const
  const parts = (['update', 'delete', 'insert'] as const)
    .map((kind) => ({ kind, n: planned.filter((c) => c.kind === kind).reduce((sum, c) => sum + c.rows, 0) }))
    .filter(({ n }) => n > 0)
    .map(({ kind, n }, i) => `${verbs[kind][past ? 1 : 0]} ${n}${i === 0 ? ` ${n === 1 ? 'row' : 'rows'}` : ''}`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}
