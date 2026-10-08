export type SchemaVersion = 1

export interface Project {
  id: string // crypto.randomUUID()
  name: string // basename of repoPath, user-editable
  repoPath: string // absolute path of the MAIN checkout
  worktreeRoot: string // `${repoPath}.worktrees`
  workspacesDir: string // `${worktreeRoot}/.workspaces`
  baseRef: string // default "origin/main"
  tmuxSession: string // default "wt"
  agentCommand: string // default "claude"
  addedAt: number
  // Runs inside the tmux pane, chained ahead of agentCommand with `&&`, before
  // the agent starts — e.g. dbt's `mise trust && direnv allow && dbt deps`.
  // undefined = auto-detect `~/.zsh/wt-setup.sh <worktree>`; '' = no setup step.
  // This IS plan 4 §7.2's "worktreePostCheckoutCommand" — same idea, kept
  // under its existing name rather than duplicated.
  setupCommand?: string
  // Projects list (plan 2.1) row action — pinned rows sort first. Default
  // false/undefined.
  pinned?: boolean
  // Plan 4 §7.1 — how session creation carries gitignored top-level entries
  // (e.g. .venv, .env) from repoPath into a new worktree. 'none' carries
  // nothing. Default 'symlink' when unset.
  ignoredFilesMode?: 'symlink' | 'copy' | 'none'
  // Plan 4 §7.2 — per-project worktree settings, each optional so an unset
  // project keeps today's behaviour exactly.
  // What new branches (basedOn: 'new') are cut from, e.g. "origin/develop".
  // Falls back to the remote's actual default branch (via `origin/HEAD`)
  // when unset — never a hardcoded "main".
  worktreeBaseBranch?: string
  // Fetch `origin` before creating a worktree. Default true (today's
  // always-fetch behaviour); set false to allow offline worktree creation.
  worktreeFetchBeforeCreate?: boolean
  // Run before `deleteSession` removes the worktree (replaces/supplements
  // the hardcoded `git clean -xdff`) — e.g. a build tool's own clean step
  // that `git worktree remove` can't get past on its own.
  worktreePreDeleteCommand?: string
  // Sparse-checkout directories applied right after worktree creation.
  // Unset/empty = full checkout, today's behaviour.
  worktreeSparseDirectories?: string[]
}

// How the process currently behind this session came to exist — plan 4 Part 3,
// borrowed from Xirp's SESSION_START_KINDS. Set at creation and again on every
// resume/fork, so "this has been resumed three times" is visible from the record.
export type SessionStartKind = 'create' | 'resume' | 'fork' | 'dependency'

