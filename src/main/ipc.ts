import { ipcMain, dialog, BrowserWindow, shell, app, clipboard } from 'electron'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import parseDiff from 'parse-diff'
import {
  addProject,
  removeProject,
  updateProject,
  getState,
  mutate,
  updateSettings
} from './store/store'
import {
  listPanes,
  capturePane,
  sendKeys,
  selectWindow,
  listClients,
  hasSession,
  newSession,
  newWindow,
  killWindow,
  splitWindow,
  focusPane,
  listWindowPanes,
  killPane
} from './exec/tmux'
import { attachControlSession, wireLayoutEvents } from './exec/tmux-control'
import { startPty, writePty, resizePty, stopPty, onPtyOutput, onPtyExit } from './exec/tmux-pty'
import {
  listCliHistory,
  listTypedPromptHistory,
  getContextWindowUsageForSession
} from './exec/transcripts'
import {
  listAgents,
  readSessionFiles,
  resumeSession,
  relaunchInSession,
  resumeCommand,
  isTransitionGuarded,
  isResuming,
  stopBackgroundAgent,
  killProcess
} from './exec/claude'
import {
  listWorktrees,
  findMainCheckout,
  branchOfWorktree,
  mergeBase,
  diffPatch,
  untrackedFiles,
  removeWorktree as gitRemoveWorktree,
  pruneWorktrees,
  gitStatus,
  gitStage,
  gitCommit,
  gitLog,
  fetchOrigin,
  localBranchExists,
  remoteBranchExists,
  addWorktreeNewBranch,
  addWorktreeExistingLocalBranch,
  addWorktreeExistingRemoteBranch,
  hasUncommittedChanges,
  listBranchesForCheckout,
  resolveRemoteBranch,
  getDefaultBranch,
  prStatesForBranches,
  lastCommitTime,
  commitTimesSince,
  remoteTrackingRefExists
} from './exec/git'
import {
  isWithinRoots,
  listFileTree,
  readProjectFile,
  writeProjectFile,
  searchProjectFiles
} from './exec/files'
import { listSkills, createSkill } from './exec/skills'
import {
  validateAttachmentPath,
  stashDroppedFile,
  writePastedImage,
  writePastedText
} from './exec/attachments'
import { listRules, appendRule, restoreRuleBackup } from './exec/rules'
import { openInCursor } from './exec/cursor'
import { run } from './exec/run'
import { discoverLiveSessions, invalidateAgentsCache, SHELL_COMMANDS } from './engine/discovery'
import { acknowledgeSession } from './engine/status'
import { markSeen, markUnread } from './engine/seen'
import {
  jiraStatus,
  configureJira,
  disconnectJira,
  loadBoard,
  loadIssueDetail,
  updateIssueText,
  addComment,
  moveToStatus,
  assignIssue,
  assignablePeople,
  setParent,
  moveToSprint,
  setPriority,
  setLabels,
  addBlockLink,
  removeBlockLink,
  setEstimate,
  addSlackLink,
  ticketPullRequests,
  issueTypes,
  createIssue,
  backlogPrefs,
  saveBacklogPrefs,
  sessionTicketLinks,
  linkSessionToTicket
} from './exec/jira'
import { triggerImmediateTick } from './engine/poller'
import { pullRequestFor } from './exec/pullRequests'
import { currentBranch } from './engine/sessionBranch'
import type { JiraCreateInput, BacklogPrefs } from './exec/jira'
import {
  carryClaudeLocalSettings,
  createSession,
  deleteSession,
  type CreateSessionInput,
  type DeleteSessionInput
} from './engine/sessions'
import { getBoundHookPort } from './engine/hooks-server'
import {
  mergeHooksIntoSettings,
  removeHooksFromSettings,
  buildOurHooksConfig,
  missingHookEvents,
  CLAUDE_SETTINGS_PATH
} from './engine/hooks-settings'
import type { SessionRecord, AppSettings, Project } from './store/types'
import { registerBacklogIpc } from './ipc-backlog'
import { registerSessionsIpc } from './ipc-sessions'
import { registerProjectsIpc } from './ipc-projects'
import { registerPaletteIpc } from './ipc-palette'
import { log } from './log'

const MAX_DIFF_PATCH_BYTES = 2 * 1024 * 1024

// U7 Git/Files handlers (plan 2.2) share this: the renderer has no OS access
// (CLAUDE.md non-negotiable) so it never holds or round-trips a filesystem
// path — it passes only ids. `sessionId`, when given, is looked up here
// against the live state to get that session's worktreePath; omitted, the
// project's own main checkout is used. Either way the resulting path is
// re-validated with isWithinRoots against the project's registered roots
// (its main checkout and its worktree root, both already resolved and
// trusted — they came from projects:add / findMainCheckout, never from the
// renderer) before anything reads or writes through it. A sessionId for a
// different project, or one that no longer exists, resolves to null.
function resolveFilesRoot(project: Project, sessionId?: string): string | null {
  if (!sessionId) return isWithinRoots([project.repoPath, project.worktreeRoot], project.repoPath)
  const session = getState().sessions.find((s) => s.id === sessionId)
  if (!session || session.projectId !== project.id) return null
  return isWithinRoots([project.repoPath, project.worktreeRoot], session.worktreePath)
}

// ---- Projects list tidy-up strip -----------------------------------------
// One summary per project for the Projects list: what is left lying around
// (open PRs, branches never pushed, idle worktrees) and how many commits
// landed on each of the last seven days.

export interface ProjectTidy {
  openPrs: number
  neverPushed: number
  idleWorktrees: number
  /** Seven local days, oldest first, ending today. */
  activity: number[]
}

const TIDY_CACHE_MS = 2 * 60 * 1000
const IDLE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
const tidyCache = new Map<string, { at: number; result: ProjectTidy }>()
const tidyInFlight = new Map<string, Promise<ProjectTidy>>()

const emptyTidy = (): ProjectTidy => ({
  openPrs: 0,
  neverPushed: 0,
  idleWorktrees: 0,
  activity: [0, 0, 0, 0, 0, 0, 0]
})

/** Runs `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Buckets commit times into the seven local days ending today, oldest first. */
function activityByDay(times: number[], now = new Date()): number[] {
  const starts = Array.from({ length: 7 }, (_, i) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + i).getTime()
  )
  const counts = [0, 0, 0, 0, 0, 0, 0]
  for (const t of times) {
    if (t < starts[0]) continue
    let day = 6
    while (day > 0 && t < starts[day]) day--
    counts[day]++
  }
  return counts
}

