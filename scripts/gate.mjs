#!/usr/bin/env node
// One command, one verdict. Runs every check CLAUDE.md requires before a
// milestone is done and prints a single PASS/FAIL summary. Builders run
// this; verifiers never do (they read the diff and look at screenshots).
//
// Usage: npm run gate                 everything (before any commit)
//        npm run gate -- --only=pages  static checks + one interaction run,
//                                      for iterating on one area; ~1 min less
import { spawn, spawnSync } from 'node:child_process'
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
// A page-check shard's root (.dev/fixture-N) gets its own session: the hash then
// covers the root as well as the checkout. The default root keeps the old name.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixtureTmuxName(repoRoot, fixtureRoot = join(repoRoot, '.dev', 'fixture')) {
  const key =
    fixtureRoot === join(repoRoot, '.dev', 'fixture') ? repoRoot : `${repoRoot}\n${fixtureRoot}`
  return `cr-fixture-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`
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
// --grep=<text> (with --only=pages): run just the page-check sections whose name
// contains <text>, case-insensitive. Comma-separated for several. Sections keep
// their order, and the static checks still run.
const grep = process.argv.find((a) => a.startsWith('--grep='))?.slice('--grep='.length)
if (grep !== undefined && only !== 'pages') {
  console.error('gate: --grep needs --only=pages (it picks page-check sections)')
  process.exit(2)
}

// Starts one command and returns a promise of its result. Never rejects, so
// Promise.all can run many of these at once. `tail`: keep only the last N lines
// of output, and only when the command fails.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function runAsync(label, cmd, args, { tail, env, timeoutMs } = {}) {
  const start = Date.now()
  return new Promise((resolve) => {
    const out = { stdout: '', stderr: '' }
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env
    })
    // A run that never ends is stopped by its own PID, never by a name pattern.
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => (out.stdout += d))
    child.stderr.on('data', (d) => (out.stderr += d))
    let done = false
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const finish = (ok, extra = '') => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = out.stdout + out.stderr + extra
      const output = tail ? (ok ? '' : text.split('\n').slice(-tail).join('\n')) : text
      resolve({ label, ok, ms: Date.now() - start, output })
    }
    child.on('error', (err) => finish(false, String(err)))
    child.on('close', (code) => finish(code === 0))
  })
}

// Static checks. None of them depends on another, so they all start now and run
// side by side. The results array keeps this order, whatever order they finish in.
// `build` writes out/, which the interaction runs read, so those wait for every
// static check to finish. The verify scripts are node-only logic checks (CLAUDE.md).
// Every scripts/verify-*.ts runs: a new one is picked up without editing this
// list (a hand-kept list once left a broken script unrun for weeks).
const VERIFY_SCRIPTS = readdirSync(join(root, 'scripts'))
  .filter((f) => /^verify-.+\.ts$/.test(f))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort()
const STATIC_STEPS = [
  'typecheck',
  'lint',
  'build',
  'contrast-check',
  'hex-literal grep',
  'native-module grep',
  'no-dead-controls',
  'no-scope-language',
  'no-raw-glyphs',
  'every-action-has-handler',
  'no-bare-z-index',
  'drops-keep-copies',
  'no-em-dash-copy',
  ...VERIFY_SCRIPTS.map((name) => `verify: ${name}`)
]
for (const step of STATIC_STEPS) console.log(`gate: ${step}...`)

const staticRuns = [
  runAsync('typecheck', 'npm', ['run', 'typecheck']),
  runAsync('lint', 'npm', ['run', 'lint']),
  runAsync('build', 'npm', ['run', 'build']),
  runAsync('contrast-check', 'npm', ['run', 'contrast-check']),
  runHexLiteralGrep(root),
  runNativeModuleGrep(root),
  runNoDeadControls(root),
  runNoScopeLanguage(root),
  runNoRawGlyphs(root),
  runEveryActionHasHandler(root),
  runNoBareZIndex(root),
  runDropsKeepCopies(root),
  runNoEmDashCopy(root),
  ...VERIFY_SCRIPTS.map((name) =>
    runAsync(`verify: ${name}`, 'npx', ['tsx', `scripts/${name}.ts`], { tail: 20 })
  )
]
results.push(...(await Promise.all(staticRuns)))

