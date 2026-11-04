import { describe, expect, it } from 'vitest'
import {
  bindVariables,
  findPlaceholders,
  quoteLiteral,
  resolveVariables,
  suggestValues,
  uniqueVariables
} from '../src/shared/variables'

const labels = (sql: string) => findPlaceholders(sql).map((p) => p.label)

describe('findPlaceholders', () => {
  it('finds named and positional placeholders', () => {
    expect(labels('select * from users where id = :user_id and org_id = $1')).toEqual([':user_id', '$1'])
  })

  it('ignores casts, slices, strings, comments and dollar-quoted bodies', () => {
    const sql = `select '2026-01-01'::date, arr[lo:hi], ':not', "x:y" -- :nope
      /* :nope */ from t where a = :yes; do $$ begin x := :inner; end $$`
    expect(labels(sql)).toEqual([':yes'])
  })

  it('allows a cast right after a variable', () => {
    expect(labels('select :n::int + 1')).toEqual([':n'])
  })

  it('leaves $1 alone in PREPARE and CREATE', () => {
    expect(labels('prepare p as select $1; select $1')).toEqual(['$1'])
    expect(findPlaceholders('prepare p as select $1; select $1')[0].from).toBe(31)
  })

  it('reports offsets into the whole script', () => {
    const sql = 'select 1;\nselect :a'
    const [p] = findPlaceholders(sql)
    expect(sql.slice(p.from, p.to)).toBe(':a')
  })

  it('lists each variable once, in order of first use', () => {
    expect(uniqueVariables(findPlaceholders('select :b, :a, :b, $2')).map((p) => p.key)).toEqual(['b', 'a', '$2'])
  })
})

describe('resolveVariables', () => {
  it('lets tab values override environment values', () => {
    const { values, sources } = resolveVariables({ limit: '5', tenant: '' }, { tenant: 'acme', region: 'eu' })
    expect(values).toEqual({ limit: '5', tenant: '', region: 'eu' })
    expect(sources).toEqual({ limit: 'tab', tenant: 'tab', region: 'environment' })
  })

  it('works without either side', () => {
    expect(resolveVariables(undefined, undefined).values).toEqual({})
    expect(resolveVariables(undefined, { a: '1' }).values).toEqual({ a: '1' })
  })
})

describe('quoteLiteral', () => {
  it('doubles quotes and escapes backslashes safely', () => {
    expect(quoteLiteral("o'brien")).toBe("'o''brien'")
    expect(quoteLiteral('a\\')).toBe("E'a\\\\'")
    expect(quoteLiteral('')).toBe("''")
  })
})

describe('bindVariables', () => {
  it('replaces placeholders with quoted literals', () => {
    const bound = bindVariables('select * from t where a = :a and b = :b or a2 = :a', { a: '1', b: "it's" })
    expect(bound.text).toBe("select * from t where a = '1' and b = 'it''s' or a2 = '1'")
    expect(bound.missing).toEqual([])
  })

  it('fills positional placeholders and NULL', () => {
    expect(bindVariables('select $1, :name', { $1: 'one', name: null }).text).toBe("select 'one', NULL")
  })

  it('reports missing values without rewriting', () => {
    const bound = bindVariables('select :a, :b', { a: '' })
    expect(bound.missing).toEqual([':a', ':b'])
    expect(bound.missingAt).toBe(7)
    expect(bound.text).toBe('select :a, :b')
  })

  it('maps positions in the rewritten text back to the original', () => {
    const statement = 'select :n, nope'
    const bound = bindVariables(statement, { n: 'a much longer value' })
    const inRewritten = bound.text.indexOf('nope')
    expect(statement.slice(bound.map(inRewritten), bound.map(inRewritten) + 4)).toBe('nope')
    expect(bound.map(bound.text.indexOf("'a much"))).toBe(statement.indexOf(':n'))
  })

  it('leaves statements without placeholders untouched', () => {
    expect(bindVariables('select 1::int', {})).toMatchObject({ text: 'select 1::int', missing: [] })
  })
})

describe('suggestValues', () => {
  const vars = { production: { org: 'acme' }, test: { org: 'test-42' }, global: { org: 'shared' } }

  it('lists the environment, global, history and other environments in that order', () => {
    expect(suggestValues('org', [{ org: '7' }, { org: '9' }], vars, 'production')).toEqual([
      { value: 'acme', source: 'production' },
      { value: 'shared', source: 'global' },
      { value: '7', source: 'history' },
      { value: '9', source: 'history' },
      { value: 'test-42', source: 'test' }
    ])
  })

  it('lists each value once, and leaves out NULL and empty values', () => {
    const got = suggestValues('org', [{ org: 'acme' }, { org: null }, { org: '' }, undefined, { other: 'x' }], vars, 'production')
    expect(got.map((s) => s.value)).toEqual(['acme', 'shared', 'test-42'])
  })

  it('works without an environment mark or settings', () => {
    expect(suggestValues('org', [{ org: '7' }], undefined, undefined)).toEqual([{ value: '7', source: 'history' }])
    expect(suggestValues('org', [], vars, undefined).map((s) => s.source)).toEqual(['global', 'test', 'production'])
  })

  it('gives positional parameters none, and stops at the limit', () => {
    expect(suggestValues('$1', [{ $1: '5' }], undefined, undefined)).toEqual([])
    const many = Array.from({ length: 30 }, (_, i) => ({ org: String(i) }))
    expect(suggestValues('org', many, undefined, undefined, 5)).toHaveLength(5)
  })
})
