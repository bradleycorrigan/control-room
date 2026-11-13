// Checks the editor setting's pure parts: how a custom editor command becomes
// argv, and what an old or new state file gets for `editor`.
//
// Run: npx tsx scripts/verify-editor-choice.ts

import { customArgv, editorName } from '../src/main/store/editors'
import { migrate } from '../src/main/store/migrate'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` ${detail}`}`)
}

const folder = '/tmp/my project'
const a = customArgv('code -n {folder}', folder)
check(
  '{folder} becomes one argument, spaces and all',
  JSON.stringify(a) === JSON.stringify(['code', '-n', folder]),
  JSON.stringify(a)
)
const b = customArgv('"/Applications/My Editor.app/bin/ed" --wait', folder)
check(
  'a quoted program keeps its spaces; no {folder} puts it on the end',
  JSON.stringify(b) === JSON.stringify(['/Applications/My Editor.app/bin/ed', '--wait', folder]),
  JSON.stringify(b)
)
const c = customArgv('ed; rm -rf ~', folder)
check(
  'shell syntax is just words (nothing goes through a shell)',
  c[0] === 'ed;' && c.includes('rm'),
  JSON.stringify(c)
)

const fresh = migrate({}).settings
check(
  'a new install has no editor and has not been set up',
  fresh.editor === null && fresh.setupCompletedAt === null,
  JSON.stringify({ editor: fresh.editor, setup: fresh.setupCompletedAt })
)
const old = migrate({
  version: 1,
  projects: [],
  sessions: [],
  settings: { hookPort: 47821 }
}).settings
check(
  'a state file from before keeps Cursor and skips setup',
  old.editor === 'cursor' && typeof old.setupCompletedAt === 'number',
  JSON.stringify({ editor: old.editor, setup: old.setupCompletedAt })
)
const chosen = migrate({
  version: 1,
  projects: [],
  sessions: [],
  settings: { editor: 'zed', setupCompletedAt: null }
}).settings
check(
  'a saved choice wins over the defaults',
  chosen.editor === 'zed' && chosen.setupCompletedAt === null,
  JSON.stringify(chosen.editor)
)

check(
  'menus name the editor',
  editorName('vscode') === 'VS Code' &&
    editorName('custom') === 'your editor' &&
    editorName(null) === 'editor'
)

if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
