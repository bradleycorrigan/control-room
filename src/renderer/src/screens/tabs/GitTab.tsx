import { useCallback, useEffect, useRef, useState } from 'react'
import {
  commitFiles,
  getGitLog,
  getGitStatus,
  stageFiles,
  type GitLogCommit,
  type GitStatusFile,
  type GitStatusResult
} from '../../api'
import { Icon, Input, Popover } from '../../components/primitives'
import './GitTab.css'

/** One checkout this tab can be pointed at, beyond the project's own. */
export interface GitWorktreeChoice {
  id: string
  title: string
  branch: string
}

interface Props {
  projectId: string
  /** Fixes the tab to one checkout and hides the picker. */
  sessionId?: string
  /** Offered in the picker alongside the project's main checkout. */
  worktrees?: GitWorktreeChoice[]
}

const LOG_PAGE_SIZE = 30

function relativeTime(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

// Single-letter git status codes -> a short human word. Status is always a
// word, never colour alone (CLAUDE.md non-negotiable).
function describeStatus(file: GitStatusFile): string {
  const code = file.staged ? file.index : file.worktree
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'conflict'
    case '?':
      return 'untracked'
    default:
      return code ? code.toLowerCase() : 'changed'
  }
}

export default function GitTab({
  projectId,
  sessionId: fixedSessionId,
  worktrees = []
}: Props): React.JSX.Element {
  // Which checkout this tab is looking at. The IPC layer has taken an optional
  // sessionId since it was written, and ProjectDetail simply never passed one —
  // so the tab always showed the project's main checkout, which is the one
  // place work is least likely to be. A tab called Git that can only ever show
  // you main is not much of a Git tab.
  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null)
  const sessionId = fixedSessionId ?? pickedSessionId ?? undefined
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const pickerAnchor = useRef<HTMLDivElement>(null)
  const picked = worktrees.find((w) => w.id === sessionId) ?? null
  // Matches on either half, because you might remember the branch or the
  // session's name and there is no reason to make you guess which.
  const query = pickerQuery.trim().toLowerCase()
  const matches = query
    ? worktrees.filter(
        (w) => w.title.toLowerCase().includes(query) || w.branch.toLowerCase().includes(query)
      )
    : worktrees

  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const [commits, setCommits] = useState<GitLogCommit[]>([])
  const [logHasMore, setLogHasMore] = useState(false)
  const [logLoading, setLogLoading] = useState(true)
  const [logError, setLogError] = useState<string | null>(null)

  const [stageError, setStageError] = useState<string | null>(null)

  // Note: these don't flip the loading/error flags to true/null before the
  // first await — doing that synchronously from the mount effect below trips
  // react-hooks/set-state-in-effect. Initial state already covers "loading".
  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const result = await getGitStatus(projectId, sessionId)
      if (result === null) {
        setStatusError('Could not read git status for this project.')
        setStatus(null)
      } else {
        setStatus(result)
        setStatusError(null)
      }
    } catch {
      setStatusError('Could not read git status for this project.')
      setStatus(null)
    } finally {
      setStatusLoading(false)
    }
  }, [projectId, sessionId])

  const loadLog = useCallback(
    async (skip: number, append: boolean): Promise<void> => {
      try {
        const result = await getGitLog(projectId, { skip, limit: LOG_PAGE_SIZE }, sessionId)
        setCommits((prev) => (append ? [...prev, ...result.commits] : result.commits))
        setLogHasMore(result.hasMore)
        setLogError(null)
      } catch {
        setLogError('Could not load the commit log.')
      } finally {
        setLogLoading(false)
      }
    },
    [projectId, sessionId]
  )

  // Mounts the two initial fetches directly (rather than via loadStatus /
  // loadLog above) so setState only ever happens inside a promise callback,
  // never synchronously reachable from the effect body itself
  // (react-hooks/set-state-in-effect). loadStatus/loadLog are still reused
  // by the stage/commit/load-more handlers below, which are event handlers,
  // not effects.
  useEffect(() => {
    let cancelled = false

    getGitStatus(projectId, sessionId)
      .then((result) => {
        if (cancelled) return
        if (result === null) {
          setStatusError('Could not read git status for this project.')
          setStatus(null)
        } else {
          setStatus(result)
          setStatusError(null)
        }
      })
      .catch(() => {
        if (cancelled) return
        setStatusError('Could not read git status for this project.')
        setStatus(null)
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })

    getGitLog(projectId, { limit: LOG_PAGE_SIZE }, sessionId)
      .then((result) => {
        if (cancelled) return
        setCommits(result.commits)
        setLogHasMore(result.hasMore)
        setLogError(null)
      })
      .catch(() => {
        if (cancelled) return
        setLogError('Could not load the commit log.')
      })
      .finally(() => {
        if (!cancelled) setLogLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, sessionId])

  const files = status?.files ?? []
  const stagedFiles = files.filter((f) => f.staged)
  const unstagedFiles = files.filter((f) => !f.staged)

  const setPathBusy = (path: string, busy: boolean): void => {
    setBusyPaths((prev) => {
      const next = new Set(prev)
      if (busy) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const toggleFile = async (path: string, stage: boolean): Promise<void> => {
    setPathBusy(path, true)
    setStageError(null)
    try {
      const ok = await stageFiles(projectId, [path], stage, sessionId)
      if (!ok) {
        setStageError(`Failed to ${stage ? 'stage' : 'unstage'} file.`)
        return
      }
      await loadStatus()
    } finally {
      setPathBusy(path, false)
    }
  }

  const bulkStage = async (stage: boolean): Promise<void> => {
    const targets = (stage ? unstagedFiles : stagedFiles).map((f) => f.path)
    if (targets.length === 0) return
    setBulkBusy(true)
    setStageError(null)
    try {
      const ok = await stageFiles(projectId, targets, stage, sessionId)
      if (!ok) {
        setStageError(`Failed to ${stage ? 'stage' : 'unstage'} files.`)
        return
      }
      await loadStatus()
    } finally {
      setBulkBusy(false)
    }
  }

  const handleCommit = async (): Promise<void> => {
    if (stagedFiles.length === 0 || message.trim().length === 0) return
    setCommitting(true)
    setCommitError(null)
    try {
      const result = await commitFiles(projectId, message.trim(), sessionId)
      if (result.ok) {
        setMessage('')
        await loadStatus()
        setLogLoading(true)
        await loadLog(0, false)
      } else {
        setCommitError(result.error ?? 'Commit failed.')
      }
    } catch {
      setCommitError('Commit failed.')
    } finally {
      setCommitting(false)
    }
  }

  const handleLoadMore = (): void => {
    setLogLoading(true)
    loadLog(commits.length, true)
  }

  const commitDisabled = committing || stagedFiles.length === 0 || message.trim().length === 0

  return (
    <div className="git-tab">
      <section className="git-tab-status">
        <div className="git-tab-branch-row" ref={pickerAnchor}>
          {worktrees.length > 0 && !fixedSessionId && (
            <>
              <button
                type="button"
                className="git-tab-checkout-picker"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                onClick={() => {
                  setPickerQuery('')
                  setPickerOpen((v) => !v)
                }}
              >
                <Icon name="GitBranch" size={14} />
                {picked ? picked.title : 'Project checkout'}
                <Icon name="ChevronDown" size={14} />
              </button>
              <Popover
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                anchorRef={pickerAnchor}
                placement="bottom-start"
                className="git-tab-checkout-menu"
                aria-label="Which checkout to show"
              >
                {/* A project with thirty sessions makes this list unusable
                    without one. Only offered once there is enough here to be
                    worth searching. */}
                {worktrees.length > 6 && (
                  <Input
                    className="git-tab-checkout-search"
                    placeholder="Search branches and sessions"
                    aria-label="Search checkouts"
                    value={pickerQuery}
                    onChange={(e) => setPickerQuery(e.target.value)}
                    autoFocus
                  />
                )}
                {!query && (
                  <button
                    type="button"
                    className="cr-popover-item"
                    onClick={() => {
                      setPickedSessionId(null)
                      setPickerOpen(false)
                    }}
                  >
                    <Icon name="Folder" size={14} />
                    Project checkout
                  </button>
                )}
                {matches.length === 0 && (
                  <div className="cr-popover-empty">Nothing matches “{pickerQuery}”.</div>
                )}
                {matches.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    className="cr-popover-item"
                    onClick={() => {
                      setPickedSessionId(w.id)
                      setPickerOpen(false)
                    }}
                  >
                    <Icon name="GitBranch" size={14} />
                    <span className="git-tab-checkout-name">{w.title}</span>
                    <span className="git-tab-checkout-branch">{w.branch}</span>
                  </button>
                ))}
              </Popover>
            </>
          )}
          {statusLoading && <span className="git-tab-muted">Loading status…</span>}
          {!statusLoading && status && (
            <>
              <span className="git-tab-branch">{status.branch ?? 'detached HEAD'}</span>
              {status.upstream && (
                <span className="git-tab-ahead-behind">
                  {status.ahead > 0 && <span>↑{status.ahead}</span>}
                  {status.behind > 0 && <span>↓{status.behind}</span>}
                  {status.ahead === 0 && status.behind === 0 && <span>up to date</span>}
                </span>
              )}
            </>
          )}
          {!statusLoading && !status && (
            <span className="git-tab-error">{statusError ?? 'Status unavailable.'}</span>
          )}
        </div>

        {stageError && <div className="git-tab-error">{stageError}</div>}

        {status && (
          <div className="git-tab-file-list">
            <div className="git-tab-file-group">
              <div className="git-tab-file-group-header">
                <span>Staged ({stagedFiles.length})</span>
                <button
                  type="button"
                  disabled={stagedFiles.length === 0 || bulkBusy}
                  onClick={() => bulkStage(false)}
                >
                  Unstage all
                </button>
              </div>
              {stagedFiles.length === 0 && <div className="git-tab-empty">No staged files.</div>}
              {stagedFiles.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  busy={busyPaths.has(file.path)}
                  onToggle={() => toggleFile(file.path, false)}
                  actionLabel="Unstage"
                />
              ))}
            </div>

            <div className="git-tab-file-group">
              <div className="git-tab-file-group-header">
                <span>Unstaged ({unstagedFiles.length})</span>
                <button
                  type="button"
                  disabled={unstagedFiles.length === 0 || bulkBusy}
                  onClick={() => bulkStage(true)}
                >
                  Stage all
                </button>
              </div>
              {unstagedFiles.length === 0 && (
                <div className="git-tab-empty">No unstaged files.</div>
              )}
              {unstagedFiles.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  busy={busyPaths.has(file.path)}
                  onToggle={() => toggleFile(file.path, true)}
                  actionLabel="Stage"
                />
              ))}
            </div>
          </div>
        )}

        <div className="git-tab-commit">
          <textarea
            className="git-tab-commit-message"
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
          />
          <div className="git-tab-commit-row">
            <button type="button" disabled={commitDisabled} onClick={handleCommit}>
              {committing
                ? 'Committing…'
                : `Commit${stagedFiles.length > 0 ? ` (${stagedFiles.length})` : ''}`}
            </button>
            {commitError && <span className="git-tab-error">{commitError}</span>}
          </div>
        </div>
      </section>

      <section className="git-tab-log">
        <h3 className="git-tab-log-heading">Commit log</h3>
        {logError && <div className="git-tab-error">{logError}</div>}
        {commits.length === 0 && !logLoading && !logError && (
          <div className="git-tab-empty">No commits yet.</div>
        )}
        <ul className="git-tab-commit-list">
          {commits.map((commit) => (
            <li key={commit.sha} className="git-tab-commit-row-item">
              <span className="git-tab-commit-sha">{commit.sha.slice(0, 7)}</span>
              <span className="git-tab-commit-subject">{commit.subject}</span>
              <span className="git-tab-commit-author">{commit.authorName}</span>
              <span className="git-tab-commit-date">{relativeTime(commit.authoredAt)}</span>
            </li>
          ))}
        </ul>
        {logHasMore && (
          <button
            type="button"
            className="git-tab-load-more"
            disabled={logLoading}
            onClick={handleLoadMore}
          >
            {logLoading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>
    </div>
  )
}

function FileRow({
  file,
  busy,
  onToggle,
  actionLabel
}: {
  file: GitStatusFile
  busy: boolean
  onToggle: () => void
  actionLabel: string
}): React.JSX.Element {
  return (
    <div className="git-tab-file-row">
      <span className="git-tab-file-status">{describeStatus(file)}</span>
      <span className="git-tab-file-path">
        {file.renamedFrom && (
          <span className="git-tab-file-renamed-from">{file.renamedFrom} → </span>
        )}
        {file.path}
      </span>
      <button type="button" disabled={busy} onClick={onToggle}>
        {actionLabel}
      </button>
    </div>
  )
}
