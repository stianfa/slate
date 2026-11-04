// Drives the built app with Playwright against the sample database (`npm run db`).
// Azure OpenAI is replaced by a local mock via AI_FOUNDRY_URL, so no key is needed.
// Screenshots land in test-results/e2e.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const shots = join(process.cwd(), 'test-results', 'e2e')
mkdirSync(shots, { recursive: true })
const port = process.env.SLATE_DEV_PG_PORT ?? '55432'

// ---- Mock Azure OpenAI (Responses API) ----
const aiRequests = []
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = JSON.parse(body || '{}')
    aiRequests.push({ url: req.url, headers: req.headers, body: json })
    if (json.stream) return streamChat(res, json)
    const prompt = JSON.stringify(json.input ?? [])
    let text = 'OK'
    if (prompt.includes('<cursor/>')) {
      text = prompt.includes('from users <cursor/>') ? 'where is_admin = true' : ''
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'resp_test',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: json.model,
        output: [
          {
            type: 'message',
            id: 'msg_test',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }]
          }
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      })
    )
  })
})

// The chat streams its answer as server-sent events, a few pieces at a time.
function streamChat(res, json) {
  const asked = json.input.at(-1).content
  const answer = asked.includes('admins')
    ? 'Users with the admin flag set.\n\n```sql\nselect id, email\nfrom users\nwhere is_admin;\n```'
    : 'No idea.'
  const pieces = answer.match(/[\s\S]{1,12}/g)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  let n = 0
  send({ type: 'response.created', sequence_number: n++, response: { id: 'resp_chat', status: 'in_progress', output: [] } })
  for (const delta of pieces) {
    send({ type: 'response.output_text.delta', sequence_number: n++, item_id: 'msg_chat', output_index: 0, content_index: 0, delta })
  }
  send({ type: 'response.completed', sequence_number: n++, response: { id: 'resp_chat', status: 'completed', output: [] } })
  res.end()
}

await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockUrl = `http://127.0.0.1:${mock.address().port}`

const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
const downloads = mkdtempSync(join(tmpdir(), 'slate-e2e-downloads-'))
const errors = []

