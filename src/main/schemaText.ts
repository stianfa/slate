import type { SchemaInfo, TableInfo } from '@shared/types'

// Roughly 25k tokens. Bigger schemas keep full detail only for the tables the
// editor mentions and list the rest by name.
const BUDGET = 100_000

function describeTable(t: TableInfo): string {
  const kind = t.kind === 'table' ? '' : ` (${t.kind})`
  const columns = t.columns.map((c) => {
    let s = `${c.name} ${c.type}`
    if (c.pk) s += ' PK'
    else if (!c.nullable) s += ' NOT NULL'
    if (c.fk) s += ` -> ${c.fk.schema}.${c.fk.table}.${c.fk.column}`
    return s
  })
  return `${t.schema}.${t.name}${kind}: ${columns.join(', ')}`
}

export function describeSchema(
  schema: SchemaInfo,
  context: { database: string; version: string | null; editorText: string }
): string {
  const header = `Database "${context.database}"${context.version ? ` on PostgreSQL ${context.version}` : ''}.`
  const enums = schema.enums.map((e) => `${e.schema}.${e.name}: ${e.labels.map((l) => `'${l}'`).join(', ')}`)
  const full = schema.tables.map(describeTable)

  const parts = [header, '', 'Tables and views (schema.name: columns):', ...full]
  if (enums.length) parts.push('', 'Enum types:', ...enums)
  const text = parts.join('\n')
  if (text.length <= BUDGET) return text

  const mentioned = context.editorText.toLowerCase()
  const detailed: string[] = []
  const brief: string[] = []
  let used = header.length + enums.join('\n').length
  schema.tables.forEach((t, i) => {
    if (mentioned.includes(t.name.toLowerCase()) && used + full[i].length < BUDGET * 0.8) {
      detailed.push(full[i])
      used += full[i].length
    } else {
      brief.push(`${t.schema}.${t.name}`)
    }
  })
  return [
    header,
    '',
    'Tables mentioned in the editor (schema.name: columns):',
    ...detailed,
    '',
    'Other tables and views (columns omitted):',
    brief.join(', ').slice(0, Math.max(0, BUDGET - used)),
    ...(enums.length ? ['', 'Enum types:', ...enums] : [])
  ].join('\n')
}
