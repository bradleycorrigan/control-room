#!/usr/bin/env node
// Dev tooling only — not shipped, not run by the app itself. Builds the app,
// then boots it headless-ish with CR_SHOT=1 so it navigates to a screen,
// applies a theme, captures a PNG to .dev/shots/, and exits.
//
// Usage: npm run shot -- <screen> <theme> [width] [name]
//     or npm run shot -- --screens s1,s2,... --themes t1,t2,... [width]
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const args = process.argv.slice(2)

// Parse arguments: support both single-shot and batch modes
let screen, theme, width, name, combinations
const screensIdx = args.indexOf('--screens')
const themesIdx = args.indexOf('--themes')

if (screensIdx !== -1 && themesIdx !== -1) {
  // Batch mode: --screens s1,s2,... --themes t1,t2,... [width]
  const screenList = args[screensIdx + 1].split(',')
  const themeList = args[themesIdx + 1].split(',')

  // Build all combinations
  combinations = []
  for (const s of screenList) {
    for (const t of themeList) {
      combinations.push({ screen: s, theme: t })
    }
  }

  // Check for width (numeric arg after the lists)
  const widthArg = args.find((arg, i) => i > themesIdx + 1 && /^\d+$/.test(arg))
  width = widthArg

  if (combinations.length === 0) {
    console.error('usage: npm run shot -- --screens s1,s2,... --themes t1,t2,... [width]')
    process.exit(1)
  }
} else {
  // Single-shot mode: <screen> <theme> [width] [name]
  screen = args[0]
  theme = args[1]

  const maybeWidth = args[2]
  const isWidth = maybeWidth !== undefined && /^\d+$/.test(maybeWidth)
  width = isWidth ? maybeWidth : undefined
  name = isWidth ? args[3] : args[2]

  if (!screen || !theme) {
    console.error('usage: npm run shot -- <screen> <theme> [width] [name]')
    console.error('       npm run shot -- --screens s1,s2,... --themes t1,t2,... [width]')
    process.exit(1)
  }

  combinations = [{ screen, theme, name }]
}

const electronBin = join(root, 'node_modules', '.bin', 'electron')
const mainEntry = join(root, 'out', 'main', 'index.js')

console.log('shot: building...')
const build = spawnSync(
  process.execPath,
  [join(root, 'node_modules', '.bin', 'electron-vite'), 'build'],
  {
    cwd: root,
    stdio: 'inherit'
  }
)
if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

console.log(
  `shot: capturing ${combinations.length} combination${combinations.length === 1 ? '' : 's'}`
)
for (const combo of combinations) {
  console.log(`  - ${combo.screen} + ${combo.theme}`)
}

// Pass combinations as JSON in env var so app can iterate through them
const combosJson = JSON.stringify(combinations)
const child = spawn(electronBin, [mainEntry], {
  cwd: root,
  env: {
    ...process.env,
    CR_SHOT: '1',
    CR_SHOT_COMBOS: combosJson,
    ...(width ? { CR_SHOT_WIDTH: width } : {})
  },
  stdio: 'inherit'
})

// Generous on purpose: screenshot.ts's own safety net waits up to 120s per
// screen (900s for a "-interactions" run) before it gives up on a screen and
// captures anyway, then still has to tear down ptys and tmux control
// sessions before it can exit. This timer used to fire well inside that
// window — 30s plus 5s per combination — so a normal, successful run that
// took a bit longer than that got SIGKILLed here and reported as a failure
// even though the PNG had already been written. It's a backstop for a truly
// hung process, not the thing that decides pass or fail — that's the child's
// own exit code, from screenshot.ts, which knows whether each screen and
// image actually came out right.
const perComboMs = combinations.some((c) => /-interactions$/.test(c.screen)) ? 900_000 : 120_000
const timeoutMs = 30_000 + combinations.length * (perComboMs + 5_000)
const killTimer = setTimeout(() => {
  console.error(`shot: timed out waiting for ${combinations.length} capture(s), killing`)
  child.kill('SIGKILL')
  process.exit(1)
}, timeoutMs)

child.on('exit', (code) => {
  clearTimeout(killTimer)
  process.exit(code ?? 0)
})
