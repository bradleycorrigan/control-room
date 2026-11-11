// Renderer wrappers for the sessions round's IPC — same shape as api.ts,
// kept in its own file per the round's file split (only api.ts and ipc.ts
// stay untouched). The renderer sends the session id only; main resolves
// the worktree and transcript itself.

import type { HandoffGitSummary } from '../../main/exec/sessionGit'
import type { PullRequestInfo, LinkedPullRequest } from '../../main/exec/pullRequests'
import type { MergeMethod, PrStatusResult } from '../../main/exec/prActions'
import type { TranscriptArtifact } from '../../main/exec/transcripts'
import type {
  TicketDraftChoices,
  TicketDraftResult,
  SessionTitleResult
} from '../../main/exec/ticketDraft'

/** Haiku's suggestion for a better session title, from what it asked and did. */
export function suggestSessionTitle(id: string): Promise<SessionTitleResult> {
  return window.api.invoke<SessionTitleResult>('sessions:suggestTitle', id)
}

export type { TicketDraftResult }

/** Haiku's draft of a ticket for this session, limited to the board's own epics, labels and priorities. */
export function draftTicketFromSession(
  id: string,
  choices: TicketDraftChoices
): Promise<TicketDraftResult> {
  return window.api.invoke<TicketDraftResult>('sessions:draftTicket', id, choices)
}

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

/** Pushes the session's branch: new commits for its open pull request. */
export function pushSessionBranch(id: string): Promise<ShipResult> {
  return window.api.invoke<ShipResult>('sessions:push', id)
}

/** Commits the files edited in the diff view, then pushes the session's branch. */
export function commitAndPushSessionFiles(
  id: string,
  paths: string[],
  message: string
): Promise<ShipResult> {
  return window.api.invoke<ShipResult>('sessions:commitPush', id, paths, message)
}

/** Takes a draft pull request out of draft: the branch's own by number, any other by URL. */
export function markPullRequestReady(id: string, pr: number | string): Promise<ShipResult> {
  return window.api.invoke<ShipResult>('sessions:prReady', id, pr)
}

export type { MergeMethod, PrStatusResult } from '../../main/exec/prActions'
type PrDoneResult = ShipResult & { branchError?: string }

/** Whether it can be merged now, how, and if not, why. */
export function getPullRequestStatus(id: string, pr: number | string): Promise<PrStatusResult> {
  return window.api.invoke<PrStatusResult>('sessions:prStatus', id, pr)
}

export function convertPullRequestToDraft(id: string, pr: number | string): Promise<ShipResult> {
  return window.api.invoke<ShipResult>('sessions:prDraft', id, pr)
}

export function closePullRequest(
  id: string,
  pr: number | string,
  deleteBranch: boolean
): Promise<PrDoneResult> {
  return window.api.invoke<PrDoneResult>('sessions:prClose', id, pr, deleteBranch)
}

export function mergePullRequest(
  id: string,
  pr: number | string,
  method: MergeMethod,
  deleteBranch: boolean
): Promise<PrDoneResult> {
  return window.api.invoke<PrDoneResult>('sessions:prMerge', id, pr, method, deleteBranch)
}

export type { TranscriptArtifact } from '../../main/exec/transcripts'

/** Pages the session published with the Artifact tool, oldest first. */
export function getSessionArtifacts(id: string): Promise<TranscriptArtifact[]> {
  return window.api.invoke<TranscriptArtifact[]>('sessions:artifacts', id)
}

/** Every session's linked pull requests, keyed by record id; sessions with none are left out. */
export function getAllLinkedPullRequests(): Promise<Record<string, LinkedPullRequest[]>> {
  return window.api.invoke<Record<string, LinkedPullRequest[]>>('sessions:linkedPrsAll')
}

/** Pull requests the session's agent opened, in any repo, from its transcript. */
export function getLinkedPullRequests(id: string): Promise<LinkedPullRequest[]> {
  return window.api.invoke<LinkedPullRequest[]>('sessions:linkedPrs', id)
}
