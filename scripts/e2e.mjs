// Drives the built app with Playwright against the sample database (`npm run db`).
// The Anthropic API is replaced by a local mock via ANTHROPIC_BASE_URL, so no key is needed.
// Screenshots land in test-results/e2e.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const shots = join(process.cwd(), 'test-results', 'e2e')
mkdirSync(shots, { recursive: true })
const port = process.env.SLATE_DEV_PG_PORT ?? '55432'

// ---- Mock Anthropic API ----
const aiRequests = []
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = JSON.parse(body || '{}')
    aiRequests.push({ url: req.url, headers: req.headers, body: json })
    const prompt = JSON.stringify(json.messages ?? [])
    let text = 'OK'
    if (prompt.includes('<cursor/>')) {
      text = prompt.includes('from users <cursor/>') ? 'where is_admin = true' : ''
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: json.model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    )
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockUrl = `http://127.0.0.1:${mock.address().port}`

const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
const downloads = mkdtempSync(join(tmpdir(), 'slate-e2e-downloads-'))
const app = await _electron.launch({
  // SLATE_EXE runs the suite against a packaged build, e.g. dist/win-unpacked/Slate.exe.
  executablePath: process.env.SLATE_EXE || electronPath,
  args: process.env.SLATE_EXE ? [] : ['.'],
  env: {
    ...process.env,
    SLATE_USER_DATA: userData,
    ANTHROPIC_BASE_URL: mockUrl,
    ANTHROPIC_API_KEY: 'test-key',
    ELECTRON_RENDERER_URL: ''
  }
})

