import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Database, Network, Search, Trash2, X } from 'lucide-react'
import { displayTitle, historyFor, useStore, type Tab } from '../store'
import { EnvBadge, useEnvironment } from './environment'
import { Spinner } from './ui'

const DAY = 86_400_000

function startOfDay(t: number) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function groupOf(t: number, today: number): string {
  if (t >= today) return 'Today'
  if (t >= today - DAY) return 'Yesterday'
  if (t >= today - 6 * DAY) return 'Previous 7 days'
  return 'Older'
}

function ago(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < DAY / 1000) return `${Math.floor(s / 3600)}h`
  if (s < 7 * (DAY / 1000)) return new Date(t).toLocaleDateString('en-US', { weekday: 'short' })
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Second line of an entry: its SQL when it has a name of its own, and how the last run went. */
function preview(tab: Tab): string {
  if (tab.kind === 'diagram') return 'Diagram'
  if (!tab.title) return ''
  return tab.sql.replace(/\s+/g, ' ').trim().slice(0, 120)
}

const HistoryItem = memo(function HistoryItem({ tab, active, now }: { tab: Tab; active: boolean; now: number }) {
  const color = useStore((s) => s.connections.find((c) => c.id === tab.target?.connectionId)?.color)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const deleteTab = useStore((s) => s.deleteTab)
  const renameTab = useStore((s) => s.renameTab)
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const sub = preview(tab)

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div
      ref={ref}
      className={`history-item${active ? ' active' : ''}`}
      onMouseDown={(e) => e.button === 0 && setActiveTab(tab.id)}
      onDoubleClick={() => setEditing(true)}
      title={displayTitle(tab)}
    >
      <span className="history-icon">
        {tab.running ? (
          <Spinner size={10} />
        ) : tab.kind === 'diagram' ? (
          <Network size={12} style={{ color }} />
        ) : (
          <span className="history-dot" style={{ background: color ?? 'var(--text-faint)' }} />
        )}
      </span>
      <div className="history-text">
        <div className="history-top">
          {editing ? (
            <input
              className="history-rename"
              defaultValue={tab.title || displayTitle(tab)}
              autoFocus
              onFocus={(e) => e.target.select()}
              onMouseDown={(e) => e.stopPropagation()}
              onBlur={(e) => {
                renameTab(tab.id, e.target.value)
                setEditing(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setEditing(false)
              }}
              aria-label="Name"
            />
          ) : (
            <span className={`history-title${tab.title ? '' : ' derived'}`}>{displayTitle(tab)}</span>
          )}
          <span className="history-time">{ago(tab.touchedAt, now)}</span>
        </div>
        {(sub || tab.lastRun) && (
          <div className="history-sub">
            {sub && <span className="history-preview">{sub}</span>}
            {tab.lastRun && (
              <span className={`history-run${tab.lastRun.ok ? '' : ' failed'}`}>
                {sub ? '· ' : ''}
                {tab.lastRun.summary}
              </span>
            )}
          </div>
        )}
      </div>
      <button
        className="history-delete"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => deleteTab(tab.id)}
        title="Delete from history"
        aria-label="Delete from history"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
})

/** The queries and diagrams of the database you are in, most recently used first. */
export function HistoryPane() {
  const tabs = useStore((s) => s.tabs)
  const target = useStore((s) => s.currentTarget)
  const connection = useStore((s) => s.connections.find((c) => c.id === s.currentTarget?.connectionId))
  const activeTabId = useStore((s) => s.activeTabId)
  const width = useStore((s) => s.historyWidth)
  const setLayout = useStore((s) => s.setLayout)
  const environment = useEnvironment(target)
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(Date.now())

  // Keep the relative times fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const entries = useMemo(() => historyFor(tabs, target), [tabs, target])
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const today = startOfDay(now)
    const result: { label: string; items: Tab[] }[] = []
    for (const tab of entries) {
      if (q && !displayTitle(tab).toLowerCase().includes(q) && !tab.sql.toLowerCase().includes(q)) continue
      const label = groupOf(tab.touchedAt, today)
      if (result.at(-1)?.label !== label) result.push({ label, items: [] })
      result.at(-1)!.items.push(tab)
    }
    return result
  }, [entries, query, now])

  const startResize = (e: PointerEvent) => {
    e.preventDefault()
    // The pane sits right of the explorer, so measure from its own left edge.
    const left = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().left
    const move = (ev: globalThis.PointerEvent) =>
      setLayout({ historyWidth: Math.min(420, Math.max(190, ev.clientX - left)) })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-col')
    }
    document.body.classList.add('resizing-col')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <aside className="history" style={{ width }} aria-label="History">
      <div className="history-head" title={target ? `${connection?.name} / ${target.database}` : undefined}>
        <Database size={13} className="muted" />
        <span className="history-db">{target ? target.database : 'No database'}</span>
        {environment && <EnvBadge env={environment} />}
        {target && <span className="history-count">{entries.length}</span>}
      </div>
      <div className="sidebar-search">
        <Search size={13} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={target ? `Search ${target.database} history` : 'Search history'}
          spellCheck={false}
        />
        {query && (
          <button className="icon-btn tiny" onClick={() => setQuery('')} aria-label="Clear search">
            <X size={12} />
          </button>
        )}
      </div>
      <div className="history-list">
        {groups.map((g) => (
          <div key={g.label} className="history-group">
            <div className="sidebar-head">
              <span>{g.label}</span>
            </div>
            {g.items.map((t) => (
              <HistoryItem key={t.id} tab={t} active={t.id === activeTabId} now={now} />
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <div className="tree-note history-empty">
            {query
              ? 'Nothing matches.'
              : target
                ? `Queries you run on ${target.database} show up here.`
                : 'Pick a database in the explorer.'}
          </div>
        )}
      </div>
      <div className="sidebar-resize" onPointerDown={startResize} />
    </aside>
  )
}
