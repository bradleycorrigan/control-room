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
  /** Null when gh couldn't say. */
  title: string | null
  isDraft: boolean
}

type PrDetails = Pick<LinkedPullRequest, 'state' | 'title' | 'isDraft'>

// A PR's state changes rarely; the header asks every time the agent finishes
// a turn, so answers are kept a minute rather than calling gh each time.
const stateCache = new Map<string, { at: number; details: PrDetails }>()
const STATE_TTL_MS = 60_000

async function pullRequestDetails(url: string): Promise<PrDetails> {
  const cached = stateCache.get(url)
  if (cached && Date.now() - cached.at < STATE_TTL_MS) return cached.details
  const details: PrDetails = { state: null, title: null, isDraft: false }
  // gh takes a PR's URL from any directory, so no checkout of its repo is needed.
  const res = await run('gh', ['pr', 'view', url, '--json', 'state,title,isDraft'], {
    timeoutMs: 10_000
  })
  if (res.code === 0) {
    try {
      const j = JSON.parse(res.stdout) as { state?: string; title?: string; isDraft?: boolean }
      if (j.state === 'OPEN' || j.state === 'MERGED' || j.state === 'CLOSED')
        details.state = j.state
      if (typeof j.title === 'string' && j.title) details.title = j.title
      details.isDraft = j.isDraft === true
    } catch {
      // Leave it unknown.
    }
  }
  stateCache.set(url, { at: Date.now(), details })
  return details
}

/** Forget what gh said about a PR, after Control Room changes it (out of draft). */
export function forgetPullRequestDetails(url: string): void {
  stateCache.delete(url)
}

/** Whether a string is a GitHub pull request's web address. */
export function isPullRequestUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)
}

export async function linkedPullRequests(
  links: { number: number; url: string; repository: string }[]
): Promise<LinkedPullRequest[]> {
  return Promise.all(links.map(async (l) => ({ ...l, ...(await pullRequestDetails(l.url)) })))
}
