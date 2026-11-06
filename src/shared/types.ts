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
  /** Attribute number (pg_attribute.attnum); result fields point at columns by it. */
  num: number
  type: string
  nullable: boolean
  default: string | null
  pk: boolean
  fk: ForeignKeyRef | null
}

export type RelationKind = 'table' | 'partitioned table' | 'view' | 'materialized view' | 'foreign table'

export interface TableInfo {
  oid: number
  schema: string
  name: string
  kind: RelationKind
  estimatedRows: number | null
  columns: ColumnInfo[]
}

/** A relation's name only: what the sidebar filter searches in databases whose schema hasn't loaded. */
export interface TableName {
  schema: string
  name: string
  kind: RelationKind
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
  /** OID and attribute number of the table column behind the field; 0 for computed values. */
  table: number
  column: number
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
  /** Azure resource URL, deployment name and API version; empty means the AI_FOUNDRY_* value applies. */
  aiEndpoint: string
  aiDeployment: string
  aiApiVersion: string
  /** What applies when a field above is empty: the AI_FOUNDRY_* variables, or the default API version. */
  aiFallback: { endpoint: string; deployment: string; apiVersion: string }
  /** Where the Azure API key comes from, if anywhere; 'unreadable' is a saved key this build can't decrypt. */
  aiKeySource: 'settings' | 'env' | 'unreadable' | null
  /** Endpoint, deployment and key are all set. */
  aiReady: boolean
  rowLimit: number
  theme: Theme
  environmentVariables: EnvironmentVariables
}

export interface SettingsInput {
  aiEnabled?: boolean
  aiEndpoint?: string
  aiDeployment?: string
  aiApiVersion?: string
  rowLimit?: number
  theme?: Theme
  environmentVariables?: EnvironmentVariables
  /** New Azure API key; undefined keeps the stored one, null or '' clears it. */
  aiApiKey?: string | null
}

export interface CompletionRequest {
  requestId: string
  target: Target
  prefix: string
  suffix: string
}

/** The Azure OpenAI API version used when neither Settings nor AI_FOUNDRY_API_VERSION sets one. */
export const DEFAULT_AI_API_VERSION = '2025-04-01-preview'

/** One turn of the AI chat that writes queries. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatRequest {
  requestId: string
  target: Target
  messages: ChatMessage[]
  /** The editor text, so "fix this" or "add a filter" work on the current query. */
  sql: string
  /** The last run's error message, if it failed (the message only, not its detail). */
  error?: string
}

export type TestResult = { ok: true; message: string } | { ok: false; message: string }
