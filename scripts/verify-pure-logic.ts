// Checks the pure cycle-planning helpers (src/renderer/src/screens/backlog/cyclePlan.ts):
// Jira's estimate shorthand and the working-day count. These were checks in the
// pages run; they call plain functions and need no app, so they run here.
//
// Run: npx tsx scripts/verify-pure-logic.ts

import { parseEstimateHours, workingDays } from '../src/renderer/src/screens/backlog/cyclePlan'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` ${detail}`}`)
}

check(
  'parseEstimateHours reads Jira shorthand (1w=5d, 1d=8h)',
  parseEstimateHours('1d 4h') === 12 && parseEstimateHours('1w') === 40,
  `${parseEstimateHours('1d 4h')}h, ${parseEstimateHours('1w')}h`
)
check(
  'workingDays counts weekdays only, and defaults to 10 with no dates',
  workingDays('2026-09-14T00:00:00.000Z', '2026-09-18T00:00:00.000Z') === 5 &&
    workingDays(undefined, undefined) === 10,
  `${workingDays('2026-09-14T00:00:00.000Z', '2026-09-18T00:00:00.000Z')}, ${workingDays(undefined, undefined)}`
)

if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All checks passed')
