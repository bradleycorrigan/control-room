import type { SessionActionResult } from './api'

// The projects team's own IPC wrappers — new handlers live in
// src/main/ipc-projects.ts, called through window.api.invoke like every
// other renderer call. See api.ts for the pattern this follows.

export function getAppInfo(): Promise<{ homeDir: string }> {
  return window.api.invoke<{ homeDir: string }>('projects:appInfo')
}

/** '' on success, an error message on failure (mirrors shell.openPath). */
export function revealProjectInFinder(projectId: string): Promise<string> {
  return window.api.invoke<string>('projects:revealInFinder', projectId)
}

export interface WorktreeCleanupCandidate {
  path: string
  branch: string | null
  merged: boolean
  prState: string | null
  dirty: boolean
  hasLiveSession: boolean
  /** The worktree's folder is already gone on disk (git reports it prunable). */
  missing: boolean
  /** When its latest commit was made (epoch ms), or null when git can't say. */
  lastCommitAt: number | null
  preselect: boolean
}

export function listWorktreesForCleanup(projectId: string): Promise<WorktreeCleanupCandidate[]> {
  return window.api.invoke<WorktreeCleanupCandidate[]>('projects:worktreesForCleanup', projectId)
}

export interface RemoveWorktreesResult {
  removed: string[]
  branchesDeleted: string[]
  failed: { path: string; reason: string }[]
}

export function removeWorktrees(
  projectId: string,
  worktreePaths: string[],
  deleteBranches: boolean
): Promise<RemoveWorktreesResult> {
  return window.api.invoke<RemoveWorktreesResult>(
    'projects:removeWorktrees',
    projectId,
    worktreePaths,
    deleteBranches
  )
}

export interface WrapUpResult {
  ok: boolean
  error?: string
  branchDeleted: boolean
  note?: string
}

/** Ends a merged worktree's sessions, removes it and deletes its local branch. */
export function wrapUpWorktree(projectId: string, worktreePath: string): Promise<WrapUpResult> {
  return window.api.invoke<WrapUpResult>('worktrees:wrapUp', projectId, worktreePath)
}

/** Pin a session so it sorts first on Home and the Sessions page. */
export function setSessionPinned(id: string, pinned: boolean): Promise<SessionActionResult> {
  return window.api.invoke<SessionActionResult>('sessions:setPinned', id, pinned)
}

export interface WorktreeDetail {
  baseRef: string
  /** Commits and diffstat since the base; null when it shares no history with it. */
  git: {
    commits: { sha: string; subject: string }[]
    commitsCapped: boolean
    filesChanged: number
    added: number
    removed: number
  } | null
  upstream: string | null
  ahead: number
  behind: number
  changes: { path: string; code: string }[]
  changeCount: number
  lastCommitAt: number | null
}

/** What's in a worktree: commits since the base, uncommitted files, push state. */
export function getWorktreeDetail(projectId: string, path: string): Promise<WorktreeDetail | null> {
  return window.api.invoke<WorktreeDetail | null>('worktrees:detail', projectId, path)
}

export function openWorktreeInIde(
  projectId: string,
  path: string
): Promise<{ ok: boolean; error?: string }> {
  return window.api.invoke<{ ok: boolean; error?: string }>('worktrees:openIde', projectId, path)
}

/** '' on success, an error message on failure. */
export function revealWorktree(projectId: string, path: string): Promise<string> {
  return window.api.invoke<string>('worktrees:reveal', projectId, path)
}
