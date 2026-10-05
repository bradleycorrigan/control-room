import type { JiraIssue } from '../../api'
import type { LiveSession } from '../../../../main/store/types'

/** What Start session hands the composer. */
export interface ComposerSeed {
  prompt: string
  branch: string
  title: string
  /** Jira project key — the composer remembers which repo you start these in. */
  jiraProject: string
}

/** A session that belongs to a ticket: linked to it, or named after it. */
export type SessionEntry = { session: LiveSession; linked: boolean }

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** The branch a ticket's session starts on: "dsd-601-wallet-change-…". */
export const branchFor = (issue: JiraIssue): string =>
  `${issue.key.toLowerCase()}-${slug(issue.summary)}`.slice(0, 60).replace(/-$/, '')

/** A new session for a ticket: its key, summary, description and link. */
export function seedFor(issue: JiraIssue): ComposerSeed {
  const description = issue.description ? `\n\n${issue.description}` : ''
  return {
    prompt: `${issue.key}: ${issue.summary}${description}\n\nJira: ${issue.url}`,
    branch: branchFor(issue),
    title: `${issue.key} ${issue.summary}`,
    jiraProject: issue.project
  }
}

/**
 * The sessions working on a ticket: the ones linked to it first, then any
 * whose name or branch starts with its key (and that aren't linked elsewhere).
 * `links` maps a session record id to the ticket key it's linked to.
 */
export function sessionsForTicket(
  issue: JiraIssue,
  sessions: LiveSession[],
  links: Record<string, string>
): SessionEntry[] {
  const key = issue.key.toLowerCase()
  const out: SessionEntry[] = []
  for (const s of sessions) {
    if (!s.record || s.record.deletedAt) continue
    const linked = links[s.record.id] === issue.key
    const named =
      (s.record.title ?? '').toLowerCase().includes(key) ||
      (s.record.branch ?? '').toLowerCase().startsWith(key)
    if (linked || (named && !links[s.record.id])) out.push({ session: s, linked })
  }
  return out.sort((a, b) => Number(b.linked) - Number(a.linked))
}

/** As many as one row or two of the grid holds: a landing pad, not the Backlog. */
const MAX_HOME_TICKETS = 6

/**
 * Your open tickets, the current cycle's first, then the most recently
 * updated. Not epics (nobody works an epic directly) and not sub-tasks (they
 * show on their parent).
 */
export function pickHomeTickets(issues: JiraIssue[]): JiraIssue[] {
  return issues
    .filter((i) => i.assignedToMe && i.statusCategory !== 'done' && !i.isEpic && !i.isSubtask)
    .sort(
      (a, b) =>
        Number(b.sprint?.state === 'active') - Number(a.sprint?.state === 'active') ||
        b.updated.localeCompare(a.updated)
    )
    .slice(0, MAX_HOME_TICKETS)
}
