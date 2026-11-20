import type { LiveSession } from '../../../main/store/types'
import type { ProjectWorktree, WorktreePullRequest } from '../api'

/** Which pile a worktree sits in on the project page. */
export type WorktreeGroup = 'ready' | 'inUse' | 'idle'

/**
 * Nothing left to do in it: the work landed (its PR merged or closed, or it
 * has no commits of its own), nothing is uncommitted, Claude isn't busy, and
 * any session in it is marked done. The same test the cleanup dialog uses to
 * pre-tick a row, so the two never disagree.
 */
export function isReadyToRemove(
  w: ProjectWorktree,
  pr: WorktreePullRequest | undefined,
  claude: LiveSession | undefined
): boolean {
  const busy = claude?.status === 'working' || claude?.status === 'needs_attention'
  const landed = pr?.state === 'MERGED' || pr?.state === 'CLOSED' || w.contained
  return landed && !w.dirty && !busy && !w.sessionId
}

export function groupOf(
  w: ProjectWorktree,
  pr: WorktreePullRequest | undefined,
  claude: LiveSession | undefined
): WorktreeGroup {
  if (isReadyToRemove(w, pr, claude)) return 'ready'
  return claude ? 'inUse' : 'idle'
}
