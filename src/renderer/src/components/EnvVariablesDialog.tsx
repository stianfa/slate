import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { ENVIRONMENTS, type EnvironmentVariables } from '@shared/types'
import { VARIABLE_NAME } from '@shared/variables'
import { useStore } from '../store'
import { envStyle } from './environment'
import { Dialog } from './ui'

type Key = keyof EnvironmentVariables

interface Row {
  id: number
  name: string
  /** One value for every environment, kept in values.global. */
  global: boolean
  values: Partial<Record<Key, string>>
}

const KEYS: Key[] = ['global', ...ENVIRONMENTS.map((e) => e.id)]

let nextId = 1

const emptyRow = (): Row => ({ id: nextId++, name: '', global: false, values: {} })

function toRows(vars: EnvironmentVariables, suggest: string[]): Row[] {
  const names: string[] = []
  for (const key of KEYS) for (const name of Object.keys(vars[key] ?? {})) if (!names.includes(name)) names.push(name)
  // Variables from the query that triggered the dialog, ready to fill in.
  for (const name of suggest) if (!names.includes(name)) names.push(name)
  const rows = names.map((name) => ({
    id: nextId++,
    name,
    global: vars.global?.[name] !== undefined,
    values: Object.fromEntries(KEYS.map((k) => [k, vars[k]?.[name] ?? '']))
  }))
  return rows.length ? rows : [emptyRow()]
}

// Switching keeps what was typed: the first environment value becomes the global one, and the
// global value fills the environments that are still empty.
function setGlobal(row: Row, global: boolean): Row {
  const values = { ...row.values }
  if (global) values.global ||= ENVIRONMENTS.map((e) => values[e.id]).find(Boolean) ?? ''
  else for (const e of ENVIRONMENTS) values[e.id] ||= values.global ?? ''
  return { ...row, global, values }
}

/** Values for :name variables per environment, or one global value; a tab picks the column matching its database's mark. */
export function EnvVariablesDialog({ suggest = [] }: { suggest?: string[] }) {
  const settings = useStore((s) => s.settings)!
  const saveSettings = useStore((s) => s.saveSettings)
  const setDialog = useStore((s) => s.setDialog)
  const [rows, setRows] = useState<Row[]>(() => toRows(settings.environmentVariables, suggest))
  const [error, setError] = useState<string | null>(null)

  const close = () => setDialog(null)
  const update = (id: number, patch: (row: Row) => Row) => {
    setRows((all) => all.map((r) => (r.id === id ? patch(r) : r)))
    setError(null)
  }
  const cleanName = (name: string) => name.trim().replace(/^:/, '')

  const save = async () => {
    // A global row saves only its global value, other rows only their environment values.
    const valueOf = (r: Row, key: Key) => (r.global === (key === 'global') ? r.values[key] : undefined)
    const used = rows.filter((r) => cleanName(r.name) || KEYS.some((k) => valueOf(r, k)))
    const names = used.map((r) => cleanName(r.name))
    const invalid = names.find((n) => !VARIABLE_NAME.test(n))
    if (invalid !== undefined) return setError(invalid ? `":${invalid}" is not a valid variable name.` : 'Every variable needs a name.')
    const duplicate = names.find((n, i) => names.indexOf(n) !== i)
    if (duplicate) return setError(`:${duplicate} is listed twice.`)

    const environmentVariables: EnvironmentVariables = {}
    for (const key of KEYS) {
      const values: Record<string, string> = {}
      used.forEach((r, i) => {
        const value = valueOf(r, key)
        if (value) values[names[i]] = value
      })
      if (Object.keys(values).length) environmentVariables[key] = values
    }
    await saveSettings({ environmentVariables })
    close()
  }

  return (
    <Dialog
      title="Environment variables"
      onClose={close}
      width={820}
      footer={
        <>
          <span className="bad small">{error}</span>
          <div className="grow" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="muted small envvars-intro">
        Values for <span className="mono">:name</span> variables. A tab uses the column matching its database&rsquo;s
        environment, so the same query picks up the right values on test and production. A global variable has one value
        for every database, marked or not. A tab can still type its own value. Mark databases with an environment in
        their connection settings.
      </p>
      <div className="envvars">
        <div className="envvars-row head">
          <span>Variable</span>
          <span className="envvars-global-head">Global</span>
          {ENVIRONMENTS.map((e) => (
            <span key={e.id} className="envvars-env" style={envStyle(e)}>
              <span className="dot" style={{ background: e.color }} />
              {e.label}
            </span>
          ))}
          <span />
        </div>
        {rows.map((r) => (
          <div key={r.id} className="envvars-row">
            <div className="envvars-name">
              <span>:</span>
              <input
                value={r.name}
                onChange={(e) => update(r.id, (row) => ({ ...row, name: e.target.value }))}
                placeholder="name"
                spellCheck={false}
                aria-label="Variable name"
              />
            </div>
            <label className="envvars-global" title="Use one value in every environment">
              <input
                type="checkbox"
                checked={r.global}
                onChange={(ev) => update(r.id, (row) => setGlobal(row, ev.target.checked))}
                aria-label={`${cleanName(r.name) || 'variable'} is global`}
              />
            </label>
            {r.global ? (
              <input
                className="envvars-value envvars-value-global"
                value={r.values.global ?? ''}
                onChange={(ev) => update(r.id, (row) => ({ ...row, values: { ...row.values, global: ev.target.value } }))}
                placeholder="same value in every environment"
                spellCheck={false}
                aria-label={`${cleanName(r.name) || 'variable'} for every environment`}
              />
            ) : (
              ENVIRONMENTS.map((e) => (
                <input
                  key={e.id}
                  className="envvars-value"
                  value={r.values[e.id] ?? ''}
                  onChange={(ev) => update(r.id, (row) => ({ ...row, values: { ...row.values, [e.id]: ev.target.value } }))}
                  placeholder="not set"
                  spellCheck={false}
                  aria-label={`${cleanName(r.name) || 'variable'} for ${e.label}`}
                />
              ))
            )}
            <button
              className="icon-btn tiny"
              onClick={() => setRows((all) => all.filter((x) => x.id !== r.id))}
              aria-label={`Remove ${cleanName(r.name) || 'variable'}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="ghost-btn envvars-add" onClick={() => setRows((all) => [...all, emptyRow()])}>
          <Plus size={13} /> Add variable
        </button>
      </div>
    </Dialog>
  )
}
