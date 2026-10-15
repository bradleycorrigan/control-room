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

/** The branch a ticket's session starts on: "proj-601-fix-the-login-…". */
export const branchFor = (issue: JiraIssue): string =>
  `${issue.key.toLowerCase()}-${slug(issue.summary)}`.slice(0, 60).replace(/-$/, '')

const DESCRIPTION_CAP = 4000
const SHORTENED_NOTE = '(Description shortened: read the ticket for the rest.)'

/**
 * A ticket description made safe to use as a prompt: embedded images and
 * encoded blobs (a pasted Metabase card is ~5,000 characters of base64) are
 * dropped, blank lines collapsed, and the rest capped at a line boundary.
 * The ticket panel still shows the full description.
 */
export function cleanDescription(text: string): string {
  let t = text
    // data: URIs, alone or inside markup
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,][^\s)\]"'>}|]*/gi, '')
    // Jira wiki images and attachments: !pic.png!, !pic.png|width=50!, [^file.pdf]
    .replace(/![^\s!|]+\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\|[^!\n]*)?!/gi, '')
    .replace(/\[\^[^\]\n]+\]/g, '')
    // Markdown images and media placeholders the conversion can leave
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/^[ \t]*\[?(?:media|mediaSingle|mediaGroup|inlineCard)\]?[ \t]*$/gim, '')
    // long encoded runs: 200+ characters with no spaces
    .replace(/[A-Za-z0-9+/=_-]{200,}/g, '')
  // a long token of only base64 characters, mixing letters and digits, with no
  // URL or path shape, is a blob
  t = t.replace(/\S{80,}/g, (tok) =>
    /^[A-Za-z0-9+/=_-]+$/.test(tok) &&
    !/^https?:/i.test(tok) &&
    /\d/.test(tok) &&
    /[A-Za-z]/.test(tok) &&
    !/[a-z]{3,}\.[a-z]/i.test(tok)
      ? ''
      : tok
  )
  t = t
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (t.length <= DESCRIPTION_CAP) return t
  const head = t.slice(0, DESCRIPTION_CAP)
  const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'))
  const kept = (cut > DESCRIPTION_CAP / 2 ? head.slice(0, cut) : head).trimEnd()
  return `${kept}\n\n${SHORTENED_NOTE}`
}

/** A new session for a ticket: its key, summary, description and link. */
export function seedFor(issue: JiraIssue): ComposerSeed {
  const cleaned = issue.description ? cleanDescription(issue.description) : ''
  const description = cleaned ? `\n\n${cleaned}` : ''
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
