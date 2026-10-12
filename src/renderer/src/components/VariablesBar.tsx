import { useEffect, useMemo, useRef } from 'react'
import { Braces, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { findPlaceholders, uniqueVariables } from '@shared/variables'
import { useStore, type Tab } from '../store'
import { editorBridge } from './Editor'
import { EnvBadge, envStyle, useEnvironment } from './environment'

// Placeholder scanning runs on every keystroke; skip it for very large scripts.
const MAX_SCAN = 500_000

/** Inputs for the :name and $1 placeholders in the tab's SQL. Hidden when there are none. */
export function VariablesBar({ tab }: { tab: Tab }) {
  const setVariable = useStore((s) => s.setVariable)
  const setDialog = useStore((s) => s.setDialog)
  const environment = useEnvironment(tab.target)
  const envValues = useStore((s) => (environment ? s.settings?.environmentVariables[environment.id] : undefined))
  const globalValues = useStore((s) => s.settings?.environmentVariables.global)
  const variables = useMemo(
    () => (tab.sql.length > MAX_SCAN ? [] : uniqueVariables(findPlaceholders(tab.sql))),
    [tab.sql]
  )
  const inputs = useRef(new Map<string, HTMLInputElement>())

  // After a blocked run, jump to the first variable that needs a value.
  useEffect(() => {
    const first = tab.missingVariables?.[0]
    if (first) inputs.current.get(first)?.focus()
  }, [tab.blockedAt])

  if (variables.length === 0) return null

  return (
    <div className="vars" style={envStyle(environment)}>
      <span
        className="vars-label"
        title={'Type values without quotes: each is inserted as a quoted literal and Postgres converts it to the type the query needs.\nFor lists, write = any(:ids) and enter {1,2,3}. NULL sends NULL.'}
      >
        <Braces size={13} /> Variables
      </span>
      {variables.map((v) => {
        const own = tab.variables?.[v.key]
        // The environment's own value wins over a global one.
        const isGlobal = envValues?.[v.key] === undefined && globalValues?.[v.key] !== undefined
        const fromEnv = isGlobal ? globalValues?.[v.key] : envValues?.[v.key]
        const source = isGlobal ? 'global' : environment?.label
        const inherited = own === undefined && fromEnv !== undefined
        const value = own !== undefined ? own : fromEnv
        const isNull = value === null
        const missing = tab.missingVariables?.includes(v.key)
        return (
          <div
            key={v.key}
            className={`var${missing ? ' missing' : ''}${isNull ? ' is-null' : ''}${inherited ? ' inherited' : ''}${isGlobal ? ' global' : ''}`}
          >
            <span className="var-name">{v.label}</span>
            <input
              ref={(el) => {
                if (el) inputs.current.set(v.key, el)
                else inputs.current.delete(v.key)
              }}
              value={value ?? ''}
              placeholder={isNull ? 'NULL' : 'value'}
              disabled={isNull}
              size={Math.min(32, Math.max(8, (value ?? '').length + 1))}
              spellCheck={false}
              onChange={(e) => setVariable(tab.id, v.key, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  editorBridge.run(e.shiftKey ? 'all' : 'smart')
                }
              }}
              aria-label={`Value for ${v.label}`}
              title={inherited ? `${isGlobal ? 'Global value' : `From ${source}`}. Type to use a different value in this tab.` : undefined}
            />
            {inherited &&
              (isGlobal ? (
                <span className="env-badge global" title="Global variable">
                  GLOBAL
                </span>
              ) : (
                environment && <EnvBadge env={environment} />
              ))}
            {!inherited && fromEnv !== undefined && (
              <button
                className="var-reset"
                onClick={() => setVariable(tab.id, v.key, undefined)}
                title={`Use the ${source} value (${fromEnv})`}
                aria-label={`Use the ${source} value`}
              >
                <RotateCcw size={11} />
              </button>
            )}
            <button
              className="var-null"
              aria-pressed={isNull}
              title={isNull ? 'Sending NULL. Click to enter a value.' : 'Send NULL'}
              onClick={() => setVariable(tab.id, v.key, isNull ? '' : null)}
            >
              NULL
            </button>
          </div>
        )
      })}
      <button
        className="ghost-btn vars-env"
        onClick={() => setDialog({ type: 'envVariables', suggest: variables.filter((v) => !v.key.startsWith('$')).map((v) => v.key) })}
        title="Set values per environment (Local, Development, Test, Production) or globally"
      >
        <SlidersHorizontal size={12} /> Environment variables
      </button>
    </div>
  )
}
