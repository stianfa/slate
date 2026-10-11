import { createWriteStream, type WriteStream } from 'node:fs'
import pg from 'pg'
import Cursor from 'pg-cursor'
import { leadingKeyword, splitStatements, type Statement } from '@shared/sql'
import { bindVariables, type BoundStatement, type VariableValues } from '@shared/variables'
import {
  targetKey,
  type ColumnInfo,
  type ConnectionConfig,
  type ConnectionInput,
  type QueryError,
  type RelationKind,
  type RunOptions,
  type RunResponse,
  type SchemaInfo,
  type ServerInfo,
  type SslMode,
  type StatementResult,
  type TableInfo,
  type Target,
  type TxStatus
} from '@shared/types'

export interface ResolvedConnection {
  config: ConnectionConfig
  password: string | null
}

interface Session {
  client: pg.Client
  target: Target
  busy: boolean
  txStatus: TxStatus
  notices: string[]
  /** Whether default_transaction_read_only is on, as far as we last set it. */
  readOnly: boolean
  idleTimer?: ReturnType<typeof setTimeout>
}

// Sessions belong to queries in the history, which can pile up; close ones nobody is using.
// A session with an open transaction is never closed this way.
const IDLE_SESSION_MS = 15 * 60_000

// Result values stay exactly as Postgres prints them (dates, numerics, json...).
const rawTypes = { getTypeParser: () => (value: string) => value } as unknown as pg.CustomTypesConfig

const NUMERIC_TYPES = new Set([20, 21, 23, 26, 700, 701, 790, 1700])

const RELATION_KINDS: Record<string, RelationKind> = {
  r: 'table',
  p: 'partitioned table',
  v: 'view',
  m: 'materialized view',
  f: 'foreign table'
}

function sslOption(mode: SslMode): pg.ClientConfig['ssl'] {
  if (mode === 'disable') return false
  return { rejectUnauthorized: mode === 'verify-full' }
}

function baseConfig(c: Omit<ConnectionInput, 'password'>, password: string | null, database: string): pg.ClientConfig {
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    // Leaving the password unset lets pg fall back to PGPASSWORD or ~/.pgpass.
    password: password || undefined,
    database,
    ssl: sslOption(c.ssl),
    application_name: 'Slate',
    connectionTimeoutMillis: 10_000,
    keepAlive: true
  }
}

const EXPORT_BATCH = 5000
const BOOL_TYPE = 16

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

function readBatch(cursor: Cursor<(string | null)[]>, size: number) {
  return new Promise<{ rows: (string | null)[][]; result: pg.QueryResult }>((resolve, reject) => {
    cursor.read(size, (err, rows, result) => (err ? reject(err) : resolve({ rows, result })))
  })
}

function write(out: WriteStream, chunk: string) {
  return new Promise<void>((resolve, reject) => out.write(chunk, (err) => (err ? reject(err) : resolve())))
}

function toQueryError(e: unknown, statement: Statement | null, bound?: BoundStatement): QueryError {
  const err = e as pg.DatabaseError & Error
  // Postgres reports a 1-based position in the text it received; map it back through variable rewriting.
  const received = Number(err.position) - 1
  const position = statement && err.position ? statement.from + (bound ? bound.map(received) : received) : undefined
  return {
    message: err.message || String(e),
    detail: err.detail,
    hint: err.hint,
    code: err.code,
    position
  }
}

export class DbManager {
  private pools = new Map<string, pg.Pool>()
  private sessions = new Map<string, Session>()
  private typeNames = new Map<string, Promise<Map<number, string>>>()
  private schemas = new Map<string, SchemaInfo>()
  private versions = new Map<string, string>()
  /** Queries whose connection dropped while a transaction was open, keyed by tab id. */
  private lostTransactions = new Set<string>()

  constructor(private resolve: (connectionId: string) => ResolvedConnection) {}

  private config(target: Target): pg.ClientConfig {
    const { config, password } = this.resolve(target.connectionId)
    return baseConfig(config, password, target.database)
  }

  private pool(target: Target): pg.Pool {
    const key = targetKey(target)
    let pool = this.pools.get(key)
    if (!pool) {
      pool = new pg.Pool({ ...this.config(target), max: 3, idleTimeoutMillis: 60_000 })
      // Idle clients can die (server restart, network drop); the pool replaces them.
      pool.on('error', () => {})
      this.pools.set(key, pool)
    }
    return pool
  }

