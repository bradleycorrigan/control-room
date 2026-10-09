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
import { existsSync, readdirSync } from 'node:fs'
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
{
  const start = Date.now()
  const sessionsDir = join(root, '.dev', 'fixture', 'sessions')
  const hasFixture =
    existsSync(join(root, '.dev', 'fixture', 'state.json')) &&
    existsSync(sessionsDir) &&
    readdirSync(sessionsDir).some((f) => f.endsWith('.json')) &&
    spawnSync('tmux', ['-u', 'has-session', '-t', '=cr-fixture']).status === 0
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
