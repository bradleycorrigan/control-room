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
  deleteMergedBranch,
  pullRequestsByBranch,
  pruneWorktrees,
  gitStatus,
  uncommittedChanges,
  removeWorktreeForce,
  headContainedIn
} from './exec/git'
import { killPane } from './exec/tmux'
import { handoffGitSummary } from './exec/sessionGit'
import { openInEditor } from './exec/editor'
import { discoverLiveSessions } from './engine/discovery'
import { retireSessionsInWorktree, shelveSessionsInWorktree } from './engine/sessions'
import type { LiveSession } from './store/types'

interface WrapUpOutcome {
  ok: boolean
  error?: string
  branchDeleted: boolean
  note?: string
}

// A worktree path as git reports it, resolved and with any trailing slash
// stripped, so it compares equal to a session's cwd or stored worktreePath
// even when one side went through a symlink or kept its trailing slash.
function normalizePath(p: string): string {
  return path.resolve(p).replace(/[/\\]+$/, '')
}

// The sessions running in a worktree: every alive one whose path — its
// record's worktreePath if it has one, else its own cwd — is that worktree or
// something inside it. Matching by cwd too catches a session with no record
// (started outside the app) and a stored path that differs from git's only by
// a trailing slash or a symlink.
function sessionsIn(worktreePath: string, liveSessions: LiveSession[]): LiveSession[] {
  const target = normalizePath(worktreePath)
  return liveSessions.filter((s) => {
    if (!s.alive) return false
    const sessionPath = normalizePath(s.record?.worktreePath ?? s.cwd)
    return sessionPath === target || sessionPath.startsWith(target + path.sep)
  })
}

/**
 * Claude is doing something, or waiting on an answer, so removing its
 * worktree would pull the floor out from under it. Anything else — sitting at
 * its prompt, marked done, a plain shell tab — is fine to stop. "Mark as
 * done" leaves Claude running at its prompt, so treating every running
 * process as in use made a done, merged worktree impossible to clean up.
 */
function isBusy(s: LiveSession): boolean {
  if (s.status === 'working' || s.status === 'needs_attention') return true
  // Started outside the app: the status says nothing, the raw one might.
  if (s.status === 'external')
    return s.rawStatus === 'busy' || s.rawStatus === 'waiting' || s.rawStatus === 'blocked'
  return false
}

function busySessionIn(
  worktreePath: string,
  liveSessions: LiveSession[]
): { key: string; title: string | null; waiting: boolean } | null {
  const s = sessionsIn(worktreePath, liveSessions).find(isBusy)
  if (!s) return null
  return {
    key: s.key,
    title: s.record?.title ?? s.agentName,
    waiting:
      s.status === 'needs_attention' || s.rawStatus === 'waiting' || s.rawStatus === 'blocked'
  }
}

/** Ends whatever still runs in a worktree's panes once its records are shelved:
 * a Claude with no record, or a shell tab. Left alone, they sat in a folder
 * that no longer existed. */
