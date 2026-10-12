export type SslMode = 'disable' | 'require' | 'verify-full'

export type Environment = 'local' | 'development' | 'test' | 'production'

export const ENVIRONMENTS: { id: Environment; label: string; short: string; color: string }[] = [
  { id: 'local', label: 'Local', short: 'LOCAL', color: '#94a3b8' },
  { id: 'development', label: 'Development', short: 'DEV', color: '#22c55e' },
  { id: 'test', label: 'Test', short: 'TEST', color: '#f59e0b' },
  { id: 'production', label: 'Production', short: 'PROD', color: '#ef4444' }
]

export interface ConnectionConfig {
  id: string
  name: string
  color: string
  host: string
  port: number
  user: string
  database: string
  ssl: SslMode
  /** Marks every database on this connection, unless a database has its own entry below. */
  environment?: Environment
  /** Per-database marks; 'none' clears the connection-wide one for that database. */
  databaseEnvironments?: Record<string, Environment | 'none'>
  hasPassword: boolean
}

export interface ConnectionInput {
  id?: string
  name: string
  color: string
  host: string
  port: number
  user: string
  database: string
  ssl: SslMode
  environment?: Environment
  databaseEnvironments?: Record<string, Environment | 'none'>
  /** New password; undefined keeps the stored one, null or '' clears it. */
  password?: string | null
}

/** The environment a database is marked with, if any. */
export function environmentOf(connection: Pick<ConnectionConfig, 'environment' | 'databaseEnvironments'> | undefined, database: string) {
  const own = connection?.databaseEnvironments?.[database]
  const id = own === 'none' ? undefined : (own ?? connection?.environment)
  return ENVIRONMENTS.find((e) => e.id === id) ?? null
}

// Staging was renamed to Test. Files saved before that still say 'staging'.
const renamed = <T extends string | undefined>(id: T): T => (id === 'staging' ? 'test' : id) as T

export function withRenamedEnvironments<T extends Pick<ConnectionConfig, 'environment' | 'databaseEnvironments'>>(connection: T): T {
  const marks = connection.databaseEnvironments
  return {
    ...connection,
    environment: renamed(connection.environment),
    databaseEnvironments: marks && Object.fromEntries(Object.entries(marks).map(([db, id]) => [db, renamed(id)]))
  }
}

export function withRenamedEnvironmentVariables(vars: EnvironmentVariables): EnvironmentVariables {
  const { staging, ...rest } = vars as EnvironmentVariables & { staging?: Record<string, string> }
  return staging ? { ...rest, test: { ...staging, ...rest.test } } : vars
}

/** Fields that change how we connect; editing anything else keeps open sessions. */
export const connectionChanged = (a: ConnectionInput, b: ConnectionInput) =>
  a.host !== b.host || a.port !== b.port || a.user !== b.user || a.database !== b.database || a.ssl !== b.ssl

export interface Target {
  connectionId: string
  database: string
}

export const targetKey = (t: Target) => `${t.connectionId}/${t.database}`

export interface ServerInfo {
  version: string
  databases: string[]
}

export interface ForeignKeyRef {
  schema: string
  table: string
  column: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  default: string | null
  pk: boolean
  fk: ForeignKeyRef | null
}

export type RelationKind = 'table' | 'partitioned table' | 'view' | 'materialized view' | 'foreign table'

export interface TableInfo {
  schema: string
  name: string
  kind: RelationKind
  estimatedRows: number | null
  columns: ColumnInfo[]
}

export interface EnumInfo {
  schema: string
  name: string
  labels: string[]
}

export interface SchemaInfo {
  tables: TableInfo[]
  enums: EnumInfo[]
}

export interface ResultField {
  name: string
  type: string
  numeric: boolean
}

export type Cell = string | null

export interface StatementResult {
  statement: string
  command: string
  /** Rows affected or returned; null for DDL and when the result was cut off at the row limit. */
  rowCount: number | null
  fields: ResultField[]
  rows: Cell[][]
  truncated: boolean
  durationMs: number
}

export interface QueryError {
  message: string
  detail?: string
  hint?: string
  code?: string
  /** Absolute offset of the error in the submitted SQL. */
  position?: number
}

export type TxStatus = 'idle' | 'transaction' | 'failed'

export interface RunOptions {
  /** Run with default_transaction_read_only on, so the server refuses writes. */
  readOnly: boolean
}

export interface RunResponse {
  results: StatementResult[]
  error: QueryError | null
  notices: string[]
  txStatus: TxStatus
  durationMs: number
}

export type Theme = 'system' | 'dark' | 'light'

/**
 * Query variable values per environment: { production: { tenant_id: 'acme' } }. Values under
 * 'global' apply to every database, marked with an environment or not.
 */
export type EnvironmentVariables = Partial<Record<Environment | 'global', Record<string, string>>>

/** The values a database inherits: global ones, overridden by its environment's own. */
export function environmentValues(vars: EnvironmentVariables | undefined, environment: Environment | undefined) {
  return { ...vars?.global, ...(environment ? vars?.[environment] : undefined) }
}

export interface Settings {
  aiEnabled: boolean
  aiModel: string
  /** Where the Anthropic key comes from, if anywhere. */
  apiKeySource: 'settings' | 'env' | null
  rowLimit: number
  theme: Theme
  environmentVariables: EnvironmentVariables
}

export interface SettingsInput {
  aiEnabled?: boolean
  aiModel?: string
  rowLimit?: number
  theme?: Theme
  environmentVariables?: EnvironmentVariables
  /** New key; undefined keeps the stored one, null or '' clears it. */
  apiKey?: string | null
}

export interface CompletionRequest {
  requestId: string
  target: Target
  prefix: string
  suffix: string
}

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' }
] as const

export type TestResult = { ok: true; message: string } | { ok: false; message: string }
