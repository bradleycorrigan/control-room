import { useEffect, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import { Badge, Button, Modal } from './primitives'
import { copyText, openExternal, type ProjectWorktree, type WorktreePullRequest } from '../api'
import {
  getWorktreeDetail,
  openWorktreeInIde,
  revealWorktree,
  type WorktreeDetail
} from '../api-projects'
import { relativeTime } from '../lib/format-time'
import './worktree-overlay.css'

/**
 * One worktree, opened from its card: what's attached to it (session, pull
 * request, ticket), what's in it (commits since the base, uncommitted files,
 * push state), and everything you can do with it.
 */
export default function WorktreeOverlay({
  projectId,
  worktree,
  displayPath,
  branch,
  liveSession,
  sessionTitle,
  pr,
  ticket,
  onOpenSession,
  onStartAgent,
  onRemove,
  onOpenTicket,
  pushToast,
  onClose
}: {
  projectId: string
  worktree: ProjectWorktree
  displayPath: string
  branch: string | null
  liveSession?: LiveSession
  /** A session that ran here but isn't open now: ended, or marked done. */
  sessionTitle?: string
  pr?: WorktreePullRequest
  ticket: string | null
  onOpenSession?: () => void
  /** Only when no session owns this worktree. */
  onStartAgent?: () => void
  /** Only when nothing is running in it. */
  onRemove?: () => void
  onOpenTicket?: (key: string) => void
  pushToast: (message: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<WorktreeDetail | null | 'loading'>('loading')

  useEffect(() => {
    let live = true
    void getWorktreeDetail(projectId, worktree.path).then((d) => {
      if (live) setDetail(d)
    })
    return () => {
      live = false
    }
  }, [projectId, worktree.path])

  const loaded = detail !== 'loading' ? detail : null
  const commits = loaded?.git?.commits ?? []

  return (
    <Modal title={branch ?? 'No branch'} icon="GitBranch" width={720} onClose={onClose}>
      <div className="wt-overlay">
        <div className="wt-overlay-path">
          <bdi title={worktree.path}>{displayPath}</bdi>
        </div>
        <div className="wt-overlay-tools">
          <Button
            variant="outlined"
            size="compact"
            onClick={() =>
              void openWorktreeInIde(projectId, worktree.path).then((r) => {
                if (!r.ok) pushToast(r.error ?? 'Could not open it in Cursor.')
              })
            }
          >
            Open in Cursor
          </Button>
          <Button
            variant="outlined"
            size="compact"
            onClick={() =>
              void revealWorktree(projectId, worktree.path).then((err) => {
                if (err) pushToast(err)
              })
            }
          >
            Show in Finder
          </Button>
          <Button
            variant="ghost"
            size="compact"
            onClick={() => void copyText(worktree.path).then(() => pushToast('Path copied.'))}
          >
            Copy path
          </Button>
        </div>

        <section className="wt-overlay-section">
          <h4>Session</h4>
          <div className="wt-overlay-line">
            {liveSession ? (
              <>
                <Badge status={liveSession.status} variant="bare" />
                <span className="wt-overlay-strong">{liveSession.record?.title}</span>
              </>
            ) : sessionTitle ? (
              <span className="wt-overlay-muted">
                Not running: <span className="wt-overlay-strong">{sessionTitle}</span>
              </span>
            ) : (
              <span className="wt-overlay-muted">No session in this worktree.</span>
            )}
            <span className="wt-overlay-spacer" />
            {onOpenSession && (
              <Button variant="outlined" size="compact" onClick={onOpenSession}>
                Open session
              </Button>
            )}
            {onStartAgent && (
              <Button variant="outlined" size="compact" onClick={onStartAgent}>
                Start agent
              </Button>
            )}
          </div>
          {liveSession?.record?.lastPrompt && (
            <p className="wt-overlay-prompt">{liveSession.record.lastPrompt}</p>
          )}
        </section>

        <section className="wt-overlay-section wt-overlay-links">
          <div>
            <h4>Pull request</h4>
            {pr ? (
              <button
                type="button"
                className={`wt-overlay-chip wt-overlay-chip--${pr.state.toLowerCase()}`}
                title="Open the pull request on GitHub"
                onClick={() => void openExternal(pr.url)}
              >
                <span className="wt-overlay-chip-dot" aria-hidden />
                PR #{pr.number} {pr.state.toLowerCase()}
              </button>
            ) : (
              <span className="wt-overlay-muted">None for this branch</span>
            )}
          </div>
          <div>
            <h4>Ticket</h4>
            {ticket ? (
              onOpenTicket ? (
                <button
                  type="button"
                  className="wt-overlay-chip wt-overlay-chip--mono"
                  title={`Open ${ticket} in Tickets`}
                  onClick={() => onOpenTicket(ticket)}
                >
                  {ticket}
                </button>
              ) : (
                <span className="wt-overlay-chip wt-overlay-chip--mono">{ticket}</span>
              )
            ) : (
              <span className="wt-overlay-muted">None linked</span>
            )}
          </div>
        </section>

        <section className="wt-overlay-section">
          <h4>Branch</h4>
          {detail === 'loading' ? (
            <span className="wt-overlay-muted">Reading git…</span>
          ) : !loaded ? (
            <span className="wt-overlay-muted">Git couldn&apos;t read this worktree.</span>
          ) : (
            <>
              <p className="wt-overlay-summary">
                {loaded.git
                  ? `${commits.length}${loaded.git.commitsCapped ? '+' : ''} commit${commits.length === 1 ? '' : 's'} since ${loaded.baseRef}, ${loaded.git.filesChanged} file${loaded.git.filesChanged === 1 ? '' : 's'} changed`
                  : `No history shared with ${loaded.baseRef}`}
                {loaded.git && (loaded.git.added > 0 || loaded.git.removed > 0) && (
                  <>
                    {' '}
                    <span className="wt-overlay-added">+{loaded.git.added}</span>{' '}
                    <span className="wt-overlay-removed">−{loaded.git.removed}</span>
                  </>
                )}
              </p>
              <p className="wt-overlay-muted">
                {loaded.upstream
                  ? loaded.ahead > 0
                    ? `${loaded.ahead} commit${loaded.ahead === 1 ? '' : 's'} not pushed to ${loaded.upstream}`
                    : `Pushed to ${loaded.upstream}`
                  : 'Never pushed'}
                {loaded.behind > 0 ? `, ${loaded.behind} behind it` : ''}
                {loaded.lastCommitAt ? `. Last commit ${relativeTime(loaded.lastCommitAt)}.` : '.'}
              </p>
              {commits.length > 0 && (
                <ul className="wt-overlay-commits">
                  {commits.slice(0, 8).map((c) => (
                    <li key={c.sha}>
                      <span className="wt-overlay-sha">{c.sha.slice(0, 7)}</span>
                      <span className="wt-overlay-subject">{c.subject}</span>
                    </li>
                  ))}
                  {commits.length > 8 && (
                    <li className="wt-overlay-muted">and {commits.length - 8} more</li>
                  )}
                </ul>
              )}
            </>
          )}
        </section>

        {loaded && (
          <section className="wt-overlay-section">
            <h4>Uncommitted changes</h4>
            {loaded.changeCount === 0 ? (
              <span className="wt-overlay-muted">None: everything is committed.</span>
            ) : (
              <ul className="wt-overlay-files">
                {loaded.changes.map((f) => (
                  <li key={f.path}>
                    <span className="wt-overlay-code">{changeWord(f.code)}</span>
                    <span className="wt-overlay-file">{f.path}</span>
                  </li>
                ))}
                {loaded.changeCount > loaded.changes.length && (
                  <li className="wt-overlay-muted">
                    and {loaded.changeCount - loaded.changes.length} more
                  </li>
                )}
              </ul>
            )}
          </section>
        )}

        {onRemove && (
          <div className="wt-overlay-footer">
            <Button variant="outlined" size="compact" onClick={onRemove}>
              Remove worktree
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** git's status letters as words: "??" means nothing to most people. */
function changeWord(code: string): string {
  if (code.includes('?')) return 'new'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('A')) return 'added'
  if (code.includes('U')) return 'conflict'
  return 'modified'
}
