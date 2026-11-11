import { app } from 'electron'
import { run } from './run'
import type { ShipResult } from './ship'

/**
 * What can be done to an open pull request from the PR panel: merge it,
 * close it, put it back into draft, and delete its branch on GitHub after.
 * Everything goes through `gh`, by number from the session's worktree or by
 * URL for a PR in another repo, so no other checkout is needed.
 */

export type MergeMethod = 'squash' | 'merge' | 'rebase'

export interface PrStatus {
  /** The method this repo allows, squash first. Null when it allows none we can use. */
  method: MergeMethod | null
  /** Why it can't be merged now, in a few words. Null when it can. */
  blocked: string | null
  /** The branch the PR merges from, for deleting it after. */
  headRefName: string | null
  /** `owner/name` of the repo the PR is in. */
  repository: string | null
}

export type PrStatusResult = { ok: true; value: PrStatus } | { ok: false; error: string }

// The fixture has no GitHub remote: the gate's fixture PR merges cleanly, and
// every action succeeds without calling gh. Never in a packaged build.
const isFixture = (): boolean =>
  !app.isPackaged && Boolean(process.env.CR_PR_FIXTURE || process.env.CR_SHIP_FIXTURE)

const failed = (res: { stderr: string }, fallback: string): ShipResult => ({
  ok: false,
  error: res.stderr.trim().split('\n').pop() || fallback
})

/** `owner/name` from a GitHub pull request address. */
function repoOf(url: string): string | null {
  return /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/.exec(url)?.[1] ?? null
}

/**
 * GitHub's mergeStateStatus, in words. Only CLEAN, UNSTABLE (a check that
 * isn't required failed) and HAS_HOOKS can be merged without an override.
 */
export function blockedReason(
  mergeable: string | undefined,
  mergeStateStatus: string | undefined,
  reviewDecision: string | undefined
): string | null {
  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') return 'Has merge conflicts.'
  switch (mergeStateStatus) {
    case 'CLEAN':
    case 'UNSTABLE':
    case 'HAS_HOOKS':
      return null
    case 'BEHIND':
      return 'Behind its base branch: update it on GitHub first.'
    case 'DRAFT':
      return 'Still a draft.'
    case 'BLOCKED':
      return reviewDecision === 'REVIEW_REQUIRED' || reviewDecision === 'CHANGES_REQUESTED'
        ? reviewDecision === 'CHANGES_REQUESTED'
          ? 'Changes requested.'
          : 'Waiting on a review.'
        : 'Waiting on required checks.'
    default:
      // UNKNOWN: GitHub is still working it out.
      return 'GitHub is still checking whether it can merge.'
  }
}

export async function pullRequestStatus(cwd: string, pr: number | string): Promise<PrStatusResult> {
  if (isFixture()) {
    return {
      ok: true,
      value: {
        method: 'squash',
        blocked: null,
        headRefName: 'fixture/ready',
        repository: 'example/fixture'
      }
    }
  }
  const view = await run(
    'gh',
    [
      'pr',
      'view',
      String(pr),
      '--json',
      'url,mergeable,mergeStateStatus,reviewDecision,headRefName'
    ],
    { cwd, timeoutMs: 20_000 }
  )
  if (view.code !== 0) return { ok: false, error: failed(view, 'gh pr view failed').error! }
  let pv: {
    url?: string
    mergeable?: string
    mergeStateStatus?: string
    reviewDecision?: string
    headRefName?: string
  }
  try {
    pv = JSON.parse(view.stdout)
  } catch {
    return { ok: false, error: 'gh gave an answer that could not be read.' }
  }
  const repository = pv.url ? repoOf(pv.url) : null
  let method: MergeMethod | null = null
  if (repository) {
    const repo = await run(
      'gh',
      [
        'repo',
        'view',
        repository,
        '--json',
        'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'
      ],
      { cwd, timeoutMs: 20_000 }
    )
    try {
      const r = JSON.parse(repo.stdout) as Record<string, boolean>
      method = r.squashMergeAllowed
        ? 'squash'
        : r.mergeCommitAllowed
          ? 'merge'
          : r.rebaseMergeAllowed
            ? 'rebase'
            : null
    } catch {
      method = null
    }
  }
  return {
    ok: true,
    value: {
      method,
      blocked: method
        ? blockedReason(pv.mergeable, pv.mergeStateStatus, pv.reviewDecision)
        : 'This repo allows no merge method Control Room can use.',
      headRefName: pv.headRefName ?? null,
      repository
    }
  }
}

/** `gh pr ready --undo`: back into draft. */
export async function convertToDraft(cwd: string, pr: number | string): Promise<ShipResult> {
  if (isFixture()) return { ok: true }
  const res = await run('gh', ['pr', 'ready', String(pr), '--undo'], { cwd, timeoutMs: 60_000 })
  return res.code === 0 ? { ok: true } : failed(res, 'gh pr ready --undo failed')
}

/**
 * The branch on GitHub, by the API rather than `git push --delete`: it works
 * for a PR in another repo too, and never touches the local branch, which the
 * session's worktree still has checked out.
 */
async function deleteRemoteBranch(
  cwd: string,
  repository: string,
  branch: string
): Promise<ShipResult> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !branch || branch.includes('..'))
    return { ok: false, error: 'No branch to delete.' }
  const ref = branch.split('/').map(encodeURIComponent).join('/')
  const res = await run(
    'gh',
    ['api', '-X', 'DELETE', `repos/${repository}/git/refs/heads/${ref}`],
    { cwd, timeoutMs: 30_000 }
  )
  return res.code === 0 ? { ok: true } : failed(res, 'Could not delete the branch.')
}

async function thenDeleteBranch(
  cwd: string,
  pr: number | string,
  done: string,
  deleteBranch: boolean
): Promise<ShipResult & { branchError?: string }> {
  if (!deleteBranch || isFixture()) return { ok: true }
  const status = await pullRequestStatus(cwd, pr)
  if (!status.ok || !status.value.repository || !status.value.headRefName)
    return { ok: true, branchError: `${done}, but the branch couldn't be found to delete.` }
  const del = await deleteRemoteBranch(cwd, status.value.repository, status.value.headRefName)
  return del.ok ? { ok: true } : { ok: true, branchError: `${done}, but ${del.error}` }
}

/** `gh pr close`, then the branch on GitHub if asked. */
export async function closePullRequest(
  cwd: string,
  pr: number | string,
  deleteBranch: boolean
): Promise<ShipResult & { branchError?: string }> {
  if (isFixture()) return { ok: true }
  const res = await run('gh', ['pr', 'close', String(pr)], { cwd, timeoutMs: 60_000 })
  if (res.code !== 0) return failed(res, 'gh pr close failed')
  return thenDeleteBranch(cwd, pr, 'Closed', deleteBranch)
}

/**
 * `gh pr merge` with the repo's method. Not `--delete-branch`: that also
 * deletes the local branch, which fails in a worktree that has it checked out.
 */
export async function mergePullRequest(
  cwd: string,
  pr: number | string,
  method: MergeMethod,
  deleteBranch: boolean
): Promise<ShipResult & { branchError?: string }> {
  if (isFixture()) return { ok: true }
  const res = await run('gh', ['pr', 'merge', String(pr), `--${method}`], {
    cwd,
    timeoutMs: 90_000
  })
  if (res.code !== 0) return failed(res, 'gh pr merge failed')
  return thenDeleteBranch(cwd, pr, 'Merged', deleteBranch)
}
