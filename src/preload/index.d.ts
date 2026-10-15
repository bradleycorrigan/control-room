import { ElectronAPI } from '@electron-toolkit/preload'

export interface ControlRoomApi {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  on: (channel: string, fn: (payload: unknown) => void) => () => void
  getPathForFile: (file: File) => string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ControlRoomApi
  }
}
