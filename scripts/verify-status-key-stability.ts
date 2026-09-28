// Regression test for P1 — the status flake: a session read as 'done' in one
// tick and 'idle'/resurrected-'done' in another because its identity key
// changes across polls.
//
// Mechanism (confirmed by running this script before the fix, see the
// milestone report for the captured log): `discoverLiveSessions()` computed
// each session's key as `session.sessionId ?? pane:<id> ?? path:<cwd>`, and
// `doneAcknowledgedAt` (src/main/engine/status.ts) was keyed by that same
// unstable string. A real `~/.claude/sessions/*.json` file does not always
// carry `sessionId` from the moment it appears — when Claude Code backfills
// it a poll or two later, the key flips from `path:<cwd>` (or `pane:<id>`) to
// the real session id. Because `doneAcknowledgedAt` is an in-memory Map keyed
// by the OLD string, the acknowledgement at the old key is orphaned: the next
// tick reads `ackAt = 0` for the NEW key and 'done' resurrects even though
// the user just cleared it.
//
// This drives the REAL discovery.ts / status.ts / store.ts / hooks-server.ts
// modules (not a reimplementation) against a disposable fixture, following
// the same pattern as verify-files-write.ts: only the 'electron' shell APIs
// (`app.getPath`, `app.isPackaged`) are stubbed so the modules can run
// outside a real Electron process; every other module is the genuine one.
//
// Run: npm run verify:status-key-stability

import Module from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok — ${name}`)
  } else {
    console.error(`  FAIL — ${name}`)
    failures++
  }
}

// --- stub 'electron' before anything under src/main is imported -----------
const root = mkdtempSync(join(tmpdir(), 'cr-status-key-fixture-'))
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

const sessionsDir = join(root, 'sessions')
mkdirSync(sessionsDir, { recursive: true })
process.env.CR_SESSIONS_DIR = sessionsDir

async function main(): Promise<void> {
  const { load: loadStore } = await import('../src/main/store/store')
  const { seedFixtureHookEvents } = await import('../src/main/engine/hooks-server')
  const { discoverLiveSessions } = await import('../src/main/engine/discovery')
  const { acknowledgeSession } = await import('../src/main/engine/status')

  loadStore() // no state.json on disk yet -> empty state, exactly like a fresh install

  const cwd = join(root, 'worktree-flaky')
  mkdirSync(cwd, { recursive: true })

  const now = Date.now()
  const sessionFilePath = join(sessionsDir, 'flaky.json')

  function writeSessionFile(withSessionId: boolean): void {
    writeFileSync(
      sessionFilePath,
      JSON.stringify({
        pid: 1, // launchd — always "alive" via kill(pid, 0)
        ...(withSessionId ? { sessionId: 'real-session-abc' } : {}),
        cwd,
        startedAt: now - 30 * 60 * 1000,
        status: 'idle',
        statusUpdatedAt: now - 15 * 60 * 1000,
        name: 'flaky'
      })
    )
  }

  // Tick 1 — session file has NOT yet been assigned a claudeSessionId (this
  // really happens: Claude Code doesn't always write `sessionId` the instant
  // a session file appears). No SessionRecord exists either (an unadopted
  // session, e.g. started with `wta`). The Stop hook can only correlate by
  // cwd in this state.
  writeSessionFile(false)
  seedFixtureHookEvents([
    { type: 'Stop', sessionId: null, cwd, message: 'finished the fixture task', at: now - 60_000 }
  ])

  const tick1 = await discoverLiveSessions()
  const s1 = tick1.find((s) => s.cwd === cwd)!
  console.log('tick1', { key: s1.key, claudeSessionId: s1.claudeSessionId, status: s1.status })
  check('tick1: resolves to done before any id is known', s1.status === 'done')
  check('tick1: key falls back to a path-based identity', s1.key === `path:${cwd}`)

  // User opens the session detail view and acknowledges 'done', using
  // whatever key tick1 handed the renderer over IPC.
  acknowledgeSession(s1.key)

  const tick2 = await discoverLiveSessions()
  const s2 = tick2.find((s) => s.cwd === cwd)!
  console.log('tick2', { key: s2.key, claudeSessionId: s2.claudeSessionId, status: s2.status })
  check('tick2: acknowledging clears done under the same key', s2.status !== 'done')

  // Claude Code now backfills the real session id onto the same session file
  // — nothing else about the session changed.
  writeSessionFile(true)

  const tick3 = await discoverLiveSessions()
  const s3 = tick3.find((s) => s.cwd === cwd)!
  console.log('tick3', { key: s3.key, claudeSessionId: s3.claudeSessionId, status: s3.status })
  check(
    "tick3: an acknowledged 'done' must not resurrect once the session's id becomes known",
    s3.status !== 'done'
  )

  rmSync(root, { recursive: true, force: true })
  delete process.env.CR_SESSIONS_DIR

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
