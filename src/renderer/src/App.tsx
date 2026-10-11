import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { api, modKey } from './api'
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
import { SaveErrorToast, UndoToast } from './components/UndoToast'
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

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const s = useStore.getState()
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 't' && !e.shiftKey) {
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
    </div>
  )
}
