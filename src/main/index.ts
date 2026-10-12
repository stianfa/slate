import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SAVE_WORKSPACE_NOW, type Api } from '@shared/api'
import { connectionChanged } from '@shared/types'
import { AiCompleter, describeAiError } from './ai'
import { DbManager } from './db'
import { describeSchema } from './schemaText'
import { Store } from './store'

// Lets tests and side-by-side installs use their own profile.
if (process.env.SLATE_USER_DATA) app.setPath('userData', process.env.SLATE_USER_DATA)

let window: BrowserWindow | null = null
let db: DbManager | null = null
let quitConfirmed = false

/** Asks before quitting would roll back open transactions. True means go ahead. */
function confirmQuit(): boolean {
  const open = db?.openTransactions() ?? []
  if (quitConfirmed || open.length === 0) return true
  const databases = [...new Set(open.map((t) => t.database))].join(', ')
  const choice = dialog.showMessageBoxSync(window ?? undefined!, {
    type: 'warning',
    buttons: ['Cancel', 'Quit and roll back'],
    defaultId: 0,
    cancelId: 0,
    message: open.length === 1 ? 'A transaction is still open' : `${open.length} transactions are still open`,
    detail: `Quitting rolls back the open transactions on ${databases}. Commit them first to keep the changes.`
  })
  quitConfirmed = choice === 1
  return quitConfirmed
}

const TITLE_BAR_HEIGHT = 40
const titleBarColors = () =>
  nativeTheme.shouldUseDarkColors ? { color: '#0e1014', symbolColor: '#c9ced6' } : { color: '#f6f7f9', symbolColor: '#3b4250' }

function createWindow() {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 860,
    minHeight: 520,
    show: false,
    title: 'Slate',
    // Packaged builds take the icon from the executable; this covers `npm run dev` and `npm start`.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    backgroundColor: titleBarColors().color,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { ...titleBarColors(), height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => window?.show())
  // On Windows and Linux closing the window quits, so ask here while the window still exists.
  window.on('close', (event) => {
    if (process.platform !== 'darwin' && !confirmQuit()) event.preventDefault()
  })
  // There is no app menu on Windows/Linux, so wire up the few shortcuts it would have provided.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !window) return
    const mod = input.control || input.meta
    const contents = window.webContents
    if (input.key === 'F12' || (mod && input.shift && input.key.toLowerCase() === 'i')) {
      contents.toggleDevTools()
    } else if (mod && (input.key === '=' || input.key === '+')) {
      contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 4))
    } else if (mod && input.key === '-') {
      contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3))
    } else if (mod && input.key === '0') {
      contents.setZoomLevel(0)
    } else return
    event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  // Diagram exports arrive as downloads; Electron asks where to save them, starting in Downloads.
  window.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
  })

  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(join(__dirname, '../renderer/index.html'))
}

async function askSavePath(defaultName: string): Promise<string | null> {
  const options = {
    defaultPath: join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  }
  const { canceled, filePath } = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  return canceled || !filePath ? null : filePath
}

function registerIpc() {
  const store = new Store()
  const manager = new DbManager((id) => store.resolve(id))
  db = manager
  const ai = new AiCompleter(() => store.aiConfig())

  const api: Api = {
    listConnections: async () => store.listConnections(),
    saveConnection: async (input) => {
      const previous = input.id ? store.listConnections().find((c) => c.id === input.id) : undefined
      const saved = store.saveConnection(input)
      // New credentials or host: drop open sessions so the next query reconnects with them.
      // Renaming or re-marking the environment leaves running work alone.
      if (previous && (connectionChanged(previous, input) || input.password !== undefined)) await manager.disconnect(saved.id)
      return saved
    },
    deleteConnection: async (id) => {
      await manager.disconnect(id)
      store.deleteConnection(id)
    },
    testConnection: async (input) => {
      try {
        const version = await manager.test({ ...input, password: store.passwordFor(input) })
        return { ok: true, message: `Connected · PostgreSQL ${version}` }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
    connect: (id) => manager.connect(id),
    disconnect: (id) => manager.disconnect(id),
    getSchema: (target, refresh) => manager.schema(target, refresh),
    runQuery: (tabId, target, sql, rowLimit, variables, options) =>
      manager.run(tabId, target, sql, rowLimit, variables, options),
    cancelQuery: (tabId) => manager.cancel(tabId),
    closeSession: (tabId) => manager.closeSession(tabId),
    getSettings: async () => store.getSettings(),
    saveSettings: async (input) => store.saveSettings(input),
    testAi: async () => {
      try {
        await ai.test()
        return { ok: true, message: `Working · ${store.aiConfig()?.deployment}` }
      } catch (e) {
        return { ok: false, message: describeAiError(e) }
      }
    },
    complete: async ({ requestId, target, prefix, suffix }) => {
      if (!store.aiEnabled()) return null
      const schema = manager.cachedSchema(target) ?? (await manager.schema(target))
      const schemaText = describeSchema(schema, {
        database: target.database,
        version: manager.serverVersion(target.connectionId),
        editorText: prefix + suffix
      })
      try {
        return await ai.complete(requestId, schemaText, prefix, suffix)
      } catch (e) {
        throw new Error(describeAiError(e))
      }
    },
    cancelCompletion: async (requestId) => ai.cancel(requestId),
    copyText: async (text) => clipboard.writeText(text),
    saveFile: async (defaultName, content) => {
      const path = await askSavePath(defaultName)
      if (!path) return null
      writeFileSync(path, content)
      return path
    },
    exportQuery: async (target, statement, variables, defaultName) => {
      const path = await askSavePath(defaultName)
      if (!path) return null
      return { path, rows: await manager.exportCsv(target, statement, variables, path) }
    },
    loadWorkspace: async () => store.loadWorkspace(),
    saveWorkspace: async (json) => store.saveWorkspace(json),
    setTitleBarColors: async ({ background, symbols }) => {
      if (process.platform !== 'darwin') {
        window?.setTitleBarOverlay({ color: background, symbolColor: symbols, height: TITLE_BAR_HEIGHT })
      }
      window?.setBackgroundColor(background)
    }
  }

  // Errors travel as values so the renderer sees the plain message, not Electron's wrapper text.
  for (const [name, fn] of Object.entries(api) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    ipcMain.handle(name, async (_event, ...args) => {
      try {
        return { value: await fn(...args) }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    })
  }

  ipcMain.on(SAVE_WORKSPACE_NOW, (event, json: string) => {
    try {
      store.saveWorkspace(json)
      event.returnValue = true
    } catch {
      event.returnValue = false
    }
  })

  return manager
}

// macOS needs an Edit menu for Cmd+C/V/X/A/Z to work in text fields. Reload is left out on
// purpose: Cmd+R would throw away every result on screen.
function macMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ])
}

app.whenReady().then(() => {
  // On Windows/Linux the default menu binds Ctrl+W/Ctrl+R to closing and reloading; the app handles its own keys.
  Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null)
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  const manager = registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  let closing = false
  app.on('before-quit', (event) => {
    if (closing) return
    // macOS keeps running after its window closes, so Cmd+Q is where open transactions are caught.
    if (!confirmQuit()) {
      event.preventDefault()
      return
    }
    closing = true
    event.preventDefault()
    // Give open sessions a moment to end cleanly so servers don't log aborted connections.
    Promise.race([manager.closeAll(), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