export interface SessionRecord {
  // what we persist
  id: string
  projectId: string
  title: string
  branch: string // "fix/dora-1140"
  dirName: string // branch with "/" -> "-"
  worktreePath: string
  // True only for a session created in "Investigate" mode: no worktree, no
  // branch of its own — worktreePath is the project's own repoPath. Never
  // offer to remove "the worktree" for one of these (deleteSession already
  // refuses when removeWorktree && worktreePath === project.repoPath, but
  // this is what the UI checks to hide that option rather than let it fail).
  investigation?: boolean
  // True when `branch` was already checked out somewhere (git allows a branch
  // in one place only), so this session got a worktree at that branch's
  // commit on no branch. `branch` says where it started. Ship pushes the
  // branch the worktree is on now, so it never pushes that one.
  detached?: boolean
  workspaceFile: string | null
  tmuxSessionName: string // "wt"
  tmuxWindowName: string // dirName with ":" and "." -> "-"
  tmuxWindowId: string | null // "@5", captured at creation
  tmuxPaneId: string | null // "%5"
  claudeSessionId: string | null
  origin: 'app' | 'discovered'
  createdAt: number
  archivedAt: number | null
  /**
   * Set when the user deleted the session: the worktree is gone and the tmux
   * window is closed, so there is nothing to resume even though the Claude
   * session id survives. The record stays for the history; History files it
   * under Ended, never Done, so it never offers a Resume that cannot work.
   */
  deletedAt?: number | null
  lastPrompt: string | null
  // Resuming can mint Claude Code a new session id while the old transcript
  // stays filed under the first one — this keeps that first id so the
  // session's whole history is traceable across however many resumes
  // follow. Set the first time a session is resumed; never overwritten after.
  originalClaudeSessionId: string | null
  startKind: SessionStartKind
  // Plain-language reason + remedy (plan 4 Part 2/7.7), set when Terminal
  // probes `no` for this record and cleared once it relinks (a fresh
  // create, or a successful resume). Never inferred UI copy — this is the
  // one string the detail view shows verbatim.
  waitingReason: string | null
  // Plan 4 §7.3 — once true, any auto-naming path (from the transcript's
  // aiTitle or similar) must skip this record entirely rather than
  // overwrite a name the user chose. Optional so every existing/other
  // SessionRecord-constructing call site keeps compiling — undefined reads
  // exactly like false. Set explicitly false at creation where convenient;
  // the rename IPC handler is responsible for flipping it true.
  isCustomName?: boolean
  // Plan 4 §7.5 — session relationships. Back-filling these later is
  // impossible, so the fields exist now even though no creation path sets
  // parentSessionId yet (no fork UI/logic exists) and no UI reads any of
  // them yet.
  // This session was created as a fork of another (`claude --resume … --fork-session`).
  parentSessionId?: string | null
  // This session was spawned to continue/stack on top of another session's work.
  stackParentSessionId?: string | null
  // Other sessions this one depends on finishing first.
  dependsOnSessionIds?: string[]
  // Plan 4 §7.6 — the running `claude --version` string captured at session
  // creation, so a later drift against the currently-running binary can be
  // explained rather than silently absorbed. null/undefined when it
  // couldn't be captured (binary not found, `--version` failed).
  harnessVersion?: string
  // Plan 7 step 3 — keeps this session at the top of Home's recent list and
  // the Sessions page, independent of the project-level Project.pinned
  // above. Default false/undefined.
  pinned?: boolean
}

export interface AppSettings {
  hookPort: number // default 47821
  pollIntervalMs: number // default 2000
  terminalApp: string // default "Ghostty", used by `open -a`
  notifyOn: Array<'needs_attention' | 'ready' | 'done' | 'errored'>
  hooksInstalled: boolean
  hooksInstalledUrl: string | null
  // What a new session starts with, until the composer's own picker says
  // otherwise for that one session. Opus at medium: the composer used to
  // hardcode sonnet with nowhere to change it.
  defaultModel: 'opus' | 'sonnet' | 'haiku'
  defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  // The terminal's own text size. It was hardcoded at 13px in Terminal.tsx,
  // which is a reasonable default and a bad answer to "I can't read this".
  terminalFontSize: number // default 13
  // Draw the terminal with WebGL. Crisper block characters, but on some Macs
  // Chromium's GPU process crashes (a CHECK on its main thread), and every
  // crash showed a sad face where the terminal was. Off by default.
  terminalGpu: boolean // default false
  theme: string // theme id, e.g. "tokyo-night"; default "tokyo-night"
  themeFollowsSystem: boolean // default false; when on, swap dark/light theme with the OS
  // How Sessions and Tickets open. The switch on each screen still changes
  // it for the moment; this is where each one starts.
  sessionsView: 'list' | 'grid' // default 'list'
  ticketsView: 'list' | 'board' // default 'list'
}

export interface StateFile {
  version: SchemaVersion
  projects: Project[]
  sessions: SessionRecord[]
  settings: AppSettings
  // Background agents `claude stop` genuinely can't always stop — its own
  // background service can be wedged, in which case the CLI itself fails
  // with "couldn't confirm ... was stopped". Rather than leave a ghost
  // entry cluttering the list forever, the user can hide it from Control
  // Room's own view. This never claims the underlying agent is actually
  // stopped — only that we've stopped showing it.
  dismissedBackgroundAgentIds: string[]
}

