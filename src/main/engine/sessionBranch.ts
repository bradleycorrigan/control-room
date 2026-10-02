import type { SessionRecord } from '../store/types'
import { branchOfWorktree } from '../exec/git'

/**
 * The branch a session's work is on now. Usually the one it was made with;
 * a detached session (started from a branch someone else had checked out,
 * usually main) has one only once the agent makes it, and it's never the
 * branch it started from. Every pull request lookup and push goes through
 * this, so none of them asks about main by mistake.
 */
export async function currentBranch(record: SessionRecord): Promise<string | null> {
  if (!record.detached) return record.branch
  const live = await branchOfWorktree(record.worktreePath)
  return live && live !== 'HEAD' && live !== record.branch ? live : null
}
