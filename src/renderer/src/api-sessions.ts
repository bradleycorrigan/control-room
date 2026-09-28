// Renderer wrappers for the sessions round's IPC — same shape as api.ts,
// kept in its own file per the round's file split (only api.ts and ipc.ts
// stay untouched). The renderer sends the session id only; main resolves
// the worktree and transcript itself.

import type { HandoffGitSummary } from '../../main/exec/sessionGit'
import type { PullRequestInfo } from '../../main/exec/pullRequests'

export interface HandoffNoteResult {
  note: string
  branch: string
}

/** Builds a session's hand-off note fresh from disk — no LLM call. */
export function getSessionHandoffNote(id: string): Promise<HandoffNoteResult | null> {
  return window.api.invoke<HandoffNoteResult | null>('sessions:handoffNote', id)
}

export interface ShipInfo {
  /** Null: no worktree to diff against (investigate mode). */
  git: HandoffGitSummary | null
}

/** Commits + diffstat since the base branch — whether Ship has anything to show. */
export function getShipInfo(id: string): Promise<ShipInfo | null> {
  return window.api.invoke<ShipInfo | null>('sessions:shipInfo', id)
}

export interface ShipResult {
  ok: boolean
  pr?: PullRequestInfo
  error?: string
}

/** Pushes the branch and opens the pull request — step 2 of the Ship panel. */
export function shipPullRequest(
  id: string,
  title: string,
  body: string,
  draft: boolean
): Promise<ShipResult> {
  return window.api.invoke<ShipResult>('sessions:ship', id, title, body, draft)
}
