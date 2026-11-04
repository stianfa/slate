import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { ENVIRONMENTS } from '@shared/types'
import { findPlaceholders, suggestValues, uniqueVariables, type ValueSuggestion } from '@shared/variables'
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
  const allTabs = useStore((s) => s.tabs)
  const environmentVariables = useStore((s) => s.settings?.environmentVariables)
  // Values each variable has in other history entries and environments, for the list under its field.
  const suggestions = useMemo(() => {
    const history = allTabs
      .filter((t) => t.id !== tab.id && t.variables)
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .map((t) => t.variables)
    return new Map(variables.map((v) => [v.key, suggestValues(v.key, history, environmentVariables, environment?.id)]))
  }, [allTabs, tab.id, variables, environmentVariables, environment?.id])
  /** The open list: whose it is, the typed text it is filtered by (null shows all), and the highlighted item. */
  const [list, setList] = useState<{ key: string; filter: string | null; active: number } | null>(null)

  // After a blocked run, jump to the first variable that needs a value, with its known values open.
  useEffect(() => {
    const first = tab.missingVariables?.[0]
    if (!first) return
    inputs.current.get(first)?.focus()
    if (suggestions.get(first)?.length) setList({ key: first, filter: null, active: -1 })
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
        const known = suggestions.get(v.key) ?? []
        const open = list?.key === v.key ? list : null
        const shown = open ? matching(known, open.filter) : []
        // Picking the inherited value goes back to it rather than copying it into the tab.
        const pick = (picked: string) => {
          setVariable(tab.id, v.key, picked === fromEnv ? undefined : picked)
          setList(null)
        }
        const listId = `var-values-${v.key}`
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
              role={known.length ? 'combobox' : undefined}
              aria-expanded={known.length ? shown.length > 0 : undefined}
              aria-controls={shown.length ? listId : undefined}
              aria-autocomplete={known.length ? 'list' : undefined}
              onChange={(e) => {
                setVariable(tab.id, v.key, e.target.value)
                if (known.length) setList({ key: v.key, filter: e.target.value, active: -1 })
              }}
              onClick={() => known.length && setList(open ? null : { key: v.key, filter: null, active: -1 })}
              onBlur={() => setList((l) => (l?.key === v.key ? null : l))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  if (!known.length) return
                  e.preventDefault()
                  if (!open) return setList({ key: v.key, filter: null, active: 0 })
                  const step = e.key === 'ArrowDown' ? 1 : -1
                  setList({ ...open, active: Math.max(-1, Math.min(shown.length - 1, open.active + step)) })
                } else if (e.key === 'Escape' && shown.length) {
                  e.preventDefault()
                  e.stopPropagation()
                  setList(null)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  // Enter picks the highlighted value; with nothing highlighted it runs, as before.
                  if (open && shown[open.active]) return pick(shown[open.active].value)
                  setList(null)
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
            {known.length > 0 && !isNull && (
              <button
                className="var-open"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  inputs.current.get(v.key)?.focus()
                  setList(open ? null : { key: v.key, filter: null, active: -1 })
                }}
                title="Values used before"
                aria-label={`Values used before for ${v.label}`}
              >
                <ChevronDown size={12} />
              </button>
            )}
            {open && shown.length > 0 && inputs.current.get(v.key) && (
              <ValueList
                id={listId}
                anchor={inputs.current.get(v.key)!.closest('.var') as HTMLElement}
                items={shown}
                current={value}
                active={open.active}
                onPick={pick}
                onClose={() => setList(null)}
              />
            )}
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

/** The known values that contain the typed text; all of them when nothing was typed since opening. */
function matching(items: ValueSuggestion[], filter: string | null) {
  if (!filter) return items
  const needle = filter.toLowerCase()
  return items.filter((s) => s.value.toLowerCase().includes(needle))
}

/**
 * Values a variable has elsewhere, under its field. Rendered into the body so the bar's
 * scrolling and clipping don't cut it off; it closes when the bar scrolls or the window resizes.
 */
function ValueList({
  id,
  anchor,
  items,
  current,
  active,
  onPick,
  onClose
}: {
  id: string
  anchor: HTMLElement
  items: ValueSuggestion[]
  current: string | null | undefined
  active: number
  onPick(value: string): void
  onClose(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; minWidth: number } | null>(null)

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect()
    const width = root.current?.offsetWidth ?? rect.width
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 4,
      minWidth: rect.width
    })
  }, [anchor, items])

  useEffect(() => {
    const onScroll = (e: Event) => !root.current?.contains(e.target as Node) && onClose()
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  useEffect(() => {
    root.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return createPortal(
    <div
      ref={root}
      id={id}
      className="var-values"
      role="listbox"
      style={position ?? { visibility: 'hidden' }}
      // Keep focus in the field, so typing and the arrow keys still work.
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        const env = ENVIRONMENTS.find((e) => e.id === item.source)
        return (
          <div
            key={item.value}
            role="option"
            aria-selected={i === active}
            className={`var-value${i === active ? ' active' : ''}${item.value === current ? ' current' : ''}`}
            title={item.value}
            onClick={() => onPick(item.value)}
          >
            <span className="var-value-text">{item.value}</span>
            {env ? (
              <EnvBadge env={env} />
            ) : (
              item.source === 'global' && <span className="env-badge global">GLOBAL</span>
            )}
          </div>
        )
      })}
    </div>,
    document.body
  )
}
