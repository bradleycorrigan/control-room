#!/usr/bin/env node
// Builds the ONE seeded fixture CLAUDE.md's verification rule calls for: a
// fake project with real worktrees, plus synthetic ~/.claude/sessions/*.json
// files covering working, waiting (+ waitingFor), done, errored and stopped
// (missing is covered too — a registered worktree whose directory is gone).
//
// Deterministic and rebuildable — safe to delete .dev/fixture and re-run.
// Never touches the real ~/.claude or the real "Control Room Dev" userData.
//
// Usage: npm run fixture:build
// Then:  CR_SESSIONS_DIR=.dev/fixture/sessions npm run shot -- sessions tokyo-night

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..')
const fixtureRoot = join(root, '.dev', 'fixture')
const repoPath = join(fixtureRoot, 'project')
const worktreeRoot = join(fixtureRoot, 'project.worktrees')
const sessionsDir = join(fixtureRoot, 'sessions')

function git(args: string[], cwd: string): void {
  const res = spawnSync('git', args, { cwd, stdio: 'inherit' })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
  }
}

function gitQuiet(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

console.log('fixture: wiping', fixtureRoot)
rmSync(fixtureRoot, { recursive: true, force: true })
mkdirSync(repoPath, { recursive: true })
mkdirSync(worktreeRoot, { recursive: true })
mkdirSync(sessionsDir, { recursive: true })

console.log('fixture: creating main checkout at', repoPath)
git(['init', '-q', '-b', 'main'], repoPath)
git(['config', 'user.email', 'fixture@control-room.local'], repoPath)
git(['config', 'user.name', 'Control Room Fixture'], repoPath)

writeFileSync(
  join(repoPath, 'README.md'),
  '# fixture-project\n\nSynthetic repo used only by `npm run fixture:build` / `npm run shot`.\n'
)
writeFileSync(
  join(repoPath, 'CLAUDE.md'),
  '# fixture-project — build conventions\n\nSynthetic CLAUDE.md for the Rules tab fixture.\n'
)
mkdirSync(join(repoPath, 'src'), { recursive: true })
writeFileSync(join(repoPath, 'src', 'index.js'), "console.log('hello from the fixture project')\n")
mkdirSync(join(repoPath, '.claude', 'skills', 'demo-skill'), { recursive: true })
writeFileSync(
  join(repoPath, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
  '---\nname: demo-skill\ndescription: Synthetic project skill for the Skills tab fixture.\n---\n\nDemo skill body.\n'
)
git(['add', '-A'], repoPath)
git(['commit', '-q', '-m', 'Initial fixture commit'], repoPath)

// A second commit so the Git tab's log section has more than one entry.
writeFileSync(join(repoPath, 'src', 'index.js'), "console.log('hello again from the fixture')\n")
git(['add', '-A'], repoPath)
git(['commit', '-q', '-m', 'Update greeting'], repoPath)

// A stand-in for GitHub: a bare repo as `origin`, holding main and a branch
// that exists only there, so the branch picker has something real to list and
// resolve against (and a typo has something real to miss).
{
  const originPath = join(fixtureRoot, 'origin.git')
  mkdirSync(originPath, { recursive: true })
  git(['init', '-q', '--bare', '-b', 'main'], originPath)
  git(['remote', 'add', 'origin', originPath], repoPath)
  // An unmerged branch with its own commit (in progress, so listed), and one
  // already merged (so only found by a search).
  git(['branch', 'feature/merged-old', 'main'], repoPath)
  git(['checkout', '-q', '-b', 'feature/remote-only', 'main'], repoPath)
  writeFileSync(join(repoPath, 'REMOTE_ONLY.md'), 'work that only exists on origin\n')
  git(['add', 'REMOTE_ONLY.md'], repoPath)
  git(['commit', '-q', '-m', 'Work on a branch that only exists on origin'], repoPath)
  git(['checkout', '-q', 'main'], repoPath)
  git(['push', '-q', 'origin', 'main', 'feature/remote-only', 'feature/merged-old'], repoPath)
  git(['branch', '-D', 'feature/remote-only', 'feature/merged-old'], repoPath)
  git(['fetch', '-q', 'origin'], repoPath)
  git(['remote', 'set-head', 'origin', 'main'], repoPath)
}

// Leave real staged + unstaged + untracked changes for the Git tab.
writeFileSync(join(repoPath, 'src', 'index.js'), "console.log('staged change')\n")
git(['add', 'src/index.js'], repoPath)
writeFileSync(join(repoPath, 'README.md'), '# fixture-project\n\nUnstaged edit for the Git tab.\n')
writeFileSync(join(repoPath, 'NOTES.txt'), 'untracked file for the Git tab\n')

// Real worktrees for the sessions that need one on disk (Files/Git tabs
// operate on the main checkout, but Overview lists these against `sessions`).
const worktreeBranches = {
  'feature-working': 'working',
  'feature-waiting': 'waiting',
  'feature-ready': 'ready',
  'feature-done': 'done',
  'feature-errored': 'errored',
  'feature-stopped': 'stopped',
  'feature-idle': 'idle'
  // feature-missing is deliberately never created — its record points at a
  // path that doesn't exist, which is exactly what produces 'missing'.
}
for (const [dirName, branch] of Object.entries(worktreeBranches)) {
  const wtPath = join(worktreeRoot, dirName)
  git(['worktree', 'add', '-q', '-b', `fixture/${branch}`, wtPath, 'main'], repoPath)
}

// One commit on the ready session's branch, so its Ship button shows. That
// session is the one with an open pull request (CR_PR_FIXTURE), so the gate
// can open Ship on a branch whose PR already exists.
{
  const wtPath = join(worktreeRoot, 'feature-ready')
  writeFileSync(join(wtPath, 'READY.md'), 'Ready for review.\n')
  git(['add', '-A'], wtPath)
  git(['commit', '-q', '-m', 'Ready for review'], wtPath)
}

// Real work on one worktree, so the diff overlay has something to show. Every
// worktree used to be a clean checkout of main, which meant "View diff" opened
// on "No changes" and there was no way to look at the diff in the real app at
// all. Several files, across directories, plus a deletion and an untracked
// file — the shapes the overlay has to render differently.
{
  const wtPath = join(worktreeRoot, 'feature-working')
  mkdirSync(join(wtPath, 'src', 'engine'), { recursive: true })
  writeFileSync(
    join(wtPath, 'src', 'index.js'),
    "console.log('hello from the working branch')\nconsole.log('a second line, so the diff has context')\n"
  )
  writeFileSync(
    join(wtPath, 'src', 'engine', 'status.js'),
    [
      'export function statusOf(session) {',
      "  if (session.exited) return 'stopped'",
      "  if (session.waitingFor) return 'waiting'",
      "  return 'working'",
      '}',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(wtPath, 'README.md'),
    '# fixture-project\n\nNotes added on the working branch.\n'
  )
  rmSync(join(wtPath, 'CLAUDE.md'), { force: true })
  git(['add', '-A'], wtPath)
  git(['commit', '-q', '-m', 'Work in progress on the working branch'], wtPath)
  // A file long enough to overflow the diff overlay. Without one the overlay
  // never scrolls in the fixture, so a broken scroll container looks fine in
  // every screenshot — which is exactly how one shipped.
  writeFileSync(
    join(wtPath, 'src', 'long.js'),
    Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i}`).join('\n') + '\n'
  )
  git(['add', '-A'], wtPath)
  git(['commit', '-q', '-m', 'A long file, so the diff overflows'], wtPath)
  writeFileSync(join(wtPath, 'scratch.txt'), 'untracked scratch file\n')
}

// The `.cursor` link worktree setup adds to real worktrees, pointing back at
// shared Cursor config. It's untracked but never counts as uncommitted work,
// so this worktree must still read as clean in "Clean up worktrees".
{
  const sharedCursor = join(fixtureRoot, 'shared-cursor')
  mkdirSync(sharedCursor, { recursive: true })
  writeFileSync(join(sharedCursor, 'rules.md'), 'shared Cursor rules\n')
  symlinkSync(sharedCursor, join(worktreeRoot, 'feature-done', '.cursor'))
}

const now = Date.now()
const addedAt = now - 7 * 24 * 60 * 60 * 1000

const project = {
  id: 'fixture-project',
  name: 'fixture-project',
  repoPath,
  worktreeRoot,
  workspacesDir: join(worktreeRoot, '.workspaces'),
  baseRef: 'main',
  tmuxSession: 'cr-fixture',
  // Inert on purpose: the fixture exercises worktree creation and the tmux
  // join, and launching a real agent for that would burn tokens and leave a
  // live process behind on every check.
  agentCommand: 'echo fixture-agent',
  addedAt,
  // No remote here, so a fetch would fail and a base of origin/<default>
  // would not resolve. Without these two the fixture could never create a
  // worktree at all — which is the app's central operation and had nothing
  // covering it.
  worktreeFetchBeforeCreate: false,
  worktreeBaseBranch: 'main',
  setupCommand: '',
  // Pinned, so the pinned state has something to render. It was false here and
  // nowhere else, so nothing ever showed a pinned project — which is part of
  // how the pin button shipped using the same icon for both states.
  pinned: true
}

interface RecordInput {
  id: string
  title: string
  branch: string
  dirName: string
  worktreePath: string
  claudeSessionId: string | null
}

function record({
  id,
  title,
  branch,
  dirName,
  worktreePath,
  claudeSessionId
}: RecordInput): Record<string, unknown> {
  return {
    id,
    projectId: project.id,
    title,
    branch,
    dirName,
    worktreePath,
    workspaceFile: null,
    tmuxSessionName: 'cr-fixture',
    tmuxWindowName: dirName,
    tmuxWindowId: null,
    tmuxPaneId: null,
    claudeSessionId,
    origin: 'app',
    createdAt: addedAt,
    archivedAt: null,
    lastPrompt: 'Fixture session — no real prompt.',
    originalClaudeSessionId: null,
    startKind: 'create',
    waitingReason: null,
    isCustomName: false
  }
}

/** Marks one record archived after the fact — `record()` has no field for it. */
function archived(r: Record<string, unknown>): Record<string, unknown> {
  return { ...r, archivedAt: now - 2 * 60 * 60 * 1000 }
}

const sessions = [
  record({
    id: 'fixture-rec-working',
    title: 'Working session',
    branch: 'fixture/working',
    dirName: 'feature-working',
    worktreePath: join(worktreeRoot, 'feature-working'),
    claudeSessionId: 'fixture-working'
  }),
  record({
    id: 'fixture-rec-waiting',
    title: 'Waiting session',
    branch: 'fixture/waiting',
    dirName: 'feature-waiting',
    worktreePath: join(worktreeRoot, 'feature-waiting'),
    claudeSessionId: 'fixture-waiting'
  }),
  // ready: finished its turn and sitting at the prompt. Distinct from
  // 'waiting' above, which sets waitingFor and is genuinely blocked on an
  // answer. The two used to report as one status, so nothing here covered the
  // far more common of them.
  record({
    id: 'fixture-rec-ready',
    title: 'Ready session',
    branch: 'fixture/ready',
    dirName: 'feature-ready',
    worktreePath: join(worktreeRoot, 'feature-ready'),
    claudeSessionId: 'fixture-ready'
  }),
  record({
    id: 'fixture-rec-done',
    title: 'Done session',
    branch: 'fixture/done',
    dirName: 'feature-done',
    worktreePath: join(worktreeRoot, 'feature-done'),
    claudeSessionId: 'fixture-done'
  }),
  record({
    id: 'fixture-rec-errored',
    title: 'Errored session',
    branch: 'fixture/errored',
    dirName: 'feature-errored',
    worktreePath: join(worktreeRoot, 'feature-errored'),
    claudeSessionId: 'fixture-errored'
  }),
  // idle: the common case — finished, at its prompt, nothing pending.
  record({
    id: 'fixture-rec-idle',
    title: 'Idle session',
    branch: 'fixture/idle',
    dirName: 'feature-idle',
    worktreePath: join(worktreeRoot, 'feature-idle'),
    claudeSessionId: 'fixture-idle'
  }),
  // stopped: registered, worktree exists on disk, no live session file below.
  record({
    id: 'fixture-rec-stopped',
    title: 'Stopped session',
    branch: 'fixture/stopped',
    dirName: 'feature-stopped',
    worktreePath: join(worktreeRoot, 'feature-stopped'),
    claudeSessionId: null
  }),
  // stopped AND resumable: the case Resume exists for. The record above has no
  // claudeSessionId, so it is stopped with nothing to resume from — both states
  // matter and the fixture could previously only produce the first, which is why
  // the Resume control shipped with its positive case unverified.
  record({
    id: 'fixture-rec-resumable',
    title: 'Resumable session',
    branch: 'fixture/resumable',
    dirName: 'feature-stopped',
    worktreePath: join(worktreeRoot, 'feature-stopped'),
    claudeSessionId: 'fixture-claude-resumable'
  }),
  // archived: resumable (it has a claudeSessionId) and put aside. This is the
  // state History's Archived section exists for, and nothing here produced one.
  archived(
    record({
      id: 'fixture-rec-archived',
      title: 'Archived session',
      branch: 'fixture/archived',
      dirName: 'feature-stopped',
      worktreePath: join(worktreeRoot, 'feature-stopped'),
      claudeSessionId: 'fixture-claude-archived'
    })
  ),
  // missing: registered, but the worktree directory was never created —
  // simulates `wtrm` running behind the app's back.
  record({
    id: 'fixture-rec-missing',
    title: 'Missing session',
    branch: 'fixture/missing',
    dirName: 'feature-missing',
    worktreePath: join(worktreeRoot, 'feature-missing'),
    claudeSessionId: null
  })
]

const state = {
  version: 1,
  // A second project whose name is long enough to stress the composer's chip
  // row. Every shot used "fixture-project", which is short enough that a row
  // too narrow for a real project name still looked fine.
  projects: [project, { ...project, id: 'fixture-long-name', name: 'data-infrastructure' }],
  sessions,
  settings: {
    hookPort: 47821,
    pollIntervalMs: 2000,
    terminalApp: 'Ghostty',
    notifyOn: ['needs_attention', 'ready', 'done', 'errored'],
    hooksInstalled: false,
    hooksInstalledUrl: null,
    theme: 'tokyo-night',
    themeFollowsSystem: false
  }
}
writeFileSync(join(fixtureRoot, 'state.json'), JSON.stringify(state, null, 2))

// Live ~/.claude/sessions/*.json-shaped files. `alive` is computed from `pid`
// via `process.kill(pid, 0)` — pid 1 (launchd on macOS) is always alive, so
// every "live" fixture session uses it rather than a pid that could exit.
function sessionFile(name: string, body: Record<string, unknown>): void {
  writeFileSync(join(sessionsDir, `${name}.json`), JSON.stringify(body, null, 2))
}

sessionFile('working', {
  pid: 1,
  sessionId: 'fixture-working',
  cwd: join(worktreeRoot, 'feature-working'),
  startedAt: now - 10 * 60 * 1000,
  status: 'busy',
  statusUpdatedAt: now - 5000,
  name: 'fixture-working'
})

sessionFile('waiting', {
  pid: 1,
  sessionId: 'fixture-waiting',
  cwd: join(worktreeRoot, 'feature-waiting'),
  startedAt: now - 20 * 60 * 1000,
  status: 'waiting',
  waitingFor: 'input needed',
  statusUpdatedAt: now - 60_000,
  name: 'fixture-waiting'
})

// waiting with no waitingFor. Kept for coverage of status.ts rule 4, but the
// comment here used to claim this is "what most sessions look like most of the
// time" and that is simply false: across a real ~/.claude/sessions directory,
// every finished session reports 'idle' and 'waiting' only ever appears with a
// waitingFor. Believing this fixture is how rule 4 looked exercised while
// never firing against the real thing. See the 'idle' session below, which is
// the common case.
sessionFile('ready', {
  pid: 1,
  sessionId: 'fixture-ready',
  cwd: join(worktreeRoot, 'feature-ready'),
  startedAt: now - 25 * 60 * 1000,
  status: 'waiting',
  statusUpdatedAt: now - 120_000,
  name: 'fixture-ready'
})

// done/errored: idle at the session-file level. The 'done'/'errored'
// verdicts themselves come from the Stop/StopFailure hook fixture below,
// which computeInteractiveStatus prefers over a bare idle rawStatus.
sessionFile('done', {
  pid: 1,
  sessionId: 'fixture-done',
  cwd: join(worktreeRoot, 'feature-done'),
  startedAt: now - 30 * 60 * 1000,
  status: 'idle',
  statusUpdatedAt: now - 15 * 60 * 1000,
  name: 'fixture-done'
})

// The shape almost every real session has: finished, sitting at its prompt,
// nothing pending. There was no fixture for it at all, which is why the most
// common state in the app was also the least looked at.
sessionFile('idle', {
  pid: 1,
  sessionId: 'fixture-idle',
  cwd: join(worktreeRoot, 'feature-idle'),
  startedAt: now - 45 * 60 * 1000,
  status: 'idle',
  statusUpdatedAt: now - 8 * 60 * 1000,
  name: 'fixture-idle'
})

sessionFile('errored', {
  pid: 1,
  sessionId: 'fixture-errored',
  cwd: join(worktreeRoot, 'feature-errored'),
  startedAt: now - 40 * 60 * 1000,
  status: 'idle',
  statusUpdatedAt: now - 20 * 60 * 1000,
  name: 'fixture-errored'
})

// No session file for 'fixture-stopped' or 'fixture-missing' — those two
// statuses come purely from a SessionRecord with no matching live session.

const hookEvents = [
  {
    type: 'Stop',
    sessionId: 'fixture-done',
    cwd: join(worktreeRoot, 'feature-done'),
    message: 'Finished the fixture task.',
    at: now - 60_000
  },
  {
    type: 'StopFailure',
    sessionId: 'fixture-errored',
    cwd: join(worktreeRoot, 'feature-errored'),
    message: 'Fixture error: build failed.',
    at: now - 30_000
  }
]
writeFileSync(join(fixtureRoot, 'hooks.json'), JSON.stringify(hookEvents, null, 2))

// Confirm the working tree actually has the staged/unstaged/untracked mix
// the Git tab fixture depends on (sanity check, not required for the app).
const status = gitQuiet(['status', '--porcelain'], repoPath)
console.log('fixture: repo status:\n' + status.stdout)

// CLI history (plan 3, Part 4) — a fake ~/.claude/projects/<slug>/*.jsonl
// directory, read via CR_CLAUDE_PROJECTS_DIR so `npm run shot` and the V6
// verify step ("CLI list count must match `ls .../*.jsonl | wc -l`") never
// touch the real ~/.claude. The slug itself is never parsed by the app —
// only `cwd` inside each file matters — so any directory name will do.
const claudeProjectsDir = join(fixtureRoot, 'claude-projects')
const cliProjectDir = join(claudeProjectsDir, '-fixture-project-slug')
mkdirSync(cliProjectDir, { recursive: true })

function cliTranscript(sessionId: string, lines: Array<Record<string, unknown>>): void {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  writeFileSync(join(cliProjectDir, `${sessionId}.jsonl`), body)
}

cliTranscript('cli-session-1', [
  {
    type: 'user',
    cwd: repoPath,
    gitBranch: 'main',
    timestamp: new Date(now - 3 * 3_600_000).toISOString()
  },
  {
    type: 'assistant',
    cwd: repoPath,
    gitBranch: 'main',
    timestamp: new Date(now - 3 * 3_600_000 + 1000).toISOString()
  },
  {
    type: 'ai-title',
    aiTitle: 'Fix the flaky worktree test',
    cwd: repoPath,
    timestamp: new Date(now - 3 * 3_600_000 + 2000).toISOString()
  }
])

cliTranscript('cli-session-2', [
  {
    type: 'last-prompt',
    lastPrompt: 'add a README section on fixtures',
    cwd: repoPath,
    gitBranch: 'main',
    timestamp: new Date(now - 26 * 3_600_000).toISOString()
  },
  { type: 'user', cwd: repoPath, timestamp: new Date(now - 26 * 3_600_000 + 500).toISOString() },
  {
    type: 'assistant',
    cwd: repoPath,
    timestamp: new Date(now - 26 * 3_600_000 + 1000).toISOString()
  }
])

// A transcript carrying real `usage` lines, so the context-window panel has
// something to show. Without one it only ever rendered "No usage data
// available yet" in every screenshot, which says nothing about the numbers it
// is supposed to display.
cliTranscript('fixture-working', [
  {
    type: 'user',
    cwd: join(worktreeRoot, 'feature-working'),
    timestamp: new Date(now - 40 * 60_000).toISOString()
  },
  {
    type: 'assistant',
    cwd: join(worktreeRoot, 'feature-working'),
    timestamp: new Date(now - 39 * 60_000).toISOString(),
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 1420,
        output_tokens: 860,
        cache_creation_input_tokens: 24_000,
        cache_read_input_tokens: 1_900_000
      }
    }
  },
  {
    type: 'assistant',
    cwd: join(worktreeRoot, 'feature-working'),
    timestamp: new Date(now - 12 * 60_000).toISOString(),
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2310,
        output_tokens: 4120,
        cache_creation_input_tokens: 11_500,
        cache_read_input_tokens: 5_100_000
      }
    }
  }
])

console.log(`fixture: built at ${fixtureRoot}`)
console.log(`fixture: CR_SESSIONS_DIR=${sessionsDir}`)
console.log(`fixture: CR_CLAUDE_PROJECTS_DIR=${claudeProjectsDir}`)