// Interaction checks: drive the real app with real input (tabs, J/K,
// closing, the house tab…) against the seeded fixture. ~40s. They used to
// run only when someone remembered, which is how a regression slips through.
// Page checks, sharded. Each shard is its own app on its own fixture, and the
// shards run at once. A name is a substring of a section name in pagesCheck.ts
// (case-insensitive, as --grep does). The order inside a shard is the order in
// pagesCheck.ts. Balanced by the per-section times in CLAUDE.md. "Completing a
// cycle" and the two cycle sections before it sit together and last in their
// shard: they close the fixture's current cycle.
const PAGE_SHARDS = [
  ['Backlog'],
  ['Session: header'],
  [
    'Dropping',
    'Sessions',
    'Settings',
    'Dev containers',
    'Projects tidy',
    'Skills and rules',
    'Ship ticks'
  ],
  [
    'Switching',
    'Home',
    'A screen that crashes',
    'A current cycle Jira',
    'An empty duplicate cycle',
    'Completing a cycle'
  ]
]
// Sections that need the app to themselves (focus, ports, timing). They run
// after the shards, one at a time, on a fixture of their own. Empty until a
// shard run shows one.
// "Title bar tooltips" reads whether the window has focus. Parallel windows take
// focus from each other, so its tooltips never show there (the shot's
// "window focused: no"). Alone it passes.
const PAGE_SERIAL = ['Title bar tooltips']

// The env one shard's app and fixture need. Same values as `npm run shot:fixture`,
// which can't be used here: it sets these itself and would overwrite the shard's.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function shardEnv(fixtureRoot) {
  return {
    CR_SHOT_SKIP_BUILD: '1',
    CR_FIXTURE_ROOT: fixtureRoot,
    CR_FIXTURE_TMUX: fixtureTmuxName(root, fixtureRoot),
    CR_SESSIONS_DIR: join(fixtureRoot, 'sessions'),
    CR_CLAUDE_PROJECTS_DIR: join(fixtureRoot, 'claude-projects'),
    CR_JIRA_FIXTURE: join(root, 'scripts', 'fixtures', 'jira-issues.json'),
    CR_PR_FIXTURE: 'fixture-rec-ready'
  }
}

