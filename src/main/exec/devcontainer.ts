import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '../store/types'
import { run } from './run'

/**
 * Dev containers, through the standard Dev Containers CLI
 * (https://containers.dev, `npm install -g @devcontainers/cli`).
 *
 * Nothing here runs the container itself. A session in a dev container types
 * one line into its tmux pane, the same way every session's agent starts:
 *
 *   <up command> && <run command>
 *
 * which by default is
 *
 *   devcontainer up --workspace-folder '<worktree>' &&
 *   devcontainer exec --workspace-folder '<worktree>' claude …
 *
 * so the container's build output, and any failure, shows in the session's
 * own terminal. Both commands are settings: a launcher script that keeps the
 * container config somewhere else (not in the repo) works too, with the "needs
 * a devcontainer.json" check turned off.
 */

type DevContainerSettings = Pick<
  AppSettings,
  'devContainerUpCommand' | 'devContainerRunCommand' | 'devContainerNeedsConfig'
>

/** Single-quotes a value for the pane's shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Where the Dev Containers CLI looks by default, without `--config`. */
export function hasDevContainerConfig(folder: string): boolean {
  return (
    existsSync(join(folder, '.devcontainer', 'devcontainer.json')) ||
    existsSync(join(folder, '.devcontainer.json'))
  )
}

/** The program a command line starts with: its first word, quotes removed, `~` expanded. */
export function commandProgram(command: string): string | null {
  const m = command.trim().match(/^(?:'([^']*)'|"([^"]*)"|(\S+))/)
  if (!m) return null
  const word = m[1] ?? m[2] ?? m[3] ?? ''
  if (!word) return null
  return word === '~' || word.startsWith('~/') ? join(homedir(), word.slice(1)) : word
}

async function programExists(program: string): Promise<boolean> {
  if (program.includes('/')) {
    try {
      accessSync(program, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  return (await run('which', [program])).code === 0
}

export interface DevContainerAvailability {
  available: boolean
  /** Why not, in plain words, for the log. */
  reason: string | null
}

/**
 * Can a session in `folder` start in a dev container right now? Only then does
 * the app show the option: the CLI (or whatever the run command starts with)
 * has to be found, and unless the setting says otherwise, the folder needs a
 * devcontainer.json.
 */
export async function devContainerAvailability(
  folder: string,
  settings: DevContainerSettings
): Promise<DevContainerAvailability> {
  const runCommand = settings.devContainerRunCommand.trim()
  if (!runCommand) return { available: false, reason: 'no run command set' }
  for (const command of [settings.devContainerUpCommand, runCommand]) {
    if (!command.trim()) continue
    const program = commandProgram(command)
    if (!program || !(await programExists(program))) {
      return { available: false, reason: `${program ?? command} not found` }
    }
  }
  if (settings.devContainerNeedsConfig && !hasDevContainerConfig(folder)) {
    return { available: false, reason: 'no devcontainer.json in the project' }
  }
  return { available: true, reason: null }
}

function fill(template: string, folder: string, agent: string): string {
  return template
    .replaceAll('{folder}', () => shellQuote(folder))
    .replaceAll('{agent}', () => agent)
}

/**
 * The line that starts `agentCommand` inside the dev container for `folder`.
 * `{folder}` is replaced with the folder, quoted; `{agent}` with the agent
 * command as is. A run command with no `{agent}` gets it on the end.
 *
 * With `hookUrl`, the agent starts as `env CR_HOOK_URL=<url> <agent>`, so its
 * hooks can find Control Room from inside the container (hooks-settings.ts's
 * CONTAINER_HOOK_COMMAND). `env` runs inside the container, so this works
 * through any launcher that runs the command it's given.
 */
export function devContainerCommand(
  agentCommand: string,
  folder: string,
  settings: DevContainerSettings,
  hookUrl: string | null = null
): string {
  const agent = hookUrl ? `env CR_HOOK_URL=${shellQuote(hookUrl)} ${agentCommand}` : agentCommand
  const runTemplate = settings.devContainerRunCommand.includes('{agent}')
    ? settings.devContainerRunCommand
    : `${settings.devContainerRunCommand} {agent}`
  const runLine = fill(runTemplate.trim(), folder, agent)
  const up = settings.devContainerUpCommand.trim()
  return up ? `${fill(up, folder, agent)} && ${runLine}` : runLine
}
