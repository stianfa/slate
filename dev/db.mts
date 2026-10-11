// Local Postgres with sample data, no Docker needed: `npm run db`.
// postgres://slate:slate@localhost:55432/shop — Ctrl+C stops it; data lives in dev/.pgdata.
import EmbeddedPostgres from 'embedded-postgres'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { splitStatements } from '../src/shared/sql.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.pgdata')
const port = Number(process.env.SLATE_DEV_PG_PORT ?? 55432)
const fresh = !existsSync(join(dataDir, 'PG_VERSION'))

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'slate',
  password: 'slate',
  port,
  persistent: true,
  onLog: () => {}
})

if (fresh) await server.initialise()
try {
  await server.start()
} catch (e) {
  // embedded-postgres rejects without a reason when the data directory is already in use.
  console.error(
    `Could not start Postgres on port ${port}. It is probably already running ` +
      '(another terminal or the Projects manager launcher).' + (e ? `\n${e}` : '')
  )
  process.exit(1)
}

if (fresh) {
  await server.createDatabase('shop')
  const client = new pg.Client({ host: 'localhost', port, user: 'slate', password: 'slate', database: 'shop' })
  await client.connect()
  // One statement at a time: CREATE DATABASE cannot run inside the implicit transaction of a multi-statement query.
  for (const s of splitStatements(readFileSync(join(here, 'seed.sql'), 'utf8'))) await client.query(s.text)
  await client.end()
  console.log('Seeded sample data.')
}

console.log(`Postgres is running: postgres://slate:slate@localhost:${port}/shop`)

const stop = async () => {
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
