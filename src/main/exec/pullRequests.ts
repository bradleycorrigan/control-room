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

/** A pull request a session opened, wherever it lives, with its state when GitHub can say. */
export interface LinkedPullRequest {
  number: number
  url: string
  /** `owner/name`. */
  repository: string
  /** Null when gh couldn't say (offline, no access, no gh): the chip still links. */
  state: 'OPEN' | 'MERGED' | 'CLOSED' | null
}

// A PR's state changes rarely; the header asks every time the agent finishes
// a turn, so answers are kept a minute rather than calling gh each time.
const stateCache = new Map<string, { at: number; state: LinkedPullRequest['state'] }>()
const STATE_TTL_MS = 60_000

async function pullRequestState(url: string): Promise<LinkedPullRequest['state']> {
  const cached = stateCache.get(url)
  if (cached && Date.now() - cached.at < STATE_TTL_MS) return cached.state
  let state: LinkedPullRequest['state'] = null
  // gh takes a PR's URL from any directory, so no checkout of its repo is needed.
  const res = await run('gh', ['pr', 'view', url, '--json', 'state'], { timeoutMs: 10_000 })
  if (res.code === 0) {
    try {
      const s = (JSON.parse(res.stdout) as { state?: string }).state
      if (s === 'OPEN' || s === 'MERGED' || s === 'CLOSED') state = s
    } catch {
      // Leave it unknown.
    }
  }
  stateCache.set(url, { at: Date.now(), state })
  return state
}

export async function linkedPullRequests(
  links: { number: number; url: string; repository: string }[]
): Promise<LinkedPullRequest[]> {
  return Promise.all(links.map(async (l) => ({ ...l, state: await pullRequestState(l.url) })))
}