async function computeProjectTidy(project: Project): Promise<ProjectTidy> {
  const [worktrees, prStates, commitTimes] = await Promise.all([
    listWorktrees(project.repoPath),
    prStatesForBranches(project.repoPath),
    commitTimesSince(project.repoPath, 7)
  ])
  const attached = new Set(getState().sessions.map((s) => s.worktreePath))
  const now = Date.now()
  const others = worktrees.filter((w) => w.path !== project.repoPath && !w.bare)

  const perWorktree = await mapLimit(others, 4, async (w) => {
    const branch = w.branch?.replace(/^refs\/heads\//, '') ?? null
    const openPr = branch !== null && prStates.get(branch) === 'OPEN'
    let neverPushed = false
    if (branch !== null && !w.prunable) {
      const status = await gitStatus(w.path)
      neverPushed =
        status.upstream === null && !(await remoteTrackingRefExists(project.repoPath, branch))
    }
    let idle = false
    if (!attached.has(w.path) && !w.prunable) {
      const last = await lastCommitTime(w.path)
      idle = last !== null && now - last > IDLE_AFTER_MS
    }
    return { openPr, neverPushed, idle }
  })

  return {
    openPrs: perWorktree.filter((w) => w.openPr).length,
    neverPushed: perWorktree.filter((w) => w.neverPushed).length,
    idleWorktrees: perWorktree.filter((w) => w.idle).length,
    activity: activityByDay(commitTimes)
  }
}

/** Cached for two minutes per project; `force` skips the cache (after a cleanup). Never throws. */
async function projectTidy(projectId: string, force = false): Promise<ProjectTidy> {
  const project = getState().projects.find((p) => p.id === projectId)
  if (!project) return emptyTidy()
  const cached = tidyCache.get(projectId)
  if (!force && cached && Date.now() - cached.at < TIDY_CACHE_MS) return cached.result
  const pending = tidyInFlight.get(projectId)
  if (pending) return pending
  const job = computeProjectTidy(project)
    .catch((err) => {
      log.warn('projects:tidy failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err)
      })
      return emptyTidy()
    })
    .then((result) => {
      tidyCache.set(projectId, { at: Date.now(), result })
      return result
    })
    .finally(() => tidyInFlight.delete(projectId))
  tidyInFlight.set(projectId, job)
  return job
}

