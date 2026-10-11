import { useEffect, useRef, type PointerEvent } from 'react'
import { Check, ChevronDown, Database, Lock, Network, Play, PlaySquare, Sparkles } from 'lucide-react'
import { environmentOf, targetKey } from '@shared/types'
import { modKey } from '../api'
import { useStore, type Tab } from '../store'
import { Editor, editorBridge } from './Editor'
import { Results } from './Results'
import { EnvBadge, EnvStrip, envStyle, useEnvironment } from './environment'
import { Popover, Spinner } from './ui'
import { VariablesBar } from './VariablesBar'

function TargetPicker({ tab }: { tab: Tab }) {
  const connections = useStore((s) => s.connections)
  const conn = useStore((s) => s.conn)
  const moveTab = useStore((s) => s.moveTab)
  const connect = useStore((s) => s.connect)
  const current = connections.find((c) => c.id === tab.target?.connectionId)

  return (
    <Popover
      trigger={(open, toggle) => (
        <button className={`target-btn${open ? ' active' : ''}`} onClick={toggle} title="Connection and database for this tab">
          {current ? (
            <>
              <span className="dot" style={{ background: current.color }} />
              <span className="target-name">{current.name}</span>
              <span className="target-sep">/</span>
              <span className="target-db">{tab.target?.database}</span>
            </>
          ) : (
            <span className="muted">Choose a database</span>
          )}
          <ChevronDown size={13} className="muted" />
        </button>
      )}
    >
      {(close) => (
        <div className="menu target-menu">
          {connections.length === 0 && <div className="menu-empty">No connections yet</div>}
          {connections.map((c) => {
            const state = conn[c.id]
            const databases = state?.server?.databases ?? [c.database]
            return (
              <div key={c.id} className="menu-group">
                <div className="menu-label">
                  <span className="dot" style={{ background: c.color }} /> {c.name}
                  {state?.status !== 'connected' && (
                    <button className="link-btn" onClick={() => void connect(c.id)}>
                      {state?.status === 'connecting' ? 'connecting…' : 'list databases'}
                    </button>
                  )}
                </div>
                {databases.map((db) => {
                  const selected = tab.target?.connectionId === c.id && tab.target.database === db
                  return (
                    <button
                      key={db}
                      className={`menu-item${selected ? ' selected' : ''}`}
                      onClick={() => {
                        moveTab(tab.id, { connectionId: c.id, database: db })
                        close()
                        editorBridge.focus()
                      }}
                    >
                      <Database size={13} className="muted" />
                      <span className="grow">{db}</span>
                      {(() => {
                        const env = environmentOf(c, db)
                        return env ? <EnvBadge env={env} /> : null
                      })()}
                      {selected && <Check size={13} />}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </Popover>
  )
}

function TransactionBadge({ tab }: { tab: Tab }) {
  const run = useStore((s) => s.run)
  const status = tab.response?.txStatus
  if (!status || status === 'idle' || tab.running) return null
  return (
    <div className={`tx-badge ${status}`}>
      <span className="tx-dot" />
      {status === 'transaction' ? 'Transaction open' : 'Transaction failed'}
      {status === 'transaction' && (
        <button onClick={() => void run(tab.id, 'COMMIT', 0)} title="Run COMMIT">
          Commit
        </button>
      )}
      <button onClick={() => void run(tab.id, 'ROLLBACK', 0)} title="Run ROLLBACK">
        Rollback
      </button>
    </div>
  )
}

function AiStatus() {
  const settings = useStore((s) => s.settings)
  const ai = useStore((s) => s.ai)
  const setDialog = useStore((s) => s.setDialog)
  const off = !settings?.aiEnabled || !settings.apiKeySource
  const label = off
    ? settings?.aiEnabled
      ? 'AI needs an API key'
      : 'AI off'
    : ai.status === 'error'
      ? 'AI error'
      : 'AI'
  const title = off
    ? 'Set up AI autocomplete in Settings'
    : ai.status === 'error'
      ? ai.error
      : `AI autocomplete is on. Suggestions appear as you type; Tab accepts.`
  return (
    <button
      className={`ai-status ${off ? 'off' : ai.status}`}
      onClick={() => setDialog({ type: 'settings' })}
      title={title}
    >
      {ai.status === 'thinking' && !off ? <Spinner size={11} /> : <Sparkles size={13} />}
      {label}
    </button>
  )
}

export function QueryPane({ tab }: { tab: Tab }) {
  const editorRatio = useStore((s) => s.editorRatio)
  const setLayout = useStore((s) => s.setLayout)
  const loadSchema = useStore((s) => s.loadSchema)
  const openDiagram = useStore((s) => s.openDiagram)
  const container = useRef<HTMLDivElement>(null)
  const target = tab.target
  const environment = useEnvironment(target)

  useEffect(() => {
    if (target) void loadSchema(target)
  }, [target ? targetKey(target) : null, loadSchema])

  const startDrag = (e: PointerEvent) => {
    e.preventDefault()
    const rect = container.current!.getBoundingClientRect()
    const move = (ev: globalThis.PointerEvent) => {
      const ratio = (ev.clientY - rect.top) / rect.height
      setLayout({ editorRatio: Math.min(0.85, Math.max(0.15, ratio)) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-row')
    }
    document.body.classList.add('resizing-row')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className={`query-pane${environment ? ` env-${environment.id}` : ''}`} style={envStyle(environment)}>
      <EnvStrip env={environment} />
      <div className="toolbar">
        <TargetPicker tab={tab} />
        {environment && <EnvBadge env={environment} long />}
        {environment?.id === 'production' && (
          <span
            className="readonly-hint"
            title="Production sessions are read-only: Postgres refuses writes unless you confirm them, including writes hidden inside functions."
          >
            <Lock size={11} /> read-only
          </span>
        )}
        <div className="toolbar-sep" />
        <button
          className="btn primary"
          onClick={() => editorBridge.run('smart')}
          disabled={tab.running || !tab.target}
          title={`Run the statement under the cursor or the selection (${modKey}+Enter)`}
        >
          <Play size={13} fill="currentColor" /> Run
        </button>
        <button
          className="icon-btn"
          onClick={() => editorBridge.run('all')}
          disabled={tab.running || !tab.target}
          title={`Run everything (${modKey}+Shift+Enter)`}
        >
          <PlaySquare size={15} />
        </button>
        <TransactionBadge tab={tab} />
        <div className="grow" />
        {tab.target && (
          <button className="icon-btn" onClick={() => openDiagram(tab.target!)} title="Database diagram">
            <Network size={15} />
          </button>
        )}
        <AiStatus />
      </div>
      <VariablesBar tab={tab} />
      <div className="split" ref={container}>
        <div className="split-editor" style={{ flexBasis: `${editorRatio * 100}%` }}>
          <Editor tab={tab} />
        </div>
        <div className="split-handle" onPointerDown={startDrag} />
        <div className="split-results">
          <Results tab={tab} />
        </div>
      </div>
    </div>
  )
}
