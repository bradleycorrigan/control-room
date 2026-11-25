// Checks the pure cycle-planning helpers (src/renderer/src/screens/backlog/cyclePlan.ts):
// Jira's estimate shorthand and the working-day count. These were checks in the
// pages run; they call plain functions and need no app, so they run here.
//
// Run: npx tsx scripts/verify-pure-logic.ts

import { parseEstimateHours, workingDays } from '../src/renderer/src/screens/backlog/cyclePlan'
import { clipboardWrite, scrollReports } from '../src/renderer/src/lib/scrollReports'
import {
  arrangeTabs,
  hiddenTabs,
  pruneLayout,
  readLayout,
  type TabLayout
} from '../src/renderer/src/lib/tabLayout'

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

// The shell's scroll pace: one report per 5 lines moved, however the
// movement arrives (a trackpad's many small events or a mouse's big notch).
{
  const cell = 16
  let carried = 0
  let reports = 0
  for (let i = 0; i < 40; i++) {
    const r = scrollReports(carried, -4, cell, 5) // 40 x 4px = 160px = 10 lines up
    carried = r.carried
    reports += r.reports
  }
  const notch = scrollReports(0, 240, cell, 5) // one 15-line notch down
  const turn = scrollReports(-70, 10, cell, 5) // reversing drops what was carried
  check(
    'scrollReports sends one report per 5 lines, small events or big',
    reports === -2 && notch.reports === 3 && turn.reports === 0 && turn.carried === 10,
    `trackpad ${reports}, notch ${notch.reports}, reversed carried ${turn.carried}`
  )
}
check(
  'clipboardWrite reads an OSC 52 write and ignores a read',
  clipboardWrite(`c;${Buffer.from('héllo wörld').toString('base64')}`) === 'héllo wörld' &&
    clipboardWrite('c;?') === null &&
    clipboardWrite('junk') === null
)

// Session tab layout: pins first, groups together, nothing lost or doubled.
{
  const layout: TabLayout = {
    pinned: ['e'],
    colour: { a: 'red' },
    groups: [{ id: 'g', name: 'Review', colour: 'blue', collapsed: true }],
    groupOf: { b: 'g', d: 'g' }
  }
  const arranged = arrangeTabs(['a', 'b', 'c', 'd', 'e'], layout)
  check(
    'arrangeTabs puts pinned tabs first and pulls a group together at its first tab',
    arranged.join('') === 'eabdc',
    arranged.join('')
  )
  const hidden = hiddenTabs(arranged, layout, 'd')
  check(
    'hiddenTabs hides a collapsed group, bar the tab you are on',
    hidden.has('b') && !hidden.has('d') && hidden.size === 1,
    [...hidden].join(',')
  )
  const pruned = pruneLayout(layout, ['a', 'c', 'd'])
  check(
    'pruneLayout drops closed tabs from pins and groups, keeps colours and live groups',
    pruned.pinned.length === 0 &&
      pruned.groupOf.d === 'g' &&
      !('b' in pruned.groupOf) &&
      pruned.groups.length === 1 &&
      pruned.colour.a === 'red'
  )
  check(
    'pruneLayout drops a group with no tabs left',
    pruneLayout(layout, ['a', 'c']).groups.length === 0
  )
  check(
    'pruneLayout returns the same object when nothing changes',
    pruneLayout(layout, ['a', 'b', 'c', 'd', 'e']) === layout
  )
  check(
    'readLayout survives a missing or broken stored layout',
    readLayout(null).pinned.length === 0 &&
      readLayout({ groups: [{ id: 'x', name: '', colour: 'mauve' as never, collapsed: false }] })
        .groups.length === 0
  )
}

if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All checks passed')
