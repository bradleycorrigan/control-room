// Forking a session copies its uncommitted work into the fork's new worktree:
// edits, deletions, new files and binary files, leaving the original alone.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
  if (!ok) failed++
}

async function main(): Promise<void> {
  const { copyWorkingChanges, headCommit } = await import('../src/main/exec/git')
  const root = mkdtempSync(join(tmpdir(), 'cr-fork-'))
  const repo = join(root, 'repo')
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'kept.txt'), 'one\n')
  writeFileSync(join(repo, 'gone.txt'), 'bye\n')
  writeFileSync(join(repo, '.gitignore'), 'secret.env\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'start')

  // Uncommitted work: an edit, a deletion, a staged new file, an untracked
  // file in a new folder, a binary file, and an ignored file.
  writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\n')
  rmSync(join(repo, 'gone.txt'))
  writeFileSync(join(repo, 'staged.txt'), 'staged\n')
  git(repo, 'add', 'staged.txt')
  mkdirSync(join(repo, 'new'))
  writeFileSync(join(repo, 'new', 'file.txt'), 'new\n')
  writeFileSync(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 255, 0, 7]))
  writeFileSync(join(repo, 'secret.env'), 'TOKEN=x\n')
  const statusBefore = git(repo, 'status', '--porcelain')

  const base = await headCommit(repo)
  const fork = join(root, 'fork')
  git(repo, 'worktree', 'add', '-q', fork, '-b', 'main-fork', base ?? 'HEAD')
  const copied = await copyWorkingChanges(repo, fork)

  check('the copy succeeds', copied.ok, copied.error)
  check(
    'edits, deletions and new files arrive',
    readFileSync(join(fork, 'kept.txt'), 'utf8') === 'one\ntwo\n' &&
      !existsSync(join(fork, 'gone.txt')) &&
      readFileSync(join(fork, 'staged.txt'), 'utf8') === 'staged\n' &&
      readFileSync(join(fork, 'new', 'file.txt'), 'utf8') === 'new\n',
    git(fork, 'status', '--porcelain')
  )
  check(
    'binary files arrive intact',
    Buffer.compare(readFileSync(join(fork, 'pic.bin')), Buffer.from([0, 1, 2, 255, 0, 7])) === 0
  )
  check('ignored files stay behind', !existsSync(join(fork, 'secret.env')))
  check(
    'the original is untouched, its staging included',
    git(repo, 'status', '--porcelain') === statusBefore,
    git(repo, 'status', '--porcelain')
  )
  check('the fork is on the same commit', (await headCommit(fork)) === base)

  // Nothing uncommitted: nothing to do, and no error.
  const clean = join(root, 'clean')
  git(repo, 'worktree', 'add', '-q', clean, '-b', 'clean', base ?? 'HEAD')
  const cleanFork = join(root, 'clean-fork')
  git(repo, 'worktree', 'add', '-q', cleanFork, '-b', 'clean-fork', base ?? 'HEAD')
  const none = await copyWorkingChanges(clean, cleanFork)
  check('a clean worktree copies nothing', none.ok && none.changed === 0, JSON.stringify(none))

  rmSync(root, { recursive: true, force: true })
  if (failed) {
    console.log(`${failed} failed`)
    process.exit(1)
  }
}

void main()
