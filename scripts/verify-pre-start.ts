// Checks src/main/engine/pre-start.ts: which pane counts as "Claude running
// with no session file yet", and when that turns from starting to needing you.
// The case it guards: Claude stops on its folder trust prompt in a repo it has
// never opened, writes no session file, and the session sat on "Starting up"
// with the prompt hidden.
//
// Run: npx tsx scripts/verify-pre-start.ts

import {
  preStartPaneFor,
  preStartStatus,
  PRE_START_GRACE_MS,
  PRE_START_REASON
} from '../src/main/engine/pre-start'
import type { TmuxPane } from '../src/main/exec/tmux'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` ${detail}`}`)
}

const SHELLS = new Set(['zsh', 'bash'])
const record = {
  tmuxPaneId: '%5',
  tmuxWindowId: '@5',
  worktreePath: '/repos/example',
  devContainer: false
}
function pane(overrides: Partial<TmuxPane> = {}): Map<string, TmuxPane> {
  const p: TmuxPane = {
    sessionName: 'wt',
    windowId: '@5',
    windowIndex: 1,
    windowName: 'example',
    paneId: '%5',
    panePid: 100,
    panePath: '/repos/example',
    paneCommand: '2.1.316',
    ...overrides
  }
  return new Map([[p.paneId, p]])
}

check(
  "a record's own pane running Claude is picked up",
  preStartPaneFor(record, pane(), SHELLS)?.paneId === '%5'
)
check(
  'a pane back at a shell is not (Claude exited)',
  preStartPaneFor(record, pane({ paneCommand: 'zsh' }), SHELLS) === null
)
check(
  'a reused pane id in another window is not',
  preStartPaneFor(record, pane({ windowId: '@9' }), SHELLS) === null
)
check(
  'a reused pane id in another folder is not',
  preStartPaneFor(record, pane({ panePath: '/elsewhere' }), SHELLS) === null
)
check('a missing pane is not', preStartPaneFor(record, new Map(), SHELLS) === null)
check(
  'a dev container session is not (it has its own path)',
  preStartPaneFor({ ...record, devContainer: true }, pane(), SHELLS) === null
)

const early = preStartStatus(1_000, 1_000 + PRE_START_GRACE_MS - 1)
check('inside the grace it reads as starting', early.status === 'working', early.status)
const late = preStartStatus(1_000, 1_000 + PRE_START_GRACE_MS)
check(
  'after the grace it needs you, and says why',
  late.status === 'needs_attention' && late.waitingFor === PRE_START_REASON,
  late.status
)

if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All checks passed')
