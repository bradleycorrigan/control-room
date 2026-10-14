// Regression test: local editor and tool files (an untracked `.cursor` link,
// `.claude/settings.local.json`, `.DS_Store`) must not count as uncommitted
// work, or block removing a worktree. A real untracked file, and a tracked
// file under one of those paths, still must.
//
// Drives the real exec/git.ts against a throwaway repo (only 'electron' is
// stubbed, as in verify-status-key-stability.ts).
//
// Run: npm run verify:local-only-changes

import Module from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok — ${name}`)
  } else {
    console.error(`  FAIL — ${name}`)
    failures++
  }
}

const root = mkdtempSync(join(tmpdir(), 'cr-local-only-'))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { getPath: () => root, isPackaged: false } }
  return originalLoad.call(this, request, parent, isMain)
}

const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })

async function main(): Promise<void> {
  const { hasUncommittedChanges, uncommittedChanges, removeWorktreeClean } =
    await import('../src/main/exec/git')

  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.cursor', 'rules'), { recursive: true })
  writeFileSync(join(repo, '.cursor', 'rules', 'a.mdc'), 'rule')
  writeFileSync(join(repo, 'README.md'), 'hi')
  git(root, 'init', '-q', '-b', 'main', repo)
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

  const wt = join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt)
  // What worktree setup leaves behind.
  symlinkSync(join(repo, '.cursor'), join(wt, '.cursor'))
  mkdirSync(join(wt, '.claude'))
  writeFileSync(join(wt, '.claude', 'settings.local.json'), '{}')
  writeFileSync(join(wt, '.DS_Store'), '')

  check('local-only files alone are not uncommitted work', !(await hasUncommittedChanges(wt)))
  check('and list as no changes', (await uncommittedChanges(wt))?.length === 0)

  writeFileSync(join(wt, 'notes.txt'), 'real work')
  check('a real untracked file still counts', await hasUncommittedChanges(wt))
  const listed = (await uncommittedChanges(wt)) ?? []
  check(
    'and is the only change listed',
    listed.length === 1 && listed[0].path === 'notes.txt' && listed[0].code === '??'
  )
  rmSync(join(wt, 'notes.txt'))

  const removed = await removeWorktreeClean(repo, wt)
  check(`a worktree with only local-only files removes (${removed.error ?? 'ok'})`, removed.ok)
  check('its folder is gone', !existsSync(wt))
  check(
    "the main checkout's .cursor survives the link being removed",
    existsSync(join(repo, '.cursor', 'rules', 'a.mdc'))
  )

  // A tracked file under a local-only path is the repo's own content.
  const wt2 = join(root, 'wt2')
  git(repo, 'worktree', 'add', '-q', '-b', 'tracked', wt2)
  mkdirSync(join(wt2, '.vscode'))
  writeFileSync(join(wt2, '.vscode', 'settings.json'), '{}')
  git(wt2, 'add', '.vscode/settings.json')
  git(wt2, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'vscode')
  writeFileSync(join(wt2, '.vscode', 'settings.json'), '{"a":1}')
  check('a change to a tracked .vscode file still counts', await hasUncommittedChanges(wt2))

  rmSync(root, { recursive: true, force: true })
  if (failures) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nall passed')
}

void main()
