import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, CHAT_DELTA, SAVE_WORKSPACE_NOW, type Api, type Bridge } from '@shared/api'

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
  saveWorkspaceNow: (json) => ipcRenderer.sendSync(SAVE_WORKSPACE_NOW, json),
  onChatDelta: (listener) => {
    const handler = (_event: IpcRendererEvent, requestId: string, delta: string) => listener(requestId, delta)
    ipcRenderer.on(CHAT_DELTA, handler)
    return () => ipcRenderer.removeListener(CHAT_DELTA, handler)
  }
}
contextBridge.exposeInMainWorld('slate', bridge)
