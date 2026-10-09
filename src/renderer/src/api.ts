import type { AppSettings, LiveSession, Project, SessionRecord } from '../../main/store/types'
import type { HooksConfig } from '../../main/engine/hooks-settings'
import type { CliHistoryEntry, ContextWindowUsage } from '../../main/exec/transcripts'

// The only renderer file allowed to touch window.api — the renderer sends
// ids, never paths it acts on itself.

export function listProjects(): Promise<Project[]> {
  return window.api.invoke<Project[]>('projects:list')
}

export function addProject(): Promise<Project | null> {
  return window.api.invoke<Project | null>('projects:add')
}

export function removeProject(id: string): Promise<void> {
  return window.api.invoke<void>('projects:remove', id)
}

export function updateProject(
  id: string,
  patch: { name?: string; pinned?: boolean; baseRef?: string }
): Promise<Project | null> {
  return window.api.invoke<Project | null>('projects:update', id, patch)
}

export interface WorktreeDefaultsPatch {
  baseBranch?: string
  fetchBeforeCreate?: boolean
  postCheckoutCommand?: string
  preDeleteCommand?: string
  sparseDirectories?: string[]
  ignoredFilesMode?: 'symlink' | 'copy' | 'none'
}

export interface WorktreeDefaultsResult {
  ok: boolean
  error?: string
}

export function updateWorktreeDefaults(
  projectId: string,
  settings: WorktreeDefaultsPatch
): Promise<WorktreeDefaultsResult> {
  return window.api.invoke<WorktreeDefaultsResult>(
    'projects:updateWorktreeDefaults',
    projectId,
    settings
  )
}

export interface UnattachedWorktree {
  path: string
  branch: string | null
}

/** Every worktree the project has on disk, with the session using it, if any. */
export interface ProjectWorktree {
  path: string
  branch: string | null
  isMainCheckout: boolean
  dirty: boolean
  /** The session record whose worktree this is, or null when nothing runs in it. */
  sessionId: string | null
}

export function listAllWorktrees(projectId: string): Promise<ProjectWorktree[]> {
  return window.api.invoke<ProjectWorktree[]>('worktrees:list', projectId)
}

export function listProjectWorktrees(projectId: string): Promise<UnattachedWorktree[]> {
  return window.api.invoke<UnattachedWorktree[]>('projects:worktrees', projectId)
}

/** The Projects list's tidy-up strip: what's left lying around, and the last seven days' commits. */
export interface ProjectTidy {
  openPrs: number
  neverPushed: number
  idleWorktrees: number
  /** Commits per local day, oldest first, ending today. */
  activity: number[]
}

/** Cached in main for two minutes; `force` re-reads (after a cleanup). Zeros on any failure. */
export function getProjectTidy(projectId: string, force = false): Promise<ProjectTidy> {
  return window.api.invoke<ProjectTidy>('projects:tidy', projectId, force)
}

export function adoptWorktree(projectId: string, path: string): Promise<SessionRecord | null> {
  return window.api.invoke<SessionRecord | null>('worktrees:adopt', projectId, path)
}

export function removeWorktree(projectId: string, path: string): Promise<boolean> {
  return window.api.invoke<boolean>('worktrees:remove', projectId, path)
}

export function listSessions(): Promise<LiveSession[]> {
  return window.api.invoke<LiveSession[]>('sessions:list')
}

export function listSessionRecordsForProject(projectId: string): Promise<SessionRecord[]> {
  return window.api.invoke<SessionRecord[]>('sessions:recordsForProject', projectId)
}

export function listCliHistory(projectId: string): Promise<CliHistoryEntry[]> {
  return window.api.invoke<CliHistoryEntry[]>('history:cli', projectId)
}

export function resumeCliSession(
  projectId: string,
  claudeSessionId: string,
  cwd: string,
  fork: boolean
): Promise<{ ok: boolean; error?: string }> {
  return window.api.invoke<{ ok: boolean; error?: string }>(
    'history:resume',
    projectId,
    claudeSessionId,
    cwd,
    fork
  )
}