// Live status is never persisted — it is recomputed each poll into a view model.
export type SessionStatus =
  | 'working'
  // Genuinely stuck: a permission prompt, a question, a blocked tool. It
  // cannot go on until you answer.
  | 'needs_attention'
  // Finished its turn and sitting at the prompt. Your move, but nothing is
  // wrong — this used to be reported as needs_attention, so a session that
  // had done its job sat there in alarm orange until you closed it.
  | 'ready'
  | 'done'
  | 'idle'
  | 'shell'
  | 'errored'
  | 'stopped'
  | 'missing'
  | 'unknown'
  // Running in a terminal Control Room did not start — outside any project's
  // tmux session, or not in tmux at all. The app can see it but cannot show
  // its terminal or reliably say what it is doing, so it claims nothing.
  | 'external'

/**
 * Sessions that want something from you: one that cannot proceed until you
 * answer, and one that has finished its turn. Both belong at the top of a
 * list and in the count; only the first is urgent, and that difference is
 * carried by colour and wording rather than by hiding the second.
 */
export function wantsYou(status: SessionStatus): boolean {
  return status === 'needs_attention' || status === 'ready'
}

/** Sort rank: blocked first, then finished, then everything else. */
export function attentionRank(status: SessionStatus): number {
  if (status === 'needs_attention') return 0
  if (status === 'ready') return 1
  return 2
}

export interface LiveSession {
  record: SessionRecord | null // null = seen live but not registered
  key: string // sessionIdentityCandidates()[0] — `record:<id>` ?? `session:<claudeId>` ?? `pane:<%id>` ?? `path:<cwd>`
  status: SessionStatus
  statusReason: string // "waiting: input needed"
  claudePid: number | null
  claudeSessionId: string | null
  cwd: string
  agentName: string | null // claude's own name, e.g. "new-test-69"
  rawStatus: string | null // idle|busy|waiting|blocked|shell
  waitingFor: string | null
  tmux: {
    sessionName: string
    windowId: string
    windowIndex: number
    windowName: string
    paneId: string
  } | null
  alive: boolean
  lastEvent: { type: string; at: number; message: string | null } | null
  updatedAt: number
  // Read from the session's .code-workspace file's "workbench.colorTheme" by
  // the discovery pass (U5's per-session accent). null when there's no
  // workspace file, or it doesn't set a theme, or it fails to parse.
  cursorTheme: string | null
  // A background agent (claude agents --json, kind "background") has no
  // pid and no tmux pane at all — its own id is the only handle for ending
  // it (`claude stop <id>`). null for every other kind of session.
  backgroundAgentId: string | null
  // Sub-agents (the Agent/Task tool) this session has spawned recently —
  // read from exec/claude.ts's listSubagentsForSession. A spawned agent is
  // never its own top-level session: it has no pid, no tmux pane and no
  // `~/.claude/sessions/*.json` file of its own, so it can only ever appear
  // here, nested under the session that spawned it. Always an array, never
  // null: empty means "none spawned, or none recently" — the caller never
  // needs to distinguish those two.
  subagents: LiveSubagentSummary[]
  // Something happened in this session since you last opened it — it
  // finished a turn, or stopped to ask you something — or you marked it
  // unread yourself. Clears when you open it. See engine/seen.ts.
  unread: boolean
  // When it last did something: now while it is working, otherwise when it
  // last finished a turn, asked something or failed. null when we can't
  // tell. What "active 5m ago" and the last-active sort read.
  activityAt: number | null
}

export interface LiveSubagentSummary {
  agentId: string
  // The spawning call's own one-line description, e.g. "Research local xirp
  // CLI" — null when the metadata file is missing or didn't parse.
  description: string | null
  // e.g. "general-purpose", "Explore", "Plan" — the subagent_type it was
  // launched with. null when unknown.
  agentType: string | null
  // Best-effort: its own transcript was touched recently and ends on an
  // unresolved tool call, the same shape every in-progress subagent
  // transcript showed during testing. false covers both "finished" and
  // "can't tell" — there is no separate error state to show for this.
  active: boolean
}
