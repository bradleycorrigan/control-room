import { useEffect, useState } from 'react'
import { Modal, Button, Stack, Row, Icon, useConfirm } from './primitives'
import {
  listWorktreesForCleanup,
  removeWorktrees,
  type WorktreeCleanupCandidate
} from '../api-projects'
import { formatHomePath } from '../lib/format-path'
import { useHomeDir } from '../state/useHomeDir'
import { relativeTime } from '../lib/format-time'
import { PickCheck } from './selection'
import './worktree-cleanup-dialog.css'
import type { PushToast } from '../state/useToasts'

interface Props {
  projectId: string
  projectName: string
  onClose: () => void
  /** Worktrees were actually removed — caller refreshes its own worktree list. */
  onCleaned: () => void
  pushToast: PushToast
  /** Opens a live session by key: the way out for a row Claude is busy in. */
  onOpenSession?: (key: string) => void
}

/** Why a row can't be selected — the main process re-checks before removing
 * anything (projects:removeWorktrees). Only a busy Claude blocks: uncommitted
 * changes can be thrown away on purpose, and an idle Claude is stopped. */
function blockedReason(w: WorktreeCleanupCandidate): string | null {
  if (w.busy) return w.busy.waiting ? 'Claude is waiting on you' : 'Claude is working'
  return null
}

type Group = 'ready' | 'review' | 'busy'

function groupOf(w: WorktreeCleanupCandidate): Group {
  if (w.busy) return 'busy'
  return w.preselect ? 'ready' : 'review'
}

const GROUP_LABEL: Record<Group, string> = {
  ready: 'Ready to remove',
  review: 'Needs a look',
  busy: 'In use'
}

/** No commit for this long reads as abandoned (the "Select untouched" button). */
const UNTOUCHED_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

function isUntouched(w: WorktreeCleanupCandidate, now = Date.now()): boolean {
  return w.lastCommitAt !== null && now - w.lastCommitAt >= UNTOUCHED_DAYS * DAY_MS
}

function statusLabel(w: WorktreeCleanupCandidate): {
  text: string
  tone: 'good' | 'warn' | 'plain'
} {
  if (w.missing) return { text: 'folder already gone', tone: 'good' }
  if (w.busy) return { text: w.busy.waiting ? 'waiting on you' : 'Claude working', tone: 'warn' }
  if (w.dirty)
    return {
      text: `${w.changeCount} uncommitted change${w.changeCount === 1 ? '' : 's'}`,
      tone: 'warn'
    }
  if (w.prState === 'MERGED') return { text: 'PR merged', tone: 'good' }
  if (w.prState === 'CLOSED') return { text: 'PR closed', tone: 'good' }
  if (w.merged) return { text: 'merged', tone: 'good' }
  if (w.contained) return { text: 'no commits of its own', tone: 'good' }
  if (w.prState === 'OPEN') return { text: 'PR open', tone: 'plain' }
  return { text: 'not merged', tone: 'plain' }
}

/** "Clean up worktrees" (plan 7 step 2) — lists every worktree but the main
 * checkout, pre-selects the ones it's safe to drop, and requires a second
 * confirm before anything on disk is touched. */
