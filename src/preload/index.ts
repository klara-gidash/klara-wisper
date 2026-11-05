import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const api = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (payload: any) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('klara', api)

export type KlaraApi = typeof api