export function adoptSession(liveKey: string, projectId: string): Promise<SessionRecord | null> {
  return window.api.invoke<SessionRecord | null>('sessions:adopt', liveKey, projectId)
}

export function onSessionsChanged(fn: (sessions: LiveSession[]) => void): () => void {
  return window.api.on('sessions:changed', (payload) => fn(payload as LiveSession[]))
}

export interface HooksStatus {
  hooksInstalled: boolean
  hooksInstalledUrl: string | null
  /** Installed, but missing events added since. Install again to add them. */
  missingHookEvents: string[]
  boundPort: number | null
  previewUrl: string | null
  previewConfig: HooksConfig | null
}

export interface HooksActionResult {
  ok: boolean
  error?: string
  backupPath?: string
}

export function getHooksStatus(): Promise<HooksStatus> {
  return window.api.invoke<HooksStatus>('hooks:status')
}

export function installHooks(): Promise<HooksActionResult> {
  return window.api.invoke<HooksActionResult>('hooks:install')
}

export function uninstallHooks(): Promise<HooksActionResult> {
  return window.api.invoke<HooksActionResult>('hooks:uninstall')
}

export function onToast(fn: (message: string) => void): () => void {
  return window.api.on('toast', (payload) => fn(String(payload)))
}

export interface NavigatePayload {
  sessionId: string | null
  liveKey: string
}

// Clicking a notification sends this — the renderer opens that session's detail.
export function onNavigate(fn: (payload: NavigatePayload) => void): () => void {
  return window.api.on('navigate', (payload) => fn(payload as NavigatePayload))
}

export function getSessionPane(paneId: string, lines = 2000): Promise<string> {
  return window.api.invoke<string>('session:pane', paneId, lines)
}

export function sendKeysToSession(paneId: string, text: string): Promise<boolean> {
  return window.api.invoke<boolean>('session:sendKeys', paneId, text)
}

export interface OpenInIdeResult {
  ok: boolean
  error?: string
}

export function openSessionInIde(id: string): Promise<OpenInIdeResult> {
  return window.api.invoke<OpenInIdeResult>('session:openIde', id)
}

export interface FocusTerminalResult {
  ok: boolean
  noClients?: boolean
  tmuxSessionName?: string
  error?: string
}

export function focusSessionTerminal(id: string): Promise<FocusTerminalResult> {
  return window.api.invoke<FocusTerminalResult>('session:focusTerminal', id)
}

export interface SessionDiffFile {
  path: string
  added: number
  removed: number
  status: string
}

export interface SessionDiff {
  base: string | null
  files: SessionDiffFile[]
  patch: string
  untracked: string[]
  truncated: boolean
}

export function getSessionDiff(id: string): Promise<SessionDiff> {
  return window.api.invoke<SessionDiff>('session:diff', id)
}

export function acknowledgeSession(sessionKey: string): Promise<void> {
  return window.api.invoke<void>('session:acknowledge', sessionKey)
}

/** Opening the session clears it again. */
export function markSessionUnread(sessionKey: string): Promise<void> {
  return window.api.invoke<void>('session:markUnread', sessionKey)
}

export interface CreateSessionInput {
  /** Starting name, e.g. from a Jira issue; kept as a custom name. */
  title?: string
  creationId: string
  projectId: string
  // Required unless investigate is true.
  branch?: string
  basedOn?: 'new' | 'existing' | 'auto'
  prompt?: string
  investigate?: boolean
  // Home screen composer's model picker (plan 7, B1) — see engine/sessions.ts.
  model?: 'opus' | 'sonnet' | 'haiku'
  // Home screen composer's plan mode toggle — adds --permission-mode plan
  planMode?: boolean
  // Home screen composer's thinking-level picker — adds --effort <level>
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  // Home screen composer's attachments — absolute paths only, already
  // validated by main (see attachments:pick/addPaths/pasteImage below).
  attachmentPaths?: string[]
}

