// Regression test: sessions that share a cwd must not borrow each other's
// hook state. getHookState used to fall back to a cwd lookup whenever the
// session id missed, so a second "General" session in the home folder (or a
// second session in one checkout) read the first one's Stop/Notification.
//
// Drives the real hooks-server.ts and status.ts (only 'electron' is stubbed,
// as in verify-status-key-stability.ts).
//
// Run: npm run verify:hook-state-cwd

import Module from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'cr-hook-cwd-fixture-'))
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

async function main(): Promise<void> {
  const { load: loadStore } = await import('../src/main/store/store')
  const { seedFixtureHookEvents, getHookState, setLiveSessions } =
    await import('../src/main/engine/hooks-server')
  const { computeInteractiveStatus } = await import('../src/main/engine/status')

  loadStore()

  const now = Date.now()
  const home = '/fixture/home'
  const solo = '/fixture/solo'

  // Session A finished a turn in the shared folder. B has said nothing.
  seedFixtureHookEvents([
    { type: 'Stop', sessionId: 'sess-a', cwd: home, message: 'A is done', at: now - 60_000 },
    { type: 'Stop', sessionId: 'sess-solo', cwd: solo, message: 'solo done', at: now - 60_000 }
  ])
  setLiveSessions([
    { sessionId: 'sess-a', cwd: home },
    { sessionId: 'sess-b', cwd: home },
    { sessionId: 'sess-solo', cwd: solo }
  ])

  check('A reads its own state', getHookState('sess-a', home)?.lastStop?.message === 'A is done')
  check('B does not borrow A through the shared cwd', getHookState('sess-b', home) === null)
  check('a session with no id does not borrow in a shared cwd', getHookState(null, home) === null)

  const statusB = computeInteractiveStatus({
    sessionKey: 'key-b',
    alive: true,
    rawStatus: 'idle',
    waitingFor: null,
    claudeSessionId: 'sess-b',
    cwd: home,
    statusUpdatedAt: now - 120_000
  })
  check("B's status is not 'done' from A's Stop", statusB.status !== 'done')

  // One session per folder keeps working, including the id-less case.
  check(
    'a lone session still reads its own state',
    getHookState('sess-solo', solo)?.lastStop?.message === 'solo done'
  )
  check(
    "a lone session doesn't take state written under a different id",
    getHookState('sess-solo-2', solo) === null
  )

  // An id-less event in a folder with one live session still attributes by cwd.
  const loose = '/fixture/loose'
  seedFixtureHookEvents([{ type: 'Stop', sessionId: null, cwd: loose, message: 'loose', at: now }])
  setLiveSessions([{ sessionId: null, cwd: loose }])
  check(
    'id-less session, id-less event, one session: cwd fallback',
    getHookState(null, loose) !== null
  )
  setLiveSessions([{ sessionId: 'sess-late', cwd: loose }])
  check(
    'session whose id is not yet in hook state falls back to an id-less cwd event',
    getHookState('sess-late', loose) !== null
  )
  setLiveSessions([
    { sessionId: null, cwd: loose },
    { sessionId: null, cwd: loose }
  ])
  check('two id-less sessions in one folder: no fallback', getHookState(null, loose) === null)

  rmSync(root, { recursive: true, force: true })
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