// The dev-check lines of a shot run: its FAIL, SUMMARY and SECTIONS lines.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function checkLines(text) {
  return [...text.matchAll(/dev-check: ((?:FAIL|SUMMARY|SECTIONS)(?:[^"\\]|\\.)*)/g)].map((m) =>
    m[1].replace(/\\(["\\])/g, '$1')
  )
}

// Builds a fresh fixture for each shard (in parallel: each is its own repo), then
// runs the shards at once, then the serial group. Returns one result for the
// whole pages check.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function runPagesSharded() {
  const start = Date.now()
  const shards = PAGE_SHARDS.map((names, i) => ({
    id: `shard ${i + 1}`,
    names,
    root: join(root, '.dev', `fixture-${i + 1}`)
  }))
  const serial = { id: 'serial', names: PAGE_SERIAL, root: join(root, '.dev', 'fixture-serial') }
  const fixtures = PAGE_SERIAL.length ? [...shards, serial] : shards
  const built = await Promise.all(
    fixtures.map(async (s) => {
      const env = { CR_FIXTURE_ROOT: s.root }
      const made = await runAsync(`${s.id}: fixture`, 'npm', ['run', 'fixture:build'], {
        tail: 30,
        env
      })
      if (!made.ok) return made
      return runAsync(`${s.id}: panes`, 'npm', ['run', 'fixture:tmux'], { tail: 30, env })
    })
  )
  const failedBuild = built.find((b) => !b.ok)
  if (failedBuild)
    return {
      ok: false,
      ms: Date.now() - start,
      output: `${failedBuild.label} failed:\n${failedBuild.output}`
    }

  // One app per run, each with its own hook port (the hook server takes the first
  // free one from 47821 up) and its own fixture.
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const runShard = (s) =>
    runAsync(
      s.id,
      'node',
      [
        'scripts/shot.mjs',
        'pages-interactions',
        'tokyo-night',
        '1400',
        `pages-${s.id.replace(' ', '-')}`
      ],
      {
        env: { ...shardEnv(s.root), CR_PAGES_SECTIONS: s.names.join(',') },
        timeoutMs: 660_000
      }
    )
  const runs = await Promise.all(shards.map(runShard))
  if (PAGE_SERIAL.length) runs.push(await runShard(serial))

  let passed = 0
  let failed = 0
  const lines = []
  for (const r of runs) {
    const got = checkLines(r.output)
    const summary = got.find((l) => l.startsWith('SUMMARY'))
    const counts = summary?.match(/^SUMMARY (\d+) passed, (\d+) failed/)
    if (counts) {
      passed += Number(counts[1])
      failed += Number(counts[2])
    }
    const ran = got.find((l) => l.startsWith('SECTIONS ran: '))
    if (ran) console.log(`gate: ${r.label}: ${ran.replace(/^SECTIONS ran: /, 'ran: ')}`)
    const times = got.find((l) => l.startsWith('SECTIONS times: '))
    if (times) console.log(`gate: ${r.label}: ${times.replace(/^SECTIONS /, 'section ')}`)
    lines.push(...got.filter((l) => l.startsWith('FAIL ')).map((l) => `${r.label}: ${l}`))
    if (!summary) lines.push(`${r.label}: no SUMMARY line — the check did not finish`)
  }
  const ok = runs.every((r) => checkLines(r.output).some((l) => /^SUMMARY .* 0 failed/.test(l)))
  lines.push(`SUMMARY ${passed} passed, ${failed} failed`)
  return { ok, ms: Date.now() - start, output: lines.join('\n') }
}

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
  // The tab run and a --grep run use the default fixture; the sharded page run builds its own.
  if (!hasFixture && (!only || only === 'tabs' || grep !== undefined)) {
    const built = spawnSync('npm', ['run', 'fixture'], { cwd: root, encoding: 'utf8' })
    output += (built.stdout || '') + (built.stderr || '')
  }
  // One run per check, so a failure names which pages broke. Tabs: the tab
  // strip, shortcuts, closing, J/K. Pages: Backlog, Home, the Sessions rows,
  // Settings, the session header and terminal find.
  for (const [label, screen] of [
    ['interactions: tabs', 'tabs-interactions'],
    ['interactions: pages', 'pages-interactions']
  ].filter(
    ([label]) =>
      (!only || label.endsWith(only)) && !(label === 'interactions: pages' && grep === undefined)
  )) {
    const runStart = Date.now()
    // One run of the check: its FAIL lines and whether it reached SUMMARY.
    // (Plain JS: there is no return type to write.)
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const runOnce = () => {
      const res = spawnSync('npm', ['run', 'shot:fixture', '--', screen, 'tokyo-night', '1400'], {
        cwd: root,
        encoding: 'utf8',
        // The app reads this to find this checkout's fixture panes (screenshot.ts).
        env: {
          ...process.env,
          CR_FIXTURE_TMUX: FIXTURE_TMUX,
          // Section filter for the pages run (dev/pagesCheck.ts); empty runs all.
          CR_PAGES_SECTIONS: screen === 'pages-interactions' ? (grep ?? '') : ''
        },
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
      const lines = [
        ...text.matchAll(/dev-check: ((?:FAIL|SUMMARY|SECTIONS)(?:[^"\\]|\\.)*)/g)
      ].map((m) => m[1].replace(/\\(["\\])/g, '$1'))
      const summary = lines.find((l) => l.startsWith('SUMMARY'))
      return { lines, summary, ok: Boolean(summary) && / 0 failed/.test(summary) }
    }
    // One run, no retry. A retry doubled the time of every failing run and
    // hid flaky checks; a check that flakes gets fixed instead.
    const run = runOnce()
    const flaky = []
    const sectionsRan = run.lines.find((l) => l.startsWith('SECTIONS ran: '))
    if (sectionsRan)
      console.log(`gate: sections ${sectionsRan.replace(/^SECTIONS ran: /, 'ran: ')}`)
    const sectionTimes = run.lines.find((l) => l.startsWith('SECTIONS times: '))
    if (sectionTimes) console.log(`gate: ${sectionTimes.replace(/^SECTIONS /, 'section ')}`)
    results.push({
      label:
        (flaky.length ? `${label} (passed on retry)` : label) + (grep ? ` --grep=${grep}` : ''),
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
  if ((!only || only === 'pages') && grep === undefined) {
    results.push({ label: 'interactions: pages', ...(await runPagesSharded()) })
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
