import type {
  CompletionRequest,
  ConnectionConfig,
  ConnectionInput,
  RunOptions,
  RunResponse,
  SchemaInfo,
  ServerInfo,
  Settings,
  SettingsInput,
  Target,
  TestResult
} from './types'
import type { VariableValues } from './variables'

/** Everything the renderer can ask the main process to do. Channel names equal method names. */
export interface Api {
  listConnections(): Promise<ConnectionConfig[]>
  saveConnection(input: ConnectionInput): Promise<ConnectionConfig>
  deleteConnection(id: string): Promise<void>
  testConnection(input: ConnectionInput): Promise<TestResult>
  connect(id: string): Promise<ServerInfo>
  disconnect(id: string): Promise<void>
  getSchema(target: Target, refresh: boolean): Promise<SchemaInfo>
  runQuery(
    tabId: string,
    target: Target,
    sql: string,
    rowLimit: number,
    variables: VariableValues,
    options: RunOptions
  ): Promise<RunResponse>
  cancelQuery(tabId: string): Promise<void>
  closeSession(tabId: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(input: SettingsInput): Promise<Settings>
  testAi(): Promise<TestResult>
  complete(request: CompletionRequest): Promise<string | null>
  cancelCompletion(requestId: string): Promise<void>
  copyText(text: string): Promise<void>
  /** The saved workspace (history and layout) as JSON, or null on first start. */
  loadWorkspace(): Promise<string | null>
  saveWorkspace(json: string): Promise<void>
  setTitleBarColors(colors: { background: string; symbols: string }): Promise<void>
}

export const API_METHODS: (keyof Api)[] = [
  'listConnections',
  'saveConnection',
  'deleteConnection',
  'testConnection',
  'connect',
  'disconnect',
  'getSchema',
  'runQuery',
  'cancelQuery',
  'closeSession',
  'getSettings',
  'saveSettings',
  'testAi',
  'complete',
  'cancelCompletion',
  'copyText',
  'loadWorkspace',
  'saveWorkspace',
  'setTitleBarColors'
]

export interface Bridge {
  api: Api
  platform: string
  /** Synchronous save for the window's last moments, when an async call may never finish. */
  saveWorkspaceNow(json: string): void
}

export const SAVE_WORKSPACE_NOW = 'saveWorkspaceNow'
