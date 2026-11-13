/**
 * The editors "Open in …" knows how to start. Plain data, so the renderer can
 * read names from it without a round trip.
 *
 * `apps` are the .app names looked for in /Applications and ~/Applications
 * (JetBrains Toolbox installs to the second). `cli` is the editor's own shell
 * command, used when it's on PATH because it can force a new window.
 * `workspaceFiles`: opens a session's .code-workspace file, which carries the
 * interpreter and tasks. Editors without it get the worktree folder instead.
 */
export interface EditorInfo {
  id: EditorId
  name: string
  apps: string[]
  cli?: { command: string; newWindow: string[] }
  workspaceFiles: boolean
}

export type EditorId =
  'cursor' | 'vscode' | 'windsurf' | 'zed' | 'sublime' | 'webstorm' | 'intellij' | 'pycharm'

export const EDITORS: EditorInfo[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    apps: ['Cursor'],
    cli: { command: 'cursor', newWindow: ['-n'] },
    workspaceFiles: true
  },
  {
    id: 'vscode',
    name: 'VS Code',
    apps: ['Visual Studio Code'],
    cli: { command: 'code', newWindow: ['-n'] },
    workspaceFiles: true
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    apps: ['Windsurf'],
    cli: { command: 'windsurf', newWindow: ['-n'] },
    workspaceFiles: true
  },
  {
    id: 'zed',
    name: 'Zed',
    apps: ['Zed'],
    cli: { command: 'zed', newWindow: ['-n'] },
    workspaceFiles: false
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    apps: ['Sublime Text'],
    cli: { command: 'subl', newWindow: ['-n'] },
    workspaceFiles: false
  },
  { id: 'webstorm', name: 'WebStorm', apps: ['WebStorm'], workspaceFiles: false },
  {
    id: 'intellij',
    name: 'IntelliJ IDEA',
    apps: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA CE'],
    workspaceFiles: false
  },
  {
    id: 'pycharm',
    name: 'PyCharm',
    apps: ['PyCharm', 'PyCharm Professional Edition', 'PyCharm CE'],
    workspaceFiles: false
  }
]

/** `editor` setting: one of the list, or your own command. */
export type EditorChoice = EditorId | 'custom'

export const DEFAULT_EDITOR_COMMAND = 'code -n {folder}'

/** What menus call it: "Open in VS Code". A custom command is "your editor". */
export function editorName(choice: EditorChoice | null | undefined): string {
  if (!choice) return 'editor'
  if (choice === 'custom') return 'your editor'
  return EDITORS.find((e) => e.id === choice)?.name ?? 'editor'
}

/**
 * A custom editor command as argv, with `{folder}` filled in. Words split on
 * spaces; single or double quotes keep a word together. It never goes near a
 * shell. A command with no `{folder}` gets the folder on the end.
 */
export function customArgv(command: string, folder: string): string[] {
  const words = command.trim().match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  const argv = words.map((w) => w.replace(/^(['"])(.*)\1$/, '$2'))
  const filled = argv.map((w) => w.replaceAll('{folder}', folder))
  if (!argv.some((w) => w.includes('{folder}'))) filled.push(folder)
  return filled
}
