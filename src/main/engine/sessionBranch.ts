import type { SessionRecord } from '../store/types'
import { branchOfWorktree } from '../exec/git'

/**
 * The branch a session's work is on now, read from its worktree. Usually the
 * one it was made with, but an agent can switch to a new one partway (one
 * opened its pull request from a second branch), and trusting the stored
 * name then looked for a pull request on a branch that had none. A detached
 * session (started from a branch someone else had checked out, usually main)
 * has one only once the agent makes it, and it's never the branch it started
 * from. Every pull request lookup and push goes through this, so none of
 * them asks about main by mistake.
 */
export async function currentBranch(record: SessionRecord): Promise<string | null> {
  const live = await branchOfWorktree(record.worktreePath)
  const onBranch = live && live !== 'HEAD' ? live : null
  if (!record.detached) return onBranch ?? record.branch
  return onBranch && onBranch !== record.branch ? onBranch : null
}
