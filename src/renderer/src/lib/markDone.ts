import { archiveSession, listWorktreePullRequests } from '../api'
import { wrapUpWorktree } from '../api-projects'
import type { PushToast } from '../state/useToasts'

interface DoneRecord {
  id: string
  title: string
  projectId: string
  branch: string
  worktreePath: string
  investigation?: boolean
}

/**
 * Wraps up a merged worktree from a toast: ends its sessions, removes it and
 * deletes the branch. Shared by "Mark as done" here and the worktree cards.
 */
export async function wrapUpFromToast(
  projectId: string,
  worktreePath: string,
  prNumber: number,
  pushToast: PushToast,
  onChanged?: () => void
): Promise<void> {
  const res = await wrapUpWorktree(projectId, worktreePath)
  if (!res.ok) {
    pushToast(res.error ?? 'Could not wrap up that worktree.', { tone: 'error' })
    return
  }
  pushToast(
    res.branchDeleted
      ? `Wrapped up #${prNumber}. Worktree and branch deleted.`
      : `Wrapped up #${prNumber}. Worktree deleted. ${res.note ?? 'The branch was kept.'}`,
    { tone: 'success' }
  )
  onChanged?.()
}

/**
 * "Mark as done", from any of the places that offer it. Marking a session done
 * leaves Claude and its worktree alone, so when the branch's pull request has
 * already merged, the worktree is now just clutter: say so and offer to wrap
 * it up there and then, instead of leaving it for a cleanup later.
 */
export async function markSessionDone(
  record: DoneRecord,
  pushToast: PushToast | undefined,
  onChanged: () => void,
  doneMessage = `${record.title} marked done. Nothing was stopped.`
): Promise<boolean> {
  const result = await archiveSession(record.id)
  if (!result.ok) {
    pushToast?.(result.error ?? 'Could not mark it done.', { tone: 'error' })
    return false
  }
  onChanged()
  if (!pushToast) return true
  const pr =
    record.investigation || !record.branch
      ? undefined
      : (await listWorktreePullRequests(record.projectId).catch(() => ({})))[record.branch]
  if (pr?.state !== 'MERGED') {
    pushToast(doneMessage, { tone: 'success' })
    return true
  }
  pushToast(`Remove its worktree and branch too? Claude stops there for good.`, {
    tone: 'success',
    title: `${record.title} marked done. PR #${pr.number} merged.`,
    action: {
      label: 'Wrap up',
      onClick: () =>
        void wrapUpFromToast(record.projectId, record.worktreePath, pr.number, pushToast, onChanged)
    },
    secondary: { label: 'Keep it', onClick: () => {} }
  })
  return true
}
