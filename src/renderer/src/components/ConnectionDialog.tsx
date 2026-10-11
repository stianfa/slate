import { useState } from 'react'
import { CheckCircle2, Trash2, XCircle } from 'lucide-react'
import { ENVIRONMENTS, type ConnectionInput, type Environment, type SslMode, type TestResult } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { envStyle } from './environment'
import { Dialog, Field, Spinner } from './ui'

const COLORS = ['#7c9cff', '#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#fb923c', '#f87171', '#94a3b8']

const isLocal = (host: string) => /^(localhost|127\.0\.0\.1|::1|\[::1\]|host\.docker\.internal)$/i.test(host.trim())

/** Parses postgres://user:pass@host:port/db?sslmode=... or "host=... dbname=..." strings. */
export function parseConnectionString(text: string): Partial<ConnectionInput> | null {
  const s = text.trim()
  const url = /^postgres(?:ql)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?(?:\/([^?#]*))?(?:\?([^#]*))?/i.exec(s)
  const decode = (v: string | undefined) => (v === undefined ? undefined : decodeURIComponent(v))
  if (url) {
    const params = new URLSearchParams(url[6] ?? '')
    const result: Partial<ConnectionInput> = {
      user: decode(url[1]),
      password: decode(url[2]),
      host: decode(url[3])?.replace(/^\[|\]$/g, '') || undefined,
      port: url[4] ? Number(url[4]) : undefined,
      database: decode(url[5]) || undefined
    }
    const mode = params.get('sslmode')
    if (mode) result.ssl = sslFromLibpq(mode)
    return result
  }
  if (/\b(host|dbname|user)\s*=/.test(s)) {
    const kv: Record<string, string> = {}
    for (const m of s.matchAll(/(\w+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S+))/g)) kv[m[1]] = m[2] ?? m[3]
    return {
      host: kv.host,
      port: kv.port ? Number(kv.port) : undefined,
      user: kv.user,
      password: kv.password,
      database: kv.dbname,
      ssl: kv.sslmode ? sslFromLibpq(kv.sslmode) : undefined
    }
  }
  return null
}

function sslFromLibpq(mode: string): SslMode {
  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') return 'disable'
  if (mode === 'verify-full' || mode === 'verify-ca') return 'verify-full'
  return 'require'
}

export function ConnectionDialog({ id }: { id?: string }) {
  const existing = useStore((s) => s.connections.find((c) => c.id === id))
  const saveConnection = useStore((s) => s.saveConnection)
  const deleteConnection = useStore((s) => s.deleteConnection)
  const setDialog = useStore((s) => s.setDialog)
  const count = useStore((s) => s.connections.length)
  const server = useStore((s) => (id ? s.conn[id]?.server : undefined))

  const [form, setForm] = useState<ConnectionInput>(() =>
    existing
      ? { ...existing }
      : {
          name: '',
          color: COLORS[count % COLORS.length],
          host: 'localhost',
          port: 5432,
          user: 'postgres',
          database: 'postgres',
          ssl: 'disable'
        }
  )
  const [password, setPassword] = useState<string | undefined>(undefined)
  const [sslTouched, setSslTouched] = useState(Boolean(existing))
  const [url, setUrl] = useState('')
  const [urlError, setUrlError] = useState(false)
  const [test, setTest] = useState<TestResult | 'running' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const inherited = ENVIRONMENTS.find((e) => e.id === form.environment)
  const databases = [
    ...new Set([...(server?.databases ?? [form.database]), ...Object.keys(form.databaseEnvironments ?? {})])
  ].sort()
  const setDatabaseEnvironment = (db: string, value: Environment | 'none' | '') => {
    setForm((f) => {
      const marks = { ...f.databaseEnvironments }
      if (value) marks[db] = value
      else delete marks[db]
      return { ...f, databaseEnvironments: marks }
    })
  }

  const close = () => setDialog(null)
  const set = <K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setTest(null)
  }

  const input = (): ConnectionInput => ({
    ...form,
    id: existing?.id,
    name: form.name.trim() || `${form.database}@${form.host}`,
    host: form.host.trim(),
    user: form.user.trim(),
    database: form.database.trim() || 'postgres',
    port: Number(form.port) || 5432,
    password
  })

  const applyUrl = (text: string) => {
    setUrl(text)
    if (!text.trim()) return setUrlError(false)
    const parsed = parseConnectionString(text)
    setUrlError(!parsed)
    if (!parsed) return
    setForm((f) => {
      const next = { ...f }
      if (parsed.host) next.host = parsed.host
      if (parsed.port) next.port = parsed.port
      if (parsed.user) next.user = parsed.user
      if (parsed.database) next.database = parsed.database
      next.ssl = parsed.ssl ?? (parsed.host && !isLocal(parsed.host) ? 'require' : next.ssl)
      return next
    })
    if (parsed.password != null) setPassword(parsed.password)
    setSslTouched(true)
    setTest(null)
  }

  const runTest = async () => {
    setTest('running')
    setTest(await api.testConnection(input()))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveConnection(input())
      close()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!existing) return
    if (!confirmDelete) return setConfirmDelete(true)
    await deleteConnection(existing.id)
    close()
  }

  return (
    <Dialog
      title={existing ? 'Edit connection' : 'New connection'}
      onClose={close}
      width={540}
      footer={
        <>
          {existing && (
            <button className={`btn ${confirmDelete ? 'danger-solid' : 'danger'}`} onClick={() => void remove()}>
              <Trash2 size={13} /> {confirmDelete ? 'Click to confirm' : 'Delete'}
            </button>
          )}
          <div className="test-result">
            {test === 'running' && <Spinner />}
            {test && test !== 'running' && (
              <span className={test.ok ? 'ok' : 'bad'} title={test.message}>
                {test.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {test.message}
              </span>
            )}
            {error && <span className="bad">{error}</span>}
          </div>
          <button className="btn" onClick={() => void runTest()} disabled={test === 'running'}>
            Test
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {existing ? 'Save' : 'Connect'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field label="Connection URL" hint={urlError ? 'Not a postgres:// URL or key=value string' : 'Paste to fill in the fields below'}>
          <input
            className={urlError ? 'invalid' : ''}
            value={url}
            onChange={(e) => applyUrl(e.target.value)}
            placeholder="postgres://user:password@host:5432/database"
            spellCheck={false}
            autoFocus={!existing}
          />
        </Field>
        <div className="form-row">
          <Field label="Name">
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={`${form.database || 'postgres'}@${form.host || 'localhost'}`}
              autoFocus={Boolean(existing)}
            />
          </Field>
          <Field label="Color" group>
            <div className="swatches">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`swatch${form.color === c ? ' selected' : ''}`}
                  style={{ background: c }}
                  onClick={() => set('color', c)}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </Field>
        </div>
        <Field
          label="Environment"
          group
          hint={
            form.environment === 'production'
              ? 'Tabs turn red, and statements that change data or schema ask before they run.'
              : 'Tabs on this connection show the environment color, so you always know where you are.'
          }
        >
          <div className="env-picker">
            <button
              type="button"
              className={`env-option${form.environment ? '' : ' selected'}`}
              onClick={() => set('environment', undefined)}
            >
              None
            </button>
            {ENVIRONMENTS.map((e) => (
              <button
                type="button"
                key={e.id}
                className={`env-option${form.environment === e.id ? ' selected' : ''}`}
                style={envStyle(e)}
                onClick={() => setForm((f) => ({ ...f, environment: e.id, color: e.color }))}
              >
                <span className="dot" style={{ background: e.color }} />
                {e.label}
              </button>
            ))}
          </div>
        </Field>
        {existing && (
          <Field
            label="Per database"
            group
            hint={
              server
                ? 'Overrides for single databases, e.g. app_prod as Production on a shared server.'
                : 'Connect to list every database on this server.'
            }
          >
            <div className="db-envs">
              {databases.map((db) => (
                <div key={db} className="db-env-row">
                  <span className="mono">{db}</span>
                  <select
                    value={form.databaseEnvironments?.[db] ?? ''}
                    onChange={(e) => setDatabaseEnvironment(db, e.target.value as Environment | 'none' | '')}
                    aria-label={`Environment for ${db}`}
                  >
                    <option value="">
                      Same as connection{inherited ? ` (${inherited.label})` : ''}
                    </option>
                    <option value="none">None</option>
                    {ENVIRONMENTS.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </Field>
        )}
        <div className="form-row">
          <Field label="Host">
            <input
              value={form.host}
              onChange={(e) => set('host', e.target.value)}
              onBlur={() => !sslTouched && set('ssl', isLocal(form.host) ? 'disable' : 'require')}
              spellCheck={false}
            />
          </Field>
          <Field label="Port">
            <input
              className="port"
              value={form.port}
              onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '')) || ('' as unknown as number))}
              inputMode="numeric"
            />
          </Field>
        </div>
        <div className="form-row">
          <Field label="User">
            <input value={form.user} onChange={(e) => set('user', e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={password ?? ''}
              onChange={(e) => {
                setPassword(e.target.value)
                setTest(null)
              }}
              placeholder={existing?.hasPassword && password === undefined ? 'Saved (unchanged)' : ''}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Database">
            <input value={form.database} onChange={(e) => set('database', e.target.value)} spellCheck={false} />
          </Field>
          <Field label="SSL">
            <select
              value={form.ssl}
              onChange={(e) => {
                setSslTouched(true)
                set('ssl', e.target.value as SslMode)
              }}
            >
              <option value="disable">Off</option>
              <option value="require">Required</option>
              <option value="verify-full">Required, verify certificate</option>
            </select>
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
