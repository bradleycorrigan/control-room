import { ipcMain } from 'electron'
import { quickIssueLookup } from './exec/jira'

/**
 * IPC handlers added in the palette round. Registered from registerIpcHandlers
 * (ipc.ts) so that file only needs the one call.
 */
export function registerPaletteIpc(): void {
  // ⌘K typing a ticket key ("DSD-101", "dsd 101") — the renderer normalizes
  // and debounces, this just answers one lookup.
  ipcMain.handle('palette:findTicket', async (_evt, key: string) => {
    return quickIssueLookup(key)
  })
}
