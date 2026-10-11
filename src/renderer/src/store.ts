import { create } from 'zustand'
import { isReadOnly, leadingKeyword, qualifiedName, splitStatements } from '@shared/sql'
import {
  bindVariables,
  findPlaceholders,
  isMissing,
  resolveVariables,
  uniqueVariables,
  type VariableValues
} from '@shared/variables'
import {
  connectionChanged,
  environmentOf,
  targetKey,
  type Environment,
  type ConnectionConfig,
  type ConnectionInput,
  type RunResponse,
  type SchemaInfo,
  type ServerInfo,
  type Settings,
  type SettingsInput,
  type TableInfo,
  type Target
} from '@shared/types'
import { api } from './api'
import { summarize } from './lib/format'

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface ConnState {
  status: ConnStatus
  error?: string
  server?: ServerInfo
}

export interface SchemaState {
  status: 'loading' | 'ready' | 'error'
  data?: SchemaInfo
  error?: string
}

export interface Tab {
  id: string
  /** Query entries hold an editor; diagram entries draw the target database's tables. */
  kind?: 'query' | 'diagram'
  /** Shown in the history; empty means "use the first line of the SQL". */
  title: string
  createdAt: number
  /** Last time the entry was created, run or refilled; the history is sorted by this. */
  touchedAt: number
  lastRun?: { at: number; summary: string; ok: boolean }
  sql: string
  target: Target | null
  /** Values for :name and $1 placeholders, keyed "name" / "$1". */
  variables?: VariableValues
  // Runtime only, not persisted:
  /** Keys of variables the last run attempt needed but had no value for. */
  missingVariables?: string[]
  /** When a run was last blocked by missing variables; the variables bar focuses the first one then. */
  blockedAt?: number
  running?: boolean
  runStartedAt?: number
  /** Offset in the editor where the submitted SQL started, to map error positions. */
  runOffset?: number
  /** The SQL of the last run, to retry it with writes allowed. */
  runSql?: string
  response?: RunResponse
  activeResult?: number
}

export interface PendingRun {
  tabId: string
  sql: string
  offset: number
  /** The statements to confirm, with variable values filled in. */
  writes: string[]
  target: Target
  /** Set when Postgres refused a write that looked like a read; holds its error message. */
  blocked?: string
}

export type DialogState = { type: 'connection'; id?: string } | { type: 'settings' } | { type: 'envVariables'; suggest?: string[] } | null

export interface AiState {
  status: 'idle' | 'thinking' | 'error'
  error?: string
}

type SavedTab = Pick<Tab, 'id' | 'kind' | 'title' | 'sql' | 'target' | 'variables' | 'createdAt' | 'touchedAt' | 'lastRun'>

interface Workspace {
  tabs: SavedTab[]
  activeTabId: string | null
  /** The database you are in: the history shows its entries and new queries go to it. */
  currentTarget: Target | null
  expanded: Record<string, boolean>
  sidebarWidth: number
  historyWidth: number
  historyOpen: boolean
  editorRatio: number
}

interface State extends Workspace {
  ready: boolean
  connections: ConnectionConfig[]
  conn: Record<string, ConnState>
  schemas: Record<string, SchemaState>
  tabs: Tab[]
  settings: Settings | null
  filter: string
  dialog: DialogState
  ai: AiState
  /** A production run waiting for the user to confirm its writes. */
  pendingRun: PendingRun | null

