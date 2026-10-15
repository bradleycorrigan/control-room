import { useEffect, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import { Badge, Button, IconButton, Modal } from './primitives'
import { copyText, openExternal, type ProjectWorktree, type WorktreePullRequest } from '../api'
import {
  getWorktreeDetail,
  openWorktreeInIde,
  revealWorktree,
  type WorktreeDetail
} from '../api-projects'
import { relativeTime } from '../lib/format-time'
import '../screens/backlog.css'
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
  onWrapUp,
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
  /** Only when the branch's pull request is merged. */
  onWrapUp?: () => void
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

  const pushState = !loaded
    ? null
    : loaded.upstream
      ? loaded.ahead > 0
        ? `${loaded.ahead} not pushed`
        : 'Pushed'
      : 'Never pushed'
  const prompt = liveSession?.record?.lastPrompt ? cleanPrompt(liveSession.record.lastPrompt) : null
  const pending = detail === 'loading'

  return (
    <Modal title={branch ?? 'No branch'} icon="GitBranch" width={720} onClose={onClose}>
      <div className="wt-overlay">
        <div className="wt-overlay-pathrow">
          <div className="wt-overlay-path">
            <bdi title={worktree.path}>{displayPath}</bdi>
          </div>
          <IconButton
            icon="Code"
            label="Open in Cursor"
            size={28}
            variant="ghost"
            onClick={() =>
              void openWorktreeInIde(projectId, worktree.path).then((r) => {
                if (!r.ok) pushToast(r.error ?? 'Could not open it in Cursor.')
              })
            }
          />
          <IconButton
            icon="FolderOpen"
            label="Show in Finder"
            size={28}
            variant="ghost"
            onClick={() =>
              void revealWorktree(projectId, worktree.path).then((err) => {
                if (err) pushToast(err)
              })
            }
          />
          <IconButton
            icon="Copy"
            label="Copy path"
            size={28}
            variant="ghost"
            onClick={() => void copyText(worktree.path).then(() => pushToast('Path copied.'))}
          />
        </div>

        {/* The ticket panel's ruled grid, label over value. */}
        <div className="backlog-props">
          <div className="backlog-prop backlog-prop--wide">
            <span className="backlog-prop-label">Session</span>
            <div className="backlog-prop-value">
              {liveSession ? (
                <>
                  <Badge status={liveSession.status} variant="bare" />
                  <span className="backlog-prop-text">{liveSession.record?.title}</span>
                </>
              ) : sessionTitle ? (
                <span className="backlog-prop-text wt-overlay-muted">
                  Not running: {sessionTitle}
                </span>
              ) : (
                <span className="wt-overlay-muted">None</span>
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
          </div>
          <div className="backlog-prop backlog-prop--third">
            <span className="backlog-prop-label">Pull request</span>
            <div className="backlog-prop-value">
              {pr ? (
                <button
                  type="button"
                  className={`wt-overlay-chip wt-overlay-chip--${pr.state.toLowerCase()}`}
                  title="Open the pull request on GitHub"
                  onClick={() => void openExternal(pr.url)}
                >
                  <span className="wt-overlay-chip-dot" aria-hidden />#{pr.number}{' '}
                  {pr.state.toLowerCase()}
                </button>
              ) : (
                <span className="wt-overlay-muted">None</span>
              )}
            </div>
          </div>
          <div className="backlog-prop backlog-prop--third">
            <span className="backlog-prop-label">Ticket</span>
            <div className="backlog-prop-value">
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
                <span className="wt-overlay-muted">None</span>
              )}
            </div>
          </div>
          <div className="backlog-prop backlog-prop--third">
            <span className="backlog-prop-label">Pushed</span>
            <div className="backlog-prop-value" title={loaded?.upstream ?? undefined}>
              {pending ? <span className="wt-overlay-muted">…</span> : (pushState ?? '-')}
              {loaded && loaded.behind > 0 && (
                <span className="wt-overlay-muted">{loaded.behind} behind</span>
              )}
            </div>
          </div>
          <div className="backlog-prop backlog-prop--third">
            <span className="backlog-prop-label">Since {loaded?.baseRef ?? 'the base'}</span>
            <div className="backlog-prop-value">
              {pending ? (
                <span className="wt-overlay-muted">…</span>
              ) : loaded?.git ? (
                `${commits.length}${loaded.git.commitsCapped ? '+' : ''} commit${commits.length === 1 ? '' : 's'}`
              ) : (
                <span className="wt-overlay-muted">No shared history</span>
              )}
            </div>
          </div>
          <div className="backlog-prop backlog-prop--third">
            <span className="backlog-prop-label">Changed</span>
            <div className="backlog-prop-value">
              {pending ? (
                <span className="wt-overlay-muted">…</span>
              ) : loaded?.git ? (
                <>
                  {loaded.git.filesChanged} file{loaded.git.filesChanged === 1 ? '' : 's'}
                  <span className="wt-overlay-added">+{loaded.git.added}</span>
                  <span className="wt-overlay-removed">−{loaded.git.removed}</span>
                </>
              ) : (
                <span className="wt-overlay-muted">-</span>
              )}
            </div>
          </div>
          <div className="backlog-prop backlog-prop--third">
            <span className="backlog-prop-label">Last commit</span>
            <div className="backlog-prop-value">
              {pending ? (
                <span className="wt-overlay-muted">…</span>
              ) : loaded?.lastCommitAt ? (
                relativeTime(loaded.lastCommitAt)
              ) : (
                <span className="wt-overlay-muted">-</span>
              )}
            </div>
          </div>
        </div>

        {prompt && (
          <section className="wt-overlay-section">
            <h4>Last prompt</h4>
            <p className="wt-overlay-prompt">{prompt}</p>
          </section>
        )}

        {commits.length > 0 && (
          <section className="wt-overlay-section">
            <h4>Commits</h4>
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
          </section>
        )}

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

        {(onRemove || onWrapUp) && (
          <div className="wt-overlay-footer">
            {onWrapUp && (
              <Button variant="outlined" size="compact" onClick={onWrapUp}>
                Wrap up
              </Button>
            )}
            {onRemove && (
              <Button variant="outlined" size="compact" onClick={onRemove}>
                Remove worktree
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * What you asked, without the app's own boilerplate: a prompt with files
 * attached carries a paragraph of instructions about reading them.
 */
function cleanPrompt(text: string): string {
  return text.replace(/\s*Attached files - read these[\s\S]*$/, '').trim()
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