export interface CreateSessionResult {
  ok: boolean
  error?: string
  record?: SessionRecord
}

export function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  return window.api.invoke<CreateSessionResult>('sessions:create', input)
}

export interface SessionCreateEvent {
  creationId: string
  step: string
  ok: boolean
  message: string | null
  at: number
}

export function onSessionCreateEvent(fn: (event: SessionCreateEvent) => void): () => void {
  return window.api.on('session:event', (payload) => fn(payload as SessionCreateEvent))
}

// ---------------------------------------------------------------------------
// Attachments (Home composer's paperclip / paste / drag-drop). A path here
// is never one the renderer constructed itself — it either came back from
// main's own file dialog, or was resolved from a dropped File via
// getPathForDroppedFile below (preload's webUtils bridge, the only way to
// get a path off a browser File at all) and then validated by main before
// use. Pasted image bytes have no path to begin with; main writes them
// somewhere and hands the resulting path back the same way.

export type AttachmentResult =
  | { ok: true; path: string; name: string; size: number }
  | { ok: false; name: string; error: string }

export function pickAttachments(): Promise<AttachmentResult[]> {
  return window.api.invoke<AttachmentResult[]>('attachments:pick')
}

export function addAttachmentPaths(paths: string[]): Promise<AttachmentResult[]> {
  return window.api.invoke<AttachmentResult[]>('attachments:addPaths', paths)
}

/** A big block of pasted text, kept out of the composer and handed over as a file. */
export function pasteAttachmentText(text: string, lines: number): Promise<AttachmentResult> {
  return window.api.invoke<AttachmentResult>('attachments:pasteText', text, lines)
}

/**
 * Paths from a drop. Call it straight away, inside the drop handler: a
 * screenshot dragged from its preview lives in a temp folder macOS empties
 * moments later, and main copies it out before that happens.
 */
export function addDroppedPaths(paths: string[]): Promise<AttachmentResult[]> {
  return window.api.invoke<AttachmentResult[]>('attachments:addDropped', paths)
}

export function pasteAttachmentImage(
  bytes: Uint8Array,
  mimeType: string
): Promise<AttachmentResult> {
  return window.api.invoke<AttachmentResult>('attachments:pasteImage', bytes, mimeType)
}

// The one piece of Electron plumbing that has to run in the renderer/preload
// boundary rather than as a plain IPC call: a browser File carries no real
// filesystem path unless Electron's webUtils resolves it, and that can only
// be called where the File object lives (preload can't receive it over IPC
// — main has no concept of a DOM File at all). The result is just a string,
// validated by addAttachmentPaths like any other before it goes near a
// prompt — this never bypasses that.
export function getPathForDroppedFile(file: File): string {
  return window.api.getPathForFile(file)
}

export interface DeleteSessionResult {
  ok: boolean
  error?: string
  warning?: string
}

export type AppSettingsPatch = Partial<AppSettings>

export function getAppSettings(): Promise<AppSettings> {
  return window.api.invoke<AppSettings>('settings:get')
}

export function setAppSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  return window.api.invoke<AppSettings>('settings:set', patch)
}

// Returns '' on success, an error message on failure (mirrors shell.openPath).
export function openDataFolder(): Promise<string> {
  return window.api.invoke<string>('app:openDataFolder')
}

/** Opens a link from terminal output in the default browser. '' on success. */
export function openExternal(url: string): Promise<string> {
  return window.api.invoke<string>('app:openExternal', url)
}

export interface SessionActionResult {
  ok: boolean
  error?: string
}

export function archiveSession(id: string): Promise<SessionActionResult> {
  return window.api.invoke<SessionActionResult>('sessions:archive', id)
}