  init(): Promise<void>
  saveConnection(input: ConnectionInput): Promise<ConnectionConfig>
  deleteConnection(id: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  loadSchema(target: Target, refresh?: boolean): Promise<void>
  newTab(opts?: { target?: Target | null; sql?: string; title?: string }): string
  /** Removes an entry from the history; restoreDeleted() brings back the last one. */
  deleteTab(id: string): void
  restoreDeleted(): void
  renameTab(id: string, title: string): void
  /** The most recently deleted entry, for the undo toast. */
  lastDeleted: { tab: Tab; at: number } | null
  setActiveTab(id: string): void
  /** Enter a database: its most recent query opens, or a blank one if it has none. */
  selectDatabase(target: Target): void
  /** Point an entry at another database; it moves to that database's history. */
  moveTab(id: string, target: Target): void
  cycleTab(step: number): void
  updateTab(id: string, patch: Partial<Tab>): void
  /** undefined clears the tab's value so the environment's value applies. */
  setVariable(tabId: string, key: string, value: string | null | undefined): void
  /** Runs SQL; on production, statements that write wait for confirmRun() unless confirmed. */
  run(tabId: string, sql: string, offset: number, confirmed?: boolean): Promise<void>
  confirmRun(): void
  cancelRun(): void
  /** After Postgres blocked a write on a read-only production session, ask to run it again with writes allowed. */
  retryWithWrites(tabId: string): void
  setDatabaseEnvironment(connectionId: string, database: string, environment: Environment | 'none' | null): Promise<void>
  cancel(tabId: string): Promise<void>
  openTable(target: Target, table: TableInfo): void
  openDiagram(target: Target): void
  toggle(key: string, open?: boolean): void
  setFilter(filter: string): void
  setDialog(dialog: DialogState): void
  saveSettings(input: SettingsInput): Promise<Settings>
  setAi(ai: AiState): void
  setLayout(patch: Partial<Pick<Workspace, 'sidebarWidth' | 'editorRatio' | 'historyWidth' | 'historyOpen'>>): void
}

const WORKSPACE_KEY = 'slate:workspace'

function loadWorkspace(): Workspace {
  const fallback: Workspace = {
    tabs: [],
    activeTabId: null,
    currentTarget: null,
    expanded: {},
    sidebarWidth: 264,
    historyWidth: 248,
    historyOpen: true,
    editorRatio: 0.45
  }
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY)
    const saved = raw ? { ...fallback, ...(JSON.parse(raw) as Partial<Workspace>) } : fallback
    // Entries saved before the history existed: keep their order, drop "Query 3"-style names.
    const now = Date.now()
    saved.tabs = saved.tabs.map((t, i) => ({
      ...t,
      title: /^Query \d+$/.test(t.title) ? '' : t.title,
      createdAt: t.createdAt ?? now - (saved.tabs.length - i) * 1000,
      touchedAt: t.touchedAt ?? now - (saved.tabs.length - i) * 1000
    }))
    return saved
  } catch {
    return fallback
  }
}

/** History order: most recently touched first. */
export const historyOrder = (tabs: Tab[]) => [...tabs].sort((a, b) => b.touchedAt - a.touchedAt)

const sameTarget = (a: Target | null, b: Target | null) => (a && b ? targetKey(a) === targetKey(b) : a === b)

/** The history of one database, most recent first. */
export const historyFor = (tabs: Tab[], target: Target | null) => historyOrder(tabs.filter((t) => sameTarget(t.target, target)))

/** An entry nobody has typed into, named or run: dropped once you leave it. */
const isBlank = (t: Tab) => t.kind !== 'diagram' && !t.title && !t.sql.trim() && !t.lastRun && !t.running

const withoutBlanks = (tabs: Tab[], keep: string | null) => tabs.filter((t) => t.id === keep || !isBlank(t))

/** The entry's name: what the user called it, else the first line of its SQL. */
export function displayTitle(tab: Pick<Tab, 'title' | 'sql' | 'kind'>): string {
  if (tab.title) return tab.title
  const line = tab.sql
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && l !== '--')
  if (!line) return 'Untitled query'
  return line.replace(/^--\s*/, '').replace(/\s+/g, ' ').slice(0, 80)
}

const uid = () => Math.random().toString(36).slice(2, 10)

const SCHEMA_CHANGING = new Set(['CREATE', 'ALTER', 'DROP', 'COMMIT', 'END', 'COMMENT', 'TRUNCATE'])

const initial = loadWorkspace()

