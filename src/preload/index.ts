import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer — the renderer never touches ipcRenderer directly.
const api = {
  invoke: <T>(channel: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, fn: (payload: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => fn(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.off(channel, handler)
  },
  // Attachments' drag-and-drop path: a browser File carries no real
  // filesystem path once context isolation is on, and a File object can't
  // cross ipcRenderer.invoke to main (Node has no concept of one) — this is
  // the one supported way to resolve it, and it only works from here, with
  // the File reference still in hand. The renderer sends the resulting
  // string on to main like any other attachment path; nothing more crosses
  // this bridge than that string.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
