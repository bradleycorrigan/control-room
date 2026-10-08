import { GitHubGlyph } from '../screens/backlogGlyphs'
import { useEffect, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import {
  getShipInfo,
  shipPullRequest,
  getSessionHandoffNote,
  pushSessionBranch,
  markPullRequestReady,
  type ShipInfo
} from '../api-sessions'
import {
  getSessionPullRequest,
  getSessionTicketLinks,
  loadJiraBoard,
  addJiraComment,
  moveJiraIssue,
  openExternal,
  type PullRequestInfo,
  type JiraBoardData,
  type JiraIssue
} from '../api'
import { Button, Textarea, Input, SegmentedControl, Icon } from './primitives'
import { useDismissible } from '../keyboard'
import './ship-panel.css'

interface Props {
  session: LiveSession
  branch: string
  ticketKey: string | null
  jiraReady: boolean
  onClose: () => void
  onOpenDiff: () => void
  pushToast?: (message: string) => void
}

type ButtonState = 'idle' | 'busy' | 'done' | 'error'

/**
 * A step's number, which turns into a tick once that step is done. The key
 * swap remounts the badge, so the change plays its short entrance once.
 */
function StepBadge({ n, done }: { n: number; done: boolean }): React.JSX.Element {
  return done ? (
    <span key="done" className="ship-panel-step ship-panel-step--done" role="img" aria-label="Done">
      <Icon name="Check" size={11} strokeWidth={2.25} />
    </span>
  ) : (
    <span key="number" className="ship-panel-step">
      {n}
    </span>
  )
}

/**
 * The Ship flow (plan 7 step 3): review, open the PR, tell Jira, tell
 * Slack — one panel instead of four separate places to remember. Every
 * section only appears once it has something real to do (CLAUDE.md: a
 * control exists only if it works) — no Jira section on an unlinked
 * session, no Slack section without a Slack link on the ticket.
 */
export default function ShipPanel({
  session,
  branch,
  ticketKey: propTicketKey,
  jiraReady,
  onClose,
  onOpenDiff,
  pushToast
}: Props): React.JSX.Element {
  useDismissible(true, 'modal', onClose)
  const recordId = session.record!.id
  const sessionTitle = session.record?.title ?? session.agentName ?? session.cwd

  const [info, setInfo] = useState<ShipInfo | null | undefined>(undefined)
  const [existingPr, setExistingPr] = useState<PullRequestInfo | null | undefined>(undefined)
  const [handoffNote, setHandoffNote] = useState<string | null | undefined>(undefined)
  const [board, setBoard] = useState<JiraBoardData | null>(null)
  // The header's own ticketKey (useTicketKey in SessionDetail) only refetches
  // on recordId/title/branch/ticketRefresh — linking a ticket while the panel
  // is open doesn't touch any of those, so it can go stale under this panel.
  // Fetch the link ourselves on mount, same as HandoffNoteDialog, and prefer
  // it; fall back to the prop for a key found in the title or branch instead
  // of a stored link.
  const [linkedTicketKey, setLinkedTicketKey] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void getSessionTicketLinks().then((links) => {
      if (!cancelled) setLinkedTicketKey(links[recordId] ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [recordId])
  const ticketKey =
    linkedTicketKey !== undefined ? (linkedTicketKey ?? propTicketKey) : propTicketKey

  useEffect(() => {
    let cancelled = false
    void Promise.all([getShipInfo(recordId), getSessionPullRequest(recordId)]).then(
      ([shipInfo, pr]) => {
        if (cancelled) return
        setInfo(shipInfo)
        setExistingPr(pr)
      }
    )
    return () => {
      cancelled = true
    }
  }, [recordId])

  useEffect(() => {
    let cancelled = false
    void getSessionHandoffNote(recordId).then((r) => {
      if (!cancelled) setHandoffNote(r?.note ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [recordId])

  useEffect(() => {
    if (!ticketKey || !jiraReady) return
    let cancelled = false
    void loadJiraBoard().then((r) => {
      if (!cancelled && r.ok) setBoard(r.value)
    })
    return () => {
      cancelled = true
    }
  }, [ticketKey, jiraReady])

  const issue: JiraIssue | null = ticketKey
    ? (board?.issues.find((i) => i.key === ticketKey) ?? null)
    : null

  // Title/body default from whatever's loaded so far, and track only the
  // person's own edit as state — that way the default can still catch up
  // once the ticket summary or hand-off note arrives, but a real edit is
  // never clobbered by data that shows up a moment later.
  const defaultTitle = ticketKey && issue ? `${ticketKey}: ${issue.summary}` : sessionTitle
  const defaultBody = [handoffNote ?? '', ticketKey && issue ? `Jira: ${issue.url}` : '']
    .filter(Boolean)
    .join('\n\n')
  const [titleOverride, setTitleOverride] = useState<string | null>(null)
  const [bodyOverride, setBodyOverride] = useState<string | null>(null)
  const title = titleOverride ?? defaultTitle
  const body = bodyOverride ?? defaultBody

  const [draft, setDraft] = useState(false)
  const [shipping, setShipping] = useState(false)
  const [shipError, setShipError] = useState<string | null>(null)

  const handleShip = async (): Promise<void> => {
    setShipping(true)
    setShipError(null)
    const result = await shipPullRequest(recordId, title, body, draft)
    setShipping(false)
    if (!result.ok || !result.pr) {
      // GitHub already has one for this branch: show that one, and what you
      // can do with it, rather than an error.
      if (/already exists/i.test(result.error ?? '')) {
        const found = await getSessionPullRequest(recordId)
        if (found) {
          setExistingPr(found)
          pushToast?.('This branch already has a pull request.')
          return
        }
      }
      setShipError(result.error ?? 'Could not open the pull request.')
      return
    }
    setExistingPr(result.pr)
    pushToast?.('Pull request opened.')
  }

  // With a pull request already open: push new commits to it, take it out
  // of draft.
  const [prAction, setPrAction] = useState<'push' | 'ready' | null>(null)
  const [prActionError, setPrActionError] = useState<string | null>(null)
  const pushToPr = async (): Promise<void> => {
    setPrAction('push')
    setPrActionError(null)
    const result = await pushSessionBranch(recordId)
    setPrAction(null)
    if (!result.ok) return setPrActionError(result.error ?? 'Could not push.')
    setInfo((cur) => (cur ? { ...cur, unpushed: 0 } : cur))
    pushToast?.('Pushed to the pull request.')
  }
  const markReady = async (): Promise<void> => {
    if (!existingPr) return
    setPrAction('ready')
    setPrActionError(null)
    const result = await markPullRequestReady(recordId, existingPr.number)
    setPrAction(null)
    if (!result.ok) return setPrActionError(result.error ?? 'Could not mark it ready.')
    setExistingPr({ ...existingPr, isDraft: false })
    pushToast?.('Marked ready for review.')
  }

  const projectKey = ticketKey?.split('-')[0] ?? null
  const reviewStatus =
    projectKey && board
      ? (board.projectStatuses[projectKey]?.find((s) => /review/i.test(s)) ?? null)
      : null

  const [commentState, setCommentState] = useState<ButtonState>('idle')
  const [commentError, setCommentError] = useState<string | null>(null)
  const handleComment = async (): Promise<void> => {
    if (!ticketKey || !existingPr) return
    setCommentState('busy')
    // An internal note: the team sees it, a service desk's requester doesn't.
    const result = await addJiraComment(ticketKey, `PR ready for review: ${existingPr.url}`, true)
    if (result.ok) setCommentState('done')
    else {
      setCommentState('error')
      setCommentError(result.error)
    }
  }

  const [moveState, setMoveState] = useState<ButtonState>('idle')
  const [moveError, setMoveError] = useState<string | null>(null)
  const handleMove = async (): Promise<void> => {
    if (!ticketKey || !reviewStatus) return
    setMoveState('busy')
    const result = await moveJiraIssue(ticketKey, reviewStatus)
    if (result.ok) setMoveState('done')
    else {
      setMoveState('error')
      setMoveError(result.error)
    }
  }

  const slackLink =
    issue?.links.find((l) => /slack/i.test(l.title) || /slack\.com/i.test(l.url)) ?? null

  const [copied, setCopied] = useState(false)
  const handleCopyMessage = async (): Promise<void> => {
    if (!existingPr) return
    try {
      // The way review requests go out in Slack: the PR's title, then its
      // changes link on the next line.
      await navigator.clipboard.writeText(
        `:github: ${existingPr.title}\n:pr-arrow: ${existingPr.url}/changes`
      )
      setCopied(true)
      pushToast?.('Message copied.')
    } catch {
      pushToast?.('Could not copy - try selecting the text by hand.')
    }
  }

  const commits = info?.git?.commits ?? []
  const loadingReview = info === undefined
  // Only an OPEN pull request means "already exists" — a CLOSED or MERGED one
  // for this branch shouldn't hide the create form or block a new one.
  const openPr = existingPr && existingPr.state === 'OPEN' ? existingPr : null
  const prStateLabel: Record<string, string> = { CLOSED: 'Closed', MERGED: 'Merged' }

  // When each step counts as done, from the state the panel already has.
  const [diffOpened, setDiffOpened] = useState(false)
  const reviewDone = commits.length > 0 && (info?.unpushed === 0 || diffOpened)
  const prDone =
    Boolean(existingPr && (existingPr.state === 'OPEN' || existingPr.state === 'MERGED')) &&
    info?.unpushed === 0
  const showJira = Boolean(ticketKey && jiraReady)
  const jiraDone = commentState === 'done' || moveState === 'done'
  const showSlack = Boolean(slackLink)
  const slackDone = copied
  const allDone = reviewDone && prDone && (!showJira || jiraDone) && (!showSlack || slackDone)
  // Once every step shown is done, the panel says so until it closes, even
  // if something later (a new commit) would undo a step.
  const [shipped, setShipped] = useState(false)
  if (allDone && !shipped) setShipped(true)

  return (
    <div className="ship-panel-backdrop" onClick={onClose}>
      <div
        className="ship-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Ship"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ship-panel-header">
          {shipped ? (
            <div key="shipped" className="ship-panel-title ship-panel-title--shipped">
              <Icon name="Check" size={20} className="ship-panel-shipped-icon" />
              <h2>Shipped</h2>
            </div>
          ) : (
            <div key="ship" className="ship-panel-title">
              <Icon name="Rocket" size={20} />
              <h2>Ship</h2>
            </div>
          )}
          <Button variant="ghost" size="compact" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="ship-panel-body">
          {/* 1. Review */}
          <section className="ship-panel-section">
            <h3 className="ship-panel-section-title">
              <StepBadge n={1} done={reviewDone} />
              Review
            </h3>
            {loadingReview ? (
              <p className="ship-panel-muted">Loading commits…</p>
            ) : (
              <>
                <div className="ship-panel-commits">
                  {commits.length === 0 ? (
                    <p className="ship-panel-muted">
                      {session.record?.detached
                        ? `No commits yet. This session started from ${branch} and isn't on a branch of its own yet.`
                        : `No commits yet on ${branch}.`}
                    </p>
                  ) : (
                    commits.map((c) => (
                      <div key={c.sha} className="ship-panel-commit">
                        <span className="ship-panel-commit-sha">{c.sha}</span>
                        <span className="ship-panel-commit-subject">{c.subject}</span>
                      </div>
                    ))
                  )}
                </div>
                <div className="ship-panel-inline">
                  <Button
                    variant="outlined"
                    size="compact"
                    onClick={() => {
                      setDiffOpened(true)
                      onOpenDiff()
                    }}
                  >
                    View diff
                  </Button>
                  {info?.git && info.git.filesChanged > 0 && (
                    <p className="ship-panel-diffstat">
                      {info.git.filesChanged} file{info.git.filesChanged === 1 ? '' : 's'} changed,{' '}
                      <span className="ship-panel-add">+{info.git.added}</span>{' '}
                      <span className="ship-panel-remove">−{info.git.removed}</span>
                    </p>
                  )}
                </div>
              </>
            )}
          </section>

          {/* 2. Pull request */}
          <section className="ship-panel-section">
            <h3 className="ship-panel-section-title">
              <StepBadge n={2} done={prDone} />
              Pull request
            </h3>
            {existingPr === undefined ? (
              <p className="ship-panel-muted">Checking for an existing pull request…</p>
            ) : (
              <>
                {existingPr && (
                  <div className="ship-panel-pr-existing">
                    <a
                      href={existingPr.url}
                      onClick={(e) => {
                        e.preventDefault()
                        void openExternal(existingPr.url)
                      }}
                    >
                      <span className="ship-panel-pr-number">#{existingPr.number}</span>
                      {existingPr.title}
                    </a>
                    <span className="ship-panel-pr-state">
                      {existingPr.isDraft
                        ? 'Draft'
                        : existingPr.state === 'OPEN'
                          ? 'Open'
                          : (prStateLabel[existingPr.state] ?? existingPr.state)}
                    </span>
                  </div>
                )}
                {openPr && (
                  <div className="ship-panel-pr-actions">
                    {(info?.unpushed ?? 0) > 0 && (
                      <Button
                        size="compact"
                        onClick={() => void pushToPr()}
                        disabled={prAction !== null}
                      >
                        {prAction === 'push'
                          ? 'Pushing…'
                          : `Push ${info!.unpushed} new commit${info!.unpushed === 1 ? '' : 's'}`}
                      </Button>
                    )}
                    {openPr.isDraft && (
                      <Button
                        variant="outlined"
                        size="compact"
                        onClick={() => void markReady()}
                        disabled={prAction !== null}
                      >
                        {prAction === 'ready' ? 'Marking ready…' : 'Mark ready for review'}
                      </Button>
                    )}
                    <Button
                      variant="outlined"
                      size="compact"
                      onClick={() => void openExternal(openPr.url)}
                    >
                      <GitHubGlyph size={13} />
                      Open in GitHub
                    </Button>
                    {info?.unpushed === 0 && !openPr.isDraft && (
                      <span className="ship-panel-muted">Up to date with your latest commit.</span>
                    )}
                    {prActionError && <p className="ship-panel-error">{prActionError}</p>}
                  </div>
                )}
                {!openPr && (
                  <div className="ship-panel-pr-form">
                    <label className="ship-panel-field">
                      <span>Title</span>
                      <Input value={title} onChange={(e) => setTitleOverride(e.target.value)} />
                    </label>
                    <label className="ship-panel-field">
                      <span>Description</span>
                      <Textarea
                        value={body}
                        onChange={(e) => setBodyOverride(e.target.value)}
                        rows={8}
                      />
                    </label>
                    <div className="ship-panel-pr-row">
                      <SegmentedControl
                        aria-label="Draft or ready for review"
                        value={draft ? 'draft' : 'ready'}
                        onChange={(v) => setDraft(v === 'draft')}
                        options={[
                          { value: 'ready', label: 'Ready for review' },
                          { value: 'draft', label: 'Draft' }
                        ]}
                      />
                      <Button
                        onClick={() => void handleShip()}
                        disabled={shipping || !title.trim()}
                      >
                        {shipping ? 'Pushing…' : 'Push and open PR'}
                      </Button>
                    </div>
                    {shipError && <p className="ship-panel-error">{shipError}</p>}
                  </div>
                )}
              </>
            )}
          </section>

          {/* 3. Jira */}
          {showJira && (
            <section className="ship-panel-section">
              <h3 className="ship-panel-section-title">
                <StepBadge n={3} done={jiraDone} />
                Jira
              </h3>
              <div className="ship-panel-jira-row">
                <Button
                  variant="outlined"
                  size="compact"
                  disabled={!existingPr || commentState === 'busy' || commentState === 'done'}
                  title={
                    !existingPr ? 'Open the pull request to add its link as a note.' : undefined
                  }
                  onClick={() => void handleComment()}
                >
                  {commentState === 'busy'
                    ? 'Adding note…'
                    : commentState === 'done'
                      ? 'Note added'
                      : 'Add internal note with the PR link'}
                </Button>
                {reviewStatus && (
                  <Button
                    variant="outlined"
                    size="compact"
                    disabled={moveState === 'busy' || moveState === 'done'}
                    onClick={() => void handleMove()}
                  >
                    {moveState === 'busy'
                      ? 'Moving…'
                      : moveState === 'done'
                        ? `Moved to ${reviewStatus}`
                        : `Move to ${reviewStatus}`}
                  </Button>
                )}
              </div>
              {commentState === 'error' && <p className="ship-panel-error">{commentError}</p>}
              {moveState === 'error' && <p className="ship-panel-error">{moveError}</p>}
            </section>
          )}

          {/* 4. Slack */}
          {slackLink && (
            <section className="ship-panel-section">
              <h3 className="ship-panel-section-title">
                <StepBadge n={4} done={slackDone} />
                Slack
              </h3>
              <div className="ship-panel-jira-row">
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={() => void openExternal(slackLink.url)}
                >
                  Open Slack thread
                </Button>
                <Button
                  variant="outlined"
                  size="compact"
                  disabled={!existingPr}
                  onClick={() => void handleCopyMessage()}
                >
                  Copy message
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
