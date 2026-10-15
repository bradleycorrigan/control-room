// Hooks from inside a dev container. There, 127.0.0.1 is the container, and
// Claude Code's session id and cwd (/workspace, say) mean nothing to the Mac,
// so the agent starts with CR_HOOK_URL pointing at /hook/container/<record
// id>, and a command hook posts there. This drives the real pieces:
//
//   - the launch line carries CR_HOOK_URL, quoted, inside the container command
//   - the installed hooks hold both the Mac's http hook and the container one,
//     and an install from before the container hook reads as out of date
//   - the hook command itself (real sh + curl) posts the payload when
//     CR_HOOK_URL is set, and does nothing when it isn't
//   - the server drops a post with the wrong token and keeps one with the
//     right one, against the right record
//   - those events turn into a status
//
// Only 'electron' is stubbed, as in verify-hook-state-cwd.ts. The hook server
// listens on a spare port, never the app's, and never touches ~/.claude.
//
// Run: npm run verify:container-hooks

import Module from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok — ${name}`)
  } else {
    console.error(`  FAIL — ${name}${detail ? ` (${detail})` : ''}`)
    failures++
  }
}

const root = mkdtempSync(join(tmpdir(), 'cr-container-hooks-'))
const userDataDir = join(root, 'userData')
mkdirSync(userDataDir, { recursive: true })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { getPath: () => userDataDir, isPackaged: false } }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Runs the hook command as Claude Code does: sh, payload on stdin. Async, so the server can answer. */
function runHook(
  command: string,
  payload: unknown,
  env: Record<string, string>
): Promise<{ status: number | null; ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { env: { PATH: process.env.PATH ?? '', ...env } })
    child.on('close', (status) => resolve({ status, ms: Date.now() - started }))
    child.stdin.end(JSON.stringify(payload))
  })
}

async function post(url: string, body: unknown): Promise<number> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) })
  return res.status
}

async function main(): Promise<void> {
  const { load: loadStore, getState } = await import('../src/main/store/store')
  const server = await import('../src/main/engine/hooks-server')
  const { devContainerCommand } = await import('../src/main/exec/devcontainer')
  const hooks = await import('../src/main/engine/hooks-settings')
  const { computeContainerStatus } = await import('../src/main/engine/status')

  loadStore()
  const settings = getState().settings
  check('a hook token is made on first start', /^[0-9a-f]{48}$/.test(settings.hookToken))
  settings.hooksInstalled = false // never re-merge into the real ~/.claude/settings.json
  settings.hookPort = 40000 + Math.floor(Math.random() * 20000)
  settings.devContainerHookHost = '127.0.0.1' // this script plays the container

  const port = await server.startHooksEngine()
  check('the hook server listens', port !== null)
  if (!port) return

  const recordId = 'rec-123e4567-e89b'
  const url = server.containerHookUrl(recordId)
  check(
    'the container hook URL names the record and carries the token',
    url === `http://127.0.0.1:${port}/hook/container/${recordId}?token=${settings.hookToken}`,
    url ?? 'null'
  )

  // The launch line.
  const line = devContainerCommand(
    'claude --model opus',
    '/Users/me/repo.worktrees/x',
    settings,
    url
  )
  check(
    'the launch line starts the agent with CR_HOOK_URL, inside the container command',
    line.includes(
      `exec --workspace-folder '/Users/me/repo.worktrees/x' env CR_HOOK_URL='${url}' claude --model opus`
    ),
    line
  )
  check(
    'with no hook server, the agent starts without it',
    !devContainerCommand('claude', '/w', settings, null).includes('CR_HOOK_URL')
  )

  // What Install hooks writes.
  const config = hooks.buildOurHooksConfig(`http://127.0.0.1:${port}/hook`)
  const stop = config.Stop[0].hooks
  check(
    'every event gets the Mac hook and the dev container hook',
    Object.values(config).every((groups) =>
      groups.every(
        (g) => g.hooks.some((h) => h.type === 'http') && g.hooks.some((h) => h.type === 'command')
      )
    ) && stop.length === 2
  )
  const container = hooks.buildContainerHooksConfig()
  check(
    'the copyable dev container hooks hold only the command hook',
    Object.values(container).every((groups) =>
      groups.every((g) => g.hooks.length === 1 && g.hooks[0].type === 'command')
    )
  )
  check(
    "someone else's command hook isn't taken for ours",
    !hooks.isOurHook({ type: 'command', command: 'echo hi', timeout: 5 })
  )
  const settingsPath = join(root, 'settings.json')
  const httpOnly = hooks.buildOurHooksConfig(`http://127.0.0.1:${port}/hook`)
  for (const groups of Object.values(httpOnly)) {
    for (const g of groups) g.hooks = g.hooks.filter((h) => h.type === 'http')
  }
  writeFileSync(settingsPath, JSON.stringify({ hooks: httpOnly }))
  check(
    'an install from before the dev container hook reads as out of date',
    hooks.missingHookEvents(settingsPath, `http://127.0.0.1:${port}/hook`).length ===
      Object.keys(config).length
  )
  writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }))
  hooks.mergeHooksIntoSettings(settingsPath, `http://127.0.0.1:${port}/hook`)
  check(
    'after Install, nothing is missing',
    hooks.missingHookEvents(settingsPath, `http://127.0.0.1:${port}/hook`).length === 0
  )

  // The hook command, run the way Claude Code runs it: sh, payload on stdin.
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'inside-1', cwd: '/workspace' }
  const quiet = await runHook(hooks.CONTAINER_HOOK_COMMAND, payload, {})
  await wait(200)
  check(
    'with no CR_HOOK_URL (on the Mac), the command hook does nothing and succeeds',
    quiet.status === 0 && server.getContainerHookEvent(recordId) === null
  )
  const sent = await runHook(hooks.CONTAINER_HOOK_COMMAND, payload, { CR_HOOK_URL: url ?? '' })
  await wait(100)
  const got = server.getContainerHookEvent(recordId)
  check(
    'with CR_HOOK_URL, the command hook posts the event to its record',
    sent.status === 0 &&
      sent.ms < 3000 &&
      got?.type === 'UserPromptSubmit' &&
      got.sessionId === 'inside-1',
    `exit ${sent.status} after ${sent.ms}ms, got ${got?.type ?? 'nothing'}`
  )

  // The token.
  const wrong = `http://127.0.0.1:${port}/hook/container/${recordId}?token=nope`
  check(
    'a post with the wrong token is refused',
    (await post(wrong, { hook_event_name: 'Stop', session_id: 'inside-1' })) === 403
  )
  check('and changes nothing', server.getContainerHookEvent(recordId)?.type === 'UserPromptSubmit')
  check(
    'a post with no token is refused',
    (await post(`http://127.0.0.1:${port}/hook/container/${recordId}`, {})) === 403
  )

  // Events into status.
  const key = `record:${recordId}`
  check('no events yet: unknown', computeContainerStatus(key, null).status === 'unknown')
  check(
    'a prompt sent: working',
    computeContainerStatus(key, server.getContainerHookEvent(recordId)).status === 'working'
  )
  await post(url!, {
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    notification_message: 'Allow Bash?'
  })
  await wait(100)
  const asked = computeContainerStatus(key, server.getContainerHookEvent(recordId))
  check(
    'a permission prompt: needs you',
    asked.status === 'needs_attention' && asked.reason === 'Allow Bash?'
  )
  await post(url!, { hook_event_name: 'Stop', last_assistant_message: 'All done' })
  await wait(100)
  await post(url!, { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
  await wait(100)
  check(
    'a finished turn: done, and a later idle_prompt does not turn it into a question',
    computeContainerStatus(key, server.getContainerHookEvent(recordId)).status === 'done'
  )
  await post(url!, { hook_event_name: 'SessionEnd' })
  await wait(100)
  check(
    'Claude exiting in the container: stopped',
    computeContainerStatus(key, server.getContainerHookEvent(recordId)).status === 'stopped'
  )
  check("another record's events stay its own", server.getContainerHookEvent('rec-other') === null)

  server.stopHooksServer()
}

main()
  .catch((err) => {
    console.error(err)
    failures++
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true })
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed`)
      process.exit(1)
    }
    console.log('\nall container hook checks passed')
    process.exit(0)
  })
