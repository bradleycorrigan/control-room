#!/usr/bin/env node
// One command, one verdict. Runs every check CLAUDE.md requires before a
// milestone is done and prints a single PASS/FAIL summary. Builders run
// this; verifiers never do (they read the diff and look at screenshots).
//
// Usage: npm run gate                 everything (before any commit)
//        npm run gate -- --only=pages  static checks + one interaction run,
//                                      for iterating on one area; ~1 min less
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import {
  runHexLiteralGrep,
  runNativeModuleGrep,
  runNoDeadControls,
  runNoScopeLanguage,
  runNoRawGlyphs,
  runEveryActionHasHandler,
  runNoBareZIndex,
  runDropsKeepCopies,
  runNoEmDashCopy
} from './gate-checks.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const results = []

// This checkout's fixture tmux session. Same function as fixtureTmuxName in
// scripts/fixtures/fixture-name.ts (that one is TypeScript; this file is plain
// JS, so it is repeated here). Keep the two identical.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixtureTmuxName(repoRoot) {
  return `cr-fixture-${createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)}`
}
const FIXTURE_TMUX = fixtureTmuxName(root)

// Machine-wide lock for the interaction checks. Two gate runs at once would
// fight over which window is frontmost, so a second run waits for the first.
// Static checks above do not take it. The lock file lives outside any repo, so
// every checkout on this machine shares it.
const LOCK_DIR = join(homedir(), '.cache', 'control-room')
const LOCK_PATH = join(LOCK_DIR, 'gate.lock')
const LOCK_STALE_MS = 20 * 60 * 1000
// A lock with no readable contents may be mid-write, so give it this long.
const LOCK_UNREADABLE_GRACE_MS = 10 * 1000
let lockHeld = false

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user: still alive.
    return err.code === 'EPERM'
  }
}

// Whether the lock on disk can be removed: its owner is gone, it is older than
// the limit, or it has no readable contents after the grace period.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function lockIsStale(held) {
  if (held) return !pidAlive(held.pid) || Date.now() - held.startedAt > LOCK_STALE_MS
  try {
    return Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_UNREADABLE_GRACE_MS
  } catch {
    return false
  }
}

// Atomic create: 'wx' fails if the file exists, so only one run can win.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function tryCreateLock() {
  try {
    const fd = openSync(LOCK_PATH, 'wx')
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, root, startedAt: Date.now() }) + '\n')
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function acquireGateLock() {
  mkdirSync(LOCK_DIR, { recursive: true })
  let announced = false
  while (!tryCreateLock()) {
    const held = readLock()
    if (lockIsStale(held)) {
      rmSync(LOCK_PATH, { force: true })
      continue
    }
    if (!announced) {
      const who = held ? `the gate running in ${held.root} (pid ${held.pid})` : 'another gate run'
      console.log(`gate: waiting for ${who}…`)
      announced = true
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  lockHeld = true
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function releaseGateLock() {
  if (!lockHeld) return
  lockHeld = false
  // Only remove the lock if it is still ours.
  if (readLock()?.pid === process.pid) rmSync(LOCK_PATH, { force: true })
}

process.on('exit', releaseGateLock)
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143]
]) {
  process.on(signal, () => {
    releaseGateLock()
    process.exit(code)
  })
}
// --only=pages / --only=tabs: run just that interaction check. The static
// checks always run; they take seconds. Never a substitute for the full gate
// before a commit.
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function run(label, cmd, args, opts = {}) {
  const start = Date.now()
  const res = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })
  const ok = res.status === 0
  const ms = Date.now() - start
  results.push({ label, ok, ms, output: (res.stdout || '') + (res.stderr || '') })
  return ok
}

console.log('gate: typecheck...')
run('typecheck', 'npm', ['run', 'typecheck'])

console.log('gate: lint...')
run('lint', 'npm', ['run', 'lint'])

console.log('gate: build...')
run('build', 'npm', ['run', 'build'])

console.log('gate: contrast-check...')
run('contrast-check', 'npm', ['run', 'contrast-check'])

console.log('gate: hex-literal grep...')
results.push(runHexLiteralGrep(root))

console.log('gate: native-module grep...')
results.push(runNativeModuleGrep(root))

console.log('gate: no-dead-controls...')
results.push(runNoDeadControls(root))

console.log('gate: no-scope-language...')
results.push(runNoScopeLanguage(root))
console.log('gate: no-raw-glyphs...')
results.push(runNoRawGlyphs(root))

console.log('gate: every-action-has-handler...')
results.push(runEveryActionHasHandler(root))

console.log('gate: no-bare-z-index...')
results.push(runNoBareZIndex(root))

