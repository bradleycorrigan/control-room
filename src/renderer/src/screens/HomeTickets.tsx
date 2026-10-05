import { useEffect, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import { getJiraStatus, getSessionTicketLinks, loadJiraBoard, type JiraIssue } from '../api'
import { IconButton, StatusDot } from '../components/primitives'
import { STATUS_WORDS } from '../components/primitives/Badge'
import { PriorityGlyph, StatusGlyph } from './backlogGlyphs'
import {
  pickHomeTickets,
  seedFor,
  sessionsForTicket,
  type ComposerSeed
} from './backlog/ticketSessions'

/**
 * "Your tickets" on Home, beside the recent sessions: pick up a ticket from
 * here. A ticket that already has a session opens it; one without starts a
 * session for it, the composer filled in from the ticket. Nothing shows
 * until Jira is connected.
 */
export default function HomeTickets({
  sessions,
  onOpenSession,
  onStartSession,
  onOpenTicket
}: {
  sessions: LiveSession[]
  onOpenSession: (liveKey: string, background?: boolean) => void
  onStartSession: (seed: ComposerSeed) => void
  onOpenTicket: (key: string) => void
}): React.JSX.Element | null {
  const [tickets, setTickets] = useState<JiraIssue[] | null>(null)
  const [links, setLinks] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    void getJiraStatus().then(async (status) => {
      if (cancelled || !status.configured) return
      const [board, linked] = await Promise.all([loadJiraBoard(), getSessionTicketLinks()])
      if (cancelled) return
      setLinks(linked)
      if (board.ok) setTickets(pickHomeTickets(board.value.issues))
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!tickets || tickets.length === 0) return null

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
              className="cr-session-card cr-ticket-card-wrap"
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
                <span className="cr-ticket-card-top">
                  <StatusGlyph name={issue.status} category={issue.statusCategory} size={12} />
                  <span className="cr-ticket-card-key">{issue.key}</span>
                  <PriorityGlyph priority={issue.priority} />
                </span>
                <span className="cr-ticket-card-title" title={issue.summary}>
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
