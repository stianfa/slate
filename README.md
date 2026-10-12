# Slate

A slim PostgreSQL desktop client for developers. Connect, browse tables and columns, and run queries with AI autocomplete that knows your schema. No admin panels, no wizards.

![Slate](docs/screenshot.png)

## Features

- **Several connections at once.** Each connection lists every database on its server; each query picks its own connection and database. Paste a `postgres://` URL to fill in the connection form.
- **History per database instead of tabs.** Click a database in the explorer to enter it. The history pane to its right then lists that database's queries and diagrams, most recent first and grouped by day, and new queries go to that database. Entering a database opens its most recent query, or a blank one if it has none (a blank query you leave untouched is removed again). An entry shows its name (or the first line of its SQL when it has none) and the result of its last run. You can search the history, double-click an entry to rename it, and delete one with an undo. Moving a query to another database in the toolbar moves it to that database's history. The button in the title bar hides the pane.
- **Schema browser.** Tables, views and columns with types, primary keys, foreign keys and row estimates. Filter by name. Double-click a table to see its first 100 rows.
- **Editor.** PostgreSQL syntax highlighting, completion for tables, columns (including columns of the tables your statement uses) and keywords. `Ctrl+Enter` runs the selection or the statement under the cursor, which is marked with a bar in the margin. `Ctrl+Shift+Enter` runs the whole script.
- **AI autocomplete.** After a pause in typing, Claude suggests the rest of the query as grey ghost text, using the tab's database schema. `Tab` accepts, `Esc` dismisses, `Ctrl+→` accepts one word, `Alt+\` asks right away. Write a comment like `-- users who signed up this week` and it writes the query. Only the schema and the text around the cursor are sent, never row data.
- **Results.** A virtualized grid that fetches at most the row limit (1,000 by default) through a cursor, so `select * from huge_table` stays fast. Values appear exactly as Postgres prints them. Double-click a cell to see the full value (JSON is pretty-printed). When a result hits the limit, **Load more** runs a read-only statement again with room for another batch. **Export** copies results as CSV, JSON or a Markdown table, or saves a CSV file: for a read-only statement it streams every row on a separate read-only connection, not just the rows on screen.
- **Variables.** Write `:name` (or `$1`) in a query and a bar above the editor asks for the values, saved per tab. Running with a missing value points you at the field. Type values without quotes: each one is inserted as a quoted literal, and Postgres converts it to the type the query needs. That means `where created_at > :since`, `limit :n`, `interval :age` and `:since is null` all work. For lists, write `= any(:ids)` and enter `{1,2,3}`. The NULL button sends `NULL`. Placeholders inside strings, comments, `::` casts and function bodies are left alone.
- **Environment variables.** Under **Environment variables** (in the variables bar or in Settings), give each variable a value per environment, for example `:tenant_id` = `test-42` on Test and `acme` on Production. A tab uses the column that matches its database's environment mark, so moving a tab from test to production switches the values. Check **Global** to give a variable one value for every database, including databases without an environment mark. A value set for an environment wins over a global one. Values that come from the environment show the environment's badge, and global values show a GLOBAL badge. Typing in the field overrides the value for that tab, and the reset button goes back to the environment's value. On Production, the confirmation dialog shows statements with their values filled in.
- **Database diagram.** The diagram button on a database in the sidebar (or in the query toolbar) opens an ER diagram in its own tab. It shows every table with its columns, primary and foreign keys, and crow's-foot relationship lines from each foreign key to the column it references; a circle marks a nullable foreign key. The layout is automatic. Drag tables to rearrange them, scroll to zoom, and hover a table to highlight its relationships. You can also filter by schema, show keys only, find a table, double-click a table to query it, or export the diagram as PNG or SVG.
- **Environment colors.** Mark a connection as Local, Development, Test or Production in its settings, or mark single databases on a shared server (say `app_prod` red, `app_test` amber). Queries on a marked database show a colored strip and a badge in the toolbar, and the history and sidebar show the mark too. On Production, statements that change data or schema (`UPDATE`, `DELETE`, `DROP`, `WITH … DELETE`, `SELECT … INTO` and so on) wait for you to confirm them. Plain reads run right away. Production sessions are also read-only on the server (`default_transaction_read_only`), so Postgres refuses writes Slate can't see, such as a `SELECT` that calls a function that writes. The error then offers to run again with writes allowed, after the same confirmation.
- **A session per query.** Each query has its own connection, so `BEGIN … COMMIT` spans runs. A badge shows open or failed transactions, with Commit and Rollback buttons. Long queries can be cancelled. Anything that would roll back an open transaction asks first: deleting or moving its query, disconnecting, or quitting. If a connection drops mid-transaction, the next run says the server rolled it back and runs nothing. Errors show the line and column and are underlined in the editor. `RAISE NOTICE` output is shown.
- **Command palette.** `Ctrl+K` (or the search button in the title bar) runs commands, opens tables of the current database, jumps to queries in any database's history, and enters databases, with fuzzy matching (`ordit` finds `order_items`).
- **Formatting.** `Shift+Alt+F` or the toolbar button formats the selection or the whole script: upper-case keywords and two-space indents, with variables, casts and function bodies left alone.
- Dark and light themes that follow the OS. History and layout are saved to `workspace.json` in the app's data folder.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+Enter` | Run selection or current statement |
| `Ctrl+Shift+Enter` | Run everything |
| `Ctrl+.` | Cancel the running query |
| `Ctrl+Shift+C` / `Ctrl+Shift+R` | Commit / roll back the open transaction |
| `Tab` / `Esc` | Accept / dismiss AI suggestion |
| `Alt+\` | Ask AI for a suggestion now |
| `Ctrl+Space` | Schema completion |
| `Ctrl+T` | New query |
| `Ctrl+Backspace` | Delete the current query from history (outside text fields; Undo brings it back) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous query in this database's history |
| `Ctrl+K` / `Ctrl+Shift+P` | Command palette |
| `Ctrl+B` | Show or hide history |
| `Ctrl+R` | Refresh the current database's schema |
| `Ctrl+Shift+F` | Filter tables |
| `Shift+Alt+F` | Format SQL |
| `Ctrl+F` | Find in editor |
| `Ctrl+,` | Settings |

On macOS, use `Cmd` instead of `Ctrl`, except for `Ctrl+Tab`: macOS keeps `Cmd+Tab` for switching apps. `Alt` is `Option`. Double-click a history entry, or the name in the title bar, to rename it.

## AI setup

Open Settings and paste an Anthropic API key, or set `ANTHROPIC_API_KEY` before starting the app. Keys and connection passwords are encrypted with the OS keychain (`safeStorage`). The default model is Claude Opus 5.5 at low effort; Claude Haiku 5.5 in Settings is the fastest and cheapest choice for autocomplete. Opus and Sonnet requests opt into Anthropic's server-side refusal fallback.

## Development

```bash
npm install
npm run db        # local Postgres with sample data: postgres://slate:slate@localhost:55432/shop
npm run dev       # app with hot reload
```

`npm run db` uses the `embedded-postgres` package, so Docker is not needed. Data is kept in `dev/.pgdata`; delete that folder to reseed.

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests, plus database tests when `npm run db` is running |
| `npm run test:e2e` | Builds the app and drives it with Playwright against the sample database. A mock Anthropic server stands in for the API. Screenshots go to `test-results/e2e`. Set `SLATE_EXE` to test a packaged build. |
| `npm run typecheck` | Type-checks main, preload and renderer |
| `npm start` | Runs the production build |
| `npm run dist` | Builds the Windows installer into `dist/` |
| `npm run dist:mac` | Builds the macOS `.dmg` and `.zip` (Apple Silicon and Intel) into `dist/`. It only runs on a Mac. |

### macOS

Slate runs on macOS with the native traffic-light buttons and a standard menu. Everything above works the same, with `Cmd` in place of `Ctrl`. Mac builds need a Mac: run `npm install && npm run dist:mac` there, or push the repository to GitHub and download the `slate-macos-latest` artifact from the `build` workflow in `.github/workflows/build.yml`. The build has an ad-hoc signature, not a Developer ID, so the first launch needs a right-click and **Open**. To skip that prompt for other people, add a Developer ID certificate and notarization.

### Layout

- `src/main` runs Node and holds connection pools, a session per tab (`db.ts`), saved connections and settings (`store.ts`), and the Claude completion call (`ai.ts`).
- `src/preload` exposes a typed `window.slate.api` bridge. Channel names match the `Api` interface in `src/shared/api.ts`.
- `src/renderer` is React with a zustand store. The editor is CodeMirror 6, and the AI ghost text lives in `editor/ghost.ts`.
- `src/shared/sql.ts` splits scripts into statements, handling quotes, dollar quoting and comments. Main and renderer both use it.
