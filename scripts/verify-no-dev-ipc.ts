// Static check: the renderer must not call dev:* IPC handlers outside a
// screenshot run. Main registers those handlers only when CR_SHOT=1 (see
// src/main/dev/screenshot.ts), so in the installed app every such call rejects
// and ScreenBoundary logs it as a crash.
//
// Rule. Outside src/renderer/src/dev/, a call to `.invoke('dev:...')`, or a call
// to a function imported from a module in dev/, must be behind the shot flag:
// inside `if (...isShotMode...) { ... }`, or after an earlier
// `if (!...isShotMode...) return;` in the same block.
//
// Run: npm run verify:no-dev-ipc            (checks src/renderer/src)
//      npm run verify:no-dev-ipc -- <dir>   (checks another tree, for a negative test)

import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const root = process.argv[2] ?? 'src/renderer/src'
const devDir = join(root, 'dev')
const FLAG = 'isShotMode'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return path === devDir ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

const mentionsFlag = (expr: ts.Expression): boolean => expr.getText().includes(FLAG)

const returns = (stmt: ts.Statement): boolean =>
  ts.isReturnStatement(stmt) || (ts.isBlock(stmt) && stmt.statements.length === 1 && returns(stmt.statements[0]))

// `if (!<flag>) return` (or `return;` in braces).
function isEarlyReturnGuard(stmt: ts.Statement): boolean {
  return (
    ts.isIfStatement(stmt) &&
    ts.isPrefixUnaryExpression(stmt.expression) &&
    stmt.expression.operator === ts.SyntaxKind.ExclamationToken &&
    mentionsFlag(stmt.expression.operand) &&
    returns(stmt.thenStatement)
  )
}

function isGuarded(node: ts.Node): boolean {
  let child: ts.Node = node
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement === child && mentionsFlag(parent.expression)) {
      return true
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const index = parent.statements.indexOf(child as ts.Statement)
      if (parent.statements.slice(0, index).some(isEarlyReturnGuard)) return true
    }
  }
  return false
}

// Names imported into this file from a module that lives in dev/.
function devImportNames(sf: ts.SourceFile, file: string): Set<string> {
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const target = relative(root, join(dirname(file), stmt.moduleSpecifier.text))
    if (!target.startsWith(`dev${sep}`) || !stmt.importClause) continue
    if (stmt.importClause.name) names.add(stmt.importClause.name.text)
    const bindings = stmt.importClause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.add(el.name.text)
    }
  }
  return names
}

let checked = 0
const violations: string[] = []

for (const file of sourceFiles(root)) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const devImports = devImportNames(sf, file)

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isDevInvoke =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'invoke' &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text.startsWith('dev:')
      const isDevImportCall = ts.isIdentifier(callee) && devImports.has(callee.text)
      if (isDevInvoke || isDevImportCall) {
        checked++
        if (!isGuarded(node)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          violations.push(`${file}:${line + 1}  ${node.getText(sf).split('\n')[0]}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

if (violations.length > 0) {
  console.error(`FAIL — dev IPC reachable outside a shot run (${violations.length}):`)
  for (const v of violations) console.error(`  ${v}`)
  console.error(`Guard each with \`if (window.api.${FLAG})\` or an early return on it.`)
  process.exit(1)
}
console.log(`ok — ${checked} dev-IPC call sites in ${root} are all behind ${FLAG}`)
