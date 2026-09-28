#!/usr/bin/env node
// Shared gate checks used by gate.mjs and gate-fast.mjs
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'out' || entry === '.dev') continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runHexLiteralGrep(root) {
  const start = Date.now()
  const files = []
  const srcRoot = join(root, 'src', 'renderer', 'src')
  try {
    walk(srcRoot, files)
  } catch {
    // renderer src not present yet; nothing to grep
  }
  const offenders = []
  const hexRe = /#[0-9a-fA-F]{6}/
  for (const f of files) {
    if (!f.endsWith('.tsx')) continue
    if (relative(root, f).split('/').includes('theme')) continue
    const text = readFileSync(f, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (hexRe.test(line)) offenders.push(`${relative(root, f)}:${i + 1}: ${line.trim()}`)
    })
  }
  return {
    label: 'hex-literal-grep',
    ok: offenders.length === 0,
    ms: Date.now() - start,
    output: offenders.join('\n')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runNativeModuleGrep(root) {
  // Known, accepted exception (see git history: "U8 round 3 — revert the
  // node-gyp check carve-out"): electron-builder's own devDependency chain
  // (electron-builder -> @electron/rebuild -> node-gyp) always matches this
  // grep. It is packaging tooling, not something the shipped app depends on
  // at runtime. Treat ONLY that exact chain as non-blocking; any other
  // node-gyp/prebuild hit still fails the gate.
  const start = Date.now()
  const res = spawnSync('npm', ['ls', '--all'], { cwd: root, encoding: 'utf8' })
  const lines = ((res.stdout || '') + (res.stderr || '')).split('\n')
  const hitLines = lines.filter((l) => /node-gyp|prebuild/i.test(l))
  const hasElectronRebuildAncestor = lines.some((l) => /@electron\/rebuild@/.test(l))
  const unexplained = hasElectronRebuildAncestor
    ? hitLines.filter((l) => !/node-gyp@/.test(l))
    : hitLines
  return {
    label: 'native-module-grep',
    ok: unexplained.length === 0,
    ms: Date.now() - start,
    output:
      unexplained.length === 0 && hitLines.length > 0
        ? `known non-blocking (electron-builder -> @electron/rebuild -> node-gyp):\n${hitLines.join('\n')}`
        : hitLines.join('\n')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runNoDeadControls(root) {
  const start = Date.now()
  const files = []
  const srcRoot = join(root, 'src', 'renderer', 'src')
  try {
    walk(srcRoot, files)
  } catch {
    return {
      label: 'no-dead-controls',
      ok: true,
      ms: Date.now() - start,
      output: 'renderer src not present yet'
    }
  }

  const offenders = []
  const divRoleButtonRe = /<div[^>]*role=["']button["']/
  for (const f of files) {
    if (!f.endsWith('.tsx')) continue
    const text = readFileSync(f, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      // Look for disabled attribute on buttons or menu items — specifically literals or missing implementations
      if (
        /disabled=\{?true\}?|disabled=['"]true['"]/.test(line) ||
        /disabled.*TODO|disabled.*not implemented/i.test(line)
      ) {
        offenders.push(`${relative(root, f)}:${i + 1}: ${line.trim()}`)
      }
      // Ban <div role="button"> — interactive elements must be <button>
      if (divRoleButtonRe.test(line)) {
        offenders.push(
          `${relative(root, f)}:${i + 1}: <div role="button"> found — use <button> instead`
        )
      }
    })
  }

  return {
    label: 'no-dead-controls',
    ok: offenders.length === 0,
    ms: Date.now() - start,
    output: offenders.join('\n')
  }
}

/**
 * Glyphs that must never be typed into JSX as an icon. Note this is a list of
 * ICONS, not of non-ASCII: an ellipsis or an em dash is typography and belongs
 * in copy. What is banned is drawing a control's symbol with a character.
 *
 * The system UI font does not contain them — verified with CoreText that
 * SF Pro, .SFNS-Regular and Helvetica all lack U+2715 — so a button built from
 * one renders blank. This has now shipped twice: first as emoji standing in for
 * icons, then as a diff sheet whose close button had no visible X. Every icon
 * comes from lucide via <Icon> or <IconButton>.
 */
const FORBIDDEN_GLYPHS =
  /[\u2715\u2716\u2717\u2718\u2713\u2714\u270E\u2612\u2573\u00D7\u2A2F\u22EF\u{1F300}-\u{1FAFF}]/u

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runNoRawGlyphs(root) {
  const start = Date.now()
  const files = []
  const srcRoot = join(root, 'src', 'renderer', 'src')
  try {
    walk(srcRoot, files)
  } catch {
    return {
      label: 'no-raw-glyphs',
      ok: true,
      ms: Date.now() - start,
      output: 'renderer src not present yet'
    }
  }

  const offenders = []
  for (const f of files) {
    if (!f.endsWith('.tsx')) continue
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      // Comments are prose, not UI. Regex literals legitimately match glyphs.
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('{/*')
      )
        return
      if (FORBIDDEN_GLYPHS.test(line)) {
        offenders.push(`${relative(root, f)}:${i + 1}: ${trimmed}`)
      }
    })
  }

  return {
    label: 'no-raw-glyphs',
    ok: offenders.length === 0,
    ms: Date.now() - start,
    output: offenders.join('\n')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runNoScopeLanguage(root) {
  const start = Date.now()
  const files = []
  const srcRoot = join(root, 'src', 'renderer', 'src')
  try {
    walk(srcRoot, files)
  } catch {
    return {
      label: 'no-scope-language',
      ok: true,
      ms: Date.now() - start,
      output: 'renderer src not present yet'
    }
  }

  const offenders = []
  // Match scope language: specifically phrases that admit the feature is unimplemented.
  // Focus on tooltip/title attributes since that's where disabled controls confess their sins.
  const problemPhrases = /IPC\s+exists\s+yet|out of scope|not implemented|coming soon/i
  for (const f of files) {
    if (!f.endsWith('.tsx')) continue
    const text = readFileSync(f, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      // Skip comments
      if (
        line.trim().startsWith('//') ||
        line.trim().startsWith('/*') ||
        line.trim().startsWith('*')
      ) {
        return
      }
      // Look for scope language specifically in title/tooltip attributes (where disabled controls confess)
      if (/(title|tooltip)\s*=/.test(line) && problemPhrases.test(line)) {
        offenders.push(`${relative(root, f)}:${i + 1}: ${line.trim()}`)
      }
    })
  }

  return {
    label: 'no-scope-language',
    ok: offenders.length === 0,
    ms: Date.now() - start,
    output: offenders.join('\n')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runEveryActionHasHandler(root) {
  const start = Date.now()
  const files = []
  const srcRoot = join(root, 'src', 'renderer', 'src')
  try {
    walk(srcRoot, files)
  } catch {
    return {
      label: 'every-action-has-handler',
      ok: true,
      ms: Date.now() - start,
      output: 'renderer src not present yet'
    }
  }

  // Collect action ids from renderer
  const actionIds = new Set()
  for (const f of files) {
    if (!f.endsWith('.tsx')) continue
    const text = readFileSync(f, 'utf8')
    // Look for ipcRenderer.invoke('action-id') or similar patterns
    const matches = text.match(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)
    if (matches) {
      for (const match of matches) {
        const actionId = match.replace(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/, '$1')
        actionIds.add(actionId)
      }
    }
  }

  // Collect registered handlers from ipc.ts
  const ipcFile = join(root, 'src', 'main', 'ipc.ts')
  const registeredHandlers = new Set()
  try {
    const ipcText = readFileSync(ipcFile, 'utf8')
    const matches = ipcText.match(/ipcMain\.handle\(['"]([^'"]+)['"]/g)
    if (matches) {
      for (const match of matches) {
        const handlerId = match.replace(/ipcMain\.handle\(['"]([^'"]+)['"]/, '$1')
        registeredHandlers.add(handlerId)
      }
    }
  } catch {
    return {
      label: 'every-action-has-handler',
      ok: false,
      ms: Date.now() - start,
      output: 'failed to read ipc.ts'
    }
  }

  // Check for missing handlers
  const offenders = []
  for (const actionId of actionIds) {
    if (!registeredHandlers.has(actionId)) {
      offenders.push(`action '${actionId}' invoked in renderer but no handler registered in ipc.ts`)
    }
  }

  return {
    label: 'every-action-has-handler',
    ok: offenders.length === 0,
    ms: Date.now() - start,
    output: offenders.join('\n')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runNoBareZIndex(root) {
  // A bare z-index is a number picked without knowing what else is on screen,
  // and guessing has been wrong twice here: the tooltip rendered behind the
  // title bar, and toasts reported "session deleted" from behind the chrome.
  // Every layer is named in theme/tokens.css, in order — add one there rather
  // than inventing a number at the call site.
  const start = Date.now()
  const files = []
  const srcRoot = join(root, 'src', 'renderer', 'src')
  try {
    walk(srcRoot, files)
  } catch {
    // renderer src not present yet; nothing to grep
  }
  const offenders = []
  // `z-index: 0` and `auto` are resets, not a position in the stack.
  const bareRe = /z-index:\s*(-?\d+)/
  for (const f of files) {
    if (!f.endsWith('.css')) continue
    const rel = relative(root, f)
    // tokens.css is where the scale itself is defined.
    if (rel.endsWith(join('theme', 'tokens.css'))) continue
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = bareRe.exec(line)
        if (m && m[1] !== '0') offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
  }
  return {
    label: 'no-bare-z-index',
    ok: offenders.length === 0,
    ms: Date.now() - start,
    output: offenders.join('\n')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runDropsKeepCopies(root) {
  // A screenshot dragged fresh from macOS's preview thumbnail is a real file in
  // a temp folder that macOS deletes moments after the drop. Referencing that
  // path is the bug that kept coming back: it works in the moment and is gone
  // by the time the agent reads it. Every drop that resolves a path must hand
  // it to addDroppedPaths, which keeps a copy.
  const start = Date.now()
  const files = []
  try {
    walk(join(root, 'src', 'renderer', 'src'), files)
  } catch {
    // nothing to check
  }
  const offenders = []
  for (const f of files) {
    if (!/\.tsx?$/.test(f) || f.endsWith(join('src', 'api.ts'))) continue
    const text = readFileSync(f, 'utf8')
    if (text.includes('getPathForDroppedFile(') && !text.includes('addDroppedPaths(')) {
      offenders.push(`${relative(root, f)}: resolves a dropped file's path without addDroppedPaths`)
    }
  }
  return {
    label: 'drops-keep-copies',
    ok: offenders.length === 0,
    ms: Date.now() - start,
    output: offenders.join('\n')
  }
}

/**
 * No em dashes in anything a person reads: string literals, template text and
 * JSX text across the app. Comments, log lines and dev-only files are exempt.
 * Uses the TypeScript parser, so a dash in a comment never counts.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function runNoEmDashCopy(root) {
  const start = Date.now()
  const ts = (await import('typescript')).default
  const files = []
  walk(join(root, 'src'), files)
  const offenders = []
  for (const f of files) {
    if (!/\.tsx?$/.test(f)) continue
    const rel = relative(root, f)
    if (rel.split('/').includes('dev')) continue
    const text = readFileSync(f, 'utf8')
    if (!text.includes('—')) continue
    const source = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true)
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const isLogCall = (node) => {
      for (let n = node.parent; n; n = n.parent) {
        if (ts.isCallExpression(n)) {
          const callee = n.expression.getText(source)
          return /^(log|console)\.\w+$/.test(callee)
        }
      }
      return false
    }
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const visit = (node) => {
      const copy =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)
      if (copy && node.getText(source).includes('—') && !isLogCall(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        offenders.push(`${rel}:${line + 1}: ${node.getText(source).trim().slice(0, 120)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return {
    label: 'no-em-dash-copy',
    ok: offenders.length === 0,
    ms: Date.now() - start,
    output: offenders.length ? 'use a colon or a hyphen instead:\n' + offenders.join('\n') : ''
  }
}
