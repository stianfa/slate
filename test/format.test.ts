import { describe, expect, it } from 'vitest'
import { formatSql } from '../src/renderer/src/editor/format'

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
