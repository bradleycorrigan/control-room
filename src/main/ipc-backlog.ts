import { ipcMain } from 'electron'
import { createSubtask } from './exec/jira'

/**
 * IPC handlers added in the backlog round. Registered from registerIpcHandlers
 * (ipc.ts) so that file only needs the one call.
 */
export function registerBacklogIpc(): void {
  ipcMain.handle(
    'backlog:createSubtask',
    (_evt, project: string, parentKey: string, summary: string) =>
      createSubtask(project, parentKey, summary)
  )
}