/** Puts an archived session back on its project's Active board. */
export function unarchiveSession(id: string): Promise<SessionActionResult> {
  return window.api.invoke<SessionActionResult>('sessions:unarchive', id)
}

export function renameSession(id: string, title: string): Promise<SessionActionResult> {
  return window.api.invoke<SessionActionResult>('sessions:rename', id, title)
}

export function copyWorktreePath(id: string): Promise<SessionActionResult> {
  return window.api.invoke<SessionActionResult>('session:copyWorktreePath', id)
}

export function copyAttachCommand(id: string): Promise<SessionActionResult> {
  return window.api.invoke<SessionActionResult>('session:copyAttachCommand', id)
}

export interface ResumeSessionResult {
  ok: boolean
  error?: string
  tmuxWindowId?: string
  tmuxPaneId?: string
  newClaudeSessionId?: string
  command?: string
}

export function resumeSession(id: string): Promise<ResumeSessionResult> {
  return window.api.invoke<ResumeSessionResult>('sessions:resume', id)
}

/** Start Claude again in a session whose Claude has exited: fresh, or resumed. */
export function relaunchSession(id: string, mode: 'new' | 'resume'): Promise<ResumeSessionResult> {
  return window.api.invoke<ResumeSessionResult>('sessions:relaunch', id, mode)
}

// Part 7.4 — the context window panel's data source (null when the
// session has no transcript yet).
export function getSessionContextWindow(id: string): Promise<ContextWindowUsage | null> {
  return window.api.invoke<ContextWindowUsage | null>('session:contextWindow', id)
}

export function deleteSession(
  id: string,
  removeWorktree: boolean,
  discardChanges = false
): Promise<DeleteSessionResult> {
  return window.api.invoke<DeleteSessionResult>('sessions:delete', id, {
    removeWorktree,
    discardChanges
  })
}

// For a session found live in a terminal but never adopted into a project —
// no SessionRecord for sessions:delete to act on, but it always has a real
// tmux window, and ending it is how you "delete" one of these.
export function killSessionWindow(windowId: string): Promise<{ ok: boolean; error?: string }> {
  return window.api.invoke<{ ok: boolean; error?: string }>('sessions:killWindow', windowId)
}

// A background agent has no tmux window and no pid we can act on — its own
// agent id (LiveSession.backgroundAgentId) is the only handle for ending it.
export function stopBackgroundAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
  return window.api.invoke<{ ok: boolean; error?: string }>('sessions:stopBackgroundAgent', agentId)
}

// Last resort: a record-less session whose terminal is confirmed gone and
// that isn't an `agents --json` background agent either — only its pid is
// left as a handle.
export function killSessionProcess(pid: number): Promise<{ ok: boolean; error?: string }> {
  return window.api.invoke<{ ok: boolean; error?: string }>('sessions:killProcess', pid)
}

// Fallback when claude stop can't confirm the agent actually stopped (its
// background service can be wedged) — hides it from Control Room's own
// view without claiming the underlying agent stopped.
export function dismissBackgroundAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
  return window.api.invoke<{ ok: boolean; error?: string }>(
    'sessions:dismissBackgroundAgent',
    agentId
  )
}

// ---------------------------------------------------------------------------
// U7 — Git tab (plan 2.2). `sessionId` selects which worktree to act on; main
// resolves it to a real path server-side (ipc.ts's resolveFilesRoot). The
// renderer never holds or passes a filesystem path here — only ids (CLAUDE.md:
// "the renderer has no OS access ... it never handles paths it can act on").
// Omit `sessionId` to act on the project's main checkout.

export interface GitStatusFile {
  path: string
  renamedFrom: string | null
  index: string
  worktree: string
  staged: boolean
}

export interface GitStatusResult {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitStatusFile[]
}

export function getGitStatus(
  projectId: string,
  sessionId?: string
): Promise<GitStatusResult | null> {
  return window.api.invoke<GitStatusResult | null>('git:status', projectId, sessionId)
}

