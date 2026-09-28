import { app } from 'electron'
import { run } from './run'

/**
 * The pull request a session's branch has open, from GitHub's own CLI — so
 * the Backlog can offer to move the ticket along once there's something to
 * review. No gh, no remote, no PR: null, and the offer simply isn't made.
 */
export interface PullRequestInfo {
  number: number
  url: string
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED' | string
  isDraft: boolean
}

export async function pullRequestFor(
  recordId: string,
  worktreePath: string,
  branch: string
): Promise<PullRequestInfo | null> {
  // The fixture has no GitHub remote; CR_PR_FIXTURE names the one fixture
  // session that "has" a PR, so the gate can drive the offer.
  if (!app.isPackaged && process.env.CR_PR_FIXTURE) {
    return process.env.CR_PR_FIXTURE === recordId
      ? {
          number: 42,
          url: 'https://github.com/example/fixture/pull/42',
          title: 'Fixture pull request',
          state: 'OPEN',
          isDraft: false
        }
      : null
  }
  if (!branch) return null
  const res = await run('gh', ['pr', 'view', branch, '--json', 'number,url,title,state,isDraft'], {
    cwd: worktreePath,
    timeoutMs: 10_000
  })
  if (res.code !== 0) return null
  try {
    const pr = JSON.parse(res.stdout) as PullRequestInfo
    return pr.url ? pr : null
  } catch {
    return null
  }
}
