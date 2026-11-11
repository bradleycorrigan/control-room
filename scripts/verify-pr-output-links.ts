// What counts as "this command opened a PR" when Claude Code wrote no
// pr-link line for it: the output's own pr_url, not any PR it mentions.
import { prOpenedInOutput } from '../src/main/exec/transcripts'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
  if (!ok) failed++
}

const omni = JSON.stringify(
  '{\n  "did_sync": false,\n  "pr_url": "https://github.com/example/analytics-omni/pull/30"\n}'
)
const found = prOpenedInOutput(omni)
check(
  "a pr_url in a command's JSON output is the PR it opened",
  found?.url === 'https://github.com/example/analytics-omni/pull/30' &&
    found.repository === 'example/analytics-omni' &&
    found.number === 30,
  JSON.stringify(found)
)
check(
  'a PR the output only mentions is not one it opened',
  prOpenedInOutput(JSON.stringify('See https://github.com/example/repo/pull/12 for context')) ===
    null
)
check('no output, no PR', prOpenedInOutput('') === null)

if (failed > 0) process.exit(1)
