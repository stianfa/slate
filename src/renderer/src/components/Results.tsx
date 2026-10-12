import { useEffect, useState } from 'react'
import { AlertCircle, ArrowRightLeft, Check, ChevronDown, Copy, Download, Info, Square, Unlock } from 'lucide-react'
import { isReadOnly } from '@shared/sql'
import type { ResultField } from '@shared/types'
import { api, modKey } from '../api'
import { formatDuration, lineCol, prettyValue, summarize, toCsv, toJson, toMarkdown } from '../lib/format'
import { useStore, type Tab } from '../store'
import { DataGrid } from './DataGrid'
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
  const [saving, setSaving] = useState(false)
  const environment = useEnvironment(tab.target)
  const [viewing, setViewing] = useState<{ value: string; field: ResultField } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const response = tab.response
  // activeResult === results.length selects the error, which gets its own tab.
  const showingError = Boolean(response?.error) && (tab.activeResult ?? 0) >= (response?.results.length ?? 0)
  const result = showingError ? undefined : response?.results[tab.activeResult ?? 0]
  const tabCount = (response?.results.length ?? 0) + (response?.error ? 1 : 0)

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
        result={result}
        transposed={Boolean(tab.transposed)}
        onOpenValue={(value, field) => setViewing({ value, field })}
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
              {result.truncated && isReadOnly(result.statement) && (
                <button
                  className="ghost-btn"
                  onClick={() => void loadMore(tab.id, tab.activeResult ?? 0)}
                  title="Run the statement again with room for more rows"
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
              <button
                className={`ghost-btn${tab.transposed ? ' active' : ''}`}
                onClick={() => updateTab(tab.id, { transposed: !tab.transposed })}
                aria-pressed={Boolean(tab.transposed)}
                title={tab.transposed ? 'Show rows as rows again' : 'Show each row as a column, with the column names down the side'}
              >
                <ArrowRightLeft size={13} /> Transpose
              </button>
              <CopyMenu onCopy={(f) => void copy(f)} onSave={() => void save()} />
            </>
          )}
        </div>
      </div>
      {tab.running && <div className="progress" />}
      <div className="results-body">{body}</div>
      {viewing && (
        <Dialog
          title={`${viewing.field.name}`}
          onClose={() => setViewing(null)}
          width={680}
          footer={
            <>
              <span className="muted mono small">{viewing.field.type}</span>
              <button className="btn" onClick={() => void api.copyText(prettyValue(viewing.value, viewing.field))}>
                <Copy size={13} /> Copy
              </button>
            </>
          }
        >
          <pre className="value-view">{prettyValue(viewing.value, viewing.field)}</pre>
        </Dialog>
      )}
    </div>
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
