import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowRightLeft, Check, ChevronDown, Copy, Download, Info, Plus, Search, Square, Unlock, X } from 'lucide-react'
import { countChanges, editTarget, readOnlyReason } from '@shared/changes'
import { isReadOnly, qualifiedName } from '@shared/sql'
import { targetKey } from '@shared/types'
import { api, modKey } from '../api'
import { formatDuration, lineCol, prettyValue, summarize, toCsv, toJson, toMarkdown } from '../lib/format'
import { nextSort, rowOrder } from '../lib/rows'
import { useStore, type Tab } from '../store'
import { ColumnMenu } from './ColumnMenu'
import { DataGrid, type DataGridHandle, type OpenValue } from './DataGrid'
import { useEnvironment } from './environment'

// SQLSTATE for a write attempted in a read-only transaction.
const READ_ONLY_VIOLATION = '25006'
import { Dialog, Kbd, Popover, Spinner } from './ui'

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [])
  return <>{formatDuration(now - since)}</>
}

function CopyMenu({ onCopy, onSave }: { onCopy(format: 'csv' | 'json' | 'markdown'): void; onSave(): void }) {
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <button className={`ghost-btn${open ? ' active' : ''}`} onClick={toggle}>
          <Copy size={13} /> Export <ChevronDown size={12} />
        </button>
      )}
    >
      {(close) => (
        <div className="menu">
          <button
            className="menu-item"
            onClick={() => {
              onSave()
              close()
            }}
          >
            <Download size={13} className="muted" /> Save as CSV file…
          </button>
          <div className="menu-sep" />
          {(['csv', 'json', 'markdown'] as const).map((f) => (
            <button
              key={f}
              className="menu-item"
              onClick={() => {
                onCopy(f)
                close()
              }}
            >
              {f === 'csv' ? 'Copy as CSV' : f === 'json' ? 'Copy as JSON' : 'Copy as Markdown table'}
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

export function Results({ tab }: { tab: Tab }) {
  const updateTab = useStore((s) => s.updateTab)
  const cancel = useStore((s) => s.cancel)
  const settings = useStore((s) => s.settings)
  const retryWithWrites = useStore((s) => s.retryWithWrites)
  const loadMore = useStore((s) => s.loadMore)
  const exportResult = useStore((s) => s.exportResult)
  const setChanges = useStore((s) => s.setChanges)
  const saveChanges = useStore((s) => s.saveChanges)
  const setView = useStore((s) => s.setView)
  const showToast = useStore((s) => s.showToast)
  const schema = useStore((s) => (tab.target ? s.schemas[targetKey(tab.target)]?.data : undefined))
  const grid = useRef<DataGridHandle>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState(false)
  const environment = useEnvironment(tab.target)
  const [viewing, setViewing] = useState<OpenValue | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const response = tab.response
  // activeResult === results.length selects the error, which gets its own tab.
  const showingError = Boolean(response?.error) && (tab.activeResult ?? 0) >= (response?.results.length ?? 0)
  const result = showingError ? undefined : response?.results[tab.activeResult ?? 0]
  const tabCount = (response?.results.length ?? 0) + (response?.error ? 1 : 0)
  const index = tab.activeResult ?? 0
  // The table a result's columns come from, whose rows the grid can change.
  const into = useMemo(() => (result ? editTarget(result.fields, schema) : null), [result?.fields, schema])
  const editable = Boolean(into && !tab.transposed)
  const pending = result && tab.changes?.result === index ? tab.changes : undefined
  const changeCount = pending ? countChanges(pending) : 0
  const view = result && tab.view?.result === index ? tab.view : undefined
  const order = useMemo(
    () => (result ? rowOrder(result, view?.sort, view?.filter, view?.columns) : null),
    [result, view?.sort, view?.filter, view?.columns]
  )
  const filteredColumns = useMemo(
    () => Object.entries(view?.columns ?? {}).flatMap(([c, f]) => (f.values.length ? [Number(c)] : [])),
    [view?.columns]
  )
  const [columnMenu, setColumnMenu] = useState<{ column: number; x: number; y: number } | null>(null)
  const closeColumnMenu = useCallback(() => setColumnMenu(null), [])
  // A new result can have other columns.
  useEffect(() => setColumnMenu(null), [result?.fields])
  const tableName = into ? qualifiedName(into.table.schema, into.table.name) : 'the table'

  const copy = async (format: 'csv' | 'json' | 'markdown') => {
    if (!result) return
    const text = format === 'csv' ? toCsv(result) : format === 'json' ? toJson(result) : toMarkdown(result)
    await api.copyText(text)
    flash(`Copied ${format.toUpperCase()}`)
  }

  const flash = (message: string) => {
    setCopied(message)
    setTimeout(() => setCopied(null), 2500)
  }

  const save = async () => {
    setSaving(true)
    try {
      const message = await exportResult(tab.id, tab.activeResult ?? 0)
      if (message) flash(message)
    } catch (e) {
      flash(`Couldn't save: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  let body
  if (tab.running && !response) {
    body = (
      <div className="results-empty">
        <Spinner size={16} />
      </div>
    )
  } else if (!response) {
    body = (
      <div className="results-empty">
        <div className="shortcuts">
          <div>
            <Kbd>{modKey}</Kbd> <Kbd>Enter</Kbd> <span>Run statement or selection</span>
          </div>
          <div>
            <Kbd>{modKey}</Kbd> <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> <span>Run everything</span>
          </div>
          <div>
            <Kbd>Tab</Kbd> <span>Accept AI suggestion</span>
          </div>
          <div>
            <Kbd>Alt</Kbd> <Kbd>\</Kbd> <span>Ask AI for a suggestion</span>
          </div>
        </div>
      </div>
    )
  } else if (showingError && response.error) {
    const where =
      response.error.position !== undefined && tab.runOffset !== undefined
        ? lineCol(tab.sql, tab.runOffset + response.error.position)
        : null
    body = (
      <div className="results-scroll">
        {response.results.length > 0 && (
          <div className="error-after">
            {response.results.length} {response.results.length === 1 ? 'statement' : 'statements'} ran before this
            error.
          </div>
        )}
        <div className="error-card">
          <AlertCircle size={16} />
          <div>
            <div className="error-message">{response.error.message}</div>
            {response.error.detail && <div className="error-extra">{response.error.detail}</div>}
            {response.error.hint && <div className="error-extra">Hint: {response.error.hint}</div>}
            <div className="error-meta">
              {where && (
                <span>
                  Line {where.line}, column {where.col}
                </span>
              )}
              {response.error.code && <span>SQLSTATE {response.error.code}</span>}
            </div>
            {response.error.code === READ_ONLY_VIOLATION && environment?.id === 'production' && (
              <button className="btn danger" onClick={() => retryWithWrites(tab.id)}>
                <Unlock size={13} /> Run again with writes allowed…
              </button>
            )}
          </div>
        </div>
        {response.notices.length > 0 && <Notices notices={response.notices} />}
      </div>
    )
  } else if (result && result.fields.length > 0) {
    body = (
      <DataGrid
        ref={grid}
        result={result}
        transposed={Boolean(tab.transposed)}
        order={order}
        sort={view?.sort}
        onSort={tab.transposed ? undefined : (column) => setView(tab.id, index, { sort: nextSort(view?.sort, column) })}
        onColumnMenu={tab.transposed ? undefined : (column, x, y) => setColumnMenu({ column, x, y })}
        filtered={filteredColumns}
        onFind={() => filterInput.current?.focus()}
        onOpenValue={setViewing}
        onReadOnly={(message) => showToast(message)}
        editor={
          into && editable
            ? {
                columns: into.columns,
                readOnly: readOnlyReason(into),
                changes: pending ?? { added: [], edited: {}, deleted: [] },
                busy: Boolean(tab.running),
                change: (changes) => setChanges(tab.id, index, changes),
                submit: () => void saveChanges(tab.id)
              }
            : undefined
        }
      />
    )
  } else if (result) {
    body = (
      <div className="results-scroll">
        <div className="command-card">
          <Check size={16} />
          <span>{summarize(result)}</span>
          <span className="muted">{formatDuration(result.durationMs)}</span>
        </div>
        {response.notices.length > 0 && <Notices notices={response.notices} />}
      </div>
    )
  } else {
    body = <div className="results-empty muted">Nothing to run.</div>
  }

  return (
    <div className="results">
      <div className="results-bar">
        {response && tabCount > 1 && (
          <div className="result-tabs">
            {response.results.map((r, i) => (
              <button
                key={i}
                className={`result-tab${i === (tab.activeResult ?? 0) ? ' active' : ''}`}
                onClick={() => updateTab(tab.id, { activeResult: i })}
                title={r.statement}
              >
                <span className="result-tab-index">{i + 1}</span>
                {summarize(r)}
              </button>
            ))}
            {response.error && (
              <button
                className={`result-tab error${showingError ? ' active' : ''}`}
                onClick={() => updateTab(tab.id, { activeResult: response.results.length })}
              >
                <AlertCircle size={12} /> Error
              </button>
            )}
          </div>
        )}
        <div className="results-summary">
          {tab.running ? (
            <>
              <Spinner /> Running <Elapsed since={tab.runStartedAt ?? Date.now()} />
            </>
          ) : showingError && response ? (
            <span className="danger">Failed after {formatDuration(response.durationMs)}</span>
          ) : result ? (
            <>
              <span className="strong">{summarize(result)}</span>
              <span className="muted">· {formatDuration(response!.durationMs)}</span>
              {result.truncated && (
                <span className="pill" title="Results stop at the row limit (Settings)">
                  row limit
                </span>
              )}
              {(view?.filter || filteredColumns.length > 0) && order && (
                <span className="pill" title="Rows that pass the filters">
                  {order.length.toLocaleString('en-US')} {order.length === 1 ? 'match' : 'matches'}
                </span>
              )}
              {result.truncated && isReadOnly(result.statement) && (
                <button
                  className="ghost-btn"
                  onClick={() => void loadMore(tab.id, tab.activeResult ?? 0)}
                  disabled={changeCount > 0}
                  title={changeCount > 0 ? 'Save or discard your changes first' : 'Run the statement again with room for more rows'}
                >
                  Load {(settings?.rowLimit ?? 1000).toLocaleString('en-US')} more
                </button>
              )}
            </>
          ) : null}
        </div>
        <div className="results-actions">
          {tab.running && (
            <button className="ghost-btn danger" onClick={() => void cancel(tab.id)} title={`Cancel the query (${modKey}+.)`}>
              <Square size={11} fill="currentColor" /> Cancel
            </button>
          )}
          {!tab.running && result && result.fields.length > 0 && (
            <>
              {saving && <Spinner />}
              {copied && <span className="copied">{copied}</span>}
              {changeCount > 0 && (
                <>
                  <button
                    className="ghost-btn"
                    onClick={() => setChanges(tab.id, index, { added: [], edited: {}, deleted: [] })}
                    title="Drop the changes"
                  >
                    Discard
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => void saveChanges(tab.id)}
                    title={`Save to ${tableName} (${modKey}+Enter in the grid)`}
                  >
                    Save {changeCount} {changeCount === 1 ? 'change' : 'changes'}
                  </button>
                </>
              )}
              <div className={`grid-filter${view?.filter ? ' active' : ''}`}>
                <Search size={12} />
                <input
                  ref={filterInput}
                  value={view?.filter ?? ''}
                  placeholder="Filter rows"
                  aria-label="Filter rows"
                  spellCheck={false}
                  title={
                    result.truncated
                      ? `Show the loaded rows with a value that contains this text (${modKey}+F in the grid)`
                      : `Show the rows with a value that contains this text (${modKey}+F in the grid)`
                  }
                  onChange={(e) => setView(tab.id, index, { filter: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && view?.filter) setView(tab.id, index, { filter: '' })
                    else if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'ArrowDown') grid.current?.focus()
                    else return
                    e.preventDefault()
                  }}
                />
                {view?.filter && (
                  <button className="grid-filter-clear" onClick={() => setView(tab.id, index, { filter: '' })} aria-label="Clear filter">
                    <X size={11} />
                  </button>
                )}
              </div>
              {into && editable && (
                <button
                  className="ghost-btn"
                  onClick={() => grid.current?.addRow()}
                  aria-label="Add row"
                  title={`Add a row to ${tableName}. Paste copied rows into it with ${modKey}+V.`}
                >
                  <Plus size={14} />
                </button>
              )}
              <button
                className={`ghost-btn${tab.transposed ? ' active' : ''}`}
                onClick={() => updateTab(tab.id, { transposed: !tab.transposed })}
                aria-pressed={Boolean(tab.transposed)}
                disabled={changeCount > 0}
                title={
                  changeCount > 0
                    ? 'Save or discard the changes first'
                    : tab.transposed
                      ? 'Show rows as rows again'
                      : 'Show each row as a column, with the column names down the side'
                }
              >
                <ArrowRightLeft size={13} /> Transpose
              </button>
              <CopyMenu onCopy={(f) => void copy(f)} onSave={() => void save()} />
            </>
          )}
        </div>
      </div>
      {tab.running && <div className="progress" />}
      {pending?.error && (
        <div className="changes-error">
          <AlertCircle size={13} />
          <span>
            {pending.error.message}
            {pending.error.detail && <span className="changes-error-detail"> {pending.error.detail}</span>}
          </span>
        </div>
      )}
      <div className="results-body">{body}</div>
      {columnMenu && result && result.fields[columnMenu.column] && (
        <ColumnMenu
          result={result}
          column={columnMenu.column}
          x={columnMenu.x}
          y={columnMenu.y}
          sort={view?.sort}
          filter={view?.columns?.[columnMenu.column]}
          onSort={(sort) => setView(tab.id, index, { sort })}
          onFilter={(filter) => {
            const columns = { ...view?.columns }
            if (filter) columns[columnMenu.column] = filter
            else delete columns[columnMenu.column]
            setView(tab.id, index, { columns })
          }}
          onClose={closeColumnMenu}
        />
      )}
      {viewing && (
        <ValueDialog
          open={viewing}
          onClose={() => {
            setViewing(null)
            grid.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/** A value in full, or an editor for it when its cell can be edited. */
function ValueDialog({ open, onClose }: { open: OpenValue; onClose(): void }) {
  const { value, field, set } = open
  // jsonb is stored normalized, so editing it pretty-printed changes nothing but the layout.
  const start = value === null || value === undefined ? '' : field.type === 'jsonb' ? prettyValue(value, field) : value
  const [text, setText] = useState(start)
  const [dirty, setDirty] = useState(false)
  if (!set) {
    const shown = prettyValue(value ?? '', field)
    return (
      <Dialog
        title={field.name}
        onClose={onClose}
        width={680}
        footer={
          <>
            <span className="muted mono small">{field.type}</span>
            <button className="btn" onClick={() => void api.copyText(shown)}>
              <Copy size={13} /> Copy
            </button>
          </>
        }
      >
        <pre className="value-view">{shown}</pre>
      </Dialog>
    )
  }
  const apply = () => {
    if (dirty) set(text)
    onClose()
  }
  return (
    <Dialog
      title={field.name}
      onClose={onClose}
      width={680}
      footer={
        <>
          <span className="muted mono small">{field.type}</span>
          <button
            className="btn"
            onClick={() => {
              set(null)
              onClose()
            }}
          >
            Set NULL
          </button>
          <button className="btn primary" onClick={apply} title={`${modKey}+Enter`}>
            Apply
          </button>
        </>
      }
    >
      <textarea
        className="value-edit"
        value={text}
        placeholder={value === null ? 'NULL' : value === undefined ? 'DEFAULT' : undefined}
        autoFocus
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          setDirty(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            // Before the app-wide Cmd+Enter, which would run the query.
            e.preventDefault()
            apply()
          }
        }}
      />
    </Dialog>
  )
}

function Notices({ notices }: { notices: string[] }) {
  return (
    <div className="notices">
      {notices.map((n, i) => (
        <div key={i} className="notice">
          <Info size={13} /> <span>{n}</span>
        </div>
      ))}
    </div>
  )
}
