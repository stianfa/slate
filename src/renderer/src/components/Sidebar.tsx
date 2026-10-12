import { useMemo, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import {
  ChevronRight,
  Copy,
  Database,
  Eye,
  KeyRound,
  Link2,
  Network,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Table2,
  Unplug,
  X
} from 'lucide-react'
import { qualifiedName } from '@shared/sql'
import { ENVIRONMENTS, environmentOf, targetKey, type ConnectionConfig, type TableInfo, type Target } from '@shared/types'
import { api, modKey } from '../api'
import { formatEstimate, shortType } from '../lib/format'
import { useStore } from '../store'
import { EnvBadge } from './environment'
import { Spinner } from './ui'

const INDENT = 14

function Row({
  depth,
  open,
  expandable = true,
  onClick,
  onDoubleClick,
  icon,
  label,
  meta,
  actions,
  className = '',
  title
}: {
  depth: number
  open?: boolean
  expandable?: boolean
  onClick?(): void
  onDoubleClick?(): void
  icon: ReactNode
  label: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
  title?: string
}) {
  return (
    <div
      className={`tree-row ${className}`}
      style={{ paddingLeft: 8 + depth * INDENT }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
    >
      <span className={`chevron${open ? ' open' : ''}${expandable ? '' : ' hidden'}`}>
        <ChevronRight size={12} />
      </span>
      <span className="tree-icon">{icon}</span>
      <span className="tree-label">{label}</span>
      {meta !== undefined && <span className="tree-meta">{meta}</span>}
      {actions && (
        <span className="tree-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
    </div>
  )
}

function TableNode({ target, table, depth, filtering }: { target: Target; table: TableInfo; depth: number; filtering: boolean }) {
  const key = `t:${targetKey(target)}/${table.schema}.${table.name}`
  const open = useStore((s) => Boolean(s.expanded[key]))
  const toggle = useStore((s) => s.toggle)
  const openTable = useStore((s) => s.openTable)
  const isView = table.kind.includes('view')

  return (
    <>
      <Row
        depth={depth}
        open={open}
        onClick={() => toggle(key)}
        onDoubleClick={() => openTable(target, table)}
        icon={isView ? <Eye size={13} /> : <Table2 size={13} />}
        label={table.name}
        title={`${table.schema}.${table.name}${table.kind !== 'table' ? ` (${table.kind})` : ''} — double-click to query`}
        meta={!filtering && table.estimatedRows !== null && table.estimatedRows > 0 ? formatEstimate(table.estimatedRows) : undefined}
        className={isView ? 'is-view' : ''}
        actions={
          <>
            <button className="tree-btn" title="Select first 100 rows" onClick={() => openTable(target, table)}>
              <Play size={11} fill="currentColor" />
            </button>
            <button
              className="tree-btn"
              title="Copy name"
              onClick={() => void api.copyText(qualifiedName(table.schema, table.name))}
            >
              <Copy size={11} />
            </button>
          </>
        }
      />
      {open &&
        table.columns.map((c) => (
          <Row
            key={c.name}
            depth={depth + 1}
            expandable={false}
            icon={
              c.pk ? (
                <KeyRound size={12} className="pk" />
              ) : c.fk ? (
                <Link2 size={12} className="fk" />
              ) : (
                <span className="col-dot" />
              )
            }
            label={c.name}
            meta={
              <span className="col-type">
                {shortType(c.type)}
                {c.nullable && !c.pk ? <span className="nullable">?</span> : null}
              </span>
            }
            title={[
              `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`,
              c.pk ? 'Primary key' : '',
              c.fk ? `References ${c.fk.schema}.${c.fk.table}(${c.fk.column})` : '',
              c.default ? `Default ${c.default}` : ''
            ]
              .filter(Boolean)
              .join('\n')}
            className="column"
            onDoubleClick={() => void api.copyText(c.name)}
          />
        ))}
    </>
  )
}

function DatabaseNode({ connection, database, depth }: { connection: ConnectionConfig; database: string; depth: number }) {
  const target = useMemo(() => ({ connectionId: connection.id, database }), [connection.id, database])
  // The connection row already shows its own mark; a database only shows one that differs.
  const environment = environmentOf(connection, database)
  const ownEnvironment = environment?.id === connection.environment ? null : environment
  const key = `d:${targetKey(target)}`
  const open = useStore((s) => Boolean(s.expanded[key]))
  const schema = useStore((s) => s.schemas[targetKey(target)])
  const filter = useStore((s) => s.filter.trim().toLowerCase())
  const toggle = useStore((s) => s.toggle)
  const loadSchema = useStore((s) => s.loadSchema)
  const openDiagram = useStore((s) => s.openDiagram)
  const selectDatabase = useStore((s) => s.selectDatabase)
  const isCurrent = useStore((s) => s.currentTarget !== null && targetKey(s.currentTarget) === targetKey(target))
  const expanded = useStore((s) => s.expanded)

  const tables = useMemo(() => {
    const all = schema?.data?.tables ?? []
    return filter ? all.filter((t) => t.name.toLowerCase().includes(filter)) : all
  }, [schema?.data, filter])
  const schemas = useMemo(() => [...new Set(tables.map((t) => t.schema))], [tables])
  const grouped = schemas.length > 1 || (schemas.length === 1 && schemas[0] !== 'public')
  const showChildren = open || (filter && tables.length > 0)

  // Clicking a database enters it (its history and new queries follow); clicking it again folds it.
  const onToggle = () => {
    if (!isCurrent) {
      selectDatabase(target)
      toggle(key, true)
      void loadSchema(target)
      return
    }
    toggle(key)
    if (!open) void loadSchema(target)
  }

  return (
    <>
      <Row
        depth={depth}
        open={Boolean(showChildren)}
        onClick={onToggle}
        icon={schema?.status === 'loading' ? <Spinner size={11} /> : <Database size={13} />}
        label={
          <>
            {database}
            {ownEnvironment && <EnvBadge env={ownEnvironment} />}
          </>
        }
        className={`database${isCurrent ? ' current' : ''}`}
        meta={schema?.data && !filter ? schema.data.tables.length : undefined}
        actions={
          <>
            <button className="tree-btn" title="Database diagram" onClick={() => openDiagram(target)}>
              <Network size={12} />
            </button>
            {open && (
              <button className="tree-btn" title="Refresh schema" onClick={() => void loadSchema(target, true)}>
                <RefreshCw size={11} />
              </button>
            )}
          </>
        }
      />
      {showChildren && schema?.status === 'error' && (
        <div className="tree-error" style={{ paddingLeft: 30 + depth * INDENT }}>
          {schema.error}
        </div>
      )}
      {showChildren && schema?.data && tables.length === 0 && (
        <div className="tree-note" style={{ paddingLeft: 30 + depth * INDENT }}>
          {filter ? 'No matching tables' : 'No tables'}
        </div>
      )}
      {showChildren &&
        (grouped
          ? schemas.map((name) => {
              const schemaKey = `s:${targetKey(target)}/${name}`
              const schemaOpen = Boolean(filter) || expanded[schemaKey] !== false
              return (
                <div key={name}>
                  <Row
                    depth={depth + 1}
                    open={schemaOpen}
                    onClick={() => toggle(schemaKey, !schemaOpen)}
                    icon={<span className="schema-glyph">{'{}'}</span>}
                    label={name}
                    className="schema"
                  />
                  {schemaOpen &&
                    tables
                      .filter((t) => t.schema === name)
                      .map((t) => (
                        <TableNode key={t.name} target={target} table={t} depth={depth + 2} filtering={Boolean(filter)} />
                      ))}
                </div>
              )
            })
          : tables.map((t) => (
              <TableNode key={`${t.schema}.${t.name}`} target={target} table={t} depth={depth + 1} filtering={Boolean(filter)} />
            )))}
    </>
  )
}

function ConnectionNode({ connection }: { connection: ConnectionConfig }) {
  const key = `c:${connection.id}`
  const open = useStore((s) => Boolean(s.expanded[key]))
  const state = useStore((s) => s.conn[connection.id])
  const toggle = useStore((s) => s.toggle)
  const connect = useStore((s) => s.connect)
  const requestDisconnect = useStore((s) => s.requestDisconnect)
  const setDialog = useStore((s) => s.setDialog)
  const status = state?.status ?? 'idle'
  const databases = state?.server?.databases ?? [connection.database]
  const connectionEnv = ENVIRONMENTS.find((e) => e.id === connection.environment) ?? null

  const onClick = () => {
    if (status === 'idle' || status === 'error') void connect(connection.id)
    else toggle(key)
  }

  return (
    <div className="conn">
      <Row
        depth={0}
        open={open && status === 'connected'}
        onClick={onClick}
        icon={
          status === 'connecting' ? (
            <Spinner size={11} />
          ) : (
            <span className={`conn-dot ${status}`} style={{ '--c': connection.color } as CSSProperties} />
          )
        }
        label={
          <>
            {connection.name}
            {connectionEnv && <EnvBadge env={connectionEnv} />}
          </>
        }
        className="connection"
        title={`${connection.user}@${connection.host}:${connection.port}${state?.server ? ` · PostgreSQL ${state.server.version}` : ''}`}
        actions={
          <>
            {status === 'connected' ? (
              <button className="tree-btn" title="Disconnect" onClick={() => void requestDisconnect(connection.id)}>
                <Unplug size={12} />
              </button>
            ) : (
              <button className="tree-btn" title="Connect" onClick={() => void connect(connection.id)}>
                <Plug size={12} />
              </button>
            )}
            <button className="tree-btn" title="Edit connection" onClick={() => setDialog({ type: 'connection', id: connection.id })}>
              <Pencil size={11} />
            </button>
          </>
        }
      />
      {status === 'error' && (
        <div className="tree-error" style={{ paddingLeft: 30 }}>
          {state?.error}
        </div>
      )}
      {open && status === 'connected' && databases.map((db) => <DatabaseNode key={db} connection={connection} database={db} depth={1} />)}
    </div>
  )
}

export function Sidebar() {
  const connections = useStore((s) => s.connections)
  const filter = useStore((s) => s.filter)
  const setFilter = useStore((s) => s.setFilter)
  const setDialog = useStore((s) => s.setDialog)
  const width = useStore((s) => s.sidebarWidth)
  const setLayout = useStore((s) => s.setLayout)

  const startResize = (e: PointerEvent) => {
    e.preventDefault()
    const move = (ev: globalThis.PointerEvent) => setLayout({ sidebarWidth: Math.min(520, Math.max(200, ev.clientX)) })
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
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-search">
        <Search size={13} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables"
          title={`Filter tables (${modKey}+Shift+F)`}
          spellCheck={false}
        />
        {filter && (
          <button className="icon-btn tiny" onClick={() => setFilter('')} aria-label="Clear filter">
            <X size={12} />
          </button>
        )}
      </div>
      <div className="sidebar-head">
        <span>Connections</span>
        <button className="icon-btn tiny" title="New connection" onClick={() => setDialog({ type: 'connection' })}>
          <Plus size={14} />
        </button>
      </div>
      <div className="tree">
        {connections.map((c) => (
          <ConnectionNode key={c.id} connection={c} />
        ))}
        {connections.length === 0 && (
          <button className="tree-add" onClick={() => setDialog({ type: 'connection' })}>
            <Plus size={13} /> Add a connection
          </button>
        )}
      </div>
      <div className="sidebar-foot">
        <button className="ghost-btn" onClick={() => setDialog({ type: 'settings' })}>
          <Settings size={13} /> Settings
        </button>
      </div>
      <div className="sidebar-resize" onPointerDown={startResize} />
    </aside>
  )
}