export function stageFiles(
  projectId: string,
  paths: string[],
  stage: boolean,
  sessionId?: string
): Promise<boolean> {
  return window.api.invoke<boolean>('git:stage', projectId, sessionId, paths, stage)
}

export interface GitCommitResult {
  ok: boolean
  sha?: string
  error?: string
}

export function commitFiles(
  projectId: string,
  message: string,
  sessionId?: string
): Promise<GitCommitResult> {
  return window.api.invoke<GitCommitResult>('git:commit', projectId, sessionId, message)
}

export interface GitLogCommit {
  sha: string
  parents: string[]
  subject: string
  authorName: string
  authoredAt: number
}

export interface GitLogResult {
  commits: GitLogCommit[]
  hasMore: boolean
}

export function getGitLog(
  projectId: string,
  opts: { skip?: number; limit?: number } = {},
  sessionId?: string
): Promise<GitLogResult> {
  return window.api.invoke<GitLogResult>('git:log', projectId, sessionId, opts)
}

// ---------------------------------------------------------------------------
// U7 — Files tab (plan 2.2). `relPath` is always relative to the resolved
// root; the renderer has no OS access and never constructs an absolute path
// (CLAUDE.md non-negotiable). `sessionId` works the same as the Git tab above.

export interface FileTreeEntry {
  path: string
  type: 'file'
}

export function getFileTree(projectId: string, sessionId?: string): Promise<FileTreeEntry[]> {
  return window.api.invoke<FileTreeEntry[]>('files:tree', projectId, sessionId)
}

export type ReadFileResult = { ok: true; content: string } | { ok: false; error: string }

export function readFile(
  projectId: string,
  relPath: string,
  sessionId?: string
): Promise<ReadFileResult> {
  return window.api.invoke<ReadFileResult>('files:read', projectId, sessionId, relPath)
}

export interface WriteFileResult {
  ok: boolean
  error?: string
}

export function writeFile(
  projectId: string,
  relPath: string,
  content: string,
  sessionId?: string
): Promise<WriteFileResult> {
  return window.api.invoke<WriteFileResult>('files:write', projectId, sessionId, relPath, content)
}

export interface FileSearchMatch {
  path: string
  line: number
  text: string
}

export function searchFiles(
  projectId: string,
  query: string,
  sessionId?: string
): Promise<FileSearchMatch[]> {
  return window.api.invoke<FileSearchMatch[]>('files:search', projectId, sessionId, query)
}

// ---------------------------------------------------------------------------
// Skills and Rules tabs (plan 3, sections 2.6/2.7).

export interface SkillInfo {
  name: string
  description: string
  scope: 'global' | 'project'
  path: string
  fileCount: number
}

export function listSkills(projectId?: string): Promise<SkillInfo[]> {
  return window.api.invoke<SkillInfo[]>('skills:list', projectId)
}

export interface CreateSkillResult {
  ok: boolean
  error?: string
  path?: string
}

export function createSkill(
  scope: 'global' | 'project',
  projectId: string | undefined,
  name: string,
  description: string,
  body?: string
): Promise<CreateSkillResult> {
  return window.api.invoke<CreateSkillResult>(
    'skills:create',
    scope,
    projectId,
    name,
    description,
    body
  )
}

export interface RuleInfo {
  scope: 'global' | 'project'
  path: string
  exists: boolean
  // Project-root-relative directory this file governs ('' for the
  // project's own root CLAUDE.md); omitted for 'global', which applies
  // everywhere rather than to one directory.
  dir?: string
  // Project-root-relative path for opening this file in the Files editor;
  // omitted for 'global', which sits outside every registered project.
  relPath?: string
}

export function listRules(projectId?: string): Promise<RuleInfo[]> {
  return window.api.invoke<RuleInfo[]>('rules:list', projectId)
}