export const useStore = create<State>((set, get) => ({
  ...initial,
  tabs: initial.tabs,
  ready: false,
  connections: [],
  conn: {},
  schemas: {},
  settings: null,
  filter: '',
  dialog: null,
  ai: { status: 'idle' },
  pendingRun: null,
  lastDeleted: null,

  async init() {
    const [connections, settings] = await Promise.all([api.listConnections(), api.getSettings()])
    // Drop tabs that point at connections which no longer exist.
    const ids = new Set(connections.map((c) => c.id))
    const tabs = get().tabs.map((t) => (t.target && !ids.has(t.target.connectionId) ? { ...t, target: null } : t))
    const active = tabs.find((t) => t.id === get().activeTabId)
    let currentTarget = get().currentTarget
    if (currentTarget && !ids.has(currentTarget.connectionId)) currentTarget = null
    currentTarget ??= active?.target ?? null
    set({ connections, settings, tabs, currentTarget, ready: true })
    if (currentTarget) get().selectDatabase(currentTarget)
    else if (connections.length > 0) get().selectDatabase({ connectionId: connections[0].id, database: connections[0].database })
  },

  async saveConnection(input) {
    const previous = get().connections.find((c) => c.id === input.id)
    const saved = await api.saveConnection(input)
    // Only new connection details mean reconnecting; a rename or new environment mark doesn't.
    const reconnect = !previous || connectionChanged(previous, input) || input.password !== undefined
    set((s) => {
      const exists = s.connections.some((c) => c.id === saved.id)
      const conn = { ...s.conn }
      if (reconnect) delete conn[saved.id]
      return {
        connections: exists ? s.connections.map((c) => (c.id === saved.id ? saved : c)) : [...s.connections, saved],
        conn
      }
    })
    if (!previous || !get().currentTarget) get().selectDatabase({ connectionId: saved.id, database: saved.database })
    if (reconnect) void get().connect(saved.id)
    return saved
  },

  async setDatabaseEnvironment(connectionId, database, environment) {
    const connection = get().connections.find((c) => c.id === connectionId)
    if (!connection) return
    const marks = { ...connection.databaseEnvironments }
    if (environment === null) delete marks[database]
    else marks[database] = environment
    const { hasPassword: _, ...input } = connection
    await get().saveConnection({ ...input, databaseEnvironments: marks })
  },

  async deleteConnection(id) {
    await api.deleteConnection(id)
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      tabs: s.tabs.map((t) => (t.target?.connectionId === id ? { ...t, target: null } : t)),
      currentTarget: s.currentTarget?.connectionId === id ? null : s.currentTarget
    }))
  },

  async connect(id) {
    const current = get().conn[id]
    if (current?.status === 'connecting' || current?.status === 'connected') return
    set((s) => ({ conn: { ...s.conn, [id]: { status: 'connecting' } } }))
    try {
      const server = await api.connect(id)
      set((s) => ({ conn: { ...s.conn, [id]: { status: 'connected', server } } }))
      const config = get().connections.find((c) => c.id === id)
      if (config) {
        get().toggle(`c:${id}`, true)
        get().toggle(`d:${id}/${config.database}`, true)
        void get().loadSchema({ connectionId: id, database: config.database })
      }
    } catch (e) {
      set((s) => ({ conn: { ...s.conn, [id]: { status: 'error', error: (e as Error).message } } }))
    }
  },

  async disconnect(id) {
    await api.disconnect(id)
    set((s) => {
      const schemas = Object.fromEntries(Object.entries(s.schemas).filter(([k]) => !k.startsWith(`${id}/`)))
      return { conn: { ...s.conn, [id]: { status: 'idle' } }, schemas }
    })
  },

  async loadSchema(target, refresh = false) {
    const key = targetKey(target)
    const existing = get().schemas[key]
    if (!refresh && existing && existing.status !== 'error') return
    if (get().conn[target.connectionId]?.status !== 'connected') {
      await get().connect(target.connectionId)
      if (get().conn[target.connectionId]?.status !== 'connected') return
    }
    set((s) => ({ schemas: { ...s.schemas, [key]: { status: 'loading', data: existing?.data } } }))
    try {
      const data = await api.getSchema(target, refresh)
      set((s) => ({ schemas: { ...s.schemas, [key]: { status: 'ready', data } } }))
    } catch (e) {
      set((s) => ({ schemas: { ...s.schemas, [key]: { status: 'error', error: (e as Error).message } } }))
    }
  },

  newTab(opts = {}) {
    const fallback = get().connections[0]
    const target =
      opts.target !== undefined
        ? opts.target
        : (get().currentTarget ?? (fallback ? { connectionId: fallback.id, database: fallback.database } : null))
    const now = Date.now()
    const tab: Tab = { id: uid(), title: opts.title ?? '', sql: opts.sql ?? '', target, createdAt: now, touchedAt: now }
    set((s) => ({ tabs: [...withoutBlanks(s.tabs, null), tab], activeTabId: tab.id, currentTarget: target }))
    return tab.id
  },

  deleteTab(id) {
    void api.closeSession(id)
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id)
      if (!tab) return {}
      const ordered = historyFor(s.tabs, tab.target)
      const index = ordered.findIndex((t) => t.id === id)
      const rest = ordered.filter((t) => t.id !== id)
      const activeTabId = s.activeTabId === id ? (rest[Math.min(index, rest.length - 1)]?.id ?? null) : s.activeTabId
      return {
        tabs: s.tabs.filter((t) => t.id !== id),
        activeTabId,
        lastDeleted: { tab: { ...tab, running: false, response: undefined }, at: Date.now() }
      }
    })
    // Deleting the last query of a database leaves a blank one to type into.
    const current = get().currentTarget
    if (!get().activeTabId && current) get().newTab({ target: current })
  },

  restoreDeleted() {
    const deleted = get().lastDeleted
    if (!deleted) return
    set((s) => ({
      tabs: [...withoutBlanks(s.tabs, null), deleted.tab],
      activeTabId: deleted.tab.id,
      currentTarget: deleted.tab.target,
      lastDeleted: null
    }))
  },

  renameTab(id, title) {
    get().updateTab(id, { title: title.trim() })
  },

  setActiveTab(id) {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id)
      if (!tab) return {}
      return { activeTabId: id, currentTarget: tab.target, tabs: withoutBlanks(s.tabs, id) }
    })
  },

  selectDatabase(target) {
    const current = get().tabs.find((t) => t.id === get().activeTabId)
    if (current && sameTarget(current.target, target)) return set({ currentTarget: target })
    const latest = historyFor(get().tabs, target)[0]
    if (latest) get().setActiveTab(latest.id)
    else get().newTab({ target })
  },

  moveTab(id, target) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, target, response: undefined, touchedAt: Date.now() } : t)),
      currentTarget: s.activeTabId === id ? target : s.currentTarget
    }))
  },

  cycleTab(step) {
    const tabs = historyFor(get().tabs, get().currentTarget)
    if (tabs.length < 2) return
    const index = tabs.findIndex((t) => t.id === get().activeTabId)
    set({ activeTabId: tabs[(index + step + tabs.length) % tabs.length].id })
  },

  updateTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  },

  setVariable(tabId, key, value) {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const variables = { ...t.variables }
        // undefined drops the tab's own value, so the environment's applies again.
        if (value === undefined) delete variables[key]
        else variables[key] = value
        return { ...t, variables, missingVariables: t.missingVariables?.filter((k) => k !== key) }
      })
    }))
  },

  confirmRun() {
    const pending = get().pendingRun
    set({ pendingRun: null })
    if (pending) void get().run(pending.tabId, pending.sql, pending.offset, true)
  },

  cancelRun() {
    set({ pendingRun: null })
  },

  retryWithWrites(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.target || !tab.runSql) return
    const environment = environmentOf(get().connections.find((c) => c.id === tab.target!.connectionId), tab.target.database)
    const { values } = resolveVariables(
      tab.variables,
      environment ? get().settings?.environmentVariables[environment.id] : undefined
    )
    set({
      pendingRun: {
        tabId,
        sql: tab.runSql,
        offset: tab.runOffset ?? 0,
        writes: splitStatements(tab.runSql).map((st) => bindVariables(st.text, values).text),
        target: tab.target,
        blocked: tab.response?.error?.message
      }
    })
  },

  async run(tabId, sql, offset, confirmed = false) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.target || tab.running || !sql.trim()) return
    const target = tab.target
    const environment = environmentOf(get().connections.find((c) => c.id === target.connectionId), target.database)
    const { values: variables } = resolveVariables(
      tab.variables,
      environment ? get().settings?.environmentVariables[environment.id] : undefined
    )

    // Stop before running anything if a variable this SQL uses has no value yet.
    const missing = uniqueVariables(findPlaceholders(sql)).filter((p) => isMissing(variables[p.key]))
    if (missing.length) {
      const labels = missing.map((p) => p.label).join(', ')
      const where = environment
        ? `Fill it in above the editor, or set it for ${environment.label} under Environment variables.`
        : 'Fill it in above the editor.'
      get().updateTab(tabId, {
        missingVariables: missing.map((p) => p.key),
        blockedAt: Date.now(),
        runOffset: offset,
        activeResult: 0,
        response: {
          results: [],
          error: { message: `No value for ${labels}. ${where}`, position: missing[0].from },
          notices: [],
          txStatus: tab.response?.txStatus ?? 'idle',
          durationMs: 0
        }
      })
      return
    }

    if (environment?.id === 'production' && !confirmed) {
      const writes = splitStatements(sql).filter((st) => !isReadOnly(st.text))
      if (writes.length) {
        // Show the statements with their variable values filled in: that is what will run.
        const shown = writes.map((w) => bindVariables(w.text, variables).text)
        set({ pendingRun: { tabId, sql, offset, writes: shown, target } })
        return
      }
    }

    if (get().conn[target.connectionId]?.status !== 'connected') void get().connect(target.connectionId)
    get().updateTab(tabId, { running: true, runStartedAt: Date.now(), runOffset: offset, runSql: sql, missingVariables: [] })
    const rowLimit = get().settings?.rowLimit ?? 1000
    let response: RunResponse
    try {
      // Production sessions refuse writes unless this run's writes were confirmed.
      const readOnly = environment?.id === 'production' && !confirmed
      response = await api.runQuery(tabId, target, sql, rowLimit, variables, { readOnly })
    } catch (e) {
      response = { results: [], error: { message: (e as Error).message }, notices: [], txStatus: 'idle', durationMs: 0 }
    }
    // Show the last result that has rows; DDL before a SELECT shouldn't hide it.
    let activeResult = response.results.length - 1
    for (let i = response.results.length - 1; i >= 0; i--) {
      if (response.results[i].fields.length) {
        activeResult = i
        break
      }
    }
    const shown = response.results[activeResult]
    get().updateTab(tabId, {
      running: false,
      response,
      activeResult: response.error ? response.results.length : Math.max(0, activeResult),
      touchedAt: Date.now(),
      lastRun: {
        at: Date.now(),
        ok: !response.error,
        summary: response.error ? 'Error' : shown ? summarize(shown) : 'Done'
      }
    })
    if (response.results.some((r) => SCHEMA_CHANGING.has(leadingKeyword(r.statement)))) {
      void get().loadSchema(target, true)
    }
  },

  async cancel(tabId) {
    await api.cancelQuery(tabId)
  },

  openTable(target, table) {
    const sql = `SELECT * FROM ${qualifiedName(table.schema, table.name)} LIMIT 100;`
    const active = get().tabs.find((t) => t.id === get().activeTabId)
    let id: string
    if (active && active.kind !== 'diagram' && !active.sql.trim() && !active.running) {
      id = active.id
      get().updateTab(id, { sql, target, title: table.name, touchedAt: Date.now() })
      set({ currentTarget: target })
    } else {
      id = get().newTab({ target, sql, title: table.name })
    }
    void get().run(id, sql, 0)
  },

  openDiagram(target) {
    const existing = get().tabs.find((t) => t.kind === 'diagram' && t.target && targetKey(t.target) === targetKey(target))
    if (existing) return get().setActiveTab(existing.id)
    const now = Date.now()
    const tab: Tab = {
      id: uid(),
      kind: 'diagram',
      title: `${target.database} diagram`,
      sql: '',
      target,
      createdAt: now,
      touchedAt: now
    }
    set((s) => ({ tabs: [...withoutBlanks(s.tabs, null), tab], activeTabId: tab.id, currentTarget: target }))
  },

  toggle(key, open) {
    set((s) => ({ expanded: { ...s.expanded, [key]: open ?? !s.expanded[key] } }))
  },

  setFilter(filter) {
    set({ filter })
  },

  setDialog(dialog) {
    set({ dialog })
  },

  async saveSettings(input) {
    const settings = await api.saveSettings(input)
    set({ settings })
    return settings
  },

  setAi(ai) {
    set({ ai })
  },

  setLayout(patch) {
    set(patch)
  }
}))

// Persist the workspace (tabs, layout, tree state) whenever it changes.
let saveTimer: ReturnType<typeof setTimeout> | undefined
useStore.subscribe((s) => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const workspace: Workspace = {
      tabs: s.tabs.map(({ id, kind, title, sql, target, variables, createdAt, touchedAt, lastRun }) => ({
        id,
        kind,
        title,
        sql,
        target,
        variables,
        createdAt,
        touchedAt,
        lastRun
      })),
      activeTabId: s.activeTabId,
      currentTarget: s.currentTarget,
      expanded: s.expanded,
      sidebarWidth: s.sidebarWidth,
      historyWidth: s.historyWidth,
      historyOpen: s.historyOpen,
      editorRatio: s.editorRatio
    }
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace))
    } catch {
      // Storage full or unavailable; the workspace just won't be restored.
    }
  }, 300)
})

export const activeTab = (s: State) => s.tabs.find((t) => t.id === s.activeTabId) ?? null
