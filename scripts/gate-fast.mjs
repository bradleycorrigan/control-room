#!/usr/bin/env node
// Fast gate check for development — runs only typecheck and the two grep
// checks. No lint, no build, no contrast. Finishes in well under 30s and is
// suitable for quick validation before a full gate run.
//
// Usage: npm run gate:fast
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  runHexLiteralGrep,
  runNativeModuleGrep,
  runNoDeadControls,
  runNoScopeLanguage,
  runEveryActionHasHandler
} from './gate-checks.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const results = []

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function run(label, cmd, args, opts = {}) {
  const start = Date.now()
  const res = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })
  const ok = res.status === 0
  const ms = Date.now() - start
  results.push({ label, ok, ms, output: (res.stdout || '') + (res.stderr || '') })
  return ok
}

console.log('gate:fast: typecheck...')
run('typecheck', 'npm', ['run', 'typecheck'])

console.log('gate:fast: hex-literal grep...')
results.push(runHexLiteralGrep(root))

console.log('gate:fast: native-module grep...')
results.push(runNativeModuleGrep(root))

console.log('gate:fast: no-dead-controls...')
results.push(runNoDeadControls(root))

console.log('gate:fast: no-scope-language...')
results.push(runNoScopeLanguage(root))

console.log('gate:fast: every-action-has-handler...')
results.push(runEveryActionHasHandler(root))

console.log('\n=== gate:fast summary ===')
let allOk = true
for (const r of results) {
  const status = r.ok ? 'PASS' : 'FAIL'
  if (!r.ok) allOk = false
  console.log(`${status}  ${r.label}  (${r.ms}ms)`)
  if ((!r.ok || r.output.startsWith('known non-blocking')) && r.output) {
    console.log(
      r.output
        .split('\n')
        .slice(-40)
        .map((l) => '    ' + l)
        .join('\n')
    )
  }
}
console.log(allOk ? '\nGATE:FAST: PASS' : '\nGATE:FAST: FAIL')
process.exit(allOk ? 0 : 1)
