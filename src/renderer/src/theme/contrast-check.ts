// Dev-only. Checks every theme's text/muted/status-dot tokens against the
// surfaces they actually render on, per the plan's hard requirement (1.2/1.3):
// body text >= 4.5:1, muted text >= 3:1, status dots >= 3:1. Run via
// `npm run contrast-check`. Prints PASS/FAIL per check and exits non-zero on
// any failure — never weaken this, fix the theme instead.
import { themes } from './themes'
import { contrastRatio } from './color'

interface Check {
  theme: string
  label: string
  fg: string
  bg: string
  minRatio: number
}

const checks: Check[] = []

for (const theme of themes) {
  // Text renders on both the app ground and on panel/card surfaces.
  const surfaces: Array<[string, string]> = [
    ['bg', theme.bg],
    ['surface', theme.surface],
    ['surface-raised', theme.surfaceRaised]
  ]

  for (const [surfaceName, surfaceHex] of surfaces) {
    checks.push({
      theme: theme.name,
      label: `text on ${surfaceName}`,
      fg: theme.text,
      bg: surfaceHex,
      minRatio: 4.5
    })
    checks.push({
      theme: theme.name,
      label: `text-muted on ${surfaceName}`,
      fg: theme.textMuted,
      bg: surfaceHex,
      minRatio: 3
    })
  }

  // Status dots are small filled shapes on a panel/row surface.
  for (const [statusName, statusHex] of Object.entries(theme.status)) {
    checks.push({
      theme: theme.name,
      label: `status-${statusName} dot on surface`,
      fg: statusHex,
      bg: theme.surface,
      minRatio: 3
    })
  }

  // The accent underline/rail also needs to read against the ground.
  checks.push({
    theme: theme.name,
    label: 'accent on bg',
    fg: theme.accent,
    bg: theme.bg,
    minRatio: 3
  })
}

let failures = 0

for (const check of checks) {
  const ratio = contrastRatio(check.fg, check.bg)
  const pass = ratio >= check.minRatio
  if (!pass) {
    failures++
    console.log(
      `FAIL  ${check.theme.padEnd(18)} ${check.label.padEnd(28)} ${ratio.toFixed(2)}:1 ` +
        `(need >= ${check.minRatio}:1)  fg=${check.fg} bg=${check.bg}`
    )
  }
}

if (failures === 0) {
  console.log(`PASS  ${checks.length} contrast checks across ${themes.length} themes`)
  process.exit(0)
} else {
  console.log(`\n${failures} of ${checks.length} contrast checks FAILED`)
  process.exit(1)
}
