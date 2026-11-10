import type {
  ChatRequest,
  CompletionRequest,
  ConnectionConfig,
  ConnectionInput,
  RunOptions,
  RunResponse,
  SchemaInfo,
  ServerInfo,
  Settings,
  SettingsInput,
  TableName,
  Target,
  TestResult
} from './types'
import type { ChangeStatement } from './changes'
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
  /** Only the table names, on a connection that closes right after, for searching unopened databases. */
  listTableNames(target: Target): Promise<TableName[]>
  runQuery(
    tabId: string,
    target: Target,
    sql: string,
    rowLimit: number,
    variables: VariableValues,
    options: RunOptions
  ): Promise<RunResponse>
  /** Saves changes made in the grid on the tab's session, all or nothing. */
  applyChanges(tabId: string, target: Target, changes: ChangeStatement[]): Promise<RunResponse>
  cancelQuery(tabId: string): Promise<void>
  closeSession(tabId: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(input: SettingsInput): Promise<Settings>
  testAi(): Promise<TestResult>
  complete(request: CompletionRequest): Promise<string | null>
  cancelCompletion(requestId: string): Promise<void>
  /** Answers the chat's last message; the text also streams in through `onChatDelta`. */
  chat(request: ChatRequest): Promise<string>
  /** Stops a chat answer; `chat` then resolves with the text so far. */
  cancelChat(requestId: string): Promise<void>
  copyText(text: string): Promise<void>
  readClipboard(): Promise<string>
  /** Asks where to save, then writes the text there. Null if the user cancelled. */
  saveFile(defaultName: string, content: string): Promise<string | null>
  /** Asks where to save, then streams every row of a read-only statement to CSV. */
  exportQuery(
    target: Target,
    statement: string,
    variables: VariableValues,
    defaultName: string
  ): Promise<{ path: string; rows: number } | null>
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
  'listTableNames',
  'runQuery',
  'applyChanges',
  'cancelQuery',
  'closeSession',
  'getSettings',
  'saveSettings',
  'testAi',
  'complete',
  'cancelCompletion',
  'chat',
  'cancelChat',
  'copyText',
  'readClipboard',
  'saveFile',
  'exportQuery',
  'loadWorkspace',
  'saveWorkspace',
  'setTitleBarColors'
]

export interface Bridge {
  api: Api
  platform: string
  /** Synchronous save for the window's last moments, when an async call may never finish. */
  saveWorkspaceNow(json: string): void
  /** Text of chat answers as it streams in. Returns a function that stops listening. */
  onChatDelta(listener: (requestId: string, delta: string) => void): () => void
}

/** Main to renderer: (requestId, delta) for each piece of a chat answer. */
export const CHAT_DELTA = 'chatDelta'

export const SAVE_WORKSPACE_NOW = 'saveWorkspaceNow'
