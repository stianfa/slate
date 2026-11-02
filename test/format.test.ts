import { describe, expect, it } from 'vitest'
import { formatSql } from '../src/renderer/src/editor/format'
import { parseTsv, toTsvRow } from '../src/renderer/src/lib/format'

describe('formatSql', () => {
  it('upper-cases keywords and breaks clauses onto lines', () => {
    expect(formatSql('select id, email from users where is_admin order by id')).toBe(
      'SELECT\n  id,\n  email\nFROM\n  users\nWHERE\n  is_admin\nORDER BY\n  id'
    )
  })

  it('keeps variables, casts and dollar-quoted bodies intact', () => {
    const out = formatSql("select :n::int + 1, $1 from t where name = :name; do $$ begin raise notice 'x;y'; end $$")
    expect(out).toContain(':n::int + 1')
    expect(out).toContain('$1')
    expect(out).toContain('name = :name')
    expect(out).toContain("$$ begin raise notice 'x;y'; end $$")
  })
})

describe('parseTsv', () => {
  it('reads rows copied from the grid, empty values as NULL', () => {
    const fields = ['id', 'name', 'note'].map((name) => ({ name, type: 'text', numeric: false, table: 0, column: 0 }))
    const text = [toTsvRow(['1', 'Ann', null], fields), toTsvRow(['2', 'Bo', 'x'], fields)].join('\n')
    expect(parseTsv(text)).toEqual([
      ['1', 'Ann', null],
      ['2', 'Bo', 'x']
    ])
  })

  it('takes one value, Windows line ends and a trailing line break', () => {
    expect(parseTsv('hello')).toEqual([['hello']])
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
    expect(parseTsv('')).toEqual([])
  })
})
