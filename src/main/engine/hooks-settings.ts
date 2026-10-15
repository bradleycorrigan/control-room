import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from '../log'

export const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

export interface HttpHookEntry {
  type: 'http'
  url: string
  timeout: number
}

export interface CommandHookEntry {
  type: 'command'
  command: string
  timeout: number
}

export type HookEntry = HttpHookEntry | CommandHookEntry

/**
 * The hook that reaches Control Room from inside a dev container, where
 * 127.0.0.1 is the container, not the Mac. Control Room starts the agent with
 * CR_HOOK_URL set to its address as seen from the container (see
 * exec/devcontainer.ts), and this posts the hook's own JSON there. Anywhere
 * else CR_HOOK_URL isn't set, and it does nothing: on the Mac, the http hook
 * above it does the work. Needs `curl` in the container.
 */
export const CONTAINER_HOOK_COMMAND =
  '[ -n "$CR_HOOK_URL" ] || exit 0; curl -s -m 5 -o /dev/null -H \'content-type: application/json\' --data-binary @- "$CR_HOOK_URL" || true'

export interface HookMatcherGroup {
  matcher?: string
  hooks: HookEntry[]
}

export type HooksConfig = Record<string, HookMatcherGroup[]>

function isOurHttpHook(hook: unknown): boolean {
  const h = hook as Partial<HttpHookEntry> | null
  return (
    !!h &&
    h.type === 'http' &&
    typeof h.url === 'string' &&
    h.url.startsWith('http://127.0.0.1:') &&
    h.url.includes('/hook')
  )
}

function isOurCommandHook(hook: unknown): boolean {
  const h = hook as Partial<CommandHookEntry> | null
  return (
    !!h &&
    h.type === 'command' &&
    typeof h.command === 'string' &&
    h.command.includes('CR_HOOK_URL')
  )
}

export function isOurHook(hook: unknown): hook is HookEntry {
  return isOurHttpHook(hook) || isOurCommandHook(hook)
}

export function buildOurHooksConfig(url: string): HooksConfig {
  const ourHook = [
    { type: 'http' as const, url, timeout: 10 },
    { type: 'command' as const, command: CONTAINER_HOOK_COMMAND, timeout: 10 }
  ]
  return {
    Notification: [
      { matcher: 'permission_prompt', hooks: ourHook },
      { matcher: 'idle_prompt', hooks: ourHook },
      { matcher: 'agent_needs_input', hooks: ourHook }
    ],
    Stop: [{ matcher: '', hooks: ourHook }],
    StopFailure: [{ matcher: '', hooks: ourHook }],
    // Announcements, so the app is told instead of having to look: you sent a
    // prompt (working, now), a session began, a session ended. Claude Code
    // never deletes a session's status file when it ends, so SessionEnd is
    // the only prompt way to hear about that.
    UserPromptSubmit: [{ matcher: '', hooks: ourHook }],
    SessionStart: [{ matcher: '', hooks: ourHook }],
    SessionEnd: [{ matcher: '', hooks: ourHook }]
  }
}

/**
 * Just the dev container hook, for a container that keeps its own
 * ~/.claude: paste it into that container's settings.json. (A container that
 * shares the Mac's ~/.claude already has it from Install hooks.)
 */
export function buildContainerHooksConfig(): HooksConfig {
  const config = buildOurHooksConfig('http://127.0.0.1:0/hook')
  for (const groups of Object.values(config)) {
    for (const group of groups) group.hooks = group.hooks.filter((h) => h.type === 'command')
  }
  return config
}

/**
 * Hook events we install that ~/.claude/settings.json doesn't carry in full
 * yet: an install from before an event, or the dev container hook, was added.
 * Empty when up to date.
 */
export function missingHookEvents(settingsPath: string, url: string): string[] {
  let hooks: HooksConfig = {}
  try {
    hooks = (JSON.parse(readFileSync(settingsPath, 'utf8')).hooks ?? {}) as HooksConfig
  } catch {
    return Object.keys(buildOurHooksConfig(url))
  }
  return Object.keys(buildOurHooksConfig(url)).filter(
    (event) =>
      !(hooks[event] ?? []).some((group) => group.hooks?.some((h) => isOurHttpHook(h))) ||
      !(hooks[event] ?? []).some((group) => group.hooks?.some((h) => isOurCommandHook(h)))
  )
}

export interface HookSettingsResult {
  ok: boolean
  error?: string
  backupPath?: string
}

function readAndBackup(
  settingsPath: string
): { obj: Record<string, unknown>; backupPath: string } | HookSettingsResult {
  if (!existsSync(settingsPath)) {
    return { ok: false, error: `${settingsPath} does not exist` }
  }

  const rawText = readFileSync(settingsPath, 'utf8')
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(rawText)
  } catch (err) {
    log.error('hooks-settings: existing file did not parse — aborting, nothing written', {
      settingsPath,
      error: String(err)
    })
    return { ok: false, error: 'existing settings.json did not parse as JSON' }
  }

  // Backed up before any write, every time — never overwritten, never pruned automatically.
  const backupPath = `${settingsPath}.controlroom-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(settingsPath, backupPath)

  return { obj, backupPath }
}

function writeSettings(settingsPath: string, obj: unknown): void {
  const tmpPath = `${settingsPath}.tmp-${process.pid}`
  writeFileSync(tmpPath, JSON.stringify(obj, null, 2))
  renameSync(tmpPath, settingsPath)
}

/** Merges `hooks` into settingsPath. Touches no other key. Never writes if the file fails to parse. */
export function mergeHooksIntoSettings(settingsPath: string, url: string): HookSettingsResult {
  const prepared = readAndBackup(settingsPath)
  if ('ok' in prepared) return prepared
  const { obj, backupPath } = prepared

  const hooks = (obj.hooks ?? {}) as HooksConfig
  const ours = buildOurHooksConfig(url)

  for (const [event, ourGroups] of Object.entries(ours)) {
    const existingGroups: HookMatcherGroup[] = hooks[event] ?? []
    for (const ourGroup of ourGroups) {
      const existing = existingGroups.find((g) => (g.matcher ?? '') === (ourGroup.matcher ?? ''))
      if (!existing) {
        existingGroups.push(ourGroup)
      } else {
        const withoutOurs: HookEntry[] = existing.hooks.filter((h) => !isOurHook(h))
        existing.hooks = withoutOurs.concat(ourGroup.hooks)
      }
    }
    hooks[event] = existingGroups
  }

  obj.hooks = hooks
  writeSettings(settingsPath, obj)

  return { ok: true, backupPath }
}

/** Removes only our hooks, then prunes any matcher group or event left empty. */
export function removeHooksFromSettings(settingsPath: string): HookSettingsResult {
  const prepared = readAndBackup(settingsPath)
  if ('ok' in prepared) return prepared
  const { obj, backupPath } = prepared

  const hooks = (obj.hooks ?? {}) as HooksConfig
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event]
      .map((group) => ({ ...group, hooks: group.hooks.filter((h) => !isOurHook(h)) }))
      .filter((group) => group.hooks.length > 0)
    if (hooks[event].length === 0) delete hooks[event]
  }

  if (Object.keys(hooks).length === 0) delete obj.hooks
  else obj.hooks = hooks

  writeSettings(settingsPath, obj)

  return { ok: true, backupPath }
}
