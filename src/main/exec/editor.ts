import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './run'
import { log } from '../log'
import { getState } from '../store/store'
import { customArgv, EDITORS, editorName, type EditorInfo, type EditorId } from '../store/editors'

export interface OpenInIdeResult {
  ok: boolean
  error?: string
}

/** What to open: always a folder, and the session's workspace file when it has one. */
export interface OpenTarget {
  folder: string
  workspaceFile?: string | null
}

/** The .app it's installed as, or null. Checked each time: people install editors. */
function installedApp(editor: EditorInfo): string | null {
  for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
    for (const app of editor.apps) {
      if (existsSync(join(dir, `${app}.app`))) return app
    }
  }
  return null
}

async function onPath(command: string): Promise<string | null> {
  const which = await run('which', [command])
  return which.code === 0 && which.stdout.trim() ? which.stdout.trim() : null
}

export interface DetectedEditor {
  id: EditorId
  name: string
  installed: boolean
}

/** Every editor in the list, and whether this Mac has it. */
export async function detectEditors(): Promise<DetectedEditor[]> {
  return Promise.all(
    EDITORS.map(async (e) => ({
      id: e.id,
      name: e.name,
      installed:
        installedApp(e) !== null || (e.cli ? (await onPath(e.cli.command)) !== null : false)
    }))
  )
}

/**
 * Open a worktree in the editor chosen in Settings.
 *
 * The target is checked first: editor CLIs exit 0 even when the path does not
 * exist, so a no-op looked identical to success. The editor is brought to the
 * front afterwards: it launches behind the window you triggered it from, which
 * is its own way of looking like nothing happened.
 */
export async function openInEditor(target: OpenTarget): Promise<OpenInIdeResult> {
  if (!existsSync(target.folder)) {
    return { ok: false, error: `nothing to open: ${target.folder} no longer exists` }
  }
  const { editor: choice, editorCommand } = getState().settings
  if (!choice) {
    return { ok: false, error: 'no editor chosen yet. Pick one in Settings › Editor.' }
  }

  if (choice === 'custom') {
    const argv = customArgv(editorCommand || '', target.folder)
    if (argv[0] === '~' || argv[0]?.startsWith('~/')) argv[0] = join(homedir(), argv[0].slice(1))
    const [program, ...args] = argv
    if (!program) return { ok: false, error: 'the editor command in Settings is empty' }
    const res = await run(program, args)
    if (res.code === 0) return { ok: true }
    return {
      ok: false,
      error: res.stderr.trim().slice(0, 200) || `couldn't run ${program}. Check Settings › Editor.`
    }
  }

  const editor = EDITORS.find((e) => e.id === choice)
  if (!editor) return { ok: false, error: `unknown editor "${choice}". Pick one in Settings.` }
  const workspace =
    editor.workspaceFiles && target.workspaceFile && existsSync(target.workspaceFile)
      ? target.workspaceFile
      : null
  const path = workspace ?? target.folder
  const app = installedApp(editor)

  const cli = editor.cli ? await onPath(editor.cli.command) : null
  if (cli && editor.cli) {
    const direct = await run(cli, [...editor.cli.newWindow, path])
    if (direct.code === 0) {
      if (app) await run('open', ['-a', app])
      return { ok: true }
    }
    log.warn('editor: CLI failed, falling back to open -a', {
      editor: editor.id,
      code: direct.code,
      stderr: direct.stderr.trim().slice(0, 200)
    })
  }

  if (!app) return { ok: false, error: `${editorName(choice)} isn't installed on this Mac` }
  const fallback = await run('open', ['-a', app, path])
  if (fallback.code === 0) return { ok: true }
  return {
    ok: false,
    error: fallback.stderr.trim() || `could not launch ${editorName(choice)}`
  }
}
