// Query variables: ":name" placeholders and "$1"-style positional parameters.
// Each value is inserted as a quoted string literal ('42', 'o''brien'), so it never needs
// quoting by hand and can't break out of the SQL. Postgres types an untyped literal from its
// context, which works in more places than bind parameters do: ":since is null" and
// "interval :d" fail with parameters ("could not determine data type") but work as literals.
import { isIdentChar, leadingKeyword, splitStatements, tokenize } from './sql'

export type VariableValues = Record<string, string | null>

export interface Placeholder {
  /** "user_id" for :user_id, "$1" for $1. */
  key: string
  /** As written: ":user_id" or "$1". */
  label: string
  from: number
  to: number
}

const NAMED = /:([A-Za-z_][A-Za-z0-9_]*)/g
const POSITIONAL = /\$([1-9][0-9]*)/g

// In these, $1 belongs to the statement itself (PREPARE, function bodies), not to us.
const OWN_PARAMETERS = new Set(['PREPARE', 'CREATE', 'DO'])

function scan(text: string, from: number, to: number, positional: boolean, base: number, out: Placeholder[]) {
  const code = text.slice(from, to)
  for (const m of code.matchAll(NAMED)) {
    const at = from + m.index
    // "a::int" is a cast and "arr[lo:hi]" a slice, not variables.
    if (text[at - 1] === ':' || isIdentChar(text[at - 1] ?? ' ')) continue
    out.push({ key: m[1], label: m[0], from: base + at, to: base + at + m[0].length })
  }
  if (!positional) return
  for (const m of code.matchAll(POSITIONAL)) {
    const at = from + m.index
    if (isIdentChar(text[at - 1] ?? ' ') || isIdentChar(text[at + m[0].length] ?? ' ')) continue
    out.push({ key: m[0], label: m[0], from: base + at, to: base + at + m[0].length })
  }
}

/** All placeholders outside strings, comments and dollar-quoted bodies, in document order. */
export function findPlaceholders(sql: string): Placeholder[] {
  const out: Placeholder[] = []
  for (const s of splitStatements(sql)) {
    const positional = !OWN_PARAMETERS.has(leadingKeyword(s.text))
    for (const t of tokenize(s.text)) {
      if (t.kind === 'code') scan(s.text, t.from, t.to, positional, s.from, out)
    }
  }
  return out.sort((a, b) => a.from - b.from)
}

/** One entry per variable, in order of first use. */
export function uniqueVariables(placeholders: Placeholder[]): Placeholder[] {
  const seen = new Set<string>()
  return placeholders.filter((p) => !seen.has(p.key) && seen.add(p.key))
}

export const isMissing = (value: string | null | undefined) => value === undefined || value === ''

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Combines a tab's own values with its environment's. A key the tab has set (even to '' or
 * NULL) wins; otherwise the environment's value applies. Sources say where each value came from.
 */
export function resolveVariables(tab: VariableValues | undefined, environment: VariableValues | undefined) {
  const values: VariableValues = { ...environment }
  const sources: Record<string, 'tab' | 'environment'> = {}
  for (const key of Object.keys(environment ?? {})) sources[key] = 'environment'
  for (const [key, value] of Object.entries(tab ?? {})) {
    values[key] = value
    sources[key] = 'tab'
  }
  return { values, sources }
}

/** A string literal that is safe whatever standard_conforming_strings is set to. */
export function quoteLiteral(value: string): string {
  const doubled = value.replace(/'/g, "''")
  return value.includes('\\') ? `E'${doubled.replace(/\\/g, '\\\\')}'` : `'${doubled}'`
}

export interface BoundStatement {
  /** The statement with every placeholder replaced by a literal or NULL. */
  text: string
  /** Labels of variables without a value. */
  missing: string[]
  /** Offset of the first placeholder with a missing value, relative to the statement. */
  missingAt: number | null
  /** Maps an offset in the rewritten text back to the original statement. */
  map(offset: number): number
}

/** Replaces the placeholders in one statement with their values. */
export function bindVariables(statement: string, values: VariableValues): BoundStatement {
  const placeholders = findPlaceholders(statement)
  if (placeholders.length === 0) return { text: statement, missing: [], missingAt: null, map: (o) => o }

  const missing: string[] = []
  let missingAt: number | null = null
  for (const p of uniqueVariables(placeholders)) {
    if (isMissing(values[p.key])) {
      missing.push(p.label)
      missingAt ??= p.from
    }
  }
  if (missing.length) return { text: statement, missing, missingAt, map: (o) => o }

  let text = ''
  let last = 0
  const spans: { origFrom: number; origTo: number; newFrom: number; newTo: number }[] = []
  for (const p of placeholders) {
    const value = values[p.key]
    const replacement = value === null || value === undefined ? 'NULL' : quoteLiteral(value)
    text += statement.slice(last, p.from)
    spans.push({ origFrom: p.from, origTo: p.to, newFrom: text.length, newTo: text.length + replacement.length })
    text += replacement
    last = p.to
  }
  text += statement.slice(last)

  const map = (offset: number) => {
    let delta = 0
    for (const s of spans) {
      if (offset < s.newFrom) break
      if (offset < s.newTo) return s.origFrom
      delta = s.origTo - s.newTo
    }
    return offset + delta
  }

  return { text, missing, missingAt, map }
}
