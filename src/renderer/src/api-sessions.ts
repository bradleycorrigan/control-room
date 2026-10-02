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
  /** The branch the session is on now; null before a detached one makes one. */
  branch?: string | null
  /** Commits origin doesn't have yet; null when that can't be told. */
  unpushed?: number | null
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

/** Pushes the session's branch: new commits for its open pull request. */
export function pushSessionBranch(id: string): Promise<ShipResult> {
  return window.api.invoke<ShipResult>('sessions:push', id)
}

/** Takes a draft pull request out of draft. */
export function markPullRequestReady(id: string, prNumber: number): Promise<ShipResult> {
  return window.api.invoke<ShipResult>('sessions:prReady', id, prNumber)
}
