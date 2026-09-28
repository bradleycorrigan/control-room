// Small cross-tab signal: clicking a Skills card should switch ProjectDetail's
// active tab to Files and open the given file in the editor there (plan 2.2,
// Skills paragraph: "Clicking a card opens its SKILL.md in the Files
// editor."). ProjectDetail owns `activeTab` and FilesTab owns the open-file
// state, and neither is in this tab's file set to edit, so this dispatches a
// plain window CustomEvent that a future ProjectDetail/FilesTab update can
// subscribe to (`onRequestOpenFile`) to perform the actual tab switch and
// file open. No OS access here — `relPath` is the same project-relative path
// api.ts's readFile/writeFile already take, never an absolute path.

export interface OpenFileRequest {
  projectId: string
  relPath: string
}

const EVENT_NAME = 'control-room:open-file'

export function requestOpenFile(projectId: string, relPath: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenFileRequest>(EVENT_NAME, { detail: { projectId, relPath } })
  )
}

export function onRequestOpenFile(handler: (request: OpenFileRequest) => void): () => void {
  const listener = (event: Event): void => {
    handler((event as CustomEvent<OpenFileRequest>).detail)
  }
  window.addEventListener(EVENT_NAME, listener)
  return () => window.removeEventListener(EVENT_NAME, listener)
}