export interface AppendRuleResult {
  ok: boolean
  error?: string
  backupPath?: string
}

export function appendRule(
  scope: 'global' | 'project',
  projectId: string | undefined,
  text: string
): Promise<AppendRuleResult> {
  return window.api.invoke<AppendRuleResult>('rules:append', scope, projectId, text)
}

export interface RestoreRuleResult {
  ok: boolean
  error?: string
}

export function restoreRuleBackup(
  scope: 'global' | 'project',
  projectId: string | undefined,
  backupPath: string
): Promise<RestoreRuleResult> {
  return window.api.invoke<RestoreRuleResult>('rules:restore', scope, projectId, backupPath)
}

// ---------------------------------------------------------------------------
// Live terminal (plan 3, Part 3 / V7). Renderer sends only tmux session
// names + pane ids (both opaque strings from LiveSession.tmux, never a
// filesystem path) — the transport itself lives in main (tmux-control.ts).

export interface TerminalAttachResult {
  ok: boolean
  fallback: boolean
  reason?: string
  backfill: string
}

export function terminalAttach(
  tmuxSessionName: string,
  paneId: string,
  scrollbackLines?: number,
  size?: { cols: number; rows: number }
): Promise<TerminalAttachResult> {
  return window.api.invoke<TerminalAttachResult>(
    'terminal:attach',
    tmuxSessionName,
    paneId,
    scrollbackLines,
    size
  )
}

export function terminalInput(
  tmuxSessionName: string,
  paneId: string,
  data: string
): Promise<boolean> {
  return window.api.invoke<boolean>('terminal:input', tmuxSessionName, paneId, data)
}

export function terminalResize(
  tmuxSessionName: string,
  cols: number,
  rows: number
): Promise<boolean> {
  return window.api.invoke<boolean>('terminal:resize', tmuxSessionName, cols, rows)
}

/** Names the pane: several terminals share one tmux session. */
export function terminalDetach(tmuxSessionName: string, paneId: string): Promise<void> {
  return window.api.invoke<void>('terminal:detach', tmuxSessionName, paneId)
}

export interface TerminalOutputPayload {
  tmuxSessionName: string
  paneId: string
  data: string
}

export function onTerminalOutput(fn: (payload: TerminalOutputPayload) => void): () => void {
  return window.api.on('terminal:output', (payload) => fn(payload as TerminalOutputPayload))
}

/**
 * Fires whenever anything writes a setting, with the whole settings object.
 *
 * Components read settings when they mount, which is usually long before the
 * Settings screen is opened — without this they keep whatever was true then.
 */
export function onSettingsChanged(fn: (settings: AppSettings) => void): () => void {
  return window.api.on('settings:changed', (payload) => fn(payload as AppSettings))
}

export function onTerminalExit(fn: (payload: { tmuxSessionName: string }) => void): () => void {
  return window.api.on('terminal:exit', (payload) => fn(payload as { tmuxSessionName: string }))
}

// ---------------------------------------------------------------------------
// A second pane in a session's window (plan 7, TerminalFrame's "add
// terminal" control) — a split of the session's own tmux window, presented
// as tabs. `paneId` below is always the session's primary pane (the same
// one passed to terminalAttach); the pane ids these return are only ever
// round-tripped back through the same calls, never constructed here.

export interface SplitPaneResult {
  ok: boolean
  paneId?: string
  error?: string
}

export function splitTerminalPane(paneId: string): Promise<SplitPaneResult> {
  return window.api.invoke<SplitPaneResult>('terminal:splitPane', paneId)
}

// Makes `paneId` the one visible pane of its window — the tab click handler.
export function focusTerminalPane(paneId: string): Promise<boolean> {
  return window.api.invoke<boolean>('terminal:focusPane', paneId)
}

// Removes a pane splitTerminalPane created.
export function closeTerminalPane(paneId: string): Promise<boolean> {
  return window.api.invoke<boolean>('terminal:closePane', paneId)
}

