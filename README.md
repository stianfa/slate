# Slate

A slim PostgreSQL desktop client for developers. Connect, browse tables and columns, and run queries with AI autocomplete that knows your schema. No admin panels, no wizards.

![Slate](docs/screenshot.png)

## Features

- **Several connections at once.** Each connection lists every database on its server; each query picks its own connection and database. Paste a `postgres://` URL to fill in the connection form.
- **History per database instead of tabs.** Click a database in the explorer to enter it. The history pane to its right then lists that database's queries and diagrams, most recent first and grouped by day, and new queries go to that database. Entering a database opens its most recent query, or a blank one if it has none (a blank query you leave untouched is removed again). An entry shows its name (or the first line of its SQL when it has none) and the result of its last run. You can search the history, double-click an entry to rename it, and delete one with an undo. Moving a query to another database in the toolbar moves it to that database's history. The button in the title bar hides the pane.
- **Schema browser.** Tables, views and columns with types, primary keys, foreign keys and row estimates. Filter by name. Double-click a table to see its first 100 rows.
- **Editor.** PostgreSQL syntax highlighting, completion for tables, columns (including columns of the tables your statement uses) and keywords. `Ctrl+Enter` runs the selection or the statement under the cursor, which is marked with a bar in the margin. `Ctrl+Shift+Enter` runs the whole script.
- **AI autocomplete.** After a pause in typing, an Azure OpenAI model suggests the rest of the query as grey ghost text, using the tab's database schema. `Tab` accepts, `Esc` dismisses, `Ctrl+→` accepts one word, `Alt+\` asks right away. Write a comment like `-- users who signed up this week` and it writes the query. Only the schema and the text around the cursor are sent, never row data.
- **AI chat.** `Ctrl+J` (or the chat button in the query toolbar) opens a chat next to the editor. Describe the query you want, or ask to change or fix the one in the editor, and the answer streams in with the SQL in a block you can put in the editor with **Replace query** or **Insert**. Each query keeps its own conversation. The chat sees the database's schema, the editor text and the last error message, never rows, and it doesn't run anything.
- **Results.** A virtualized grid that fetches at most the row limit (1,000 by default) through a cursor, so `select * from huge_table` stays fast. Values appear exactly as Postgres prints them. Press `Shift+Enter` on a cell to see the full value (JSON is pretty-printed), or double-click it in a result you can't edit. Click a column header to sort by it (again for descending, a third time to go back), and type in **Filter rows** (or press `Ctrl+F` in the grid) to show only rows with a value that contains the text. Right-click a column header to sort from a menu and, when the column has fewer than 50 different values, tick values and choose **Show ticked** or **Hide ticked**; a funnel in the header marks the filter and opens the menu again. Sorting and filtering work on the loaded rows and run nothing again. When a result hits the limit, **Load more** runs a read-only statement again with room for another batch. **Export** copies results as CSV, JSON or a Markdown table, or saves a CSV file: for a read-only statement it streams every row on a separate read-only connection, not just the rows on screen. **Transpose** shows each row as a column, with the column names down the side, which is easier to read for a few wide rows. Very wide grids only draw the columns in view.
- **Editing rows.** When a result's columns come from one table (a table opened from the sidebar, or any `select` from a single table) and include its primary key, you can edit it in place, as in DataGrip. Type into a selected cell, or double-click it or press `Enter`, to edit it; JSON and values with line breaks open in an editor with **Set NULL**. `Delete` sets the selected cells to NULL. Select rows (click a row number, shift-click another, or `Ctrl+A`) and press `Delete` to mark them for deletion. Pasting over selected cells fills them: one copied value fills every selected cell. Edited cells are marked in amber and deleted rows are struck through until you save. `Ctrl+Z` in the grid undoes the changes to the selected cells or rows, and **Discard** drops them all. **Save** (or `Ctrl+Enter` in the grid) runs the changes on the query's own session in one go: in a transaction of their own, or inside a savepoint when a transaction is open, so either all of them are saved or none. An update that finds no row (because it changed since the query ran) saves nothing. Saved rows show what Postgres returned, defaults and triggers included. If the save fails, the changes stay so you can fix them. On Production the save asks first. Running the query again asks before it drops unsaved changes.
- **Adding rows.** The **+** button in the results bar adds an empty row under the result, also when the primary key is missing from it. `Delete` puts a new row's cell back to the column's default. Copy rows with `Ctrl+C` and paste them into a new row with `Ctrl+V`: the values fill the row and as many rows below it as you copied. Pasting with whole rows of the result selected adds the rows at the bottom. New rows are inserted with the other changes when you save.
- **Variables.** Write `:name` (or `$1`) in a query and a bar above the editor asks for the values, saved per tab. Running with a missing value points you at the field. Type values without quotes: each one is inserted as a quoted literal, and Postgres converts it to the type the query needs. That means `where created_at > :since`, `limit :n`, `interval :age` and `:since is null` all work. For lists, write `= any(:ids)` and enter `{1,2,3}`. The NULL button sends `NULL`. Placeholders inside strings, comments, `::` casts and function bodies are left alone. Click a field, press `↓` or use its arrow to pick a value the variable already has: its environment's value, the global one, values from other queries in the history, and the other environments' values, each with its badge.
- **Environment variables.** Under **Environment variables** (in the variables bar or in Settings), give each variable a value per environment, for example `:tenant_id` = `test-42` on Test and `acme` on Production. A tab uses the column that matches its database's environment mark, so moving a tab from test to production switches the values. Check **Global** to give a variable one value for every database, including databases without an environment mark. A value set for an environment wins over a global one. Values that come from the environment show the environment's badge, and global values show a GLOBAL badge. Typing in the field overrides the value for that tab, and the reset button goes back to the environment's value. On Production, the confirmation dialog shows statements with their values filled in.
- **Database diagram.** The diagram button on a database in the sidebar (or in the query toolbar) opens an ER diagram in its own tab. It shows every table with its columns, primary and foreign keys, and crow's-foot relationship lines from each foreign key to the column it references; a circle marks a nullable foreign key. The layout is automatic. Drag tables to rearrange them, scroll to zoom, and hover a table to highlight its relationships. You can also filter by schema, show keys only, find a table, double-click a table to query it, or export the diagram as PNG or SVG.
- **Environment colors.** Mark a connection as Local, Development, Test or Production in its settings, or mark single databases on a shared server (say `app_prod` red, `app_test` amber). Queries on a marked database show a colored strip and a badge in the toolbar, and the history and sidebar show the mark too. In the sidebar, a connection's mark sits on the connection, and a database only shows a mark of its own that differs from it. On Production, statements that change data or schema (`UPDATE`, `DELETE`, `DROP`, `WITH … DELETE`, `SELECT … INTO` and so on) wait for you to confirm them. Plain reads run right away. Production sessions are also read-only on the server (`default_transaction_read_only`), so Postgres refuses writes Slate can't see, such as a `SELECT` that calls a function that writes. The error then offers to run again with writes allowed, after the same confirmation.
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
| `Ctrl+C` / `Ctrl+V` in the grid | Copy the selected cells or rows / paste over the selected cells, or into new rows |
| `Enter`, `F2` or typing in the grid | Edit the selected cell |
| `Shift+Enter` in the grid | Show the full value, in an editor when the cell can be edited |
| `Delete` in the grid | Set the selected cells to NULL (DEFAULT in new rows), or delete the selected rows |
| `Ctrl+Z` in the grid | Undo the changes to the selected cells or rows |
| `Ctrl+Enter` in the grid with changes | Save the changes |
| `Ctrl+F` in the grid | Filter the rows |
| `Ctrl+Shift+C` / `Ctrl+Shift+R` | Commit / roll back the open transaction |
| `Tab` / `Esc` | Accept / dismiss AI suggestion |
| `Alt+\` | Ask AI for a suggestion now |
| `Ctrl+Space` | Schema completion |
| `Ctrl+T` | New query |
| `Ctrl+Backspace` | Delete the current query from history (outside text fields; Undo brings it back) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous query in this database's history |
| `Ctrl+K` / `Ctrl+Shift+P` | Command palette |
| `Ctrl+B` | Show or hide history |
| `Ctrl+J` | Open or close the AI chat |
| `Ctrl+R` | Refresh the current database's schema |
| `Ctrl+Shift+F` | Filter tables |
| `Shift+Alt+F` | Format SQL |
| `Ctrl+F` | Find in editor |
| `Ctrl+,` | Settings |

On macOS, use `Cmd` instead of `Ctrl`, except for `Ctrl+Tab`: macOS keeps `Cmd+Tab` for switching apps. `Alt` is `Option`. Double-click a history entry, or the name in the title bar, to rename it.

## AI setup

Autocomplete runs on an Azure OpenAI deployment in Azure AI Foundry (`AzureOpenAI` from the `openai` package, Responses API, low reasoning effort). In Settings, enter the resource endpoint, the deployment name and an API key; the API version defaults to `2025-04-01-preview`. A full request URL like `https://<resource>.cognitiveservices.azure.com/openai/responses?api-version=...` works as the endpoint too. Instead of Settings you can set `AI_FOUNDRY_URL`, `AI_FOUNDRY_MODEL`, `AI_FOUNDRY_API_KEY` and `AI_FOUNDRY_API_VERSION` before starting the app; a field set in Settings wins over its variable. These values live in Slate's settings file in your user data folder, never in this repo. Keys and connection passwords are encrypted with the OS keychain (`safeStorage`).

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
| `npm run test:e2e` | Builds the app and drives it with Playwright against the sample database. A mock Azure OpenAI server stands in for the API. Screenshots go to `test-results/e2e`. Set `SLATE_EXE` to test a packaged build. |
| `npm run typecheck` | Type-checks main, preload and renderer |
| `npm start` | Runs the production build |
| `npm run dist` | Builds the Windows installer into `dist/` |
| `npm run dist:mac` | Builds the macOS `.dmg` and `.zip` (Apple Silicon and Intel) into `dist/`. It only runs on a Mac. |

### macOS

Slate runs on macOS with the native traffic-light buttons and a standard menu. Everything above works the same, with `Cmd` in place of `Ctrl`. Mac builds need a Mac: run `npm install && npm run dist:mac` there, or push the repository to GitHub and download the `slate-macos-latest` artifact from the `build` workflow in `.github/workflows/build.yml`. The build has an ad-hoc signature, not a Developer ID, so the first launch needs a right-click and **Open**. To skip that prompt for other people, add a Developer ID certificate and notarization.

### Layout

- `src/main` runs Node and holds connection pools, a session per tab (`db.ts`), saved connections and settings (`store.ts`), and the AI completion call (`ai.ts`).
- `src/preload` exposes a typed `window.slate.api` bridge. Channel names match the `Api` interface in `src/shared/api.ts`.
- `src/renderer` is React with a zustand store. The editor is CodeMirror 6, and the AI ghost text lives in `editor/ghost.ts`.
- `src/shared/sql.ts` splits scripts into statements, handling quotes, dollar quoting and comments. Main and renderer both use it.

## License

MIT. See [LICENSE](LICENSE).
