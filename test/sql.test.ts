import { describe, expect, it } from 'vitest'
import { quoteIdent, splitStatements, statementAt } from '../src/shared/sql'
import { cleanCompletion } from '../src/main/ai'

const texts = (sql: string) => splitStatements(sql).map((s) => s.text)

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('select 1;  select 2 ;\n\nselect 3')).toEqual(['select 1', 'select 2', 'select 3'])
  })

  it('ignores semicolons in strings, identifiers and comments', () => {
    const sql = `select 'a;b', "c;d" -- e;f\nfrom t /* g; /* nested; */ h; */ where x = ';';select 2`
    expect(texts(sql)).toEqual([`select 'a;b', "c;d" -- e;f\nfrom t /* g; /* nested; */ h; */ where x = ';'`, 'select 2'])
  })

  it('handles escaped quotes', () => {
    expect(texts(`select 'it''s;'; select E'a\\';b'; select 3`)).toEqual([`select 'it''s;'`, `select E'a\\';b'`, 'select 3'])
  })

  it('handles dollar quoting', () => {
    const fn = `create function f() returns int as $body$ begin return 1; end; $body$ language plpgsql`
    expect(texts(`${fn}; select $$a;b$$; select $1::int`)).toEqual([fn, 'select $$a;b$$', 'select $1::int'])
  })

  it('drops comment-only statements and leading comments', () => {
    expect(texts('-- just a comment\n;\n/* note */ select 1; -- trailing')).toEqual(['select 1'])
  })

  it('keeps offsets into the original text', () => {
    const sql = '  select 1;\n-- c\nselect 2;'
    const [a, b] = splitStatements(sql)
    expect(sql.slice(a.from, a.to)).toBe('select 1')
    expect(sql.slice(b.from, b.to)).toBe('select 2')
  })
})

describe('statementAt', () => {
  const sql = 'select 1;\n\nselect 2;\nselect 3'
  it('finds the statement under the cursor', () => {
    expect(statementAt(sql, 3)?.text).toBe('select 1')
    expect(statementAt(sql, sql.indexOf('2'))?.text).toBe('select 2')
    expect(statementAt(sql, sql.length)?.text).toBe('select 3')
  })
  it('treats the spot right after a semicolon as that statement', () => {
    expect(statementAt(sql, sql.indexOf(';') + 1)?.text).toBe('select 1')
  })
  it('falls back to the previous statement in trailing whitespace', () => {
    expect(statementAt('select 1;\n\n', 11)?.text).toBe('select 1')
  })
})

describe('quoteIdent', () => {
  it('quotes only when needed', () => {
    expect(quoteIdent('users')).toBe('users')
    expect(quoteIdent('user')).toBe('"user"')
    expect(quoteIdent('Orders')).toBe('"Orders"')
    expect(quoteIdent('a"b')).toBe('"a""b"')
  })
})

describe('cleanCompletion', () => {
  it('strips code fences and cursor markers', () => {
    expect(cleanCompletion('```sql\nwhere id = 1\n```', 'select * from t ', '')).toBe('where id = 1')
  })
  it('removes a restated partial word', () => {
    expect(cleanCompletion('users where', 'select * from us', '')).toBe('ers where')
  })
  it('removes a restated line', () => {
    expect(cleanCompletion('select * from users', 'select * from ', '')).toBe('users')
  })
  it('drops text that duplicates what follows the cursor', () => {
    expect(cleanCompletion('id, email)', 'select count(', ')')).toBe('id, email')
  })
  it('returns null for empty output', () => {
    expect(cleanCompletion('  \n', 'select ', '')).toBeNull()
  })
})