const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `)
  await fn()
  console.log('ok')
}
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function setEditor(text) {
  await page.locator('.cm-content').click()
  await page.keyboard.press(`${mod}+A`)
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
  await page.keyboard.press('Escape')
}

try {
  // Theme follows the OS by default; show the dark look first, light at the end.
  await page.emulateMedia({ colorScheme: 'dark' })

  await step('welcome screen', async () => {
    await page.getByText('Connect to PostgreSQL').waitFor()
    await shot('01-welcome')
  })

  await step('add a connection from a URL', async () => {
    await page.getByRole('button', { name: 'New connection' }).first().click()
    await page.getByPlaceholder('postgres://user:password@host:5432/database').fill(`postgres://slate:slate@localhost:${port}/shop`)
    await page.locator('.field', { hasText: 'Name' }).locator('input').fill('Local shop')
    await page.getByRole('button', { name: 'Test' }).click()
    await page.getByText(/Connected · PostgreSQL/).waitFor()
    await shot('02-connection-dialog')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
  })

  await step('browse tables and columns', async () => {
    await page.locator('.tree-row', { hasText: 'order_items' }).waitFor()
    await page.locator('.tree-row', { hasText: /^users/ }).first().click()
    await page.locator('.tree-row.column', { hasText: 'email' }).waitFor()
    await page.locator('.tree-row.schema', { hasText: 'analytics' }).waitFor()
  })

  await step('double-click a table to query it', async () => {
    await page.locator('.tree-row', { hasText: /^orders/ }).first().dblclick()
    await page.locator('.grid-head', { hasText: 'status' }).waitFor()
    await page.locator('.results-summary', { hasText: '100 rows' }).waitFor()
    const tab = await page.locator('.history-item.active .history-title').textContent()
    if (tab !== 'orders') throw new Error(`tab title was ${tab}`)
    await shot('03-table-rows')
  })

  await step('run the statement under the cursor', async () => {
    await page.getByRole('button', { name: 'New query', exact: true }).click()
    await setEditor('select 1 as one;\n\nselect u.email, u.is_admin, u.settings, u.last_seen\nfrom users u\nwhere u.is_admin\norder by u.id;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.grid-head', { hasText: 'settings' }).waitFor()
    await page.locator('.results-summary', { hasText: '117 rows' }).waitFor()
    await page.locator('.grid-cell .null').first().waitFor()
  })

  await step('copy and inspect values', async () => {
    await page.locator('.grid-row').first().locator('.grid-cell').nth(2).dblclick()
    await page.locator('.value-view').waitFor()
    const value = await page.locator('.value-view').textContent()
    if (!value.includes('\n  "beta"')) throw new Error(`json not pretty printed: ${value}`)
    await page.keyboard.press('Escape')
  })

  await step('show errors with their position', async () => {
    await setEditor('select id, nope from users;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.error-card', { hasText: 'column "nope" does not exist' }).waitFor()
    await page.getByText('Line 1, column 12').waitFor()
    await page.locator('.cm-sql-error', { hasText: 'nope' }).waitFor()
    await shot('04-error')
  })

  await step('run a whole script with several results', async () => {
    await setEditor("create temp table t(x int);\ninsert into t values (1), (2), (3);\nselect * from t;\ndo $$ begin raise notice 'done'; end $$;")
    await page.keyboard.press(`${mod}+Shift+Enter`)
    await page.locator('.result-tab').nth(3).waitFor()
    await page.locator('.result-tab', { hasText: 'INSERT 3' }).waitFor()
    await page.locator('.result-tab', { hasText: '3 rows' }).click()
    await page.locator('.grid-head', { hasText: 'x' }).waitFor()
  })

  await step('track transactions across runs', async () => {
    await setEditor("begin; update organizations set plan = 'team' where id = 1;")
    await page.keyboard.press(`${mod}+Shift+Enter`)
    await page.locator('.tx-badge', { hasText: 'Transaction open' }).waitFor()
    await shot('05-transaction')
    await page.locator('.tx-badge').getByRole('button', { name: 'Rollback' }).click()
    await page.locator('.tx-badge').waitFor({ state: 'detached' })
  })

  await step('variables prompt for values and run', async () => {
    await setEditor('select id, email, is_admin from users\nwhere id = :user_id and is_admin = :admin;')
    await page.locator('.var', { hasText: ':user_id' }).waitFor()
    await page.locator('.cm-variable', { hasText: ':admin' }).waitFor()
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.error-card', { hasText: 'No value for :user_id, :admin' }).waitFor()
    await page.locator('.var.missing', { hasText: ':user_id' }).waitFor()
    // The first missing variable gets focus, so typing fills it in.
    await page.keyboard.type('34')
    await page.locator('.var', { hasText: ':admin' }).locator('input').fill('true')
    await page.keyboard.press('Enter')
    await page.locator('.results-summary', { hasText: '1 row' }).waitFor()
    const email = await page.locator('.grid-row').first().locator('.grid-cell').nth(1).textContent()
    if (email !== 'user34@example.com') throw new Error(`got ${email}`)
    await shot('09-variables')
  })

  await step('AI ghost text completes the query', async () => {
    await page.getByRole('button', { name: 'New query', exact: true }).click()
    await page.locator('.cm-content').click()
    await page.keyboard.type('select email from users ', { delay: 15 })
    await page.locator('.cm-ghost', { hasText: 'where is_admin = true' }).waitFor({ timeout: 10000 })
    await shot('06-ai-suggestion')
    await page.keyboard.press('Tab')
    const doc = await page.locator('.cm-content').textContent()
    if (!doc.includes('select email from users where is_admin = true')) throw new Error(`doc was: ${doc}`)
    const completion = aiRequests.find((r) => JSON.stringify(r.body.messages).includes('<cursor/>'))
    if (!completion) throw new Error('no completion request reached the mock')
    if (completion.body.model !== 'claude-opus-5-5') throw new Error(`model ${completion.body.model}`)
    if (completion.body.fallbacks !== 'default') throw new Error('fallbacks not set')
    if (!String(completion.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01')) throw new Error('beta header missing')
    if (!completion.body.system[0].text.includes('public.users: id bigint PK')) throw new Error('schema missing from prompt')
    if (completion.headers['x-api-key'] !== 'test-key') throw new Error('api key not sent')
  })

  await step('schema completion offers columns', async () => {
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.press('Delete')
    await page.keyboard.type('select * from organizations where pl', { delay: 10 })
    await page.locator('.cm-tooltip-autocomplete li[aria-selected]', { hasText: 'plan' }).waitFor()
    await shot('07-autocomplete')
    await page.keyboard.press('Escape')
  })

  await step('database diagram', async () => {
    await page.locator('.toolbar').getByTitle('Database diagram').click()
    await page.locator('.dg-table[data-table="public.users"]').waitFor()
    // users.org_id, orders.user_id, order_items x2, analytics.events.user_id
    await page.getByText('7 tables · 5 relationships').waitFor()
    await page.waitForTimeout(300)
    await shot('10-diagram')

    await page.locator('.dg-table[data-table="public.orders"]').hover()
    await shot('11-diagram-hover')

    const products = page.locator('.dg-table[data-table="public.products"]')
    const before = await products.getAttribute('transform')
    const box = await products.boundingBox()
    await page.mouse.move(box.x + 40, box.y + 12)
    await page.mouse.down()
    await page.mouse.move(box.x + 140, box.y + 92, { steps: 5 })
    await page.mouse.up()
    if ((await products.getAttribute('transform')) === before) throw new Error('table did not move')

    // Save exports straight to a temp folder instead of showing the save dialog.
    await app.evaluate(({ session }, dir) => {
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(`${dir}/${item.getFilename()}`))
    }, downloads)
    for (const format of ['SVG (vector)', 'PNG image']) {
      await page.getByRole('button', { name: 'Export' }).click()
      await page.getByRole('button', { name: format }).click()
    }
    const svgFile = join(downloads, 'shop-diagram.svg')
    const pngFile = join(downloads, 'shop-diagram.png')
    for (let i = 0; i < 50 && !(existsSync(svgFile) && existsSync(pngFile)); i++) await page.waitForTimeout(100)
    if (!readFileSync(svgFile, 'utf8').includes('order_items')) throw new Error('svg export is missing tables')
    if (readFileSync(pngFile).subarray(1, 4).toString() !== 'PNG') throw new Error('png export is not a PNG')

    await products.dblclick()
    await page.locator('.history-item.active', { hasText: 'products' }).waitFor()
    await page.locator('.grid-head', { hasText: 'sku' }).waitFor()
  })

  await step('mark a database as production', async () => {
    await page.locator('.tree-row.connection').hover()
    await page.locator('.tree-row.connection').getByTitle('Edit connection').click()
    await page.getByLabel('Environment for shop').selectOption('production')
    await shot('12-environment-dialog')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.tree-row.database', { hasText: 'shop' }).locator('.env-badge', { hasText: 'PROD' }).waitFor()
    // Re-marking must not drop the open connection.
    await page.locator('.tree-row', { hasText: 'order_items' }).waitFor()

    await page.getByRole('button', { name: 'New query', exact: true }).click()
    await page.locator('.env-strip.production').waitFor()
    await page.locator('.toolbar .env-badge', { hasText: 'Production' }).waitFor()

    await setEditor("update organizations set plan = plan where id = 1;\nselect id, name, plan from organizations order by id;")
    await page.keyboard.press(`${mod}+Shift+Enter`)
    await page.locator('.dialog.danger pre', { hasText: 'update organizations' }).waitFor()
    if ((await page.locator('.dialog.danger pre').count()) !== 1) throw new Error('the select should not be listed as a write')
    await shot('13-production-confirm')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.locator('.dialog.danger').waitFor({ state: 'detached' })
    if (await page.locator('.result-tab').count()) throw new Error('cancelled run still executed')

    await page.keyboard.press(`${mod}+Shift+Enter`)
    await page.getByRole('button', { name: 'Run on production' }).click()
    await page.locator('.result-tab', { hasText: 'UPDATE 1' }).waitFor()

    // Reads run without asking.
    await setEditor('select count(*) from organizations;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.results-summary', { hasText: '1 row' }).waitFor()
    if (await page.locator('.dialog.danger').count()) throw new Error('a read asked for confirmation')
    await shot('14-production-tab')
  })

  await step('environment variables fill in per environment', async () => {
    // This tab's database was marked Production in the previous step.
    await setEditor('select id, name from organizations where id = :org;')
    await page.locator('.var', { hasText: ':org' }).waitFor()
    await page.getByRole('button', { name: 'Environment variables' }).click()
    await page.getByLabel('org for Production').fill('3')
    await page.getByLabel('org for Staging').fill('7')
    await shot('15-env-variables-dialog')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    const field = page.locator('.var', { hasText: ':org' })
    await field.locator('.env-badge', { hasText: 'PROD' }).waitFor()
    if ((await field.locator('input').inputValue()) !== '3') throw new Error('production value not filled in')
    const firstId = () => page.locator('.grid-row').first().locator('.grid-cell').first().textContent()

    await page.locator('.cm-content').click()
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.results-summary', { hasText: '1 row' }).waitFor()
    if ((await firstId()) !== '3') throw new Error('query did not use the production value')
    await shot('16-env-variable-in-tab')

    // A tab value overrides the environment's, and resetting brings it back.
    await field.locator('input').fill('5')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.grid-row .grid-cell')?.textContent === '5')
    if (await field.locator('.env-badge').count()) throw new Error('override still marked as inherited')
    await page.getByRole('button', { name: 'Use the Production value' }).click()
    if ((await field.locator('input').inputValue()) !== '3') throw new Error('reset did not restore the production value')
  })

  await step('production sessions are read-only on the server', async () => {
    // A function that writes, called from a SELECT: the client can't tell, Postgres can.
    await setEditor(
      'create function pg_temp.touch_org() returns int language sql as $$ update organizations set plan = plan where id = 1 returning id $$;'
    )
    await page.keyboard.press(`${mod}+Enter`)
    await page.getByRole('button', { name: 'Run on production' }).click()
    await page.locator('.command-card', { hasText: 'CREATE' }).waitFor()
    await page.locator('.readonly-hint').waitFor()

    await setEditor('select pg_temp.touch_org();')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.error-card', { hasText: 'read-only transaction' }).waitFor()
    await shot('17-readonly-blocked')
    await page.getByRole('button', { name: /Run again with writes allowed/ }).click()
    await page.locator('.dialog.danger', { hasText: 'Postgres refused a write' }).waitFor()
    await page.getByRole('button', { name: 'Run on production' }).click()
    await page.locator('.results-summary', { hasText: '1 row' }).waitFor()
  })

  await step('history lists, renames, deletes and restores queries', async () => {
    await page.locator('.history-group .sidebar-head', { hasText: 'Today' }).waitFor()
    // The entry just run is at the top, titled by its first line and showing the last result.
    const top = page.locator('.history-item').first()
    await top.locator('.history-title', { hasText: 'select pg_temp.touch_org()' }).waitFor()
    await top.locator('.history-run', { hasText: '1 row' }).waitFor()
    await page.locator('.history-head', { hasText: 'shop' }).locator('.env-badge', { hasText: 'PROD' }).waitFor()

    await top.dblclick()
    await page.getByLabel('Name').fill('Touch org')
    await page.keyboard.press('Enter')
    await page.locator('.history-item.active .history-title', { hasText: 'Touch org' }).waitFor()
    await page.locator('.titlebar-title', { hasText: 'Touch org' }).waitFor()

    await page.getByPlaceholder(/^Search .*history$/).fill('organizations where')
    const matches = await page.locator('.history-item').count()
    if (matches !== 1) throw new Error(`search found ${matches} entries`)
    await page.getByPlaceholder(/^Search .*history$/).fill('')
    await shot('18-history')

    const before = await page.locator('.history-item').count()
    await top.hover()
    await top.getByRole('button', { name: 'Delete from history' }).click()
    await page.locator('.toast', { hasText: 'Touch org' }).waitFor()
    if ((await page.locator('.history-item').count()) !== before - 1) throw new Error('entry not deleted')
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.locator('.history-item', { hasText: 'Touch org' }).waitFor()

    await page.getByRole('button', { name: 'Toggle history' }).click()
    await page.locator('.history').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Toggle history' }).click()
    await page.locator('.history').waitFor()
  })

  await step('history follows the database you are in', async () => {
    const explorer = await page.locator('.sidebar').boundingBox()
    const history = await page.locator('.history').boundingBox()
    if (!(history.x > explorer.x)) throw new Error('history should sit right of the explorer')
    const shopEntries = await page.locator('.history-item').count()
    const database = (name) => page.locator('.tree-row.database', { hasText: new RegExp(`^${name}`) })

    // A database without history opens a blank query for it.
    await database('scratch').click()
    await page.locator('.history-head', { hasText: 'scratch' }).waitFor()
    await page.locator('.toolbar .target-db', { hasText: 'scratch' }).waitFor()
    await setEditor('select current_database();')
    await page.keyboard.press(`${mod}+Enter`)
    await page.waitForFunction(() => document.querySelector('.grid-row .grid-cell')?.textContent === 'scratch')
    if ((await page.locator('.history-item').count()) !== 1) throw new Error('scratch history should hold one entry')
    await shot('19-history-scratch')

    // Back to shop: its own entries, and nothing from scratch.
    await database('shop').click()
    await page.locator('.history-head', { hasText: 'shop' }).waitFor()
    if ((await page.locator('.history-item').count()) !== shopEntries) throw new Error('shop history changed')
    if (await page.locator('.history-item', { hasText: 'current_database' }).count()) throw new Error('scratch entry leaked into shop')

    // Returning to scratch reopens its query rather than a new blank one.
    await database('scratch').click()
    await page.locator('.history-item.active', { hasText: 'current_database' }).waitFor()

    // A blank query you leave untouched disappears.
    await database('postgres').click()
    await page.locator('.history-head', { hasText: 'postgres' }).waitFor()
    await database('shop').click()
    await database('postgres').click()
    if ((await page.locator('.history-item').count()) !== 1) throw new Error('blank queries piled up')
    await database('shop').click()
    await page.locator('.history-head', { hasText: 'shop' }).waitFor()
  })

  await step('light theme', async () => {
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Light' }).click()
    await page.keyboard.press('Escape')
    await page.locator('.history-item', { hasText: 'orders' }).click()
    await page.locator('.grid-head', { hasText: 'status' }).waitFor()
    await shot('08-light-theme')
  })

  const unexpected = errors.filter((e) => !/Autofill|DevTools/.test(e))
  if (unexpected.length) throw new Error(`renderer errors:\n${unexpected.join('\n')}`)
  console.log(`\nAll steps passed. Screenshots in ${shots}`)
} catch (e) {
  await shot('failure').catch(() => {})
  console.error('\nFAILED:', e.message)
  process.exitCode = 1
} finally {
  await app.close()
  mock.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(downloads, { recursive: true, force: true })
}
