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

interface Props {
  projectId: string
  projectName: string
  onClose: () => void
  /** Worktrees were actually removed — caller refreshes its own worktree list. */
  onCleaned: () => void
  pushToast: (message: string) => void
}

/** Why a row can't be selected — same reasons the main process re-checks
 * before actually removing anything (projects:removeWorktrees). A missing
 * folder isn't a block — it's still safe (and preselected) to remove. */
function blockedReason(w: WorktreeCleanupCandidate): string | null {
  if (w.hasLiveSession) return 'a live session is using it'
  if (w.dirty) return 'has uncommitted changes'
  return null
}

/** No commit for this long reads as abandoned (the "Select untouched" button). */
const UNTOUCHED_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

function isUntouched(w: WorktreeCleanupCandidate, now = Date.now()): boolean {
  return w.lastCommitAt !== null && now - w.lastCommitAt >= UNTOUCHED_DAYS * DAY_MS
}

function statusLabel(w: WorktreeCleanupCandidate): string {
  if (w.prState === 'MERGED') return 'PR merged'
  if (w.prState === 'CLOSED') return 'PR closed'
  if (w.prState === 'OPEN') return 'PR open'
  if (w.merged) return 'merged'
  return 'not merged'
}

/** "Clean up worktrees" (plan 7 step 2) — lists every worktree but the main
 * checkout, pre-selects the ones it's safe to drop, and requires a second
 * confirm before anything on disk is touched. */
export default function WorktreeCleanupDialog({
  projectId,
  projectName,
  onClose,
  onCleaned,
  pushToast
}: Props): React.JSX.Element {
  const homeDir = useHomeDir()
  const [confirmNode, confirm] = useConfirm()
  const [loading, setLoading] = useState(true)
  const [candidates, setCandidates] = useState<WorktreeCleanupCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleteBranches, setDeleteBranches] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listWorktreesForCleanup(projectId)
      .then((list) => {
        if (cancelled) return
        // Oldest commit first: the abandoned ones are what you're here for.
        // A folder that's already gone goes first of all.
        setCandidates(
          [...list].sort(
            (a, b) =>
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
  // Untouched for two weeks or more, and nothing stops it being removed.
  const untouched = candidates.filter((w) => isUntouched(w) && blockedReason(w) === null)
  const selectUntouched = (): void =>
    setSelected((prev) => new Set([...prev, ...untouched.map((w) => w.path)]))

  const handleRemove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: `Remove ${selectedCount} worktree${selectedCount === 1 ? '' : 's'}?`,
      body: deleteBranches
        ? 'This deletes each worktree from disk and its branch, if fully merged.'
        : 'This deletes each worktree from disk. Branches are left alone.',
      confirmLabel: `Remove ${selectedCount} worktree${selectedCount === 1 ? '' : 's'}`,
      danger: true
    })
    if (!confirmed) return

    setBusy(true)
    setError(null)
    try {
      const result = await removeWorktrees(projectId, [...selected], deleteBranches)
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

  const anyMergedSelected = [...selected].some((path) => {
    const w = candidates.find((c) => c.path === path)
    return w?.merged
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
            {candidates.map((w) => {
              const reason = blockedReason(w)
              const disabled = reason !== null
              return (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected.has(w.path)}
                  key={w.path}
                  className={`wt-cleanup-row${disabled ? ' wt-cleanup-row--disabled' : ''}`}
                  disabled={disabled}
                  onClick={() => toggle(w.path)}
                >
                  <PickCheck on={selected.has(w.path)} />
                  <div className="wt-cleanup-row-main">
                    <div className="wt-cleanup-row-branch">
                      <bdi>{w.branch ?? 'detached'}</bdi>
                    </div>
                    <div className="wt-cleanup-row-path" title={w.path}>
                      <bdi>{formatHomePath(w.path, homeDir)}</bdi>
                    </div>
                    {w.lastCommitAt !== null && (
                      <div
                        className={`wt-cleanup-row-age${isUntouched(w) ? ' wt-cleanup-row-age--old' : ''}`}
                        title={new Date(w.lastCommitAt).toLocaleString()}
                      >
                        Last commit {relativeTime(w.lastCommitAt)}
                      </div>
                    )}
                  </div>
                  <div className="wt-cleanup-row-status">
                    {w.missing ? (
                      <span className="wt-cleanup-row-tag wt-cleanup-row-tag--merged">
                        folder already gone
                      </span>
                    ) : (
                      <span
                        className={
                          w.merged || w.prState === 'MERGED' || w.prState === 'CLOSED'
                            ? 'wt-cleanup-row-tag wt-cleanup-row-tag--merged'
                            : 'wt-cleanup-row-tag'
                        }
                      >
                        {statusLabel(w)}
                      </span>
                    )}
                    {reason && (
                      <Row gap={4} align="center" className="wt-cleanup-row-blocked">
                        <Icon name="AlertTriangle" size={13} />
                        <span>{reason}</span>
                      </Row>
                    )}
                  </div>
                </button>
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
          <label className="wt-cleanup-checkbox">
            <input
              type="checkbox"
              checked={deleteBranches}
              onChange={(e) => setDeleteBranches(e.target.checked)}
              disabled={!anyMergedSelected}
            />
            Also delete merged branches
          </label>
        )}

        <Row gap={8} justify="flex-end">
          <Button variant="outlined" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {candidates.length > 0 && (
            <Button
              variant="filled"
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
