import type { LiveSession } from '../../../main/store/types'
import type { ProjectWorktree, WorktreePullRequest } from '../api'
import { Badge } from './primitives'
import { openExternal } from '../api'
import { useState } from 'react'
import { isReadyToRemove } from '../lib/worktreeGroup'

/** No commit for this long reads as abandoned. Same bar as the cleanup dialog. */
const UNTOUCHED_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

interface Props {
  worktree: ProjectWorktree
  branch: string | null
  /** The session it belongs to, open or done, for the heading. */
  sessionTitle: string | null
  /** Claude running in it, if any: from its record, or matched by folder. */
  claude: LiveSession | undefined
  pr: WorktreePullRequest | undefined
  ticket: string | null
  onOpen: () => void
  onOpenTicket?: (key: string) => void
  onOpenSession: (key: string) => void
  onStartAgent: () => void
  onRemove: () => void
  onWrapUp: (prNumber: number) => void
}

/**
 * One worktree: what it's for (the session's title, the branch under it),
 * where it stands in one word, what it's tied to, and the one thing you'd do
 * next. The folder path lives in the overlay, not here.
 */
export default function WorktreeCard({
  worktree: w,
  branch,
  sessionTitle,
  claude,
  pr,
  ticket,
  onOpen,
  onOpenTicket,
  onOpenSession,
  onStartAgent,
  onRemove,
  onWrapUp
}: Props): React.JSX.Element {
  // Read once: "untouched for 3 weeks" doesn't need to tick.
  const [now] = useState(() => Date.now())
  const ready = isReadyToRemove(w, pr, claude)
  const busy = claude?.status === 'working' || claude?.status === 'needs_attention'
  const untouchedDays = w.lastCommitAt === null ? 0 : Math.floor((now - w.lastCommitAt) / DAY_MS)
  const merged = pr?.state === 'MERGED'

  // The status line: one verdict, always a word with its colour.
  const verdict = ready ? (
    <span className="cr-worktree-card-verdict cr-worktree-card-verdict--ready">
      <span className="cr-worktree-card-verdict-dot" aria-hidden />
      Ready to remove
    </span>
  ) : claude ? (
    <Badge status={claude.status} variant="bare" />
  ) : w.dirty ? (
    <span className="cr-worktree-card-verdict cr-worktree-card-verdict--warn">
      <span className="cr-worktree-card-verdict-dot" aria-hidden />
      Uncommitted changes
    </span>
  ) : (
    <span className="cr-worktree-card-verdict">
      <span className="cr-worktree-card-verdict-dot" aria-hidden />
      {untouchedDays >= UNTOUCHED_DAYS
        ? `Untouched for ${untouchedDays >= 28 ? `${Math.floor(untouchedDays / 7)} weeks` : `${untouchedDays} days`}`
        : 'Idle'}
    </span>
  )

  // The one thing you'd do next, styled as the main button.
  // Ready beats a Claude idling at its prompt: that one is only left over.
  const primary: { label: string; run: () => void } | null =
    ready && merged
      ? { label: 'Wrap up', run: () => onWrapUp(pr!.number) }
      : ready
        ? { label: 'Remove', run: onRemove }
        : claude
          ? { label: 'Open session', run: () => onOpenSession(claude.key) }
          : !w.sessionId
            ? { label: 'Start agent', run: onStartAgent }
            : null

  return (
    <div
      className={`cr-worktree-card cr-worktree-card--clickable${ready ? ' cr-worktree-card--ready' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Details for ${sessionTitle ?? branch ?? 'this worktree'}`}
      // The card opens its overlay; the buttons on it do their own thing.
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button')) onOpen()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen()
      }}
    >
      <div className="cr-worktree-card-head">
        <div className="cr-worktree-card-title" title={sessionTitle ?? branch ?? undefined}>
          <bdi>{sessionTitle ?? branch ?? 'Detached worktree'}</bdi>
        </div>
        <div className="cr-worktree-card-branch" title={w.path}>
          <bdi>{branch ?? 'no branch'}</bdi>
        </div>
      </div>

      <div className="cr-worktree-card-session">{verdict}</div>

      {(pr || ticket || (w.dirty && claude)) && (
        <div className="cr-worktree-card-links">
          {pr && (
            <button
              type="button"
              className={`cr-worktree-card-pr cr-worktree-card-pr--${pr.state.toLowerCase()}`}
              title="Open the pull request on GitHub"
              onClick={() => void openExternal(pr.url)}
            >
              <span className="cr-worktree-card-pr-dot" aria-hidden />
              PR #{pr.number} {pr.state.toLowerCase()}
            </button>
          )}
          {ticket &&
            (onOpenTicket ? (
              <button
                type="button"
                className="cr-worktree-card-ticket"
                title={`Open ${ticket} in Tickets`}
                onClick={() => onOpenTicket(ticket)}
              >
                {ticket}
              </button>
            ) : (
              <span className="cr-worktree-card-ticket">{ticket}</span>
            ))}
          {/* Said here only when the status line is about something else. */}
          {w.dirty && claude && <span className="cr-worktree-card-dirty">uncommitted changes</span>}
        </div>
      )}

      <div className="cr-worktree-card-actions">
        {primary && (
          <button type="button" className="cr-worktree-card-primary" onClick={primary.run}>
            {primary.label}
          </button>
        )}
        {/* Busy: removing it would pull the folder out from under Claude. */}
        {!busy && primary?.label !== 'Remove' && (
          <button type="button" onClick={onRemove}>
            Remove
          </button>
        )}
        {ready && claude && (
          <button type="button" onClick={() => onOpenSession(claude.key)}>
            Open session
          </button>
        )}
        {merged && primary?.label !== 'Wrap up' && !busy && (
          <button type="button" onClick={() => onWrapUp(pr!.number)}>
            Wrap up
          </button>
        )}
      </div>
    </div>
  )
}
