import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import type { Api } from '@shared/api'
import { connectionChanged } from '@shared/types'
import { AiCompleter, describeAiError } from './ai'
import { DbManager } from './db'
import { describeSchema } from './schemaText'
import { Store } from './store'

// Lets tests and side-by-side installs use their own profile.
if (process.env.SLATE_USER_DATA) app.setPath('userData', process.env.SLATE_USER_DATA)

let window: BrowserWindow | null = null

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

function registerIpc() {
  const store = new Store()
  const db = new DbManager((id) => store.resolve(id))
  const ai = new AiCompleter(
    () => store.apiKey(),
    () => store.aiModel()
  )

  const api: Api = {
    listConnections: async () => store.listConnections(),
    saveConnection: async (input) => {
      const previous = input.id ? store.listConnections().find((c) => c.id === input.id) : undefined
      const saved = store.saveConnection(input)
      // New credentials or host: drop open sessions so the next query reconnects with them.
      // Renaming or re-marking the environment leaves running work alone.
      if (previous && (connectionChanged(previous, input) || input.password !== undefined)) await db.disconnect(saved.id)
      return saved
    },
    deleteConnection: async (id) => {
      await db.disconnect(id)
      store.deleteConnection(id)
    },
    testConnection: async (input) => {
      try {
        const version = await db.test({ ...input, password: store.passwordFor(input) })
        return { ok: true, message: `Connected · PostgreSQL ${version}` }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
    connect: (id) => db.connect(id),
    disconnect: (id) => db.disconnect(id),
    getSchema: (target, refresh) => db.schema(target, refresh),
    runQuery: (tabId, target, sql, rowLimit, variables, options) =>
      db.run(tabId, target, sql, rowLimit, variables, options),
    cancelQuery: (tabId) => db.cancel(tabId),
    closeSession: (tabId) => db.closeSession(tabId),
    getSettings: async () => store.getSettings(),
    saveSettings: async (input) => store.saveSettings(input),
    testAi: async () => {
      try {
        await ai.test()
        return { ok: true, message: `Working · ${store.aiModel()}` }
      } catch (e) {
        return { ok: false, message: describeAiError(e) }
      }
    },
    complete: async ({ requestId, target, prefix, suffix }) => {
      if (!store.aiEnabled()) return null
      const schema = db.cachedSchema(target) ?? (await db.schema(target))
      const schemaText = describeSchema(schema, {
        database: target.database,
        version: db.serverVersion(target.connectionId),
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

  return db
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
  const db = registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  let closing = false
  app.on('before-quit', (event) => {
    if (closing) return
    closing = true
    event.preventDefault()
    // Give open sessions a moment to end cleanly so servers don't log aborted connections.
    Promise.race([db.closeAll(), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
