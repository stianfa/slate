import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { ENVIRONMENTS, type Environment, type EnvironmentVariables } from '@shared/types'
import { VARIABLE_NAME } from '@shared/variables'
import { useStore } from '../store'
import { envStyle } from './environment'
import { Dialog } from './ui'

interface Row {
  id: number
  name: string
  values: Partial<Record<Environment, string>>
}

let nextId = 1

function toRows(vars: EnvironmentVariables, suggest: string[]): Row[] {
  const names: string[] = []
  for (const env of ENVIRONMENTS) for (const name of Object.keys(vars[env.id] ?? {})) if (!names.includes(name)) names.push(name)
  // Variables from the query that triggered the dialog, ready to fill in.
  for (const name of suggest) if (!names.includes(name)) names.push(name)
  const rows = names.map((name) => ({
    id: nextId++,
    name,
    values: Object.fromEntries(ENVIRONMENTS.map((e) => [e.id, vars[e.id]?.[name] ?? '']))
  }))
  return rows.length ? rows : [{ id: nextId++, name: '', values: {} }]
}

/** Values for :name variables per environment; a tab picks the column matching its database's mark. */
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
    const used = rows.filter((r) => cleanName(r.name) || Object.values(r.values).some(Boolean))
    const names = used.map((r) => cleanName(r.name))
    const invalid = names.find((n) => !VARIABLE_NAME.test(n))
    if (invalid !== undefined) return setError(invalid ? `":${invalid}" is not a valid variable name.` : 'Every variable needs a name.')
    const duplicate = names.find((n, i) => names.indexOf(n) !== i)
    if (duplicate) return setError(`:${duplicate} is listed twice.`)

    const environmentVariables: EnvironmentVariables = {}
    for (const env of ENVIRONMENTS) {
      const values: Record<string, string> = {}
      used.forEach((r, i) => {
        const value = r.values[env.id]
        if (value) values[names[i]] = value
      })
      if (Object.keys(values).length) environmentVariables[env.id] = values
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
        environment, so the same query picks up the right values on test and production. A tab can still type its own
        value. Mark databases with an environment in their connection settings.
      </p>
      <div className="envvars">
        <div className="envvars-row head">
          <span>Variable</span>
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
            {ENVIRONMENTS.map((e) => (
              <input
                key={e.id}
                className="envvars-value"
                value={r.values[e.id] ?? ''}
                onChange={(ev) => update(r.id, (row) => ({ ...row, values: { ...row.values, [e.id]: ev.target.value } }))}
                placeholder="not set"
                spellCheck={false}
                aria-label={`${cleanName(r.name) || 'variable'} for ${e.label}`}
              />
            ))}
            <button
              className="icon-btn tiny"
              onClick={() => setRows((all) => all.filter((x) => x.id !== r.id))}
              aria-label={`Remove ${cleanName(r.name) || 'variable'}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="ghost-btn envvars-add" onClick={() => setRows((all) => [...all, { id: nextId++, name: '', values: {} }])}>
          <Plus size={13} /> Add variable
        </button>
      </div>
    </Dialog>
  )
}
