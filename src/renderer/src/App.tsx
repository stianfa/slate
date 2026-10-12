import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { api, modKey } from './api'
import { CommandPalette } from './components/CommandPalette'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ConfirmRunDialog } from './components/ConfirmRunDialog'
import { ConnectionDialog } from './components/ConnectionDialog'
import { DiagramView } from './components/DiagramView'
import { EnvVariablesDialog } from './components/EnvVariablesDialog'
import { HistoryPane } from './components/HistoryPane'
import { editorBridge } from './components/Editor'
import { QueryPane } from './components/QueryPane'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Kbd, Logo } from './components/ui'
import { SaveErrorToast, Toast, UndoToast } from './components/UndoToast'
import { activeTab, useStore } from './store'

function useTheme() {
  const theme = useStore((s) => s.settings?.theme ?? 'system')
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      const css = getComputedStyle(document.documentElement)
      void api.setTitleBarColors({
        background: css.getPropertyValue('--bg-chrome').trim(),
        symbols: css.getPropertyValue('--text-muted').trim()
      })
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

// Text fields keep Cmd+Backspace for deleting to the start of the line.
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null)

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const s = useStore.getState()
      // Skip keys something else already handled, like Cmd+Shift+C copying from the grid.
      if (!mod || e.defaultPrevented) return
      const key = e.key.toLowerCase()
      // Keys that change the query behind a dialog or the palette shouldn't reach it.
      const blocked = Boolean(s.dialog || s.confirmation || s.pendingRun || s.paletteOpen)
      const tab = activeTab(s)
      if (key === 'k' || (key === 'p' && e.shiftKey)) {
        e.preventDefault()
        s.setPalette(!s.paletteOpen)
      } else if (key === 't' && !e.shiftKey) {
        e.preventDefault()
        s.newTab()
      } else if (key === 'tab') {
        e.preventDefault()
        s.cycleTab(e.shiftKey ? -1 : 1)
      } else if (key === ',') {
        e.preventDefault()
        s.setDialog({ type: 'settings' })
      } else if (key === 'enter' && !(e.target as HTMLElement).closest?.('.cm-editor')) {
        // Run from anywhere, e.g. while the results grid has focus.
        e.preventDefault()
        editorBridge.run(e.shiftKey ? 'all' : 'smart')
      } else if (key === '.') {
        e.preventDefault()
        if (tab?.running) void s.cancel(tab.id)
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault()
        s.setLayout({ historyOpen: !s.historyOpen })
      } else if (key === 'r' && !e.shiftKey) {
        e.preventDefault()
        if (s.currentTarget) void s.loadSchema(s.currentTarget, true)
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault()
        const filter = document.querySelector<HTMLInputElement>('.sidebar .sidebar-search input')
        filter?.focus()
        filter?.select()
      } else if ((key === 'c' || key === 'r') && e.shiftKey) {
        // Same as the buttons on the transaction badge: Commit only while the transaction is healthy.
        const status = tab?.response?.txStatus
        if (blocked || !tab || tab.running || !status || status === 'idle') return
        if (key === 'c' && status !== 'transaction') return
        e.preventDefault()
        void s.run(tab.id, key === 'c' ? 'COMMIT' : 'ROLLBACK', 0)
      } else if (key === 'backspace' && !editable(e.target)) {
        e.preventDefault()
        if (!blocked && tab) void s.requestDelete(tab.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function Welcome() {
  const setDialog = useStore((s) => s.setDialog)
  const newTab = useStore((s) => s.newTab)
  const hasConnections = useStore((s) => s.connections.length > 0)
  return (
    <div className="welcome">
      <Logo size={44} />
      <h1>{hasConnections ? 'No queries yet' : 'Connect to PostgreSQL'}</h1>
      <p className="muted">
        {hasConnections
          ? 'Start a new query, or double-click a table in the sidebar to look at its rows.'
          : 'Add a connection to browse tables and run queries. Paste a connection URL to fill everything in at once.'}
      </p>
      {hasConnections ? (
        <button className="btn primary" onClick={() => newTab()}>
          <Plus size={14} /> New query <Kbd>{modKey}+T</Kbd>
        </button>
      ) : (
        <button className="btn primary" onClick={() => setDialog({ type: 'connection' })}>
          <Plus size={14} /> New connection
        </button>
      )}
    </div>
  )
}

export function App() {
  const ready = useStore((s) => s.ready)
  const tab = useStore(activeTab)
  const dialog = useStore((s) => s.dialog)
  const init = useStore((s) => s.init)
  const historyOpen = useStore((s) => s.historyOpen)

  useEffect(() => {
    void init()
  }, [init])
  useTheme()
  useShortcuts()

  if (!ready) return <div className="app loading" />

  return (
    <div className="app">
      <TitleBar />
      <div className="main">
        <Sidebar />
        {historyOpen && <HistoryPane />}
        <main className="workspace">
          {!tab ? (
            <Welcome />
          ) : tab.kind === 'diagram' && tab.target ? (
            <DiagramView key={tab.id} target={tab.target} />
          ) : (
            <QueryPane tab={tab} />
          )}
        </main>
      </div>
      {dialog?.type === 'connection' && <ConnectionDialog id={dialog.id} />}
      {dialog?.type === 'settings' && <SettingsDialog />}
      {dialog?.type === 'envVariables' && <EnvVariablesDialog suggest={dialog.suggest} />}
      <ConfirmRunDialog />
      <ConfirmDialog />
      <UndoToast />
      <SaveErrorToast />
      <Toast />
      <CommandPalette />
    </div>
  )
}
