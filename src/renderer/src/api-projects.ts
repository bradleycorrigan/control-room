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

/** Pin a session so it sorts first on Home and the Sessions page. */
export function setSessionPinned(id: string, pinned: boolean): Promise<SessionActionResult> {
  return window.api.invoke<SessionActionResult>('sessions:setPinned', id, pinned)
}
