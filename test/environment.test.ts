import { describe, expect, it } from 'vitest'
import { isReadOnly } from '../src/shared/sql'
import { environmentOf } from '../src/shared/types'

describe('isReadOnly', () => {
  it('accepts reads and session commands', () => {
    for (const sql of [
      'select * from users',
      '(select 1) union (select 2)',
      'with x as (select 1) select * from x',
      "select * from users where note = 'please update me'",
      'select * from orders for update',
      'explain select * from users',
      'show search_path',
      'begin',
      'commit',
      'set statement_timeout = 0'
    ]) {
      expect(isReadOnly(sql), sql).toBe(true)
    }
  })

  it('flags writes, including hidden ones', () => {
    for (const sql of [
      'update users set is_admin = true',
      'delete from users',
      'insert into t values (1)',
      'truncate orders',
      'drop table users',
      'alter table users add column x int',
      'create index on users (email)',
      'with gone as (delete from users returning id) select count(*) from gone',
      'select * into backup from users',
      'explain analyze delete from users',
      'call do_things()',
      'do $$ begin end $$',
      'vacuum users'
    ]) {
      expect(isReadOnly(sql), sql).toBe(false)
    }
  })
})

describe('environmentOf', () => {
  const connection = { environment: 'staging' as const, databaseEnvironments: { app_prod: 'production' as const, scratch: 'none' as const } }
  it('prefers the database mark, then the connection mark', () => {
    expect(environmentOf(connection, 'app_prod')?.id).toBe('production')
    expect(environmentOf(connection, 'app')?.id).toBe('staging')
    expect(environmentOf(connection, 'scratch')).toBeNull()
    expect(environmentOf(undefined, 'x')).toBeNull()
  })
})
