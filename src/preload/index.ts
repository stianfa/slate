import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, SAVE_WORKSPACE_NOW, type Api, type Bridge } from '@shared/api'

const api = Object.fromEntries(
  API_METHODS.map((name) => [
    name,
    async (...args: unknown[]) => {
      const reply = (await ipcRenderer.invoke(name, ...args)) as { value?: unknown; error?: string }
      if (reply.error !== undefined) throw new Error(reply.error)
      return reply.value
    }
  ])
) as unknown as Api

const bridge: Bridge = {
  api,
  platform: process.platform,
  saveWorkspaceNow: (json) => ipcRenderer.sendSync(SAVE_WORKSPACE_NOW, json)
}
contextBridge.exposeInMainWorld('slate', bridge)
