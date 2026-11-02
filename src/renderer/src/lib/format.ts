import type { Cell, ResultField, StatementResult } from '@shared/types'

export const formatCount = (n: number) => n.toLocaleString('en-US')

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export function formatEstimate(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

const SHORT_TYPES: [RegExp, string][] = [
  [/timestamp(\(\d+\))? with time zone/, 'timestamptz$1'],
  [/timestamp(\(\d+\))? without time zone/, 'timestamp$1'],
  [/time(\(\d+\))? with time zone/, 'timetz$1'],
  [/time(\(\d+\))? without time zone/, 'time$1'],
  [/character varying/, 'varchar'],
  [/^character\b/, 'char'],
  [/double precision/, 'float8'],
  [/bit varying/, 'varbit']
]

/** Compact spelling of Postgres type names for tight spaces. */
export function shortType(type: string): string {
  return SHORT_TYPES.reduce((t, [pattern, short]) => t.replace(pattern, short), type)
}

export function summarize(r: StatementResult): string {
  if (r.fields.length) {
    if (r.truncated) return `First ${formatCount(r.rows.length)} rows`
    return `${formatCount(r.rows.length)} ${r.rows.length === 1 ? 'row' : 'rows'}`
  }
  return r.rowCount !== null ? `${r.command} ${formatCount(r.rowCount)}` : r.command
}

const isJson = (f: ResultField) => f.type === 'json' || f.type === 'jsonb'

function typed(value: Cell, field: ResultField): unknown {
  if (value === null) return null
  if (field.type === 'bool') return value === 't'
  if (field.numeric && field.type !== 'int8' && field.type !== 'numeric' && field.type !== 'money') {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  if (isJson(field)) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

export function displayValue(value: string, field: ResultField): string {
  if (field.type === 'bool') return value === 't' ? 'true' : value === 'f' ? 'false' : value
  return value
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function toCsv(r: StatementResult): string {
  const lines = [r.fields.map((f) => csvEscape(f.name)).join(',')]
  for (const row of r.rows) {
    lines.push(row.map((v, i) => (v === null ? '' : csvEscape(displayValue(v, r.fields[i])))).join(','))
  }
  return lines.join('\n')
}

export function toJson(r: StatementResult): string {
  const rows = r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name, typed(row[i], f)])))
  return JSON.stringify(rows, null, 2)
}

export function toMarkdown(r: StatementResult): string {
  const esc = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const header = `| ${r.fields.map((f) => esc(f.name)).join(' | ')} |`
  const rule = `| ${r.fields.map((f) => (f.numeric ? '---:' : '---')).join(' | ')} |`
  const body = r.rows.map(
    (row) => `| ${row.map((v, i) => (v === null ? 'NULL' : esc(displayValue(v, r.fields[i])))).join(' | ')} |`
  )
  return [header, rule, ...body].join('\n')
}

export function toTsvRow(row: Cell[], fields: ResultField[]): string {
  return row.map((v, i) => (v === null ? '' : displayValue(v, fields[i]).replace(/[\t\n]/g, ' '))).join('\t')
}

/** Rows of tab-separated text, as copied from a grid or a spreadsheet. Empty values read as NULL. */
export function parseTsv(text: string): Cell[][] {
  if (!text) return []
  return text
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .map((line) => line.split('\t').map((v) => (v === '' ? null : v)))
}

export function prettyValue(value: string, field: ResultField): string {
  if (isJson(field)) {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return displayValue(value, field)
}

/** Line and column (1-based) of an offset in text. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, col: offset - before.lastIndexOf('\n') }
}