console.log('gate: drops-keep-copies...')
results.push(runDropsKeepCopies(root))

console.log('gate: no-em-dash-copy...')
results.push(await runNoEmDashCopy(root))

// Interaction checks: drive the real app with real input (tabs, J/K,
// closing, the house tab…) against the seeded fixture. ~40s. They used to
// run only when someone remembered, which is how a regression slips through.
console.log('gate: interactions...')
await acquireGateLock()
try {
  const start = Date.now()
  const sessionsDir = join(root, '.dev', 'fixture', 'sessions')
  const hasFixture =
    existsSync(join(root, '.dev', 'fixture', 'state.json')) &&
    existsSync(sessionsDir) &&
    readdirSync(sessionsDir).some((f) => f.endsWith('.json')) &&
    spawnSync('tmux', ['-u', 'has-session', '-t', `=${FIXTURE_TMUX}`]).status === 0
  let output = ''
  if (!hasFixture) {
    const built = spawnSync('npm', ['run', 'fixture'], { cwd: root, encoding: 'utf8' })
    output += (built.stdout || '') + (built.stderr || '')
  }
  // One run per check, so a failure names which pages broke. Tabs: the tab
  // strip, shortcuts, closing, J/K. Pages: Backlog, Home, the Sessions rows,
  // Settings, the session header and terminal find.
  for (const [label, screen] of [
    ['interactions: tabs', 'tabs-interactions'],
    ['interactions: pages', 'pages-interactions']
  ].filter(([label]) => !only || label.endsWith(only))) {
    const runStart = Date.now()
    // One run of the check: its FAIL lines and whether it reached SUMMARY.
    // (Plain JS: there is no return type to write.)
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const runOnce = () => {
      const res = spawnSync('npm', ['run', 'shot:fixture', '--', screen, 'tokyo-night', '1400'], {
        cwd: root,
        encoding: 'utf8',
        // The app reads this to find this checkout's fixture panes (screenshot.ts).
        env: { ...process.env, CR_FIXTURE_TMUX: FIXTURE_TMUX },
        // Never let a stuck run hang the gate. A normal pages run is ~3.5
        // minutes; a cap that trips on a slow-but-healthy run is a false
        // failure. Just above the app's own 10-minute limit
        // (dev/screenshot.ts), so that one reports first.
        timeout: 660_000
      })
      // A timeout kills npm but not the Electron it started; left running, that
      // instance holds the fixture profile and the next run can't start.
      if (res.error || res.signal) {
        spawnSync('pkill', ['-f', join(root, 'node_modules', 'electron', 'dist', 'Electron.app')])
      }
      const text = (res.stdout || '') + (res.stderr || '')
      // The message sits in a JSON log line: read up to its closing quote,
      // not the first quote inside it, and unescape it, so a check whose name
      // has quotes in it reports in full.
      const lines = [...text.matchAll(/dev-check: ((?:FAIL|SUMMARY)(?:[^"\\]|\\.)*)/g)].map((m) =>
        m[1].replace(/\\(["\\])/g, '$1')
      )
      const summary = lines.find((l) => l.startsWith('SUMMARY'))
      return { lines, summary, ok: Boolean(summary) && / 0 failed/.test(summary) }
    }
    // One run, no retry. A retry doubled the time of every failing run and
    // hid flaky checks; a check that flakes gets fixed instead.
    const run = runOnce()
    const flaky = []
    results.push({
      label: flaky.length ? `${label} (passed on retry)` : label,
      ok: run.ok,
      ms: Date.now() - runStart,
      output:
        output +
        (flaky.length
          ? `flaky, failed only on the first run:\n${flaky.join('\n')}`
          : run.lines.length
            ? run.lines.join('\n')
            : 'no SUMMARY line — the check did not finish')
    })
    output = ''
  }
  void start
} finally {
  releaseGateLock()
}

console.log('\n=== gate summary ===')
let allOk = true
for (const r of results) {
  const status = r.ok ? 'PASS' : 'FAIL'
  if (!r.ok) allOk = false
  console.log(`${status}  ${r.label}  (${r.ms}ms)`)
  if (
    (!r.ok || r.output.startsWith('known non-blocking') || r.output.includes('flaky,')) &&
    r.output
  ) {
    console.log(
      r.output
        .split('\n')
        .slice(-40)
        .map((l) => '    ' + l)
        .join('\n')
    )
  }
}
if (only) console.log(`\n(partial run: --only=${only}; run the full gate before committing)`)
console.log(allOk ? '\nGATE: PASS' : '\nGATE: FAIL')
process.exit(allOk ? 0 : 1)