export default function WorktreeCleanupDialog({
  projectId,
  projectName,
  onClose,
  onCleaned,
  pushToast,
  onOpenSession
}: Props): React.JSX.Element {
  const homeDir = useHomeDir()
  const [confirmNode, confirm] = useConfirm()
  const [loading, setLoading] = useState(true)
  const [candidates, setCandidates] = useState<WorktreeCleanupCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleteBranches, setDeleteBranches] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Rows whose uncommitted files are shown.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    listWorktreesForCleanup(projectId)
      .then((list) => {
        if (cancelled) return
        // Ready first, then the ones to look at, then the busy ones; within
        // each, a folder that's already gone, then oldest commit first.
        const rank: Record<Group, number> = { ready: 0, review: 1, busy: 2 }
        setCandidates(
          [...list].sort(
            (a, b) =>
              rank[groupOf(a)] - rank[groupOf(b)] ||
              Number(b.missing) - Number(a.missing) ||
              (a.lastCommitAt ?? Infinity) - (b.lastCommitAt ?? Infinity)
          )
        )
        setSelected(new Set(list.filter((w) => w.preselect).map((w) => w.path)))
      })
      .catch(() => {
        if (!cancelled) setError('Could not list worktrees.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const toggle = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectedCount = selected.size
  // Untouched for two weeks or more, nothing stops it being removed, and
  // nothing uncommitted: a bulk pick never throws work away.
  const untouched = candidates.filter(
    (w) => isUntouched(w) && blockedReason(w) === null && !w.dirty && !selected.has(w.path)
  )
  const selectUntouched = (): void =>
    setSelected((prev) => new Set([...prev, ...untouched.map((w) => w.path)]))

  const toggleExpanded = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleRemove = async (): Promise<void> => {
    const picked = candidates.filter((w) => selected.has(w.path))
    const stopping = picked.filter((w) => w.running > 0).length
    const discarding = picked.filter((w) => w.dirty)
    const lostFiles = discarding.reduce((n, w) => n + w.changeCount, 0)
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
    const confirmed = await confirm({
      title: `Remove ${selectedCount} worktree${selectedCount === 1 ? '' : 's'}?`,
      body:
        (deleteBranches
          ? 'This deletes each worktree from disk and its branch, if fully merged.'
          : 'This deletes each worktree from disk. Branches are left alone.') +
        (discarding.length > 0
          ? ` It throws away ${plural(lostFiles, 'uncommitted change')} in ${plural(discarding.length, 'worktree')}. That can't be undone.`
          : '') +
        (stopping > 0
          ? ` Claude stops in ${plural(stopping, 'worktree')}. Their sessions are kept as done, and Resume rebuilds the worktree.`
          : ''),
      confirmLabel: `Remove ${selectedCount} worktree${selectedCount === 1 ? '' : 's'}`,
      danger: true
    })
    if (!confirmed) return

    setBusy(true)
    setError(null)
    try {
      const result = await removeWorktrees(
        projectId,
        [...selected],
        deleteBranches,
        picked.filter((w) => w.dirty).map((w) => w.path)
      )
      if (result.failed.length > 0) {
        pushToast(
          result.removed.length > 0
            ? `Removed ${result.removed.length}, ${result.failed.length} could not be removed.`
            : `Could not remove ${result.failed.length === 1 ? 'that worktree' : 'those worktrees'}.`
        )
      } else if (result.removed.length > 0) {
        pushToast(
          `Removed ${result.removed.length} worktree${result.removed.length === 1 ? '' : 's'}` +
            (result.branchesDeleted.length > 0
              ? ` and deleted ${result.branchesDeleted.length} branch${result.branchesDeleted.length === 1 ? '' : 'es'}.`
              : '.')
        )
      }
      if (result.removed.length > 0) onCleaned()
      if (result.failed.length === 0) {
        onClose()
      } else {
        // Leave the dialog open on a partial failure so the reason for
        // each row that didn't go is still visible, rather than losing it
        // in a toast that's already gone.
        const remaining = new Set(result.failed.map((f) => f.path))
        setCandidates((prev) => prev.filter((w) => remaining.has(w.path)))
        setSelected(new Set())
      }
    } catch {
      setError('Could not remove those worktrees.')
    } finally {
      setBusy(false)
    }
  }

  // Merged into the default branch, or a pull request that merged: a squash
  // merge leaves no trace git can see, so the PR is the only sign.
  const anyMergedSelected = [...selected].some((path) => {
    const w = candidates.find((c) => c.path === path)
    return w?.merged || w?.prState === 'MERGED'
  })

  // The checkbox is disabled once nothing merged is selected, but a
  // previously-checked value stayed checked underneath it — so the confirm
  // text could still promise a branch deletion the request would never do.
  // Adjusted during render (React's own pattern for state derived from a
  // changed value — see ProjectDetail's prevInitialTab) rather than an
  // effect, so it never causes an extra commit.
  const [prevAnyMergedSelected, setPrevAnyMergedSelected] = useState(anyMergedSelected)
  if (anyMergedSelected !== prevAnyMergedSelected) {
    setPrevAnyMergedSelected(anyMergedSelected)
    if (!anyMergedSelected) setDeleteBranches(false)
  }

  return (
    <Modal title="Clean up worktrees" icon="GitBranch" onClose={onClose} width={600}>
      <Stack gap={16}>
        {loading ? (
          <p className="wt-cleanup-note">Looking at {projectName}&rsquo;s worktrees…</p>
        ) : candidates.length === 0 ? (
          <p className="wt-cleanup-note">No worktrees to clean up.</p>
        ) : (
          <div className="wt-cleanup-list">
            {candidates.map((w, i) => {
              const reason = blockedReason(w)
              const disabled = reason !== null
              const group = groupOf(w)
              const startsGroup = i === 0 || groupOf(candidates[i - 1]) !== group
              const status = statusLabel(w)
              const isPicked = selected.has(w.path)
              const showFiles = expanded.has(w.path) || (w.dirty && isPicked)
              const session = w.openSessionTitle ?? w.doneSessionTitle
              return (
                <div key={w.path} className="wt-cleanup-item">
                  {startsGroup && (
                    <div className="wt-cleanup-group">
                      {GROUP_LABEL[group]}
                      <span className="wt-cleanup-group-count">
                        {candidates.filter((c) => groupOf(c) === group).length}
                      </span>
                    </div>
                  )}
                  <div className="wt-cleanup-line">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isPicked}
                      className={`wt-cleanup-row${disabled ? ' wt-cleanup-row--disabled' : ''}`}
                      disabled={disabled}
                      onClick={() => toggle(w.path)}
                    >
                      <PickCheck on={isPicked} />
                      <div className="wt-cleanup-row-main">
                        <div className="wt-cleanup-row-branch">
                          <bdi>{w.branch ?? 'detached'}</bdi>
                        </div>
                        <div className="wt-cleanup-row-meta">
                          {session && (
                            <span className="wt-cleanup-row-session">
                              {w.openSessionTitle ? 'Active: ' : 'Done: '}
                              <bdi>{session}</bdi>
                            </span>
                          )}
                          {w.lastCommitAt !== null && (
                            <span
                              className={`wt-cleanup-row-age${isUntouched(w) ? ' wt-cleanup-row-age--old' : ''}`}
                              title={new Date(w.lastCommitAt).toLocaleString()}
                            >
                              Last commit {relativeTime(w.lastCommitAt)}
                            </span>
                          )}
                        </div>
                        <div className="wt-cleanup-row-path" title={w.path}>
                          <bdi>{formatHomePath(w.path, homeDir)}</bdi>
                        </div>
                      </div>
                      <div className="wt-cleanup-row-status">
                        <span className={`wt-cleanup-row-tag wt-cleanup-row-tag--${status.tone}`}>
                          {status.text}
                        </span>
                        {!w.busy && w.running > 0 && (
                          <span
                            className="wt-cleanup-row-kept"
                            title="Removing it stops Claude. The session is kept as done, and Resume rebuilds the worktree."
                          >
                            stops Claude
                          </span>
                        )}
                      </div>
                    </button>
                    {w.busy && onOpenSession && (
                      <Button
                        variant="outlined"
                        size="compact"
                        onClick={() => {
                          onOpenSession(w.busy!.key)
                          onClose()
                        }}
                      >
                        Open session
                      </Button>
                    )}
                    {w.dirty && !isPicked && (
                      <Button
                        variant="ghost"
                        size="compact"
                        aria-expanded={showFiles}
                        onClick={() => toggleExpanded(w.path)}
                      >
                        {showFiles ? 'Hide changes' : 'Show changes'}
                      </Button>
                    )}
                  </div>
                  {w.dirty && showFiles && (
                    <div className="wt-cleanup-changes">
                      {isPicked && (
                        <p className="wt-cleanup-changes-warning">
                          <Icon name="AlertTriangle" size={13} />
                          Removing it throws these away.
                        </p>
                      )}
                      <ul>
                        {w.changes.map((c) => (
                          <li key={c.path}>
                            <span className="wt-cleanup-changes-code">{c.code}</span>
                            <bdi>{c.path}</bdi>
                          </li>
                        ))}
                        {w.changeCount > w.changes.length && (
                          <li className="wt-cleanup-changes-more">
                            and {w.changeCount - w.changes.length} more
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {error && <p className="settings-error">{error}</p>}

        {untouched.length > 0 && (
          <Row justify="flex-start">
            <Button variant="outlined" size="compact" onClick={selectUntouched}>
              Select {untouched.length} untouched for {UNTOUCHED_DAYS}+ days
            </Button>
          </Row>
        )}

        {candidates.length > 0 && (
          // The same check as the rows above, not the system checkbox.
          <button
            type="button"
            role="checkbox"
            aria-checked={deleteBranches}
            className="wt-cleanup-checkbox"
            disabled={!anyMergedSelected}
            title={
              anyMergedSelected
                ? undefined
                : 'Select a worktree whose branch or pull request merged'
            }
            onClick={() => setDeleteBranches((v) => !v)}
          >
            <PickCheck on={deleteBranches} />
            Also delete merged branches
          </button>
        )}

        <Row gap={8} justify="flex-end">
          <Button variant="outlined" size="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {candidates.length > 0 && (
            <Button
              variant="filled"
              size="default"
              className="wt-cleanup-destructive"
              onClick={handleRemove}
              disabled={busy || selectedCount === 0}
            >
              {busy
                ? 'Removing…'
                : `Remove ${selectedCount} worktree${selectedCount === 1 ? '' : 's'}`}
            </Button>
          )}
        </Row>
      </Stack>
      {confirmNode}
    </Modal>
  )
}