export interface TerminalWindowPane {
  paneId: string
  active: boolean
}

// Every pane sharing `paneId`'s window — used on mount (and while polling)
// to notice a split that already exists, or one that was just closed
// outside the app (tmux directly, or `exit` in the shell).
export function listTerminalWindowPanes(paneId: string): Promise<TerminalWindowPane[]> {
  return window.api.invoke<TerminalWindowPane[]>('terminal:listWindowPanes', paneId)
}

/** ⌘W, caught in main before the app menu takes it. */
export function onCloseTabShortcut(fn: () => void): () => void {
  return window.api.on('shortcut:closeTab', () => fn())
}

export function closeWindow(): Promise<void> {
  return window.api.invoke<void>('window:close')
}

// ---- Jira (Backlog screen) --------------------------------------------------
export type {
  JiraIssue,
  JiraStatus,
  JiraResult,
  JiraBoardData,
  JiraIssueDetail,
  JiraComment,
  JiraSprint,
  JiraLink,
  JiraBlockLink,
  BlockDirection,
  JiraColumn,
  JiraIssueType,
  JiraCreateInput,
  BacklogPrefs,
  SavedView,
  TicketPullRequest,
  JiraPerson
} from '../../main/exec/jira'
export type { PullRequestInfo } from '../../main/exec/pullRequests'
import type {
  JiraIssue,
  JiraStatus,
  JiraResult,
  JiraBoardData,
  JiraIssueDetail,
  JiraComment,
  JiraIssueType,
  JiraCreateInput,
  BacklogPrefs,
  BlockDirection,
  JiraPerson,
  JiraSprint
} from '../../main/exec/jira'
import type { PullRequestInfo } from '../../main/exec/pullRequests'

export function getJiraStatus(): Promise<JiraStatus> {
  return window.api.invoke<JiraStatus>('jira:status')
}

export function configureJira(input: {
  site: string
  email: string
  token: string
  projects: string[]
}): Promise<JiraResult<JiraStatus>> {
  return window.api.invoke<JiraResult<JiraStatus>>('jira:configure', input)
}

export function disconnectJira(): Promise<void> {
  return window.api.invoke<void>('jira:disconnect')
}

export function loadJiraBoard(refresh = false): Promise<JiraResult<JiraBoardData>> {
  return window.api.invoke<JiraResult<JiraBoardData>>('jira:board', refresh)
}

export function loadJiraDetail(key: string): Promise<JiraResult<JiraIssueDetail>> {
  return window.api.invoke<JiraResult<JiraIssueDetail>>('jira:detail', key)
}

export function updateJiraText(
  key: string,
  patch: { summary?: string; descriptionWiki?: string }
): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:updateText', key, patch)
}

/** `internal` posts a Jira Service Management internal note, seen only by the team. */
export function addJiraComment(
  key: string,
  body: string,
  internal = false
): Promise<JiraResult<JiraComment>> {
  return window.api.invoke<JiraResult<JiraComment>>('jira:comment', key, body, internal)
}

export function moveJiraIssue(key: string, status: string): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:move', key, status)
}

/** `true` assigns it to you, `false` to nobody, a string to that account id. */
export function assignJiraIssue(
  key: string,
  who: boolean | string
): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:assign', key, who)
}

export function loadAssignablePeople(): Promise<JiraResult<JiraPerson[]>> {
  return window.api.invoke<JiraResult<JiraPerson[]>>('jira:assignable')
}

/** Anyone on the Jira site matching a name or email, for @-mentions. */
export function searchJiraPeople(query: string): Promise<JiraResult<JiraPerson[]>> {
  return window.api.invoke<JiraResult<JiraPerson[]>>('jira:searchPeople', query)
}

export function setJiraParent(key: string, parent: string | null): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:parent', key, parent)
}

