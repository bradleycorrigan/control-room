import type { LiveSession } from '../../../main/store/types'
import { loadTicketPullRequests, openExternal, type JiraIssue } from '../api'
import { IconButton, StatusDot } from '../components/primitives'
import { STATUS_WORDS } from '../components/primitives/Badge'
import { PriorityGlyph, StatusGlyph } from './backlogGlyphs'
import {
  pickHomeTickets,
  seedFor,
  sessionsForTicket,
  type ComposerSeed
} from './backlog/ticketSessions'

const PR_WORDS = { open: 'PR open', merged: 'PR merged' } as const

/** Opens the ticket's pull request on GitHub: the one in the state the chip shows, else the first. */
async function openTicketPullRequest(issue: JiraIssue): Promise<void> {
  const result = await loadTicketPullRequests(issue.key)
  if (!result.ok || result.value.length === 0) return
  const want = issue.pullRequests === 'open' ? 'OPEN' : 'MERGED'
  const pr = result.value.find((p) => p.status === want) ?? result.value[0]
  await openExternal(pr.url)
}

/**
 * "Your tickets" on Home, beside the recent sessions: pick up a ticket from
 * here. A ticket that already has a session opens it; one without starts a
 * session for it, the composer filled in from the ticket. Nothing shows
 * until Jira is connected. Home loads the board (its summary line and
 * suggestions read it too) and hands it down.
 */
export default function HomeTickets({
  issues,
  links,
  sessions,
  onOpenSession,
  onStartSession,
  onOpenTicket
}: {
  issues: JiraIssue[] | null
  links: Record<string, string>
  sessions: LiveSession[]
  onOpenSession: (liveKey: string, background?: boolean) => void
  onStartSession: (seed: ComposerSeed) => void
  onOpenTicket: (key: string) => void
}): React.JSX.Element | null {
  const tickets = issues ? pickHomeTickets(issues) : []
  if (tickets.length === 0) return null

  return (
    <div className="home-recent home-tickets">
      <div className="home-recent-header">
        <h2 className="home-recent-title">Your tickets</h2>
      </div>
      <div className="cr-active-grid">
        {tickets.map((issue) => {
          const entries = sessionsForTicket(issue, sessions, links)
          const session = entries[0]?.session
          const open = (background = false): void =>
            session ? onOpenSession(session.key, background) : onStartSession(seedFor(issue))
          return (
            <div
              key={issue.key}
              className={`cr-session-card cr-ticket-card-wrap${issue.pullRequests ? ' cr-ticket-card-wrap--pr' : ''}`}
              data-home-ticket={issue.key}
            >
              <button
                type="button"
                className="cr-ticket-card"
                aria-label={
                  session
                    ? `${issue.key}: open its session`
                    : `${issue.key}: start a session for it`
                }
                onClick={(e) => open(e.metaKey || e.ctrlKey)}
              >
                <span className="cr-session-card-top cr-ticket-card-top">
                  <StatusGlyph name={issue.status} category={issue.statusCategory} size={12} />
                  <span className="cr-ticket-card-key">{issue.key}</span>
                  <PriorityGlyph priority={issue.priority} />
                </span>
                <span className="cr-session-card-title" title={issue.summary}>
                  {issue.summary}
                </span>
                <span className="cr-ticket-card-foot">
                  {session ? (
                    <>
                      <StatusDot status={session.status} size={8} />
                      <span>{STATUS_WORDS[session.status]}</span>
                    </>
                  ) : (
                    <span className="cr-ticket-card-start">Start a session</span>
                  )}
                  {/* In the foot's own line, so it can't drift from it. A span
                      that acts as a button: the card is the button, and
                      buttons don't nest. */}
                  {issue.pullRequests && (
                    <span
                      role="button"
                      tabIndex={0}
                      className={`cr-ticket-card-pr cr-ticket-card-pr--${issue.pullRequests}`}
                      aria-label={`${PR_WORDS[issue.pullRequests]} for ${issue.key}: open it on GitHub`}
                      title="Open the pull request"
                      onClick={(e) => {
                        e.stopPropagation()
                        void openTicketPullRequest(issue)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          void openTicketPullRequest(issue)
                        }
                      }}
                    >
                      <span className="cr-ticket-card-pr-dot" aria-hidden />
                      {PR_WORDS[issue.pullRequests]}
                    </span>
                  )}
                </span>
              </button>
              <IconButton
                icon="PanelRight"
                label={`View ${issue.key}`}
                tooltip="View ticket"
                size={28}
                variant="ghost"
                className="cr-ticket-card-view"
                onClick={() => onOpenTicket(issue.key)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
