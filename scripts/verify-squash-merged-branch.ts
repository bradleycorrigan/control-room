// Clean up worktrees' "Also delete merged branches" on a squash-merged pull
// request, which git can't see as merged: the branch goes when it still
// points at the commit GitHub merged, and stays when it has anything newer.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchTip, deleteMergedBranch } from '../src/main/exec/git'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
  if (!ok) failed++
}

const repo = mkdtempSync(join(tmpdir(), 'cr-squash-'))
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com'
    }
  }).trim()

async function main(): Promise<void> {
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-qm', 'start')

  // Two branches, each squash-merged into main the way GitHub does it.
  for (const name of ['feature/done', 'feature/more']) {
    git('switch', '-qc', name, 'main')
    writeFileSync(join(repo, `${name.replace('/', '-')}.txt`), 'work\n')
    git('add', '.')
    git('commit', '-qm', `${name} work`)
    git('switch', '-q', 'main')
    git('merge', '-q', '--squash', name)
    git('commit', '-qm', `${name} (squashed)`)
  }
  const doneTip = (await branchTip(repo, 'feature/done')) ?? ''
  const moreMerged = (await branchTip(repo, 'feature/more')) ?? ''
  // feature/more gets a commit after its PR merged.
  git('switch', '-q', 'feature/more')
  writeFileSync(join(repo, 'later.txt'), 'later\n')
  git('add', '.')
  git('commit', '-qm', 'after the merge')
  git('switch', '-q', 'main')

  const pr = (headRefOid: string) => ({ number: 1, state: 'MERGED', url: '', headRefOid }) as const

  const noPr = await deleteMergedBranch(repo, 'feature/done', undefined)
  check('without a merged PR, a squash-merged branch is kept', !noPr.ok, JSON.stringify(noPr))

  const done = await deleteMergedBranch(repo, 'feature/done', pr(doneTip))
  check(
    'a branch at the commit its merged PR shipped is deleted',
    done.ok && (await branchTip(repo, 'feature/done')) === null,
    JSON.stringify(done)
  )

  const more = await deleteMergedBranch(repo, 'feature/more', pr(moreMerged))
  check(
    'a branch with commits after its PR merged is kept',
    !more.ok && (await branchTip(repo, 'feature/more')) !== null,
    JSON.stringify(more)
  )
}

main()
  .catch((e) => {
    console.log(`FAIL  squash-merged branch check crashed (${e})`)
    failed++
  })
  .finally(() => {
    rmSync(repo, { recursive: true, force: true })
    if (failed > 0) process.exit(1)
  })