export function setJiraSprint(
  key: string,
  sprintId: number | null
): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:sprint', key, sprintId)
}

/** Creates a future cycle on a board in Jira. Starting it stays in Jira. */
export function createJiraSprint(input: {
  boardId: number
  name: string
  startDate: string
  endDate: string
  goal?: string
}): Promise<JiraResult<JiraSprint>> {
  return window.api.invoke<JiraResult<JiraSprint>>('jira:createSprint', input)
}

export function setJiraSprintGoal(sprintId: number, goal: string): Promise<JiraResult<JiraSprint>> {
  return window.api.invoke<JiraResult<JiraSprint>>('jira:sprintGoal', sprintId, goal)
}

export function setJiraPriority(key: string, priority: string): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:priority', key, priority)
}

export function setJiraLabels(key: string, labels: string[]): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:labels', key, labels)
}

export function setJiraEstimate(
  key: string,
  estimate: string | null
): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:estimate', key, estimate)
}

/** Links two tickets: `other` blocks this one (blockedBy), or this one blocks `other`. */
export function addJiraBlockLink(
  key: string,
  other: string,
  direction: BlockDirection
): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:addBlock', key, other, direction)
}

export function removeJiraBlockLink(key: string, linkId: string): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:removeBlock', key, linkId)
}

/** Puts a Slack thread on a ticket, the way the Zapier zaps do. */
export function addJiraSlackLink(key: string, url: string): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>('jira:slackLink', key, url)
}

/** A ticket's pull requests, as Jira's development panel has them. */
export function loadTicketPullRequests(
  key: string
): Promise<JiraResult<import('../../main/exec/jira').TicketPullRequest[]>> {
  return window.api.invoke('jira:pullRequests', key)
}

export function loadJiraIssueTypes(project: string): Promise<JiraResult<JiraIssueType[]>> {
  return window.api.invoke<JiraResult<JiraIssueType[]>>('jira:issueTypes', project)
}

export function createJiraIssue(
  input: JiraCreateInput
): Promise<JiraResult<{ issue: JiraIssue; skipped: string[] }>> {
  return window.api.invoke('jira:create', input)
}

export function getBacklogPrefs(): Promise<BacklogPrefs> {
  return window.api.invoke<BacklogPrefs>('backlog:prefs')
}

export function saveBacklogPrefs(patch: Partial<BacklogPrefs>): Promise<BacklogPrefs> {
  return window.api.invoke<BacklogPrefs>('backlog:savePrefs', patch)
}

/** The PR a session's branch has open on GitHub, or null. */
export function getSessionPullRequest(recordId: string): Promise<PullRequestInfo | null> {
  return window.api.invoke<PullRequestInfo | null>('sessions:pullRequest', recordId)
}

export type { CheckoutBranch } from '../../main/exec/git'
/** Checks a branch name against GitHub; says which branch it resolved. */
export function resolveBranch(
  projectId: string,
  name: string
): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
  return window.api.invoke('git:resolveBranch', projectId, name)
}
/** The repo's default branch on GitHub ("main", usually). */
export function getDefaultBranch(projectId: string): Promise<string> {
  return window.api.invoke<string>('git:defaultBranch', projectId)
}
/** Branches a new session can start on — open PRs first, then origin's, then local. */
export function listCheckoutBranches(
  projectId: string
): Promise<import('../../main/exec/git').CheckoutBranch[]> {
  return window.api.invoke('git:checkoutBranches', projectId)
}

/** Local session ↔ ticket links: { sessionRecordId: issueKey }. Never sent to Jira. */
export function getSessionTicketLinks(): Promise<Record<string, string>> {
  return window.api.invoke<Record<string, string>>('jira:links')
}

export function linkSessionToTicket(
  recordId: string,
  issueKey: string | null
): Promise<Record<string, string>> {
  return window.api.invoke<Record<string, string>>('jira:link', recordId, issueKey)
}
