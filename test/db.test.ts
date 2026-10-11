// Runs against the sample database from `npm run db`; skipped when it isn't running.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { DbManager } from '../src/main/db'
import { describeSchema } from '../src/main/schemaText'
import type { ConnectionConfig } from '../src/shared/types'

const port = Number(process.env.SLATE_DEV_PG_PORT ?? 55432)
const config: ConnectionConfig = {
  id: 'local',
  name: 'local',
  color: '#fff',
  host: 'localhost',
  port,
  user: 'slate',
  database: 'shop',
  ssl: 'disable',
  hasPassword: true
}
const target = { connectionId: 'local', database: 'shop' }

async function reachable() {
  const client = new pg.Client({ host: 'localhost', port, user: 'slate', password: 'slate', database: 'shop' })
  try {
    await client.connect()
    await client.end()
    return true
  } catch {
    return false
  }
}

const up = await reachable()

describe.skipIf(!up)('DbManager against the sample database', () => {
  const db = new DbManager(() => ({ config, password: 'slate' }))

  beforeAll(async () => {
    await db.connect('local')
  })
  afterAll(async () => {
    await db.closeAll()
  })

  it('lists databases and the server version', async () => {
    const info = await db.connect('local')
    expect(info.databases).toEqual(expect.arrayContaining(['shop', 'scratch']))
    expect(info.version).toMatch(/^\d+/)
  })

  it('introspects tables, keys and enums', async () => {
    const schema = await db.schema(target)
    const users = schema.tables.find((t) => t.name === 'users')!
    expect(users.columns.find((c) => c.name === 'id')?.pk).toBe(true)
    expect(users.columns.find((c) => c.name === 'org_id')?.fk).toEqual({ schema: 'public', table: 'organizations', column: 'id' })
    expect(schema.tables.find((t) => t.name === 'revenue_by_org')?.kind).toBe('view')
    expect(schema.tables.find((t) => t.schema === 'analytics' && t.name === 'events')).toBeTruthy()
    expect(schema.enums).toContainEqual({ schema: 'public', name: 'order_status', labels: ['pending', 'paid', 'shipped', 'cancelled'] })
    const text = describeSchema(schema, { database: 'shop', version: '17', editorText: '' })
    expect(text).toContain('public.users: id bigint PK, org_id integer NOT NULL -> public.organizations.id')
  })

  it('runs scripts, keeps values as text and caps rows', async () => {
    const r = await db.run('t1', target, "select 1 as a, 'x;y' as b; select id, is_admin, settings, created_at from users order by id", 50)
    expect(r.error).toBeNull()
    expect(r.results).toHaveLength(2)
    expect(r.results[0].rows).toEqual([['1', 'x;y']])
    const users = r.results[1]
    expect(users.truncated).toBe(true)
    expect(users.rows).toHaveLength(50)
    expect(users.fields.map((f) => f.type)).toEqual(['int8', 'bool', 'jsonb', 'timestamptz'])
    expect(users.fields[0].numeric).toBe(true)
    expect(users.rows[0][1]).toBe('f')
  })

  it('reports errors with an absolute position and keeps earlier results', async () => {
    const sql = 'select 1;\nselect nope from users'
    const r = await db.run('t2', target, sql, 100)
    expect(r.results).toHaveLength(1)
    expect(r.error?.code).toBe('42703')
    expect(sql.slice(r.error!.position!, r.error!.position! + 4)).toBe('nope')
  })

  it('keeps a session per tab so transactions span runs', async () => {
    let r = await db.run('t3', target, 'begin; update organizations set plan = plan where id = 1', 100)
    expect(r.txStatus).toBe('transaction')
    expect(r.results[1].command).toBe('UPDATE')
    expect(r.results[1].rowCount).toBe(1)
    r = await db.run('t3', target, 'select nope', 100)
    expect(r.txStatus).toBe('failed')
    r = await db.run('t3', target, 'rollback', 100)
    expect(r.txStatus).toBe('idle')
  })

  it('captures notices and DDL results', async () => {
    const r = await db.run('t4', target, "do $$ begin raise notice 'hello %', 42; end $$; create temp table tmp_x (id int)", 100)
    expect(r.error).toBeNull()
    expect(r.notices).toEqual(['NOTICE: hello 42'])
    expect(r.results[1]).toMatchObject({ command: 'CREATE', rowCount: null, fields: [] })
  })

  it('cancels a running query', async () => {
    const running = db.run('t5', target, 'select pg_sleep(10)', 100)
    await new Promise((r) => setTimeout(r, 300))
    await db.cancel('t5')
    const r = await running
    expect(r.error?.code).toBe('57014')
    const after = await db.run('t5', target, 'select 1', 100)
    expect(after.error).toBeNull()
  })

  it('binds variables as parameters', async () => {
    const r = await db.run(
      't7',
      target,
      "select :n::int + 1 as next, :email as email, :missing_ok is null as is_null; select count(*) from users where id = any(:ids)",
      100,
      { n: '41', email: "o'brien@example.com", missing_ok: null, ids: '{1,2,3}' }
    )
    expect(r.error).toBeNull()
    expect(r.results[0].rows).toEqual([['42', "o'brien@example.com", 't']])
    expect(r.results[1].rows).toEqual([['3']])
  })

  it('maps error positions back through variable rewriting', async () => {
    const sql = 'select :long_variable_name, nope from users'
    const r = await db.run('t8', target, sql, 100, { long_variable_name: 'x' })
    expect(r.error?.code).toBe('42703')
    expect(sql.slice(r.error!.position!, r.error!.position! + 4)).toBe('nope')
  })

  it('refuses to run with a missing variable', async () => {
    const r = await db.run('t9', target, 'select 1; select :absent', 100, {})
    expect(r.results).toHaveLength(1)
    expect(r.error?.message).toContain(':absent')
  })

  it('makes the server refuse writes in read-only runs, including hidden ones', async () => {
    const readOnly = { readOnly: true }
    // A function that writes, called from a SELECT the client can't see into.
    let r = await db.run(
      't10',
      target,
      'create function pg_temp.touch_org() returns int language sql as $$ update organizations set plan = plan where id = 1 returning id $$',
      100
    )
    expect(r.error).toBeNull()
    r = await db.run('t10', target, 'select count(*) from organizations', 100, {}, readOnly)
    expect(r.error).toBeNull()
    r = await db.run('t10', target, 'update organizations set plan = plan where id = 1', 100, {}, readOnly)
    expect(r.error?.code).toBe('25006')
    r = await db.run('t10', target, 'select pg_temp.touch_org()', 100, {}, readOnly)
    expect(r.error?.code).toBe('25006')
    // A confirmed run turns writes back on for the same session.
    r = await db.run('t10', target, 'select pg_temp.touch_org()', 100, {}, { readOnly: false })
    expect(r.error).toBeNull()
    expect(r.results[0].rows).toEqual([['1']])
  })

  it('tracks open transactions and reports one lost with its connection', async () => {
    await db.run('t11', target, 'begin', 100)
    expect(db.openTransactions()).toContainEqual(target)
    const pid = (await db.run('t11', target, 'select pg_backend_pid()', 100)).results[0].rows[0][0]

    // Kill the session's server process from outside, as a network drop or server restart would.
    const killer = new pg.Client({ host: 'localhost', port, user: 'slate', password: 'slate', database: 'shop' })
    await killer.connect()
    await killer.query('select pg_terminate_backend($1)', [pid])
    await killer.end()
    await new Promise((r) => setTimeout(r, 300))

    let r = await db.run('t11', target, 'select 1', 100)
    expect(r.error?.message).toContain('rolled it back')
    expect(r.results).toHaveLength(0)
    r = await db.run('t11', target, 'select 1', 100)
    expect(r.error).toBeNull()
    expect(db.openTransactions()).not.toContainEqual(target)
  })

  it('switches database when the tab target changes', async () => {
    const r = await db.run('t6', { connectionId: 'local', database: 'scratch' }, 'select current_database()', 100)
    expect(r.results[0].rows).toEqual([['scratch']])
  })
})
