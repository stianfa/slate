import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlignLeft, Braces, Database, Eye, FileCode2, MessageSquare, Moon, Network, PanelLeft, Play, PlaySquare, Plug, Plus, RefreshCw, Settings, Sun, Table2 } from 'lucide-react'
import { targetKey, type Target } from '@shared/types'
import { modKey } from '../api'
import { displayTitle, historyOrder, useStore } from '../store'
import { score } from '../lib/fuzzy'
import { editorBridge } from './Editor'

interface Item {
  id: string
  group: 'Command' | 'Query' | 'Table' | 'Database'
  label: string
  detail?: string
  hint?: string
  icon: ReactNode
  run(): void
}

const DEFAULT_LIMIT = { Command: 12, Query: 6, Table: 8, Database: 6 }

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  if (!open) return null
  return <Palette />
}

function Palette() {
  const s = useStore()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const close = () => s.setPalette(false)
  const current = s.currentTarget
  const activeTab = s.tabs.find((t) => t.id === s.activeTabId)
  const dark = document.documentElement.dataset.theme === 'dark'

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const command = (id: string, label: string, icon: ReactNode, run: () => void, hint?: string) =>
      out.push({ id: `cmd:${id}`, group: 'Command', label, icon, run, hint })
    const isQuery = activeTab && activeTab.kind !== 'diagram'

    command('new', 'New query', <Plus size={14} />, () => s.newTab(), `${modKey}+T`)
    if (isQuery) {
      command('run', 'Run statement', <Play size={14} />, () => editorBridge.run('smart'), `${modKey}+Enter`)
      command('run-all', 'Run everything', <PlaySquare size={14} />, () => editorBridge.run('all'), `${modKey}+Shift+Enter`)
      command('format', 'Format SQL', <AlignLeft size={14} />, () => editorBridge.format(), 'Shift+Alt+F')
      command(
        'chat',
        s.chatOpen ? 'Close AI chat' : 'Ask AI to write a query',
        <MessageSquare size={14} />,
        () => s.setLayout({ chatOpen: !s.chatOpen }),
        `${modKey}+J`
      )
    }
    if (current) {
      command('diagram', `Open diagram of ${current.database}`, <Network size={14} />, () => s.openDiagram(current))
      command('refresh', `Refresh schema of ${current.database}`, <RefreshCw size={14} />, () => void s.loadSchema(current, true), `${modKey}+R`)
    }
    command(
      'history',
      s.historyOpen ? 'Hide history' : 'Show history',
      <PanelLeft size={14} />,
      () => s.setLayout({ historyOpen: !s.historyOpen }),
      `${modKey}+B`
    )
    command('envvars', 'Environment variables', <Braces size={14} />, () => s.setDialog({ type: 'envVariables' }))
    command('connection', 'New connection', <Plug size={14} />, () => s.setDialog({ type: 'connection' }))
    command('settings', 'Settings', <Settings size={14} />, () => s.setDialog({ type: 'settings' }), `${modKey}+,`)
    command(
      'theme',
      dark ? 'Switch to light theme' : 'Switch to dark theme',
      dark ? <Sun size={14} /> : <Moon size={14} />,
      () => void s.saveSettings({ theme: dark ? 'light' : 'dark' })
    )

    // Queries from every database, current one first.
    const connectionName = (t: Target | null) => s.connections.find((c) => c.id === t?.connectionId)?.name ?? 'No database'
    const inCurrent = (t: Target | null) => current !== null && t !== null && targetKey(t) === targetKey(current)
    for (const tab of historyOrder(s.tabs).sort((a, b) => Number(inCurrent(b.target)) - Number(inCurrent(a.target)))) {
      if (tab.id === s.activeTabId) continue
      out.push({
        id: `query:${tab.id}`,
        group: 'Query',
        label: displayTitle(tab),
        detail: tab.target ? `${connectionName(tab.target)} / ${tab.target.database}` : undefined,
        icon: tab.kind === 'diagram' ? <Network size={14} /> : <FileCode2 size={14} />,
        run: () => s.setActiveTab(tab.id)
      })
    }

    if (current) {
      for (const table of s.schemas[targetKey(current)]?.data?.tables ?? []) {
        out.push({
          id: `table:${table.schema}.${table.name}`,
          group: 'Table',
          label: table.schema === 'public' ? table.name : `${table.schema}.${table.name}`,
          detail: table.kind === 'table' ? current.database : `${table.kind} · ${current.database}`,
          icon: table.kind.includes('view') ? <Eye size={14} /> : <Table2 size={14} />,
          run: () => s.openTable(current, table)
        })
      }
    }

    for (const c of s.connections) {
      for (const database of s.conn[c.id]?.server?.databases ?? [c.database]) {
        const target = { connectionId: c.id, database }
        if (inCurrent(target)) continue
        out.push({
          id: `db:${c.id}/${database}`,
          group: 'Database',
          label: database,
          detail: c.name,
          icon: <Database size={14} />,
          run: () => {
            s.selectDatabase(target)
            s.toggle(`c:${c.id}`, true)
            s.toggle(`d:${c.id}/${database}`, true)
            void s.loadSchema(target)
          }
        })
      }
    }
    return out
  }, [s.tabs, s.schemas, s.connections, s.conn, current, s.activeTabId, s.historyOpen, dark])

  const shown = useMemo(() => {
    const q = query.trim()
    if (!q) {
      const counts: Record<string, number> = {}
      return items.filter((i) => (counts[i.group] = (counts[i.group] ?? 0) + 1) <= DEFAULT_LIMIT[i.group])
    }
    return items
      .map((item) => {
        const own = score(item.label, q)
        const detail = item.detail ? score(item.detail, q) : null
        const best = own ?? (detail === null ? null : detail * 0.5)
        return { item, best }
      })
      .filter((x): x is { item: Item; best: number } => x.best !== null)
      .sort((a, b) => b.best - a.best)
      .slice(0, 50)
      .map((x) => x.item)
  }, [items, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    list.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: Item | undefined) => {
    if (!item) return
    close()
    item.run()
  }

  return (
    <div className="backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          className="palette-input"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Run a command, open a table, query or database…"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(shown[active])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
        <div className="palette-list" ref={list}>
          {shown.map((item, i) => (
            <div
              key={item.id}
              className={`palette-item${i === active ? ' active' : ''}`}
              onMouseMove={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(item)
              }}
            >
              <span className="palette-icon">{item.icon}</span>
              <span className="palette-label">{item.label}</span>
              {item.detail && <span className="palette-detail">{item.detail}</span>}
              {item.hint ? <kbd className="kbd">{item.hint}</kbd> : <span className="palette-group">{item.group}</span>}
            </div>
          ))}
          {shown.length === 0 && <div className="palette-empty">Nothing matches.</div>}
        </div>
      </div>
    </div>
  )
}