/** Every ipcMain.handle lives here. */
export function registerIpcHandlers(): void {
  ipcMain.handle('projects:tidy', (_evt, projectId: string, force?: boolean) =>
    projectTidy(projectId, force === true)
  )

  registerBacklogIpc()
  registerSessionsIpc()
  registerProjectsIpc()
  registerPaletteIpc()

  ipcMain.handle('projects:list', async () => {
    return getState().projects
  })

  ipcMain.handle('projects:add', async () => {
    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    if (result.canceled || result.filePaths.length === 0) return null

    const chosenPath = result.filePaths[0]
    const repoPath = await findMainCheckout(chosenPath)
    if (!repoPath) {
      log.warn('projects:add — not a git repository', { chosenPath })
      return null
    }

    return addProject({
      name: basename(repoPath),
      repoPath,
      worktreeRoot: `${repoPath}.worktrees`,
      workspacesDir: `${repoPath}.worktrees/.workspaces`,
      baseRef: 'origin/main',
      tmuxSession: 'wt',
      agentCommand: 'claude'
    })
  })

  ipcMain.handle('projects:remove', async (_evt, id: string) => {
    // Only ever removes the id from state.json — never touches the repo or
    // its worktrees on disk (plan 2.1 / non-negotiable).
    removeProject(id)
  })

  ipcMain.handle(
    'projects:update',
    async (_evt, id: string, patch: { name?: string; pinned?: boolean; baseRef?: string }) => {
      return updateProject(id, patch)
    }
  )

  // Worktrees on disk with no SessionRecord attached (plan 2.2, "Worktrees
  // (n)"). No existing handler covered this — readdir via `git worktree
  // list` and diff against known session worktreePaths for the project.
  ipcMain.handle('projects:worktrees', async (_evt, projectId: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project) return []

    const known = new Set(
      getState()
        .sessions.filter((s) => s.projectId === projectId)
        .map((s) => s.worktreePath)
    )

    const worktrees = await listWorktrees(project.repoPath)
    return worktrees
      .filter((w) => w.path !== project.repoPath && !w.bare && !known.has(w.path))
      .map((w) => ({ path: w.path, branch: w.branch }))
  })

  // Registers an existing worktree as a session with no live tmux pane —
  // it shows as 'stopped' until the user attaches or starts something in it.
  // Adopting never creates or moves anything on disk.
  ipcMain.handle('worktrees:adopt', async (_evt, projectId: string, worktreePath: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project) return null

    const branch = (await branchOfWorktree(worktreePath)) ?? 'unknown'
    const dirName = worktreePath.split('/').pop() ?? branch.replaceAll('/', '-')

    const record: SessionRecord = {
      id: randomUUID(),
      projectId,
      title: dirName,
      branch,
      dirName,
      worktreePath,
      workspaceFile: null,
      tmuxSessionName: project.tmuxSession,
      tmuxWindowName: dirName.replace(/[:.]/g, '-'),
      tmuxWindowId: null,
      tmuxPaneId: null,
      claudeSessionId: null,
      origin: 'discovered',
      createdAt: Date.now(),
      archivedAt: null,
      lastPrompt: null,
      originalClaudeSessionId: null,
      startKind: 'create',
      waitingReason: null
    }

    mutate((draft) => {
      draft.sessions.push(record)
    })

    return record
  })

  // Removes an unattached worktree from disk via `git worktree remove` —
  // this is a deliberate git operation on a worktree the user chose to drop,
  // not the "never touch the repo" rule for *project* removal above.
  ipcMain.handle('worktrees:remove', async (_evt, projectId: string, worktreePath: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project) return false
    const ok = await gitRemoveWorktree(project.repoPath, worktreePath)
    await pruneWorktrees(project.repoPath)
    return ok
  })

  ipcMain.handle('sessions:list', async () => {
    // Discovery touches tmux, the filesystem and the transcripts, so it has
    // plenty of ways to fail. A rejection here crosses IPC as a rejected
    // promise the renderer never catches, and the list silently stays empty —
    // "No sessions yet" over a machine with twenty running agents. Log it and
    // say how long it took, so a slow poll and a broken one look different.
    const startedAt = Date.now()
    try {
      const sessions = await discoverLiveSessions()
      const ms = Date.now() - startedAt
      if (ms > 1500) log.warn('sessions: discovery slow', { ms, count: sessions.length })
      return sessions
    } catch (err) {
      log.error('sessions: discovery failed', {
        error: String(err),
        ms: Date.now() - startedAt
      })
      throw err
    }
  })

  // Project detail's "Recent sessions" (plan 2.2) needs archived records too
  // — discoverLiveSessions() deliberately drops them (they have no live
  // status to compute). Raw records straight from state, newest first.
  ipcMain.handle('sessions:recordsForProject', async (_evt, projectId: string) => {
    return getState()
      .sessions.filter((s) => s.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
  })

  // Turns a "Found in terminal" live session into a first-class, persisted
  // SessionRecord — after this it can show 'stopped'/'missing' like any
  // app-created session once its live process goes away.
  ipcMain.handle('sessions:adopt', async (_evt, liveKey: string, projectId: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project) return null

    const live = (await discoverLiveSessions()).find((s) => s.key === liveKey)
    if (!live || live.record) return null // already adopted, or no longer live

    const branch = (await branchOfWorktree(live.cwd)) ?? 'unknown'
    const dirName = live.cwd.split('/').pop() ?? branch.replaceAll('/', '-')

    const record: SessionRecord = {
      id: randomUUID(),
      projectId,
      title: live.agentName ?? branch,
      branch,
      dirName,
      worktreePath: live.cwd,
      workspaceFile: null,
      tmuxSessionName: live.tmux?.sessionName ?? project.tmuxSession,
      tmuxWindowName: live.tmux?.windowName ?? dirName,
      tmuxWindowId: live.tmux?.windowId ?? null,
      tmuxPaneId: live.tmux?.paneId ?? null,
      claudeSessionId: live.claudeSessionId,
      origin: 'discovered',
      createdAt: Date.now(),
      archivedAt: null,
      lastPrompt: null,
      originalClaudeSessionId: null,
      startKind: 'create',
      waitingReason: null
    }

    mutate((draft) => {
      draft.sessions.push(record)
    })

    return record
  })

  ipcMain.handle('session:pane', async (_evt, paneId: string, lines?: number) => {
    return capturePane(paneId, lines ?? 2000)
  })

  ipcMain.handle('session:sendKeys', async (_evt, paneId: string, text: string) => {
    return sendKeys(paneId, text)
  })

  ipcMain.handle('session:openIde', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    // Prefer the workspace file (it carries the interpreter and tasks), but fall
    // back to the worktree when it was never written or has been removed.
    const workspace = record.workspaceFile
    const target = workspace && existsSync(workspace) ? workspace : record.worktreePath
    return openInCursor(target)
  })

  ipcMain.handle('session:focusTerminal', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record || !record.tmuxWindowId) {
      return { ok: false, error: 'no tmux window recorded for this session' }
    }

    await selectWindow(record.tmuxSessionName, record.tmuxWindowId)

    const clients = await listClients(record.tmuxSessionName)
    if (clients.length === 0) {
      // Do not try to launch a terminal running attach — that path is
      // fiddly and terminal-specific. Surface the command instead.
      return { ok: false, noClients: true, tmuxSessionName: record.tmuxSessionName }
    }

    const settings = getState().settings
    await run('open', ['-a', settings.terminalApp])
    return { ok: true }
  })

  ipcMain.handle('session:diff', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return null

    const project = getState().projects.find((p) => p.id === record.projectId)
    const baseRef = project?.baseRef ?? 'origin/main'
    const base = await mergeBase(record.worktreePath, baseRef)
    if (!base) {
      return { base: null, files: [], patch: '', untracked: [], truncated: false }
    }

    const rawPatch = await diffPatch(record.worktreePath, base)
    const truncated = Buffer.byteLength(rawPatch, 'utf8') > MAX_DIFF_PATCH_BYTES
    const patch = truncated ? rawPatch.slice(0, MAX_DIFF_PATCH_BYTES) : rawPatch

    let files: Array<{ path: string; added: number; removed: number; status: string }> = []
    try {
      files = parseDiff(rawPatch).map((f) => ({
        path: f.to && f.to !== '/dev/null' ? f.to : (f.from ?? 'unknown'),
        added: f.additions,
        removed: f.deletions,
        status: f.new ? 'added' : f.deleted ? 'deleted' : f.from !== f.to ? 'renamed' : 'modified'
      }))
    } catch (err) {
      log.error('session:diff — failed to parse patch', { error: String(err) })
    }

    const untracked = await untrackedFiles(record.worktreePath)

    return { base, files, patch, untracked, truncated }
  })

  ipcMain.handle('session:acknowledge', async (_evt, sessionKey: string) => {
    acknowledgeSession(sessionKey)
    markSeen(sessionKey)
    triggerImmediateTick()
  })

  ipcMain.handle('session:markUnread', async (_evt, sessionKey: string) => {
    markUnread(sessionKey)
    triggerImmediateTick()
  })

  ipcMain.handle('sessions:create', async (_evt, input: CreateSessionInput) => {
    return createSession(input)
  })

  ipcMain.handle(
    'sessions:delete',
    async (_evt, id: string, options: { removeWorktree: boolean; discardChanges?: boolean }) => {
      const input: DeleteSessionInput = {
        id,
        removeWorktree: options.removeWorktree,
        discardChanges: options.discardChanges ?? false
      }
      return deleteSession(input)
    }
  )

  // ---------------------------------------------------------------------
  // Attachments (Home composer's paperclip / paste / drag-drop). Never a
  // copy: a path from the file dialog or a drop is referenced where it
  // already lives on disk (CLAUDE.md — a worktree is a git checkout and
  // must not accumulate stray files) — main only validates it is real, a
  // plain file, readable and under the size cap before it can reach a
  // prompt. The one exception is pasted clipboard image bytes, which have
  // no path to reference and are written to the OS temp dir instead
  // (exec/attachments.ts).

  ipcMain.handle('attachments:pick', async () => {
    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    return result.filePaths.map(validateAttachmentPath)
  })

  // Drag-and-drop from Finder: the renderer resolves each dropped File to a
  // real path itself via webUtils.getPathForFile (preload's own bridge —
  // there is no other way to get a path off a browser File) and sends us
  // only the resulting strings. Those are exactly as trustworthy as any
  // other renderer-supplied string, i.e. not at all — validated here the
  // same as the dialog's own output before anything touches a prompt.
  ipcMain.handle('attachments:addPaths', async (_evt, paths: string[]) => {
    return (paths ?? []).map(validateAttachmentPath)
  })

  // Dropped files: like addPaths, except a file sitting in the temp folder
  // (a screenshot fresh from its preview thumbnail) is copied first, because
  // macOS deletes it moments after the drop.
  ipcMain.handle('attachments:addDropped', async (_evt, paths: string[]) => {
    return (paths ?? []).map(stashDroppedFile)
  })

  ipcMain.handle('attachments:pasteImage', async (_evt, bytes: Uint8Array, mimeType: string) => {
    return writePastedImage(bytes, mimeType)
  })

  ipcMain.handle('attachments:pasteText', async (_evt, text: string, lines: number) => {
    return writePastedText(text, lines)
  })

  // A session found live in a terminal but never adopted into a project has
  // no SessionRecord — nothing for sessions:delete to act on. But it always
  // has a real tmux window, and a user must always be able to end a session
  // they can see, adopted or not. killWindow targets by the window's own
  // @N id, which is unique across the whole tmux server — no session-name
  // prefix-matching risk, unlike a session-level kill.
  ipcMain.handle('sessions:killWindow', async (_evt, windowId: string) => {
    if (!/^@\d+$/.test(windowId)) return { ok: false, error: 'invalid window id' }
    const ok = await killWindow(windowId)
    return ok ? { ok: true } : { ok: false, error: 'failed to close the terminal window' }
  })

  // A background agent has neither a tmux window nor a pid we can act on —
  // `claude stop <id>` is the only (and the documented, safe) way to end
  // one. Its own agent id, not a SessionRecord id.
  ipcMain.handle('sessions:stopBackgroundAgent', async (_evt, agentId: string) => {
    invalidateAgentsCache()
    if (!agentId) return { ok: false, error: 'missing agent id' }
    const ok = await stopBackgroundAgent(agentId)
    return ok ? { ok: true } : { ok: false, error: 'failed to stop the background agent' }
  })

  // Last resort for a record-less session with no live tmux window and no
  // `agents --json` id — only its pid remains. Same trust boundary the
  // liveness check already uses for this pid: the renderer only ever holds
  // one our own discovery pass handed it.
  ipcMain.handle('sessions:killProcess', (_evt, pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'invalid pid' }
    const ok = killProcess(pid)
    return ok ? { ok: true } : { ok: false, error: 'failed to end the process' }
  })

  // `claude stop` can genuinely fail against a wedged background agent (its
  // own background service unresponsive) — this never claims the agent
  // itself stopped, only that Control Room stops showing it.
  ipcMain.handle('sessions:dismissBackgroundAgent', (_evt, agentId: string) => {
    invalidateAgentsCache()
    if (!agentId) return { ok: false, error: 'missing agent id' }
    mutate((draft) => {
      if (!draft.dismissedBackgroundAgentIds.includes(agentId)) {
        draft.dismissedBackgroundAgentIds.push(agentId)
      }
    })
    return { ok: true }
  })

  ipcMain.handle('hooks:status', async () => {
    const settings = getState().settings
    const boundPort = getBoundHookPort()
    const previewUrl = boundPort ? `http://127.0.0.1:${boundPort}/hook` : null
    return {
      hooksInstalled: settings.hooksInstalled,
      hooksInstalledUrl: settings.hooksInstalledUrl,
      // Installed, but from before some events were added: pressing Install
      // again adds them (it merges, and backs the file up first).
      missingHookEvents:
        settings.hooksInstalled && settings.hooksInstalledUrl
          ? missingHookEvents(CLAUDE_SETTINGS_PATH, settings.hooksInstalledUrl)
          : [],
      boundPort,
      previewUrl,
      previewConfig: previewUrl ? buildOurHooksConfig(previewUrl) : null
    }
  })

  // Only ever runs from an explicit button click — never on startup.
  ipcMain.handle('hooks:install', async () => {
    const boundPort = getBoundHookPort()
    if (!boundPort) return { ok: false, error: 'hook server is not listening: still polling-only' }

    const url = `http://127.0.0.1:${boundPort}/hook`
    const result = mergeHooksIntoSettings(CLAUDE_SETTINGS_PATH, url)
    if (result.ok) updateSettings({ hooksInstalled: true, hooksInstalledUrl: url })
    return result
  })

  ipcMain.handle('hooks:uninstall', async () => {
    const result = removeHooksFromSettings(CLAUDE_SETTINGS_PATH)
    if (result.ok) updateSettings({ hooksInstalled: false, hooksInstalledUrl: null })
    return result
  })

  ipcMain.handle('settings:get', async () => {
    return getState().settings
  })

  ipcMain.handle('settings:set', async (_evt, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch)
    // Broadcast, because settings are read by components that mount long
    // before Settings is opened. The terminal's text size is the case that
    // forced this: it read the value once on mount, so changing it did
    // nothing at all until the session was closed and reopened.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings:changed', next)
    }
    return next
  })

  // AppShell's overflow menu — "Open data folder". `shell.openPath` is an
  // Electron API (reveals a path in Finder/Explorer), not a spawn, so it
  // doesn't go through exec/run.ts. Returns '' on success, an error string
  // on failure (matches shell.openPath's own contract).
  // Jira, for the Backlog screen. The token goes in once and never comes back
  // out to the renderer — jira:status reports only whether it's set.
  ipcMain.handle('jira:status', () => jiraStatus())
  ipcMain.handle(
    'jira:configure',
    (_evt, input: { site: string; email: string; token: string; projects: string[] }) =>
      configureJira(input)
  )
  ipcMain.handle('jira:disconnect', () => disconnectJira())
  ipcMain.handle('jira:board', (_evt, refresh?: boolean) => loadBoard(Boolean(refresh)))
  ipcMain.handle('jira:detail', (_evt, key: string) => loadIssueDetail(key))
  ipcMain.handle(
    'jira:updateText',
    (_evt, key: string, patch: { summary?: string; descriptionWiki?: string }) =>
      updateIssueText(key, patch)
  )
  ipcMain.handle('jira:comment', (_evt, key: string, body: string, internal?: boolean) =>
    addComment(key, body, internal === true)
  )
  ipcMain.handle('jira:move', (_evt, key: string, status: string) => moveToStatus(key, status))
  ipcMain.handle('jira:assign', (_evt, key: string, who: boolean | string) => assignIssue(key, who))
  ipcMain.handle('jira:assignable', () => assignablePeople())
  // A screen that crashed, from the renderer's ScreenBoundary.
  ipcMain.handle(
    'log:rendererError',
    (_evt, detail: { screen: string; message: string; stack?: string; component?: string }) => {
      log.error('renderer: screen crashed', detail)
    }
  )
  ipcMain.handle('jira:parent', (_evt, key: string, parent: string | null) =>
    setParent(key, parent)
  )
  // Local only: which sessions belong to which tickets.
  ipcMain.handle('jira:links', () => sessionTicketLinks())
  ipcMain.handle('jira:link', (_evt, recordId: string, issueKey: string | null) =>
    linkSessionToTicket(recordId, issueKey)
  )
  ipcMain.handle('jira:sprint', (_evt, key: string, sprintId: number | null) =>
    moveToSprint(key, sprintId)
  )
  ipcMain.handle('jira:priority', (_evt, key: string, priority: string) =>
    setPriority(key, priority)
  )
  ipcMain.handle('jira:labels', (_evt, key: string, labels: string[]) => setLabels(key, labels))
  ipcMain.handle(
    'jira:addBlock',
    (_evt, key: string, other: string, direction: 'blockedBy' | 'blocking') =>
      addBlockLink(key, other, direction === 'blocking' ? 'blocking' : 'blockedBy')
  )
  ipcMain.handle('jira:removeBlock', (_evt, key: string, linkId: string) =>
    removeBlockLink(key, linkId)
  )
  ipcMain.handle('jira:estimate', (_evt, key: string, estimate: string | null) =>
    setEstimate(key, estimate)
  )
  ipcMain.handle('jira:slackLink', (_evt, key: string, url: string) => addSlackLink(key, url))
  ipcMain.handle('jira:pullRequests', (_evt, key: string) => ticketPullRequests(key))
  ipcMain.handle('jira:issueTypes', (_evt, project: string) => issueTypes(project))
  ipcMain.handle('jira:create', (_evt, input: JiraCreateInput) => createIssue(input))
  ipcMain.handle('backlog:prefs', () => backlogPrefs())
  ipcMain.handle('backlog:savePrefs', (_evt, patch: Partial<BacklogPrefs>) =>
    saveBacklogPrefs(patch)
  )
  ipcMain.handle('sessions:pullRequest', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record || record.investigation || record.deletedAt) return null
    // The branch it's on now: a detached session's work isn't on `main`.
    const branch = await currentBranch(record)
    return branch ? pullRequestFor(record.id, record.worktreePath, branch) : null
  })

  // ⌘W with no session tab to close falls back to what it always did.
  ipcMain.handle('window:close', (evt) => {
    BrowserWindow.fromWebContents(evt.sender)?.close()
  })

  ipcMain.handle('app:openDataFolder', async () => {
    return shell.openPath(app.getPath('userData'))
  })

  // Clicking a link in the terminal. xterm's web-links addon opens links with
  // window.open, which Electron denies for an external URL unless a window
  // open handler is registered — so the browser confirm appeared, you pressed
  // OK, and nothing happened at all.
  //
  // The URL comes out of tmux pane output, which is untrusted (CLAUDE.md), so
  // main decides what is openable rather than trusting what it is handed:
  // http and https only. file:// would open anything on disk and javascript:
  // and data: are code, none of which a link in a terminal gets to ask for.
  ipcMain.handle('app:openExternal', async (_evt, url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return 'not a URL'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log.warn('openExternal: refused non-web link', { protocol: parsed.protocol })
      return `refused ${parsed.protocol} link: only http and https open`
    }
    await shell.openExternal(parsed.toString())
    return ''
  })

  // ---------------------------------------------------------------------
  // U7 — Git tab (plan 2.2). `sessionId` is optional on every one of these;
  // omitted, it defaults to the project's main checkout. The renderer sends
  // only the id — never a worktree path — and main resolves it to a
  // validated real path via resolveFilesRoot above.

  // Branches a new session can check out: open PRs first, then origin's.
  ipcMain.handle('git:resolveBranch', async (_evt, projectId: string, name: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project || project.id === 'general') return { ok: false, error: 'no project' }
    return resolveRemoteBranch(project.repoPath, name)
  })
  ipcMain.handle('git:defaultBranch', async (_evt, projectId: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project || project.id === 'general') return 'main'
    return getDefaultBranch(project.repoPath)
  })
  ipcMain.handle('git:checkoutBranches', async (_evt, projectId: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project || project.id === 'general' || !project.repoPath) return []
    return listBranchesForCheckout(project.repoPath)
  })

  ipcMain.handle('git:status', async (_evt, projectId: string, sessionId?: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    const root = project && resolveFilesRoot(project, sessionId)
    if (!root) return null
    return gitStatus(root)
  })

  ipcMain.handle(
    'git:stage',
    async (
      _evt,
      projectId: string,
      sessionId: string | undefined,
      paths: string[],
      stage: boolean
    ) => {
      const project = getState().projects.find((p) => p.id === projectId)
      const root = project && resolveFilesRoot(project, sessionId)
      if (!root) return false
      return gitStage(root, paths, stage)
    }
  )

  ipcMain.handle(
    'git:commit',
    async (_evt, projectId: string, sessionId: string | undefined, message: string) => {
      const project = getState().projects.find((p) => p.id === projectId)
      const root = project && resolveFilesRoot(project, sessionId)
      if (!root) return { ok: false, error: 'unknown project, session or path outside it' }
      return gitCommit(root, message)
    }
  )

  ipcMain.handle(
    'git:log',
    async (
      _evt,
      projectId: string,
      sessionId: string | undefined,
      opts?: { skip?: number; limit?: number }
    ) => {
      const project = getState().projects.find((p) => p.id === projectId)
      const root = project && resolveFilesRoot(project, sessionId)
      if (!root) return { commits: [], hasMore: false }
      return gitLog(root, opts ?? {})
    }
  )

  // ---------------------------------------------------------------------
  // U7 — Files tab (plan 2.2). `relPath` is always relative — the renderer
  // has no OS access and never sends an absolute path it constructed itself
  // (CLAUDE.md non-negotiable); files:write's refusal of anything outside a
  // registered project lives in exec/files.ts's resolveProjectPath, called
  // through readProjectFile/writeProjectFile below. `sessionId` is resolved
  // the same way as the Git handlers above — never a raw path from the
  // renderer.

  ipcMain.handle('files:tree', async (_evt, projectId: string, sessionId?: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    const root = project && resolveFilesRoot(project, sessionId)
    if (!root) return []
    return listFileTree(root)
  })

  ipcMain.handle(
    'files:read',
    async (_evt, projectId: string, sessionId: string | undefined, relPath: string) => {
      const project = getState().projects.find((p) => p.id === projectId)
      const root = project && resolveFilesRoot(project, sessionId)
      if (!root) return { ok: false, error: 'path is outside every registered project' }
      return readProjectFile([root], relPath)
    }
  )

  ipcMain.handle(
    'files:write',
    async (
      _evt,
      projectId: string,
      sessionId: string | undefined,
      relPath: string,
      content: string
    ) => {
      const project = getState().projects.find((p) => p.id === projectId)
      const root = project && resolveFilesRoot(project, sessionId)
      if (!root) return { ok: false, error: 'path is outside every registered project' }
      return writeProjectFile([root], relPath, content)
    }
  )

  ipcMain.handle(
    'files:search',
    async (_evt, projectId: string, sessionId: string | undefined, query: string) => {
      const project = getState().projects.find((p) => p.id === projectId)
      const root = project && resolveFilesRoot(project, sessionId)
      if (!root) return []
      return searchProjectFiles(root, query)
    }
  )

  // ---------------------------------------------------------------------
  // Skills tab (plan 3, section 2.6). Reads are unrestricted (only ever
  // list the two documented directories); skills:create sanitizes `name`
  // into a single path segment itself (exec/skills.ts) and refuses an
  // existing directory rather than overwrite it.

  ipcMain.handle('skills:list', async (_evt, projectId?: string) => {
    const project = projectId ? getState().projects.find((p) => p.id === projectId) : undefined
    return listSkills(project?.repoPath ?? null)
  })

  ipcMain.handle(
    'skills:create',
    async (
      _evt,
      scope: 'global' | 'project',
      projectId: string | undefined,
      name: string,
      description: string,
      body?: string
    ) => {
      const project = projectId ? getState().projects.find((p) => p.id === projectId) : undefined
      return createSkill(scope, project?.repoPath ?? null, name, description, body)
    }
  )

  // ---------------------------------------------------------------------
  // Rules tab (plan 3, section 2.7). rules:append is the only automatic
  // edit CLAUDE.md allows — append-only, always behind a timestamped
  // backup (exec/rules.ts), never a rewrite.

  ipcMain.handle('rules:list', async (_evt, projectId?: string) => {
    const project = projectId ? getState().projects.find((p) => p.id === projectId) : undefined
    return listRules(project?.repoPath ?? null)
  })

  ipcMain.handle(
    'rules:append',
    async (_evt, scope: 'global' | 'project', projectId: string | undefined, text: string) => {
      const project = projectId ? getState().projects.find((p) => p.id === projectId) : undefined
      return appendRule(scope, project?.repoPath ?? null, text)
    }
  )

  // The Undo toast on "Add to rules" — restores the exact backup appendRule
  // just wrote, byte-for-byte. restoreRuleBackup itself refuses any path
  // that isn't that scope's own fixed target plus its backup suffix.
  ipcMain.handle(
    'rules:restore',
    async (
      _evt,
      scope: 'global' | 'project',
      projectId: string | undefined,
      backupPath: string
    ) => {
      const project = projectId ? getState().projects.find((p) => p.id === projectId) : undefined
      return restoreRuleBackup(scope, project?.repoPath ?? null, backupPath)
    }
  )

  // ---------------------------------------------------------------------
  // Worktrees section (plan 3, section 2.3.3) — every worktree on disk for
  // a project, session or not, with its clean/dirty state. Distinct from
  // `projects:worktrees` above, which only lists *unattached* ones for the
  // adopt flow; this is the fuller "WORKTREES (n)" list. worktrees:create
  // does only the git half of sessions:create (engine/sessions.ts) — no
  // tmux window, no agent launch — because a worktree can outlive its agent
  // (CLAUDE.md).

  ipcMain.handle('worktrees:list', async (_evt, projectId: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project) return []

    const sessionByPath = new Map(
      getState()
        .sessions.filter((s) => s.projectId === projectId && !s.archivedAt)
        .map((s) => [s.worktreePath, s.id])
    )

    const worktrees = await listWorktrees(project.repoPath)
    return Promise.all(
      worktrees
        .filter((w) => !w.bare)
        .map(async (w) => ({
          path: w.path,
          branch: w.branch,
          isMainCheckout: w.path === project.repoPath,
          dirty: await hasUncommittedChanges(w.path),
          sessionId: sessionByPath.get(w.path) ?? null
        }))
    )
  })

  ipcMain.handle(
    'worktrees:create',
    async (_evt, projectId: string, branch: string, basedOn: 'new' | 'existing') => {
      const project = getState().projects.find((p) => p.id === projectId)
      if (!project) return { ok: false, error: 'project not found' }

      const dirName = branch.replaceAll('/', '-')
      const target = `${project.worktreeRoot}/${dirName}`
      if (existsSync(target)) return { ok: false, error: `${target} already exists` }

      const fetchOk = await fetchOrigin(project.repoPath)
      if (!fetchOk) return { ok: false, error: 'git fetch origin failed' }

      let worktreeOk = false
      if (basedOn === 'new') {
        worktreeOk = await addWorktreeNewBranch(project.repoPath, target, branch)
      } else if (await localBranchExists(project.repoPath, branch)) {
        worktreeOk = await addWorktreeExistingLocalBranch(project.repoPath, target, branch)
      } else if (await remoteBranchExists(project.repoPath, branch)) {
        worktreeOk = await addWorktreeExistingRemoteBranch(project.repoPath, target, branch)
      } else {
        return { ok: false, error: `branch '${branch}' not found locally or on origin` }
      }
      if (!worktreeOk) return { ok: false, error: 'git worktree add failed' }

      carryClaudeLocalSettings(project.repoPath, target)
      return { ok: true, path: target }
    }
  )

  // ---------------------------------------------------------------------
  // Recent / CLI history (plan 3, Part 4), both read-only, both from disk.

  ipcMain.handle('history:recent', async (_evt, projectId: string) => {
    return getState()
      .sessions.filter((s) => s.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        branch: s.branch,
        worktreePath: s.worktreePath,
        createdAt: s.createdAt,
        archivedAt: s.archivedAt,
        claudeSessionId: s.claudeSessionId
      }))
  })

  ipcMain.handle('history:cli', async (_evt, projectId?: string) => {
    const project = projectId ? getState().projects.find((p) => p.id === projectId) : undefined
    const roots = project ? [project.repoPath, project.worktreeRoot] : undefined
    return listCliHistory(roots)
  })

  ipcMain.handle('history:typedPrompts', async () => {
    return listTypedPromptHistory()
  })

  // Resume (or fork) a CLI transcript into a new tmux window, per Part 4:
  // "claude --resume <session-id> in a new tmux window in that cwd". The
  // renderer sends only ids/paths it read back from history:cli — it never
  // constructs a shell string itself (CLAUDE.md).
  ipcMain.handle(
    'history:resume',
    async (
      _evt,
      projectId: string,
      claudeSessionId: string,
      cwd: string,
      fork: boolean
    ): Promise<{ ok: boolean; error?: string }> => {
      const project = getState().projects.find((p) => p.id === projectId)
      if (!project) return { ok: false, error: 'project not found' }
      if (!existsSync(cwd)) return { ok: false, error: `${cwd} no longer exists on disk` }

      const winName = `resume-${claudeSessionId.slice(0, 8)}`
      const sessionStatus = await hasSession(project.tmuxSession)
      const created = sessionStatus.exists
        ? await newWindow(project.tmuxSession, winName, cwd)
        : await newSession(project.tmuxSession, winName, cwd)
      if (!created) return { ok: false, error: 'failed to create tmux window' }

      const command = fork
        ? `claude --resume ${claudeSessionId} --fork-session`
        : `claude --resume ${claudeSessionId}`
      const launched = await sendKeys(created.paneId, command)
      if (!launched) return { ok: false, error: 'failed to launch claude in the new window' }

      return { ok: true }
    }
  )

  // ---------------------------------------------------------------------
  // Live terminal transport (plan 4, Part 10 — supersedes plan 3 Part 3).
  // A real PTY (node-pty) per visible session, attached to a *grouped* tmux
  // session (`cr-view-<name>`) so our client size is independent of any
  // other client attached to the same target session — that's what stops
  // tmux clamping every window to the smallest attached client. tmux
  // control mode (`tmux -C`) stays wired, but only for the cheap
  // session-list-liveness signals; it no longer carries pixels. Renderer
  // sends only ids and text — never a path, never a shell string
  // (CLAUDE.md).
  //
  // Plan 7 audit fix: tmux-pty.ts now keys one real PTY per *pane*, not per
  // tmux session name — every project defaults its tmux session to 'wt', so
  // two sessions in the same project used to collide on one shared PTY
  // (session A silent, session B mislabelled with A's output, keystrokes
  // racing to whichever window the shared grouped session had last
  // selected). `terminal:attach`/`terminal:input` already carry a paneId
  // from the renderer, so they route on it directly.
  //
  // `terminal:resize` and `terminal:detach` do not — that call shape is
  // Terminal.tsx/api.ts (frozen for this fix; out of this file's ownership
  // lane), which only ever sends the tmux session name for those two calls.
  // `activeTerminalPane` tracks, per session name, the LIFO stack of panes
  // currently attached under it, purely to resolve those two calls back to
  // a real pane:
  //   - resize fans out to every pane attached under that session. Harmless
  //     to over-apply — it's idempotent, and the next real resize from
  //     whichever pane actually changed size corrects it again.
  //   - detach pops the most-recently-attached pane for that session and
  //     tears down only *that* pane's PTY (refcounted in tmux-pty.ts), so a
  //     still-open terminal is never killed by a different one closing.
  // `paneSession` is the reverse lookup, so output/exit events are tagged
  // with the pane the PTY actually belongs to — never "whichever pane
  // attached most recently", which was the root cause of the mislabelling.
  //
  // The stack is a multiset, not a set: it is never deduplicated on push. A
  // pane can legitimately be attached more than once before it is ever
  // detached (Terminal.tsx has no unmount cleanup that calls
  // terminalDetach, so any remount of the same pane — React StrictMode's
  // double-invoke in dev included — re-attaches without an intervening
  // detach), and `startPty` refcounts that exact case. Deduplicating here
  // would let one `terminal:detach` call pop a pane that was really
  // attached twice, leaving tmux-pty.ts's refcount stuck above zero and its
  // PTY never torn down. One stack entry per attach, one pop per detach,
  // keeps this side's bookkeeping matched to tmux-pty.ts's own count.

  const activeTerminalPane = new Map<string, string[]>()
  const paneSession = new Map<string, string>()

  function trackAttach(tmuxSessionName: string, paneId: string): void {
    paneSession.set(paneId, tmuxSessionName)
    const stack = activeTerminalPane.get(tmuxSessionName) ?? []
    stack.push(paneId)
    activeTerminalPane.set(tmuxSessionName, stack)
  }

  // Drops `paneId` from the liveness bookkeeping without tearing anything
  // down — used when its PTY has already exited on its own, so a later
  // resize/detach for its session never targets an already-dead pane.
  function untrackPane(paneId: string): void {
    const tmuxSessionName = paneSession.get(paneId)
    paneSession.delete(paneId)
    if (!tmuxSessionName) return
    const stack = activeTerminalPane.get(tmuxSessionName)
    if (!stack) return
    const next = stack.filter((p) => p !== paneId)
    if (next.length === 0) activeTerminalPane.delete(tmuxSessionName)
    else activeTerminalPane.set(tmuxSessionName, next)
  }

  onPtyOutput((paneId, data) => {
    const tmuxSessionName = paneSession.get(paneId) ?? ''
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('terminal:output', { tmuxSessionName, paneId, data })
    }
  })
  onPtyExit((paneId) => {
    const tmuxSessionName = paneSession.get(paneId) ?? ''
    untrackPane(paneId)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('terminal:exit', { tmuxSessionName, paneId })
    }
  })

  function wireLiveness(tmuxSessionName: string): void {
    wireLayoutEvents(
      tmuxSessionName,
      (line) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('terminal:layout', { tmuxSessionName, line })
        }
      },
      () => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('terminal:exit', { tmuxSessionName })
        }
      }
    )
  }

  ipcMain.handle(
    'terminal:attach',
    async (
      _evt,
      tmuxSessionName: string,
      paneId: string,
      scrollbackLines?: number,
      size?: { cols: number; rows: number }
    ) => {
      const backfill = await capturePane(paneId, scrollbackLines ?? 2000)
      trackAttach(tmuxSessionName, paneId)
      // Attach at the size the terminal already is. Starting at 80x24 and
      // resizing a moment later made tmux squeeze the window to 80 columns
      // and back on every tab switch, and the agent redrew at both widths.
      const cols = Number.isInteger(size?.cols) && size!.cols > 1 ? size!.cols : 80
      const rows = Number.isInteger(size?.rows) && size!.rows > 1 ? size!.rows : 24
      const result = await startPty(tmuxSessionName, cols, rows, paneId)
      // Liveness (%window-add/%window-close/%exit) is best-effort — never
      // let a control-mode hiccup fall the real PTY attach back to polling.
      void attachControlSession(tmuxSessionName).then((r) => {
        if (r.ok) wireLiveness(tmuxSessionName)
      })
      if (!result.ok) return { ok: false, fallback: true, reason: result.reason, backfill }
      return { ok: true, fallback: false, backfill }
    }
  )

  ipcMain.handle(
    'terminal:input',
    async (_evt, _tmuxSessionName: string, paneId: string, data: string) => {
      return writePty(paneId, data)
    }
  )

  ipcMain.handle(
    'terminal:resize',
    async (_evt, tmuxSessionName: string, cols: number, rows: number) => {
      const paneIds = activeTerminalPane.get(tmuxSessionName)
      if (!paneIds || paneIds.length === 0) return false
      let ok = false
      for (const paneId of paneIds) {
        if (resizePty(paneId, cols, rows)) ok = true
      }
      return ok
    }
  )

  // Detach the pane the renderer names. Popping "the most recent pane in this
  // tmux session" was wrong the moment tabs existed: every session lives in
  // one tmux session, and switching tabs raced — the old tab's detach landed
  // after the new tab's attach and killed the NEW terminal, which dropped to
  // "read-only, terminal lost connection". The pop stays as the fallback for
  // a caller that names no pane.
  ipcMain.handle('terminal:detach', async (_evt, tmuxSessionName: string, named?: string) => {
    const stack = activeTerminalPane.get(tmuxSessionName)
    let paneId: string | undefined
    if (named) {
      const at = stack?.lastIndexOf(named) ?? -1
      if (at === -1) return
      stack!.splice(at, 1)
      paneId = named
    } else {
      paneId = stack?.pop()
    }
    if (!paneId) return
    if (stack && stack.length === 0) activeTerminalPane.delete(tmuxSessionName)
    paneSession.delete(paneId)
    await stopPty(paneId)
  })

  // ---------------------------------------------------------------------
  // A second pane in a session's window (plan 7 — TerminalFrame's "add
  // terminal" control). No new PTY here — see exec/tmux.ts's header
  // comment: both panes live in the one window the session's existing PTY
  // is already attached to, and are presented as tabs (select + zoom) so
  // that single attached client always shows exactly one of them, full
  // size. `paneId` is always the session's own primary pane, sourced from
  // `record.tmuxPaneId` by way of TerminalFrame's props — never a value
  // the renderer constructs itself.

  ipcMain.handle('terminal:splitPane', async (_evt, paneId: string) => {
    const created = await splitWindow(paneId)
    if (!created.ok || !created.paneId) {
      return { ok: false, error: created.error ?? 'tmux split-window failed' }
    }
    // Restore the primary pane's full view — the split briefly halves it,
    // and the button's whole promise is "nothing changes until you switch
    // tabs". Best-effort: even if this one call fails, the split itself
    // succeeded and the renderer still gets the new pane id back.
    await focusPane(paneId)
    return { ok: true, paneId: created.paneId }
  })

  ipcMain.handle('terminal:focusPane', async (_evt, paneId: string) => {
    return focusPane(paneId)
  })

  ipcMain.handle('terminal:closePane', async (_evt, paneId: string) => {
    return killPane(paneId)
  })

  ipcMain.handle('terminal:listWindowPanes', async (_evt, paneId: string) => {
    return listWindowPanes(paneId)
  })

  // Dev-only probe for the M3 exec-layer verify step — compares against the
  // same tmux/claude/git commands run by hand.
  ipcMain.handle('debug:probe', async (_evt, repoPath?: string) => {
    const [panes, agents, sessions] = await Promise.all([
      listPanes(),
      listAgents(),
      readSessionFiles()
    ])
    const worktrees = repoPath ? await listWorktrees(repoPath) : []
    return { panes, sessions, agents, worktrees }
  })

  // =====================================================================
  // Part 4 — Session commands (plan 4)

  // Archive (plan 4 Part 4): sets archivedAt so the row files under Recent —
  // the worktree and branch are left exactly as they are. The renderer only
  // offers this when the session is not live (NOT_LIVE in preconditions.ts);
  // enforced again here so a stale menu state can't archive a live session.
  ipcMain.handle('sessions:archive', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    if (record.archivedAt) return { ok: false, error: 'this session is already archived' }
    // No liveness check: archiving takes a session off a project's Active
    // board and nothing else. The agent keeps running and the row stays in
    // the Sessions list — this is about what you want to look at.
    mutate((draft) => {
      const target = draft.sessions.find((s) => s.id === id)
      if (target) target.archivedAt = Date.now()
    })
    return { ok: true }
  })

  // The other half of archive. Archiving is how a session leaves a project's
  // Active board without anything being stopped or deleted, so there has to be
  // a way back — otherwise "remove" is a one-way door that looks like a tidy-up.
  ipcMain.handle('sessions:unarchive', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    if (!record.archivedAt) return { ok: false, error: 'this session is not archived' }
    mutate((draft) => {
      const target = draft.sessions.find((s) => s.id === id)
      if (target) target.archivedAt = null
    })
    return { ok: true }
  })

  // Rename (plan 4 Part 4): inline edit of SessionRecord.title, persisted.
  // An empty (or whitespace-only) name is rejected rather than silently
  // falling back to something invented.
  ipcMain.handle('sessions:rename', async (_evt, id: string, newTitle: string) => {
    const title = newTitle.trim()
    if (!title) return { ok: false, error: 'name cannot be empty' }
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    mutate((draft) => {
      const target = draft.sessions.find((s) => s.id === id)
      if (target) {
        target.title = title
        target.isCustomName = true
      }
    })
    return { ok: true }
  })

  // Resume (plan 4 Part 3): a dead pane can't be reattached, so this opens a
  // fresh tmux window and relaunches `claude --resume <id>` into it. Refuses
  // outright — rather than queueing or racing — when a resume for this
  // session is already in flight or the session transitioned moments ago;
  // the renderer should disable the control on those same preconditions
  // (ATTACH_LOCK_FREE in preconditions.ts) rather than let this reject.
  ipcMain.handle('sessions:resume', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    // Enforced here as well as hidden in the UI: a deleted session's worktree
    // is gone, so there is nowhere for it to start.
    if (record.deletedAt) {
      return { ok: false, error: 'this session was deleted: its worktree no longer exists' }
    }
    // Archived is where a resumable session waits, so Resume is the way out
    // of it — refusing here made the archive a dead end and forced the UI to
    // unarchive first, as a separate step that meant nothing on its own.
    if (record.archivedAt) {
      mutate((draft) => {
        const target = draft.sessions.find((s) => s.id === id)
        if (target) target.archivedAt = null
      })
    }
    if (!record.claudeSessionId) {
      return { ok: false, error: 'no Claude Code session id recorded for this session yet' }
    }
    if (isResuming(id) || isTransitionGuarded(id)) {
      return {
        ok: false,
        error: 'this session was just created or resumed - wait a few seconds and try again'
      }
    }

    const result = await resumeSession({
      sessionId: record.id,
      claudeSessionId: record.claudeSessionId,
      tmuxSessionName: record.tmuxSessionName,
      windowName: record.tmuxWindowName,
      cwd: record.worktreePath,
      fork: false
    })

    if (result.tmuxWindowId || result.newClaudeSessionId) {
      mutate((draft) => {
        const target = draft.sessions.find((s) => s.id === id)
        if (!target) return
        if (!target.originalClaudeSessionId) {
          target.originalClaudeSessionId = target.claudeSessionId
        }
        if (result.newClaudeSessionId) target.claudeSessionId = result.newClaudeSessionId
        if (result.tmuxWindowId) target.tmuxWindowId = result.tmuxWindowId
        if (result.tmuxPaneId) target.tmuxPaneId = result.tmuxPaneId
        target.startKind = 'resume'
        // Only clear waitingReason once the new session file actually
        // relinked (newClaudeSessionId set) — on a poll timeout the window
        // is open but unconfirmed, so the reason should stay until the next
        // poll resolves it one way or the other.
        if (result.newClaudeSessionId) target.waitingReason = null
      })
    }

    return result
  })

  // Start Claude again in a session whose Claude has exited (Ctrl-C, /exit,
  // a crash). 'new' is a fresh conversation, 'resume' carries on the last one.
  // Typed into the session's own pane when it's still open at a shell prompt
  // — never into a pane something else is running in — else a new window in
  // the same worktree.
  ipcMain.handle('sessions:relaunch', async (_evt, id: string, mode: 'new' | 'resume') => {
    const state = getState()
    const record = state.sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    if (record.deletedAt || !existsSync(record.worktreePath)) {
      return { ok: false, error: 'its worktree no longer exists, so there is nowhere to start it' }
    }
    const project = state.projects.find((p) => p.id === record.projectId)
    let command: string
    if (mode === 'resume') {
      const claudeId = record.claudeSessionId ?? record.originalClaudeSessionId
      if (!claudeId) return { ok: false, error: 'no conversation recorded to resume' }
      command = resumeCommand(claudeId)
    } else {
      const { defaultModel, defaultEffort } = state.settings
      command = `${project?.agentCommand ?? 'claude'} --model ${defaultModel} --effort ${defaultEffort}`
    }
    const pane = record.tmuxPaneId
      ? (await listPanes()).find((p) => p.paneId === record.tmuxPaneId)
      : undefined
    const shellPaneId = pane && SHELL_COMMANDS.has(pane.paneCommand) ? pane.paneId : null

    const result = await relaunchInSession({
      sessionId: record.id,
      tmuxSessionName: record.tmuxSessionName,
      windowName: record.tmuxWindowName,
      cwd: record.worktreePath,
      shellPaneId,
      command,
      // Late check-in: record the new conversation's id when it arrives.
      onRelinked: (claudeId) => {
        if (!claudeId) return
        mutate((draft) => {
          const target = draft.sessions.find((s) => s.id === id)
          if (!target || target.claudeSessionId === claudeId) return
          if (!target.originalClaudeSessionId)
            target.originalClaudeSessionId = target.claudeSessionId
          target.claudeSessionId = claudeId
        })
        triggerImmediateTick()
      }
    })
    if (result.ok) {
      mutate((draft) => {
        const target = draft.sessions.find((s) => s.id === id)
        if (!target) return
        // Starting it again means it isn't done any more.
        target.archivedAt = null
        target.waitingReason = null
        if (result.tmuxWindowId) target.tmuxWindowId = result.tmuxWindowId
        if (result.tmuxPaneId) target.tmuxPaneId = result.tmuxPaneId
        if (result.newClaudeSessionId) {
          if (!target.originalClaudeSessionId) {
            target.originalClaudeSessionId = target.claudeSessionId
          }
          target.claudeSessionId = result.newClaudeSessionId
        }
        target.startKind = mode === 'resume' ? 'resume' : target.startKind
      })
      triggerImmediateTick()
    }
    return result
  })

  // Clipboard handlers (plan 4 Part 4) — the renderer never touches the OS
  // clipboard itself, it sends the session id and main resolves the real
  // path/command, matching every other "renderer has no OS access" handler
  // above.
  ipcMain.handle('session:copyWorktreePath', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    clipboard.writeText(record.worktreePath)
    return { ok: true }
  })

  ipcMain.handle('session:copyAttachCommand', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'session not found' }
    if (!record.tmuxWindowId) {
      return { ok: false, error: 'no tmux window recorded for this session' }
    }
    const command = `tmux attach -t ${record.tmuxSessionName} \\; select-window -t ${record.tmuxSessionName}:${record.tmuxWindowId}`
    clipboard.writeText(command)
    return { ok: true }
  })

  // =====================================================================
  // Part 7 — Worktree settings (plan 4)

  ipcMain.handle(
    'projects:updateWorktreeDefaults',
    async (
      _evt,
      projectId: string,
      settings: {
        baseBranch?: string
        fetchBeforeCreate?: boolean
        postCheckoutCommand?: string
        preDeleteCommand?: string
        sparseDirectories?: string[]
        ignoredFilesMode?: 'symlink' | 'copy' | 'none'
      }
    ) => {
      const project = getState().projects.find((p) => p.id === projectId)
      if (!project) return { ok: false, error: 'project not found' }

      try {
        mutate((draft) => {
          const target = draft.projects.find((p) => p.id === projectId)
          if (!target) return
          if (settings.baseBranch !== undefined) target.worktreeBaseBranch = settings.baseBranch
          if (settings.fetchBeforeCreate !== undefined) {
            target.worktreeFetchBeforeCreate = settings.fetchBeforeCreate
          }
          if (settings.postCheckoutCommand !== undefined) {
            target.setupCommand = settings.postCheckoutCommand
          }
          if (settings.preDeleteCommand !== undefined) {
            target.worktreePreDeleteCommand = settings.preDeleteCommand
          }
          if (settings.sparseDirectories !== undefined) {
            target.worktreeSparseDirectories = settings.sparseDirectories
          }
          if (settings.ignoredFilesMode !== undefined) {
            target.ignoredFilesMode = settings.ignoredFilesMode
          }
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Context window usage (plan 4 Part 7.4) — reads assistant-line `usage`
  // straight out of the session's transcript; the renderer never parses the
  // JSONL itself. Returns null when there is no transcript to read yet.
  ipcMain.handle('session:contextWindow', async (_evt, sessionId: string) => {
    // Callers pass a SessionRecord id; transcripts on disk are named by Claude's
    // own session id. Passing the record id straight through meant this always
    // returned null, so no session ever showed a context percentage. Accept
    // either: resolve a record id when we have one, else treat it as a Claude id.
    const record = getState().sessions.find((s) => s.id === sessionId)
    const claudeId = record ? (record.claudeSessionId ?? record.originalClaudeSessionId) : sessionId
    if (!claudeId) return null
    return getContextWindowUsageForSession(claudeId)
  })
}
