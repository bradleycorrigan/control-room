import { ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import path from 'node:path'
import { getState, mutate } from './store/store'
import {
  listWorktrees,
  getDefaultBranch,
  mergedBranches,
  prStatesForBranches,
  hasUncommittedChanges,
  lastCommitTime,
  removeWorktreeClean,
  deleteLocalBranch,
  pruneWorktrees
} from './exec/git'
import { discoverLiveSessions } from './engine/discovery'
import type { LiveSession } from './store/types'

// A worktree path as git reports it, resolved and with any trailing slash
// stripped, so it compares equal to a session's cwd or stored worktreePath
// even when one side went through a symlink or kept its trailing slash.
function normalizePath(p: string): string {
  return path.resolve(p).replace(/[/\\]+$/, '')
}

// A worktree counts as "has a live session" when any alive session's path —
// its record's worktreePath if it has one, else its own cwd — is that
// worktree or something inside it. A record's worktreePath is the only
// thing the two removal handlers used to check, which misses two real
// cases: a discovered/external session with no record at all (cwd is all
// it has), and a stored path that differs from git's only by a trailing
// slash or a symlink. Both left a worktree with a running agent looking
// clean, and `git worktree remove` on it either succeeds and kills the
// agent's cwd out from under it, or fails loudly if the agent has written
// there — neither is "safe to remove".
function worktreeHasLiveSession(worktreePath: string, liveSessions: LiveSession[]): boolean {
  const target = normalizePath(worktreePath)
  return liveSessions.some((s) => {
    if (!s.alive) return false
    const sessionPath = normalizePath(s.record?.worktreePath ?? s.cwd)
    return sessionPath === target || sessionPath.startsWith(target + path.sep)
  })
}

/**
 * IPC handlers added in the projects round. Registered from registerIpcHandlers
 * (ipc.ts) so that file only needs the one call.
 */
export function registerProjectsIpc(): void {
  // Display-only: the renderer swaps this for "~" in long paths rather than
  // shortening them from the wrong end. It never acts on this path itself.
  ipcMain.handle('projects:appInfo', () => ({ homeDir: homedir() }))

  // "Reveal in Finder" on a project's header. The renderer sends the project
  // id, never a path — main resolves it from the store, same as every other
  // handler that touches disk. `shell.openPath` is the same Electron API
  // app:openDataFolder already uses for this in ipc.ts; not a spawn, so it
  // doesn't go through exec/run.ts.
  ipcMain.handle('projects:revealInFinder', (_evt, projectId: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project) return 'Project not found.'
    return shell.openPath(project.repoPath)
  })

  // "Clean up worktrees" dialog (plan 7 step 2). Lists every worktree under
  // this project except the main checkout, with everything the dialog needs
  // to decide whether removing it is safe. The renderer never sees a raw
  // filesystem path it didn't already have — every path returned here is one
  // `git worktree list` reported for this project, so `projects:removeWorktrees`
  // below can re-validate against the same list rather than trust the caller.
  ipcMain.handle('projects:worktreesForCleanup', async (_evt, projectId: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project) return []

    const [worktrees, defaultBranch, liveSessions] = await Promise.all([
      listWorktrees(project.repoPath),
      getDefaultBranch(project.repoPath),
      discoverLiveSessions()
    ])
    const candidates = worktrees.filter((w) => w.path !== project.repoPath && !w.bare)
    if (candidates.length === 0) return []

    const merged = await mergedBranches(project.repoPath, defaultBranch)
    const prStates = await prStatesForBranches(project.repoPath)

    return Promise.all(
      candidates.map(async (w) => {
        const branch = w.branch?.replace(/^refs\/heads\//, '') ?? null
        const isMerged = branch ? merged.has(branch) : false
        const prState = branch ? (prStates.get(branch) ?? null) : null
        const [dirty, lastCommitAt] = await Promise.all([
          hasUncommittedChanges(w.path),
          w.prunable ? Promise.resolve(null) : lastCommitTime(w.path)
        ])
        // A "live session" is one with a real tmux pane or background agent
        // still running, not merely a SessionRecord that once pointed here —
        // a stopped session's worktree is exactly the kind of thing this
        // dialog should offer to clean up. Matches by cwd too, so a
        // discovered session with no record isn't missed.
        const hasLiveSession = worktreeHasLiveSession(w.path, liveSessions)
        // git already flags a worktree whose folder is gone as "prunable" —
        // that row is always safe to remove (there is nothing left to lose),
        // regardless of merge state.
        const missing = w.prunable
        const safe =
          missing ||
          ((isMerged || prState === 'MERGED' || prState === 'CLOSED') && !dirty && !hasLiveSession)
        return {
          path: w.path,
          branch,
          merged: isMerged,
          prState,
          dirty,
          hasLiveSession,
          missing,
          lastCommitAt,
          preselect: safe
        }
      })
    )
  })

  // Runs the bulk removal the dialog above confirmed. `worktreePaths` and
  // `deleteBranches` come from the renderer, but every path is re-checked
  // against this project's own current worktree list and re-tested for
  // uncommitted changes and a live session — the dialog's snapshot could be
  // stale by the time the user presses the button. Never `--force` and
  // never `git branch -D`: a row this can't safely act on is skipped and
  // reported, not overridden.
  ipcMain.handle(
    'projects:removeWorktrees',
    async (_evt, projectId: string, worktreePaths: string[], deleteBranches: boolean) => {
      const project = getState().projects.find((p) => p.id === projectId)
      if (!project) return { removed: [], branchesDeleted: [], failed: [] }

      const [worktrees, defaultBranch, liveSessions] = await Promise.all([
        listWorktrees(project.repoPath),
        getDefaultBranch(project.repoPath),
        discoverLiveSessions()
      ])
      const byPath = new Map(worktrees.map((w) => [w.path, w]))
      const merged = await mergedBranches(project.repoPath, defaultBranch)

      const removed: string[] = []
      const branchesDeleted: string[] = []
      const failed: { path: string; reason: string }[] = []

      for (const wtPath of worktreePaths) {
        const w = byPath.get(wtPath)
        if (!w || wtPath === project.repoPath || w.bare) {
          failed.push({ path: wtPath, reason: 'not a worktree of this project' })
          continue
        }
        if (worktreeHasLiveSession(wtPath, liveSessions)) {
          failed.push({ path: wtPath, reason: 'a live session is using it' })
          continue
        }
        if (await hasUncommittedChanges(wtPath)) {
          failed.push({ path: wtPath, reason: 'has uncommitted changes' })
          continue
        }
        const result = await removeWorktreeClean(project.repoPath, wtPath)
        if (!result.ok) {
          failed.push({ path: wtPath, reason: result.error ?? 'git worktree remove failed' })
          continue
        }
        removed.push(wtPath)

        const branch = w.branch?.replace(/^refs\/heads\//, '')
        if (deleteBranches && branch && merged.has(branch)) {
          const branchResult = await deleteLocalBranch(project.repoPath, branch)
          if (branchResult.ok) branchesDeleted.push(branch)
        }
      }

      await pruneWorktrees(project.repoPath)
      return { removed, branchesDeleted, failed }
    }
  )

  // Pin a session (plan 7 step 3): a session-level preference, independent
  // of a project's own `pinned` above — keeps it at the top of Home's
  // recent list and the Sessions page. Same shape as sessions:archive and
  // sessions:rename in ipc.ts: look the record up, mutate the one field.
  ipcMain.handle('sessions:setPinned', (_evt, id: string, pinned: boolean) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    mutate((draft) => {
      const target = draft.sessions.find((s) => s.id === id)
      if (target) target.pinned = pinned
    })
    return { ok: true }
  })
}