async function launch() {
  const app = await _electron.launch({
    // SLATE_EXE runs the suite against a packaged build, e.g. dist/win-unpacked/Slate.exe.
    executablePath: process.env.SLATE_EXE || electronPath,
    args: process.env.SLATE_EXE ? [] : ['.'],
    env: {
      ...process.env,
      SLATE_USER_DATA: userData,
      // A full request URL as AI_FOUNDRY_URL: only its origin should be used.
      AI_FOUNDRY_URL: `${mockUrl}/openai/responses?api-version=2025-04-01-preview`,
      AI_FOUNDRY_MODEL: 'slate-test-deployment',
      AI_FOUNDRY_API_KEY: 'test-key',
      AI_FOUNDRY_API_VERSION: '',
      ELECTRON_RENDERER_URL: ''
    }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return { app, page }
}

let { app, page } = await launch()

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `)
  await fn()
  console.log('ok')
}
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

// The row's buttons only show while it is hovered, and a hover can miss while a dialog is still
// fading out over the sidebar, so hover again until the button is there.
async function editConnection() {
  const row = page.locator('.tree-row.connection')
  const button = row.getByTitle('Edit connection')
  for (let i = 0; i < 10 && !(await button.isVisible()); i++) {
    await page.mouse.move(0, 0)
    await row.hover()
    await page.waitForTimeout(100)
  }
  await button.click()
}

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
    await page.getByRole('button', { name: 'Test connection' }).click()
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
    // A double-click shows the whole value in place, selected, so part of it can be copied.
    await page.locator('.grid-row').first().locator('.grid-cell').nth(2).dblclick()
    const open = page.locator('.grid-open-cell')
    await open.waitFor()
    const raw = await open.inputValue()
    const selected = await open.evaluate((el) => [el.selectionStart, el.selectionEnd])
    if (!raw.includes('"beta"') || selected[0] !== 0 || selected[1] !== raw.length) {
      throw new Error(`the whole value should be shown and selected: ${raw} ${selected}`)
    }
    await open.evaluate((el) => el.setSelectionRange(0, 5))
    await page.keyboard.press(`${mod}+C`)
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    if (clipboard !== raw.slice(0, 5)) throw new Error(`copied "${clipboard}" instead of the selected text`)
    await shot('06b-open-cell')
    await page.keyboard.press('Escape')
    await open.waitFor({ state: 'detached' })

    // Shift+Enter on the selected cell still opens the viewer, with JSON pretty-printed.
    await page.keyboard.press('Shift+Enter')
    await page.locator('.value-view').waitFor()
    const value = await page.locator('.value-view').textContent()
    if (!value.includes('\n  "beta"')) throw new Error(`json not pretty printed: ${value}`)
    await page.keyboard.press('Escape')
    await page.locator('.value-view').waitFor({ state: 'detached' })

    // App-wide shortcuts still work from the open value.
    await page.locator('.grid-row').first().locator('.grid-cell').nth(2).dblclick()
    await open.waitFor()
    await page.keyboard.press(`${mod}+K`)
    await page.locator('.palette').waitFor()
    await open.waitFor({ state: 'detached' })
    await page.keyboard.press('Escape')
    await page.locator('.palette').waitFor({ state: 'detached' })

    // A value with very many lines opens too.
    await setEditor("select repeat(E'x\\n', 200000) as many;")
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.grid-head', { hasText: 'many' }).waitFor()
    await page.locator('.grid-row').first().locator('.grid-cell').first().dblclick()
    await open.waitFor()
    const lines = (await open.inputValue()).split('\n').length
    if (lines !== 200001) throw new Error(`the open value had ${lines} lines`)
    await page.keyboard.press('Escape')
    await open.waitFor({ state: 'detached' })
  })

  await step('transpose a result', async () => {
    await setEditor('select id, email, is_admin from users order by id limit 2;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.results-summary', { hasText: '2 rows' }).waitFor()
    await page.getByRole('button', { name: 'Transpose' }).click()
    await page.locator('.grid-rowhead', { hasText: 'email' }).waitFor()
    if ((await page.locator('.grid-rowhead').count()) !== 3) throw new Error('expected one row per column')
    await page.locator('.grid-head', { hasText: 'Row 2' }).waitFor()
    if (!/^\d+$/.test(await page.locator('.grid-row').first().locator('.grid-cell').first().textContent())) {
      throw new Error('the first row should hold the ids')
    }
    await shot('07b-transposed')

    // A long result turns into many columns; only those in view are drawn.
    await setEditor('select * from products order by id limit 100;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.grid-head', { hasText: /^Row 1$/ }).waitFor()
    if ((await page.locator('.grid-head').count()) >= 100) throw new Error('every column was drawn')
    await page.locator('.grid').evaluate((el) => (el.scrollLeft = el.scrollWidth))
    await page.locator('.grid-head', { hasText: 'Row 100' }).waitFor()

    await page.getByRole('button', { name: 'Transpose' }).click()
    await page.locator('.grid-head', { hasText: 'sku' }).waitFor()
  })

  await step('add rows with + and paste copied rows into them', async () => {
    // Keep the system clipboard out of the test; the grid copies and pastes through main.
    await app.evaluate(({ clipboard }) => {
      let text = ''
      clipboard.writeText = (t) => (text = t)
      clipboard.readText = () => text
    })
    const run = async (sql, summary) => {
      await setEditor(sql)
      await page.keyboard.press(`${mod}+Enter`)
      await page.locator('.results-summary', { hasText: summary }).waitFor()
    }
    await run("delete from products where sku like 'SKU-E2E-%';", 'DELETE')

    // Copy two whole rows: click a row number, shift-click another.
    await run('select * from products where id <= 2 order by id;', '2 rows')
    await page.locator('.grid-row .grid-rownum').nth(0).click()
    await page.locator('.grid-row .grid-rownum').nth(1).click({ modifiers: ['Shift'] })
    await page.keyboard.press(`${mod}+C`)

    // + adds one row; pasting two rows into it adds the second.
    await run('select * from products order by id limit 3;', '3 rows')
    await page.getByRole('button', { name: 'Add row' }).click()
    const fresh = page.locator('.grid-row.new')
    await fresh.first().locator('.grid-cell', { hasText: 'DEFAULT' }).first().waitFor()
    await page.keyboard.press(`${mod}+V`)
    await fresh.nth(1).waitFor()
    if ((await fresh.count()) !== 2) throw new Error('expected two new rows')
    const sku = await fresh.first().locator('.grid-cell').nth(1).textContent()
    if (sku !== 'SKU-0001') throw new Error(`pasted ${sku} as the first sku`)

    // The copied ids are taken, so the insert fails and the rows stay.
    await page.getByRole('button', { name: 'Save 2 changes' }).click()
    await page.locator('.changes-error', { hasText: 'duplicate key value' }).waitFor()
    await shot('07c-new-rows')

    // Delete puts the ids back to DEFAULT; typing or double-clicking edits a cell.
    await fresh.nth(0).locator('.grid-cell').nth(0).click()
    await fresh.nth(1).locator('.grid-cell').nth(0).click({ modifiers: ['Shift'] })
    await page.keyboard.press('Delete')
    await fresh.nth(1).locator('.grid-cell').first().filter({ hasText: 'DEFAULT' }).waitFor()
    await fresh.nth(0).locator('.grid-cell').nth(1).click()
    await page.keyboard.type('SKU-E2E-1')
    await page.keyboard.press('Enter')
    await fresh.nth(1).locator('.grid-cell').nth(1).dblclick()
    await page.locator('.grid-input').fill('SKU-E2E-2')
    await page.keyboard.press('Enter')
    await fresh.nth(0).locator('.grid-cell', { hasText: 'SKU-E2E-1' }).waitFor()

    // Cmd+Enter in the grid inserts instead of running the query; the rows join the result.
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.results-summary', { hasText: '5 rows' }).waitFor()
    if (await fresh.count()) throw new Error('new rows were left after the insert')
    const id = await page.locator('.grid-row').nth(4).locator('.grid-cell').first().textContent()
    if (!(Number(id) > 120)) throw new Error(`inserted row got id ${id}`)
    await run("delete from products where sku like 'SKU-E2E-%';", 'DELETE 2')
  })

  await step('edit cells and delete rows in place, on a sorted result', async () => {
    const run = async (sql, summary) => {
      await setEditor(sql)
      await page.keyboard.press(`${mod}+Enter`)
      await page.locator('.results-summary', { hasText: summary }).waitFor()
    }
    await run("delete from products where sku like 'SKU-E2E-%';", 'DELETE')
    await run("insert into products (sku, title, price) values ('SKU-E2E-A', 'alpha', 1), ('SKU-E2E-B', 'beta', 2), ('SKU-E2E-C', 'gamma', 3);", 'INSERT 3')
    await run("select id, sku, title, price from products where sku like 'SKU-E2E-%' order by sku;", '3 rows')

    // Sort by sku descending, so the rows show as C, B, A and edits have to find the right row.
    const sku = page.locator('.grid-head', { hasText: 'sku' })
    await sku.click()
    await sku.click()
    await page.locator('.grid-head.sorted', { hasText: 'sku' }).locator('[aria-label="descending"]').waitFor()
    const rows = page.locator('.grid-row')
    const cell = (r, c) => rows.nth(r).locator('.grid-cell').nth(c)
    if ((await cell(0, 1).textContent()) !== 'SKU-E2E-C') throw new Error('rows were not sorted by sku')

    await cell(2, 2).click()
    await page.keyboard.type('ALPHA')
    await page.keyboard.press('Enter')
    await rows.nth(2).locator('.grid-cell.changed', { hasText: 'ALPHA' }).waitFor()
    await cell(1, 3).dblclick()
    await page.locator('.grid-input').fill('22.5')
    await page.keyboard.press('Enter')
    // Delete on a cell of the result sets it to NULL; title can't be NULL, so the save fails.
    await cell(1, 2).click()
    await page.keyboard.press('Delete')
    await rows.nth(1).locator('.grid-cell.changed .null').waitFor()
    await rows.nth(0).locator('.grid-rownum').click()
    await page.keyboard.press('Delete')
    await page.locator('.grid-row.deleted').waitFor()
    await page.getByRole('button', { name: 'Save 3 changes' }).waitFor()
    await shot('07d-edited-rows')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.changes-error', { hasText: 'null value in column "title"' }).waitFor()
    if ((await rows.count()) !== 3) throw new Error('a failed save should change nothing')

    // Cmd+Z puts the cell back; then the save goes through and the result follows.
    await cell(1, 2).click()
    await page.keyboard.press(`${mod}+Z`)
    await rows.nth(1).locator('.grid-cell', { hasText: 'beta' }).waitFor()
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.toast', { hasText: 'Updated 2 rows and deleted 1 in products' }).waitFor()
    await page.locator('.results-summary', { hasText: '2 rows' }).waitFor()
    if (await page.locator('.grid-cell.changed, .grid-row.deleted').count()) throw new Error('changes were left after the save')
    if ((await cell(0, 3).textContent()) !== '22.50') throw new Error('the updated row should show what Postgres returned')

    // Shift+Enter edits a value in a dialog, which keeps line breaks; Discard drops the edit.
    await cell(0, 2).click()
    await page.keyboard.press('Shift+Enter')
    await page.locator('.value-edit').fill('two\nlines')
    await page.getByRole('button', { name: 'Apply' }).click()
    await rows.nth(0).locator('.grid-cell.changed', { hasText: 'two ↵ lines' }).waitFor()
    await page.getByRole('button', { name: 'Discard' }).click()
    await rows.nth(0).locator('.grid-cell', { hasText: 'beta' }).waitFor()

    await run("select sku, title, price from products where sku like 'SKU-E2E-%' order by sku;", '2 rows')
    const saved = await rows.evaluateAll((els) => els.map((el) => [...el.querySelectorAll('.grid-cell')].map((c) => c.textContent)))
    if (JSON.stringify(saved) !== JSON.stringify([['SKU-E2E-A', 'ALPHA', '1.00'], ['SKU-E2E-B', 'beta', '22.50']])) {
      throw new Error(`saved rows were ${JSON.stringify(saved)}`)
    }

    // Without the primary key in the result, rows can't be edited, and typing says why.
    await run("select sku, title from products where sku like 'SKU-E2E-%' order by sku;", '2 rows')
    await cell(0, 1).click()
    await page.keyboard.type('x')
    await page.locator('.toast', { hasText: 'Add id to the query' }).waitFor()
    await run("delete from products where sku like 'SKU-E2E-%';", 'DELETE 2')
  })

  await step('sort and filter the loaded rows', async () => {
    await setEditor('select id, sku, price from products order by id limit 50;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.results-summary', { hasText: '50 rows' }).waitFor()
    const price = page.locator('.grid-head', { hasText: 'price' })
    const prices = async () =>
      (await page.locator('.grid-row').evaluateAll((els) => els.slice(0, 5).map((el) => Number(el.querySelectorAll('.grid-cell')[2].textContent))))
    await price.click()
    let seen = await prices()
    if (seen.some((p, i) => i && p < seen[i - 1])) throw new Error(`prices not ascending: ${seen}`)
    await price.click()
    seen = await prices()
    if (seen.some((p, i) => i && p > seen[i - 1])) throw new Error(`prices not descending: ${seen}`)
    await price.click()
    if (await page.locator('.grid-head.sorted').count()) throw new Error('a third click should stop sorting')

    // Cmd+F in the grid goes to the filter; Escape there clears it.
    await page.locator('.grid-row').first().locator('.grid-cell').first().click()
    await page.keyboard.press(`${mod}+F`)
    await page.keyboard.type('sku-001')
    await page.locator('.results-summary .pill', { hasText: '10 matches' }).waitFor()
    if ((await page.locator('.grid-row').count()) !== 10) throw new Error('the filter should leave 10 rows')
    await shot('07e-filtered')
    await page.keyboard.press('Escape')
    await page.locator('.grid-row').nth(20).waitFor()
    if (await page.locator('.results-summary .pill').count()) throw new Error('the filter was not cleared')
  })

  await step('pick values to show or hide from a column header', async () => {
    await setEditor('select id, status, total from orders order by id limit 200;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.results-summary', { hasText: '200 rows' }).waitFor()
    const menu = page.getByRole('menu', { name: 'status column' })
    const statuses = () =>
      page.locator('.grid-row').evaluateAll((els) => [...new Set(els.map((el) => el.querySelectorAll('.grid-cell')[1].textContent))].sort())

    // The four statuses each have 50 of the 200 orders.
    await page.locator('.grid-head', { hasText: 'status' }).click({ button: 'right' })
    await menu.waitFor()
    if ((await menu.locator('.column-menu-values .column-menu-value').count()) !== 4) throw new Error('expected the four statuses')
    await menu.locator('.column-menu-value', { hasText: 'paid' }).locator('input').check()
    await menu.locator('.column-menu-value', { hasText: 'shipped' }).locator('input').check()
    await page.locator('.results-summary .pill', { hasText: '100 matches' }).waitFor()
    if (JSON.stringify(await statuses()) !== '["paid","shipped"]') throw new Error(`showing ${await statuses()}`)
    await shot('07f-column-filter')
    await menu.getByRole('button', { name: 'Hide ticked' }).click()
    await page.locator('.results-summary .pill', { hasText: '100 matches' }).waitFor()
    if (JSON.stringify(await statuses()) !== '["cancelled","pending"]') throw new Error(`hiding left ${await statuses()}`)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    await page.locator('.grid-head.filtered', { hasText: 'status' }).waitFor()

    // Sorting from the menu; a column with 50 or more values gets no list.
    await page.locator('.grid-head', { hasText: 'total' }).click({ button: 'right' })
    await page.getByRole('menu', { name: 'total column' }).getByText('50 or more different values').waitFor()
    await page.getByRole('menu', { name: 'total column' }).getByRole('button', { name: 'Sort descending' }).click()
    await page.locator('.grid-head.sorted', { hasText: 'total' }).waitFor()

    // The filter mark opens the menu again, to clear the filter.
    await page.locator('.grid-head.filtered .grid-head-filter').click()
    await menu.getByRole('button', { name: 'Clear filter' }).click()
    await page.locator('.grid-head.filtered').waitFor({ state: 'detached' })
    if (await page.locator('.results-summary .pill').count()) throw new Error('the filter was not cleared')
    await page.keyboard.press('Escape')
  })

  await step('load more rows and save the full result', async () => {
    await setEditor('select * from orders order by id;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.results-summary', { hasText: 'First 1,000 rows' }).waitFor()
    await page.getByRole('button', { name: 'Load 1,000 more' }).click()
    await page.locator('.results-summary', { hasText: 'First 2,000 rows' }).waitFor()

    // Answer the save dialog in the main process instead of on screen.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showSaveDialog = async (...args) => {
        const options = args.at(-1)
        return { canceled: false, filePath: `${dir}/${options.defaultPath.split(/[\\/]/).pop()}` }
      }
    }, downloads)
    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('button', { name: 'Save as CSV file…' }).click()
    await page.locator('.copied', { hasText: 'Saved 5,000 rows' }).waitFor()
    const csv = readdirSync(downloads).find((f) => f.endsWith('.csv'))
    const file = readFileSync(join(downloads, csv), 'utf8')
    if (file.trimEnd().split('\n').length !== 5001) throw new Error('export is missing rows')
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
    await page.keyboard.press(`${mod}+Shift+R`)
    await page.locator('.tx-badge').waitFor({ state: 'detached' })

    await setEditor('begin; select 1;')
    await page.keyboard.press(`${mod}+Shift+Enter`)
    await page.locator('.tx-badge', { hasText: 'Transaction open' }).waitFor()
    await page.keyboard.press(`${mod}+Shift+C`)
    await page.locator('.tx-badge').waitFor({ state: 'detached' })
  })

  await step('cancel a running query', async () => {
    await setEditor('select pg_sleep(30);')
    await page.keyboard.press(`${mod}+Enter`)
    await page.getByRole('button', { name: 'Cancel' }).waitFor()
    await page.keyboard.press(`${mod}+.`)
    await page.getByText(/canceling statement due to user request/).waitFor()
  })

  await step('ask before an open transaction would be rolled back', async () => {
    await setEditor('begin; select 1;')
    await page.keyboard.press(`${mod}+Shift+Enter`)
    await page.locator('.tx-badge', { hasText: 'Transaction open' }).waitFor()

    const entry = page.locator('.history-item.active')
    await entry.hover()
    await entry.getByRole('button', { name: 'Delete from history' }).click()
    await page.locator('.dialog', { hasText: 'Deleting the query rolls the transaction back' }).waitFor()
    await shot('20-transaction-warning')
    await page.getByRole('button', { name: 'Cancel' }).click()
    if (!(await entry.count())) throw new Error('entry deleted despite cancel')

    await page.locator('.target-btn').click()
    await page.locator('.target-menu .menu-item', { hasText: 'scratch' }).click()
    await page.locator('.dialog', { hasText: 'Move to scratch?' }).waitFor()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.locator('.toolbar .target-db', { hasText: 'shop' }).waitFor()

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
    const completion = aiRequests.find((r) => JSON.stringify(r.body.input).includes('<cursor/>'))
    if (!completion) throw new Error('no completion request reached the mock')
    if (completion.url !== '/openai/responses?api-version=2025-04-01-preview') throw new Error(`url ${completion.url}`)
    if (completion.body.model !== 'slate-test-deployment') throw new Error(`model ${completion.body.model}`)
    if (completion.body.reasoning?.effort !== 'low') throw new Error('reasoning effort not low')
    const system = completion.body.input.find((m) => m.role === 'system')
    if (!system?.content.includes('public.users: id bigint PK')) throw new Error('schema missing from prompt')
    if (completion.headers['api-key'] !== 'test-key') throw new Error('api key not sent')
  })

  await step('chat writes a query', async () => {
    await page.getByRole('button', { name: 'New query', exact: true }).click()
    await page.keyboard.press(`${mod}+J`)
    await page.locator('.chat-panel').waitFor()
    await page.getByLabel('Message').fill('list the admins')
    await page.keyboard.press('Enter')
    const block = page.locator('.chat-sql-block', { hasText: 'where is_admin;' })
    await block.getByRole('button', { name: 'Replace query' }).waitFor()
    await shot('06b-chat')

    const request = aiRequests.find((r) => r.body.stream && JSON.stringify(r.body.input).includes('list the admins'))
    if (!request) throw new Error('no chat request reached the mock')
    if (request.body.reasoning?.effort !== 'medium') throw new Error('chat effort not medium')
    if (!request.body.input[0].content.includes('public.users: id bigint PK')) throw new Error('schema missing from chat prompt')
    if (!request.body.input.at(-1).content.includes('My editor is empty.')) throw new Error('editor context missing')

    await block.getByRole('button', { name: 'Replace query' }).click()
    if (!(await page.locator('.cm-content').textContent()).includes('where is_admin;')) throw new Error('query not in the editor')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.results-summary', { hasText: /rows?/ }).waitFor()

    // The chat belongs to its query and survives closing the panel.
    await page.keyboard.press(`${mod}+J`)
    await page.locator('.chat-panel').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Ask AI' }).click()
    await page.locator('.chat-msg.user', { hasText: 'list the admins' }).waitFor()
    await page.getByRole('button', { name: 'Close chat' }).click()
    await page.locator('.cm-content').click()
  })

  await step('schema completion offers columns', async () => {
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.press('Delete')
    await page.keyboard.type('select * from organizations where pl', { delay: 10 })
    await page.locator('.cm-tooltip-autocomplete li[aria-selected]', { hasText: 'plan' }).waitFor()
    await shot('07-autocomplete')
    // Tab picks the highlighted completion, like Enter.
    await page.keyboard.press('Tab')
    await page.locator('.cm-tooltip-autocomplete').waitFor({ state: 'detached' })
    const text = await page.locator('.cm-content').textContent()
    if (text !== 'select * from organizations where plan') throw new Error(`Tab left "${text}"`)
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
    await editConnection()
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

  await step('a marked connection shows its badge once', async () => {
    await editConnection()
    await page.getByRole('group', { name: 'Environment' }).getByRole('button', { name: 'Test' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.tree-row.connection .env-badge', { hasText: 'TEST' }).waitFor()
    // Databases that only inherit the mark don't repeat it; shop keeps its own Production mark.
    await page.locator('.tree-row.database', { hasText: 'shop' }).locator('.env-badge', { hasText: 'PROD' }).waitFor()
    if (await page.locator('.tree-row.database', { hasText: 'scratch' }).locator('.env-badge').count()) {
      throw new Error('scratch repeats the connection badge')
    }
    await shot('14b-connection-badge')

    await editConnection()
    await page.getByRole('group', { name: 'Environment' }).getByRole('button', { name: 'None' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.tree-row.connection .env-badge').waitFor({ state: 'detached' })
  })

  await step('environment variables fill in per environment', async () => {
    // This tab's database was marked Production in the previous step.
    await setEditor('select id, name from organizations where id = :org;')
    await page.locator('.var', { hasText: ':org' }).waitFor()
    await page.getByRole('button', { name: 'Environment variables' }).click()
    await page.getByLabel('org for Production').fill('3')
    await page.getByLabel('org for Test').fill('7')
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

    // The list under the field offers values set elsewhere, such as Test's.
    await field.getByRole('button', { name: 'Values used before for :org' }).click()
    await page.locator('.var-values .var-value', { hasText: 'TEST' }).waitFor()
    await page.waitForTimeout(200) // let the list finish fading in
    await shot('16a-variable-values')
    await page.locator('.var-values .var-value', { hasText: '7' }).click()
    if ((await field.locator('input').inputValue()) !== '7') throw new Error('picked value not filled in')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.grid-row .grid-cell')?.textContent === '7')
    // Picking the environment's own value from the keyboard goes back to inheriting it.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await field.locator('.env-badge', { hasText: 'PROD' }).waitFor()
    if (await page.locator('.var-values').count()) throw new Error('value list still open after picking')
  })

  await step('global variables apply in every environment', async () => {
    await setEditor('select :greeting::text as greeting;')
    await page.locator('.var', { hasText: ':greeting' }).waitFor()
    await page.getByRole('button', { name: 'Environment variables' }).click()
    await page.getByLabel('greeting is global').check()
    if (await page.getByLabel('greeting for Production').count()) throw new Error('a global variable still shows per-environment fields')
    await page.getByLabel('greeting for every environment').fill('hello')
    await shot('16b-global-variable')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    // This tab's database is marked Production, which has no value of its own for :greeting.
    const field = page.locator('.var', { hasText: ':greeting' })
    await field.locator('.env-badge', { hasText: 'GLOBAL' }).waitFor()
    if ((await field.locator('input').inputValue()) !== 'hello') throw new Error('global value not filled in')
    await page.locator('.cm-content').click()
    await page.keyboard.press(`${mod}+Enter`)
    await page.waitForFunction(() => document.querySelector('.grid-row .grid-cell')?.textContent === 'hello')
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

    // Cmd+Backspace outside a text field deletes the current query.
    await page.locator('.history-item.active', { hasText: 'Touch org' }).waitFor()
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press(`${mod}+Backspace`)
    await page.locator('.toast', { hasText: 'Touch org' }).waitFor()
    if ((await page.locator('.history-item').count()) !== before - 1) throw new Error('entry not deleted from the keyboard')
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.locator('.history-item', { hasText: 'Touch org' }).waitFor()

    await page.getByRole('button', { name: 'Toggle history' }).click()
    await page.locator('.history').waitFor({ state: 'detached' })
    await page.keyboard.press(`${mod}+B`)
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

  await step('refresh the schema and filter tables from the keyboard', async () => {
    // A table made outside Slate shows up after Cmd+R, and goes away after the next one.
    const table = `made_elsewhere_${Date.now()}`
    const db = new (require('pg').Client)({ connectionString: `postgres://slate:slate@localhost:${port}/shop` })
    await db.connect()
    try {
      await db.query(`create table ${table} (id int)`)
      await page.keyboard.press(`${mod}+R`)
      await page.locator('.tree-row', { hasText: table }).waitFor()
      await db.query(`drop table ${table}`)
      await page.keyboard.press(`${mod}+R`)
      await page.locator('.tree-row', { hasText: table }).waitFor({ state: 'detached' })
    } finally {
      await db.query(`drop table if exists ${table}`)
      await db.end()
    }

    await page.keyboard.press(`${mod}+Shift+F`)
    if (!(await page.locator('.sidebar .sidebar-search input').evaluate((el) => el === document.activeElement))) {
      throw new Error('the table filter is not focused')
    }
  })

  await step('format SQL', async () => {
    await page.getByRole('button', { name: 'New query', exact: true }).click()
    await setEditor("select id,email from users where id=:id and created_at>now()-interval '1 day'")
    await page.keyboard.press('Shift+Alt+F')
    await page.locator('.cm-line', { hasText: /^SELECT$/ }).waitFor()
    const text = await page.locator('.cm-content').innerText()
    if (!text.includes('WHERE') || !text.includes('id = :id') || !text.includes("interval '1 day'")) {
      throw new Error(`unexpected formatting:\n${text}`)
    }
    await shot('21-formatted')
  })

  await step('command palette', async () => {
    await page.keyboard.press(`${mod}+K`)
    await page.locator('.palette').waitFor()
    await page.keyboard.type('ordit')
    await page.locator('.palette-item.active', { hasText: 'order_items' }).waitFor()
    await shot('22-palette')
    await page.keyboard.press('Enter')
    await page.locator('.history-item.active', { hasText: 'order_items' }).waitFor()
    await page.locator('.grid-head', { hasText: 'quantity' }).waitFor()

    // The title bar button opens it too, and commands run from it.
    await page.locator('.titlebar-search').click()
    await page.keyboard.type('diagram')
    await page.keyboard.press('Enter')
    await page.locator('.dg-table[data-table="public.users"]').waitFor()
    await page.keyboard.press(`${mod}+K`)
    await page.keyboard.press('Escape')
    await page.locator('.palette').waitFor({ state: 'detached' })
  })

  await step('light theme', async () => {
    await page.getByRole('button', { name: 'Settings' }).click()
    // The AI fields come from AI_FOUNDRY_* here, so Settings shows them as environment values.
    await page.getByText('Using AI_FOUNDRY_URL from the environment.').waitFor()
    await page.getByText('Using AI_FOUNDRY_API_KEY from the environment.').waitFor()
    await page.waitForTimeout(500) // let the dialog finish fading in
    await shot('23-settings-ai')
    await page.getByRole('button', { name: 'Light' }).click()
    await page.keyboard.press('Escape')
    await page.locator('.history-item', { hasText: 'orders' }).click()
    await page.locator('.grid-head', { hasText: 'status' }).waitFor()
    await shot('08-light-theme')
  })

  await step('history survives a restart', async () => {
    const entries = await page.locator('.history-item').count()
    const active = await page.locator('.history-item.active .history-title').textContent()
    // Typed right before quitting, inside the save debounce: the save on close must catch it.
    await setEditor('select 42 as restart_check;')
    await app.close()
    ;({ app, page } = await launch())
    await page.locator('.history-item.active').waitFor()
    if ((await page.locator('.history-item').count()) !== entries) throw new Error('history entries were lost')
    if ((await page.locator('.history-item.active .history-title').textContent()) !== active) throw new Error('active entry changed')
    await page.locator('.cm-content', { hasText: 'restart_check' }).waitFor()
    if (!existsSync(join(userData, 'workspace.json'))) throw new Error('workspace.json missing')
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
