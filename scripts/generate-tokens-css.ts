// Generates the per-theme `:root[data-theme="..."]` blocks in
// theme/tokens.css from theme/themes.ts, the single source of truth for
// hex values (including the contrast-fix nudges contrast-check.ts
// verifies). Run with `npm run generate-tokens-css` after changing
// themes.ts. Pure JS/TS, no native modules — safe to run in CI.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { themes, type Theme } from '../src/renderer/src/theme/themes'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tokensPath = join(__dirname, '..', 'src', 'renderer', 'src', 'theme', 'tokens.css')

const START = '/* generated:themes:start */'
const END = '/* generated:themes:end */'

function themeBlock(theme: Theme): string {
  const a = theme.ansi
  const lines = [
    `:root[data-theme='${theme.id}'] {`,
    `  --bg: ${theme.bg};`,
    `  --bg-sunken: ${theme.bgSunken};`,
    `  --surface: ${theme.surface};`,
    `  --surface-raised: ${theme.surfaceRaised};`,
    `  --border: ${theme.border};`,
    `  --border-strong: ${theme.borderStrong};`,
    `  --text: ${theme.text};`,
    `  --text-muted: ${theme.textMuted};`,
    `  --text-faint: ${theme.textFaint};`,
    `  --accent: ${theme.accent};`,
    `  --accent-fg: ${theme.accentFg};`,
    `  --accent-soft: ${theme.accentSoft};`,
    ``,
    `  --status-working: ${theme.status.working};`,
    `  --status-attention: ${theme.status.attention};`,
    `  --status-done: ${theme.status.done};`,
    `  --status-idle: ${theme.status.idle};`,
    `  --status-error: ${theme.status.error};`,
    ``,
    `  --term-bg: ${theme.termBg};`,
    `  --term-fg: ${theme.termFg};`,
    `  --term-cursor-fg: ${theme.termCursorFg};`,
    `  --term-selection: ${theme.termSelection};`,
    `  --term-min-contrast: ${theme.termMinContrast};`,
    `  --term-font-smoothing: ${theme.termFontSmoothing};`,
    `  --term-ansi-0: ${a.black};`,
    `  --term-ansi-1: ${a.red};`,
    `  --term-ansi-2: ${a.green};`,
    `  --term-ansi-3: ${a.yellow};`,
    `  --term-ansi-4: ${a.blue};`,
    `  --term-ansi-5: ${a.magenta};`,
    `  --term-ansi-6: ${a.cyan};`,
    `  --term-ansi-7: ${a.white};`,
    `  --term-ansi-8: ${a.brightBlack};`,
    `  --term-ansi-9: ${a.brightRed};`,
    `  --term-ansi-10: ${a.brightGreen};`,
    `  --term-ansi-11: ${a.brightYellow};`,
    `  --term-ansi-12: ${a.brightBlue};`,
    `  --term-ansi-13: ${a.brightMagenta};`,
    `  --term-ansi-14: ${a.brightCyan};`,
    `  --term-ansi-15: ${a.brightWhite};`,
    `}`
  ]
  return lines.join('\n')
}

const generated = themes.map(themeBlock).join('\n\n')
const block = `${START}\n${generated}\n${END}`

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const current = readFileSync(tokensPath, 'utf8')
const pattern = new RegExp(`${escapeRegExp(START)}[\\s\\S]*${escapeRegExp(END)}`)
if (!pattern.test(current)) {
  throw new Error(`tokens.css is missing the ${START} / ${END} markers`)
}
writeFileSync(tokensPath, current.replace(pattern, block))
console.log(`generate-tokens-css: wrote ${themes.length} theme blocks to ${tokensPath}`)