  async test(input: ConnectionInput): Promise<string> {
    const client = new pg.Client(baseConfig(input, input.password ?? null, input.database))
    try {
      await client.connect()
      const { rows } = await client.query<{ version: string }>("SELECT current_setting('server_version') AS version")
      return rows[0].version
    } finally {
      client.end().catch(() => {})
    }
  }

  async connect(connectionId: string): Promise<ServerInfo> {
    const { config } = this.resolve(connectionId)
    const pool = this.pool({ connectionId, database: config.database })
    const [version, databases] = await Promise.all([
      pool.query<{ version: string }>("SELECT current_setting('server_version') AS version"),
      pool.query<{ datname: string }>(
        `SELECT datname FROM pg_database
         WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
         ORDER BY datname`
      )
    ])
    this.versions.set(connectionId, version.rows[0].version)
    return { version: version.rows[0].version, databases: databases.rows.map((r) => r.datname) }
  }

  serverVersion(connectionId: string): string | null {
    return this.versions.get(connectionId) ?? null
  }

  async disconnect(connectionId: string): Promise<void> {
    const prefix = `${connectionId}/`
    for (const [tabId, s] of this.sessions) {
      if (s.target.connectionId === connectionId) await this.closeSession(tabId)
    }
    const ending: Promise<void>[] = []
    for (const [key, pool] of this.pools) {
      if (key.startsWith(prefix)) {
        this.pools.delete(key)
        ending.push(pool.end().catch(() => {}))
      }
    }
    for (const map of [this.typeNames, this.schemas]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key)
    }
    this.versions.delete(connectionId)
    await Promise.all(ending)
  }

  cachedSchema(target: Target): SchemaInfo | undefined {
    return this.schemas.get(targetKey(target))
  }

  async schema(target: Target, refresh = false): Promise<SchemaInfo> {
    const key = targetKey(target)
    const cached = this.schemas.get(key)
    if (cached && !refresh) return cached

    const pool = this.pool(target)
    const [relations, constraints, enums] = await Promise.all([
      pool.query<{
        schema: string
        name: string
        kind: string
        estimate: number
        column: string | null
        type: string | null
        notnull: boolean | null
        default: string | null
      }>(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples::float8 AS estimate,
                a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
                pg_get_expr(d.adbin, d.adrelid) AS default
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND NOT c.relispartition
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
         ORDER BY n.nspname, c.relname, a.attnum`
      ),
      pool.query<{
        type: string
        schema: string
        table: string
        columns: string[]
        ref_schema: string | null
        ref_table: string | null
        ref_columns: string[]
      }>(
        `SELECT con.contype AS type, n.nspname AS schema, c.relname AS table,
                ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(num, i)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.i)::text[] AS columns,
                fn.nspname AS ref_schema, fc.relname AS ref_table,
                ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(num, i)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.i)::text[] AS ref_columns
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class fc ON fc.oid = con.confrelid
         LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
         WHERE con.contype IN ('p', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')`
      ),
      pool.query<{ schema: string; name: string; labels: string[] }>(
        `SELECT n.nspname AS schema, t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
         GROUP BY n.nspname, t.typname
         ORDER BY n.nspname, t.typname`
      )
    ])

    const tables = new Map<string, TableInfo>()
    for (const r of relations.rows) {
      const id = `${r.schema}.${r.name}`
      let table = tables.get(id)
      if (!table) {
        table = {
          schema: r.schema,
          name: r.name,
          kind: RELATION_KINDS[r.kind] ?? 'table',
          estimatedRows: r.estimate >= 0 && r.kind !== 'v' ? Math.round(r.estimate) : null,
          columns: []
        }
        tables.set(id, table)
      }
      if (r.column) {
        table.columns.push({
          name: r.column,
          type: r.type ?? '',
          nullable: !r.notnull,
          default: r.default,
          pk: false,
          fk: null
        })
      }
    }

    for (const c of constraints.rows) {
      const table = tables.get(`${c.schema}.${c.table}`)
      if (!table) continue
      c.columns.forEach((name, i) => {
        const column = table.columns.find((col: ColumnInfo) => col.name === name)
        if (!column) return
        if (c.type === 'p') column.pk = true
        // Composite foreign keys still point each column at its partner.
        else if (c.ref_schema && c.ref_table && !column.fk) {
          column.fk = { schema: c.ref_schema, table: c.ref_table, column: c.ref_columns[i] ?? '' }
        }
      })
    }

    const info: SchemaInfo = { tables: [...tables.values()], enums: enums.rows }
    this.schemas.set(key, info)
    return info
  }

  private typeNamesFor(target: Target): Promise<Map<number, string>> {
    const key = targetKey(target)
    let names = this.typeNames.get(key)
    if (!names) {
      names = this.pool(target)
        .query<{ oid: number; name: string }>(
          `SELECT t.oid::int AS oid,
                  CASE WHEN t.typcategory = 'A' AND e.typname IS NOT NULL THEN e.typname || '[]' ELSE t.typname END AS name
           FROM pg_type t LEFT JOIN pg_type e ON e.oid = t.typelem`
        )
        .then((r) => new Map(r.rows.map((row) => [row.oid, row.name])))
      names.catch(() => this.typeNames.delete(key))
      this.typeNames.set(key, names)
    }
    return names
  }

  private async session(tabId: string, target: Target): Promise<Session> {
    let s = this.sessions.get(tabId)
    if (s && targetKey(s.target) !== targetKey(target)) {
      await this.closeSession(tabId)
      s = undefined
    }
    if (s) return s

    const client = new pg.Client(this.config(target))
    const session: Session = { client, target, busy: false, txStatus: 'idle', notices: [], readOnly: false }
    const drop = () => {
      if (this.sessions.get(tabId)?.client !== client) return
      this.sessions.delete(tabId)
      // An unexpected drop mid-transaction means the server rolled it back; say so on the next run.
      if (session.txStatus !== 'idle') this.lostTransactions.add(tabId)
    }
    client.on('error', drop)
    client.on('end', drop)
    client.on('notice', (n) => session.notices.push(`${n.severity ?? 'NOTICE'}: ${n.message}`))
    await client.connect()
    // ReadyForQuery carries the transaction state: I(dle), T(ransaction), E(rror).
    const connection = client.connection as unknown as NodeJS.EventEmitter
    connection.on('readyForQuery', (msg: { status: string }) => {
      session.txStatus = msg.status === 'T' ? 'transaction' : msg.status === 'E' ? 'failed' : 'idle'
    })
    this.sessions.set(tabId, session)
    return session
  }

  async run(
    tabId: string,
    target: Target,
    sql: string,
    rowLimit: number,
    variables: VariableValues = {},
    options: RunOptions = { readOnly: false }
  ): Promise<RunResponse> {
    const started = performance.now()
    if (this.lostTransactions.delete(tabId)) {
      const message =
        'The connection was lost while a transaction was open, so the server rolled it back. ' +
        'Nothing ran. Run again to continue in a new session.'
      return { results: [], error: { message }, notices: [], txStatus: 'idle', durationMs: 0 }
    }
    let session: Session
    try {
      session = await this.session(tabId, target)
    } catch (e) {
      const error = toQueryError(e, null)
      return { results: [], error, notices: [], txStatus: 'idle', durationMs: performance.now() - started }
    }
    if (session.busy) throw new Error('A query is already running in this tab.')
    session.busy = true
    clearTimeout(session.idleTimer)
    session.notices = []
    const results: StatementResult[] = []
    let error: QueryError | null = null
    try {
      // Production runs with the server refusing writes, even ones hidden inside functions.
      // Set on every such run: a SET inside a transaction that rolls back is undone.
      if (options.readOnly || session.readOnly) {
        try {
          await session.client.query(`SET default_transaction_read_only = ${options.readOnly ? 'on' : 'off'}`)
          session.readOnly = options.readOnly
        } catch {
          // An aborted transaction rejects everything; the statements below report it.
        }
      }
      const typeNames = await this.typeNamesFor(target)
      for (const statement of splitStatements(sql)) {
        const bound = bindVariables(statement.text, variables)
        if (bound.missing.length) {
          error = {
            message: `No value for ${bound.missing.join(', ')}. Fill it in above the editor.`,
            position: statement.from + (bound.missingAt ?? 0)
          }
          break
        }
        try {
          results.push(await this.runStatement(session, statement, bound, rowLimit, typeNames))
        } catch (e) {
          error = toQueryError(e, statement, bound)
          break
        }
      }
    } catch (e) {
      error = toQueryError(e, null)
    } finally {
      if (error && this.sessions.get(tabId) === session) {
        // The ReadyForQuery that reports a failed transaction arrives a round trip after the
        // error. pg queues this empty query behind it, so awaiting it settles txStatus.
        await session.client.query('').catch(() => {})
      }
      session.busy = false
      session.idleTimer = setTimeout(() => {
        if (!session.busy && session.txStatus === 'idle' && this.sessions.get(tabId) === session) {
          void this.closeSession(tabId)
        }
      }, IDLE_SESSION_MS)
    }
    return {
      results,
      error,
      notices: session.notices,
      txStatus: session.txStatus,
      durationMs: performance.now() - started
    }
  }

  private async runStatement(
    session: Session,
    statement: Statement,
    bound: BoundStatement,
    rowLimit: number,
    typeNames: Map<number, string>
  ): Promise<StatementResult> {
    const started = performance.now()
    // A cursor reads only rowLimit + 1 rows, so "select * from huge_table" stays cheap.
    const cursor = session.client.query(new Cursor(bound.text, undefined, { rowMode: 'array', types: rawTypes }))
    const { rows, result } = await new Promise<{ rows: (string | null)[][]; result: pg.QueryResult }>(
      (resolve, reject) => {
        cursor.read(rowLimit + 1, (err, rows, result) => (err ? reject(err) : resolve({ rows, result })))
      }
    )
    const truncated = rows.length > rowLimit
    if (truncated) rows.length = rowLimit
    await cursor.close()

    const fields = (result?.fields ?? []).map((f) => ({
      name: f.name,
      type: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID),
      numeric: NUMERIC_TYPES.has(f.dataTypeID)
    }))
    return {
      statement: statement.text,
      command: result?.command || leadingKeyword(statement.text),
      rowCount: truncated ? null : (result?.rowCount ?? null),
      fields,
      rows,
      truncated,
      durationMs: performance.now() - started
    }
  }

  /**
   * Streams every row of a read-only statement into a CSV file. Runs on its own read-only
   * connection in batches, so a big table never sits in memory or blocks the query's session.
   */
  async exportCsv(target: Target, statement: string, variables: VariableValues, file: string): Promise<number> {
    const bound = bindVariables(statement, variables)
    if (bound.missing.length) throw new Error(`No value for ${bound.missing.join(', ')}.`)
    const client = await this.pool(target).connect()
    const out = createWriteStream(file)
    let count = 0
    try {
      await client.query('BEGIN READ ONLY')
      const cursor = client.query(new Cursor<(string | null)[]>(bound.text, undefined, { rowMode: 'array', types: rawTypes }))
      let bools: boolean[] | null = null
      for (;;) {
        const { rows, result } = await readBatch(cursor, EXPORT_BATCH)
        if (!bools) {
          const fields = result?.fields ?? []
          bools = fields.map((f) => f.dataTypeID === BOOL_TYPE)
          await write(out, fields.map((f) => csvCell(f.name)).join(',') + '\n')
        }
        let chunk = ''
        for (const row of rows) {
          chunk +=
            row
              .map((v, i) => (v === null ? '' : csvCell(bools![i] ? (v === 't' ? 'true' : v === 'f' ? 'false' : v) : v)))
              .join(',') + '\n'
        }
        if (chunk) await write(out, chunk)
        count += rows.length
        if (rows.length < EXPORT_BATCH) break
      }
      await cursor.close()
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
      await new Promise<void>((resolve) => out.end(resolve))
    }
    return count
  }

  /** Databases with an open (or failed) transaction, one entry per query. */
  openTransactions(): Target[] {
    return [...this.sessions.values()].filter((s) => s.txStatus !== 'idle').map((s) => s.target)
  }

  async cancel(tabId: string): Promise<void> {
    const s = this.sessions.get(tabId)
    if (!s?.busy) return
    const pid = (s.client as unknown as { processID: number }).processID
    await this.pool(s.target).query('SELECT pg_cancel_backend($1)', [pid])
  }

  async closeSession(tabId: string): Promise<void> {
    const s = this.sessions.get(tabId)
    if (!s) return
    clearTimeout(s.idleTimer)
    this.sessions.delete(tabId)
    await s.client.end().catch(() => {})
  }

  async closeAll(): Promise<void> {
    const ids = new Set([...this.pools.keys()].map((k) => k.slice(0, k.indexOf('/'))))
    for (const tabId of [...this.sessions.keys()]) await this.closeSession(tabId)
    await Promise.all([...ids].map((id) => this.disconnect(id)))
  }
}
