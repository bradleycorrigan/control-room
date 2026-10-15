#!/usr/bin/env node
// Real tmux panes for terminal testing, in a dedicated session this repo's
// tooling owns outright: "cr-fixture-<hash>", where <hash> is 8 hex chars of
// this checkout's path, so each git worktree has its own (see fixture-name.ts).
// NEVER touch "wt" or any other session from this script — that is the user's
// own tmux server, and two tmux servers have already been lost on this machine
// to agents doing exactly that. Every tmux mutation below is scoped to this
// checkout's session only, with an exact (`=`) target so a prefix match can
// never widen it.
//
// Usage: npm run fixture:tmux [count]
// Teardown: tmux kill-session -t =<name>. This script prints <name> when it
// starts ('creating session "<name>"'). To list every fixture session on this
// machine, run: tmux ls | grep cr-fixture-

import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { defaultFixtureRoot, fixtureTmuxName, REPO_ROOT } from './fixture-name'

// The fixture root to put panes in: the same CR_FIXTURE_ROOT build-fixture.ts reads.
const fixtureRoot = process.env.CR_FIXTURE_ROOT
  ? resolve(REPO_ROOT, process.env.CR_FIXTURE_ROOT)
  : defaultFixtureRoot(REPO_ROOT)
const SESSION = fixtureTmuxName(REPO_ROOT, fixtureRoot)
const count = parseInt(process.argv[2] ?? '3', 10)
const worktreeRoot = join(fixtureRoot, 'project.worktrees')

// Matches build-fixture.ts's worktree dir names, so each window's cwd lands
// findPaneForSession's cwd-match (src/main/engine/discovery.ts) without any
// session JSON needing a `tmux` field.
const WINDOWS = [
  'feature-working',
  'feature-waiting',
  'feature-ready',
  'feature-done',
  'feature-errored'
]

function tmux(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('tmux', args, { encoding: 'utf8' })
}

const has = tmux(['has-session', '-t', `=${SESSION}`])
if (has.status === 0) {
  console.log(`fixture-tmux: killing existing session "${SESSION}"`)
  tmux(['kill-session', '-t', `=${SESSION}`])
}

const windows = WINDOWS.slice(0, Math.max(count, WINDOWS.length))
const [first, ...rest] = windows

console.log(`fixture-tmux: creating session "${SESSION}" with ${windows.length} windows`)
tmux(['new-session', '-d', '-s', SESSION, '-n', first, '-c', join(worktreeRoot, first)])

for (const name of rest) {
  tmux(['new-window', '-t', `=${SESSION}`, '-n', name, '-c', join(worktreeRoot, name)])
}

// Sample coloured output in the first window, so a terminal screenshot shows
// how the theme treats text. The 24-bit pale pink stands in for Claude
// Code's own fixed colours (it prints file paths in one), which no ANSI
// palette can remap; on a light theme it was near-invisible.
tmux([
  'send-keys',
  '-t',
  `=${SESSION}:${first}`,
  "clear; printf '\\033[38;2;255;175;215msrc/engine/status.js\\033[0m  \\033[35mmagenta\\033[0m  \\033[90mdim grey\\033[0m  plain text\\n'",
  'Enter'
])

// A plain shell in each window, cwd'd into the matching fixture worktree —
// enough to exercise send-keys, resize and PTY attach/detach without
// needing a live agent, and enough for findPaneForSession to join it to the
// right session record by cwd.
console.log(`fixture-tmux: ready. windows: ${tmux(['list-windows', '-t', `=${SESSION}`]).stdout}`)
console.log(`fixture-tmux: attach with: tmux attach -t ${SESSION}`)
console.log(`fixture-tmux: teardown with: tmux kill-session -t =${SESSION}`)