async function closePanesIn(worktreePath: string, liveSessions: LiveSession[]): Promise<void> {
  for (const s of sessionsIn(worktreePath, liveSessions)) {
    if (s.tmux?.paneId) await killPane(s.tmux.paneId)
  }
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

  // The worktree overlay. Every handler takes a path the renderer got from
  // worktrees:list, and acts only if git still lists it as one of this
  // project's worktrees (never the main checkout).
  const projectWorktree = async (
    projectId: string,
    worktreePath: string
  ): Promise<{ repoPath: string; baseRef: string } | null> => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project || worktreePath === project.repoPath) return null
    const listed = await listWorktrees(project.repoPath)
    if (!listed.some((w) => w.path === worktreePath && !w.bare)) return null
    return { repoPath: project.repoPath, baseRef: project.baseRef ?? 'origin/main' }
  }

  ipcMain.handle('worktrees:detail', async (_evt, projectId: string, worktreePath: string) => {
    const wt = await projectWorktree(projectId, worktreePath)
    if (!wt) return null
    const [git, status, changes, lastCommitAt] = await Promise.all([
      handoffGitSummary(worktreePath, wt.baseRef),
      gitStatus(worktreePath),
      uncommittedChanges(worktreePath),
      lastCommitTime(worktreePath)
    ])
    return {
      baseRef: wt.baseRef,
      git,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      // Enough to see what's uncommitted; the count says if there's more.
      changes: (changes ?? []).slice(0, 50).map((c) => ({ path: c.path, code: c.code.trim() })),
      changeCount: changes?.length ?? 0,
      lastCommitAt
    }
  })

  ipcMain.handle('worktrees:openIde', async (_evt, projectId: string, worktreePath: string) => {
    if (!(await projectWorktree(projectId, worktreePath)))
      return { ok: false, error: 'not a worktree of this project' }
    return openInEditor({ folder: worktreePath })
  })

  ipcMain.handle('worktrees:reveal', async (_evt, projectId: string, worktreePath: string) => {
    if (!(await projectWorktree(projectId, worktreePath))) return 'Not a worktree of this project.'
    return shell.openPath(worktreePath)
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
    const baseRef = project.baseRef ?? 'origin/main'

    const [worktrees, defaultBranch, liveSessions] = await Promise.all([
      listWorktrees(project.repoPath),
      getDefaultBranch(project.repoPath),
      discoverLiveSessions()
    ])
    const candidates = worktrees.filter((w) => w.path !== project.repoPath && !w.bare)
    if (candidates.length === 0) return []

    const merged = await mergedBranches(project.repoPath, defaultBranch)
    const prStates = await prStatesForBranches(project.repoPath)
    const records = getState().sessions.filter((s) => s.projectId === projectId && !s.deletedAt)

    return Promise.all(
      candidates.map(async (w) => {
        const branch = w.branch?.replace(/^refs\/heads\//, '') ?? null
        const isMerged = branch ? merged.has(branch) : false
        const prState = branch ? (prStates.get(branch) ?? null) : null
        const missing = w.prunable
        const [changes, lastCommitAt, contained] = await Promise.all([
          missing ? Promise.resolve([]) : uncommittedChanges(w.path),
          missing ? Promise.resolve(null) : lastCommitTime(w.path),
          missing ? Promise.resolve(false) : headContainedIn(w.path, baseRef)
        ])
        const changeList = changes ?? []
        const dirty = changeList.length > 0
        const busy = busySessionIn(w.path, liveSessions)
        // Claude processes that removing it will stop: not shell tabs.
        const running = sessionsIn(w.path, liveSessions).filter((s) => s.status !== 'shell').length
        const here = records.filter((r) => normalizePath(r.worktreePath) === normalizePath(w.path))
        // A session you haven't marked done: removing it is allowed (it's
        // kept, and Resume rebuilds the worktree), but never pre-ticked.
        const openSession = here.find((r) => !r.archivedAt) ?? null
        const doneSession = here.find((r) => r.archivedAt) ?? null
        // Nothing to lose: the folder's gone, or its work landed (merged, a
        // merged or closed PR, or no commits of its own), with nothing
        // uncommitted, Claude not busy, and every session in it marked done.
        const finished = isMerged || prState === 'MERGED' || prState === 'CLOSED' || contained
        const preselect = missing || (finished && !dirty && !busy && !openSession)
        return {
          path: w.path,
          branch,
          merged: isMerged,
          prState,
          contained,
          dirty,
          changes: changeList.slice(0, 20).map((c) => ({ path: c.path, code: c.code.trim() })),
          changeCount: changeList.length,
          busy,
          running,
          openSessionTitle: openSession?.title ?? null,
          doneSessionTitle: doneSession?.title ?? null,
          missing,
          lastCommitAt,
          preselect
        }
      })
    )
  })

  // Runs the bulk removal the dialog above confirmed. `worktreePaths`,
  // `deleteBranches` and `discardPaths` come from the renderer, but every path
  // is re-checked against this project's own current worktree list and
  // re-tested for uncommitted changes and a busy Claude — the dialog's
  // snapshot could be stale by the time the user presses the button. A
  // worktree with changes is forced only when it's in `discardPaths`: the
  // person saw those changes in the dialog and ticked it anyway.
  ipcMain.handle(
    'projects:removeWorktrees',
    async (
      _evt,
      projectId: string,
      worktreePaths: string[],
      deleteBranches: boolean,
      discardPaths: string[] = []
    ) => {
      const project = getState().projects.find((p) => p.id === projectId)
      if (!project) return { removed: [], branchesDeleted: [], failed: [] }
      const discard = new Set(discardPaths)

      const [worktrees, defaultBranch, liveSessions] = await Promise.all([
        listWorktrees(project.repoPath),
        getDefaultBranch(project.repoPath),
        discoverLiveSessions()
      ])
      const byPath = new Map(worktrees.map((w) => [w.path, w]))
      // A squash-merged PR's branch counts too: git can't see that merge.
      const [merged, prs] = await Promise.all([
        mergedBranches(project.repoPath, defaultBranch),
        deleteBranches ? pullRequestsByBranch(project.repoPath) : Promise.resolve(new Map())
      ])

      const removed: string[] = []
      const branchesDeleted: string[] = []
      const failed: { path: string; reason: string }[] = []

      for (const wtPath of worktreePaths) {
        const w = byPath.get(wtPath)
        if (!w || wtPath === project.repoPath || w.bare) {
          failed.push({ path: wtPath, reason: 'not a worktree of this project' })
          continue
        }
        const busy = busySessionIn(wtPath, liveSessions)
        if (busy) {
          failed.push({
            path: wtPath,
            reason: busy.waiting ? 'Claude is waiting on you in it' : 'Claude is working in it'
          })
          continue
        }
        const dirty = !w.prunable && (await hasUncommittedChanges(wtPath))
        if (dirty && !discard.has(wtPath)) {
          failed.push({ path: wtPath, reason: 'has uncommitted changes' })
          continue
        }
        // Its sessions are stopped first and kept as done: Resume rebuilds
        // the worktree from the branch. Only a deleted branch ends them.
        await shelveSessionsInWorktree(wtPath)
        await closePanesIn(wtPath, liveSessions)
        const result = dirty
          ? await removeWorktreeForce(project.repoPath, wtPath)
          : await removeWorktreeClean(project.repoPath, wtPath)
        if (!result.ok) {
          failed.push({ path: wtPath, reason: result.error ?? 'git worktree remove failed' })
          continue
        }
        removed.push(wtPath)

        const branch = w.branch?.replace(/^refs\/heads\//, '')
        if (
          deleteBranches &&
          branch &&
          (merged.has(branch) || prs.get(branch)?.state === 'MERGED')
        ) {
          const branchResult = await deleteMergedBranch(project.repoPath, branch, prs.get(branch))
          if (branchResult.ok) {
            branchesDeleted.push(branch)
            await retireSessionsInWorktree(wtPath)
          }
        }
      }

      await pruneWorktrees(project.repoPath)
      return { removed, branchesDeleted, failed }
    }
  )

  // "Wrap up" for a worktree whose pull request merged: end its sessions,
  // remove the worktree and delete the local branch. The merge is re-read
  // from GitHub here, never taken from the renderer or the card cache.
  ipcMain.handle('worktrees:wrapUp', async (_evt, projectId: string, worktreePath: string) => {
    const fail = (error: string): WrapUpOutcome => ({ ok: false, error, branchDeleted: false })
    const wt = await projectWorktree(projectId, worktreePath)
    if (!wt) return fail('Not a worktree of this project.')
    const listed = await listWorktrees(wt.repoPath)
    const branch = listed
      .find((w) => w.path === worktreePath)
      ?.branch?.replace(/^refs\/heads\//, '')
    if (!branch) return fail('This worktree has no branch.')
    const pr = (await pullRequestsByBranch(wt.repoPath)).get(branch)
    if (pr?.state !== 'MERGED') return fail('Could not confirm the pull request is merged.')
    if (await hasUncommittedChanges(worktreePath))
      return fail('This worktree has uncommitted changes. Commit or discard them first.')

    const liveSessions = await discoverLiveSessions()
    const busy = busySessionIn(worktreePath, liveSessions)
    if (busy)
      return fail(
        busy.waiting
          ? 'Claude is waiting on you in this worktree. Answer it or stop it first.'
          : 'Claude is still working in this worktree. Let it finish or stop it first.'
      )

    await retireSessionsInWorktree(worktreePath)
    await closePanesIn(worktreePath, liveSessions)
    const removed = await removeWorktreeClean(wt.repoPath, worktreePath)
    if (!removed.ok) return fail(removed.error ?? 'Could not remove the worktree.')
    await pruneWorktrees(wt.repoPath)

    const branchDeleted = (await deleteMergedBranch(wt.repoPath, branch, pr)).ok
    return {
      ok: true,
      branchDeleted,
      note: branchDeleted
        ? undefined
        : `Kept the branch ${branch}: it has commits that are not on GitHub.`
    }
  })

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
