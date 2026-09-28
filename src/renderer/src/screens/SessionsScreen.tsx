import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  attentionRank,
  wantsYou,
  type LiveSession,
  type Project,
  type SessionStatus
} from '../../../main/store/types'
import { STATUS_WORDS } from '../components/primitives/Badge'
import DeleteSessionDialog from '../components/DeleteSessionDialog'
import DeleteSessionsDialog from '../components/DeleteSessionsDialog'
import { useDismissible } from '../keyboard'
import { PickCheck, SelectionAction, SelectionBar } from '../components/selection'
import { readAction, useSessionActions } from '../components/useSessionActions'
import {
  Button,
  Modal,
  Badge,
  Icon,
  Popover,
  StatusDot,
  Tooltip,
  useConfirm
} from '../components/primitives'
import {
  adoptSession,
  listSessions,
  updateProject,
  removeProject,
  renameSession,
  killSessionWindow,
  stopBackgroundAgent,
  dismissBackgroundAgent,
  killSessionProcess
} from '../api'
import { useStoredState } from '../state/useStoredState'
import { resolveSessionProjectId } from '../state/useSessions'
import './sessions-list.css'

interface Props {
  sessions: LiveSession[]
  projects: Project[]
  selectedProjectId: string | null
  onAdopted: () => void
  onOpenSession: (liveKey: string, background?: boolean) => void
  /** Clears the project filter (the sidebar's own "All" selection). This
   * screen has no direct access to that state — it lives in App, driven by
   * the ProjectsScreen sidebar — so the empty state's "Clear filter" control
   * calls back up through this. */
  onClearFilter?: () => void
  /** Opens the new-session form. Same modal the sidebar's own button opens —
   * every door into it (the empty state's CTA, a project container's own
   * button) is another way to reach it, not a second flow. A project id
   * preselects that project in the form; omitted keeps today's default. */
  onNewSession?: (projectId?: string) => void
  /** Refreshes the project list after a rename/pin/remove from a project
   * container's overflow menu. Optional so this screen still renders
   * (menu just goes without those three actions) if a caller doesn't wire
   * it — never a broken control, only a smaller one. */
  onProjectsChanged?: () => void
  /** Opens a session's worktree in the configured IDE / focuses its tmux
   * pane in the terminal app — the same actions the session detail header
   * and command palette already perform, reachable here per-row. */
  onOpenInIde?: (session: LiveSession) => void
  onFocusTerminal?: (session: LiveSession) => void
  /** Shows a short, non-blocking message on failure (e.g. Adopt returning
   * null) — matches ProjectDetail's own pushToast prop. Optional so this
   * screen still renders without it: falls back to window.alert, this
   * file's existing pattern for the delete/stop failures below, so a
   * failure is never silent either way. */
  pushToast?: (message: string) => void
  /** The title bar bell's click target: show only sessions whose status is
   * 'needs_attention', across every project — independent of, and takes
   * priority over, selectedProjectId (the bell means "show me what needs
   * me", not "what needs me in whatever project I had selected"). Optional;
   * omitted/false renders exactly as before. */
  attentionOnly?: boolean
  /** Turns attentionOnly back off — the "visible and escapable" half of the
   * filter, wired to a control this screen renders whenever attentionOnly
   * is on (the header's own clear action, and the empty state's). */
  onClearAttentionFilter?: () => void
  unreadOnly: boolean
  onUnreadOnlyChange: (next: boolean) => void
  statusFilter: StatusFilterId | null
  onStatusFilterChange: (next: StatusFilterId | null) => void
}

function projectForCwd(cwd: string, projects: Project[]): Project | null {
  return projects.find((p) => cwd === p.repoPath || cwd.startsWith(`${p.worktreeRoot}/`)) ?? null
}

// A bare clock icon and "3d 23h" said nothing about which span it meant —
// running time, idle time, age? It was age, measured from the record's
// createdAt, which for an idle session is the least interesting number
// available. The label below says what it is, and the value prefers the last
// thing that actually happened over when the session was first made.
function formatElapsed(ts: number): string {
  const totalSeconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  // One unit: "18h", not "18h 33m" — minutes only matter under an hour.
  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/** "active 5m ago", from the last thing it actually did; "started …" if we can't tell. */
function activityLabel(session: LiveSession): string | null {
  if (session.status === 'working') return 'active now'
  if (session.activityAt !== null) return `active ${formatElapsed(session.activityAt)} ago`
  if (session.record?.createdAt) return `started ${formatElapsed(session.record.createdAt)} ago`
  return null
}

/** For the last-active sort: activity if known, else when it was created. */
function activityTime(session: LiveSession): number {
  // Working is as recent as it gets; activityAt holds when the turn began.
  if (session.status === 'working') return Number.MAX_SAFE_INTEGER
  return session.activityAt ?? session.record?.createdAt ?? 0
}

// Plan 2.4 — five fixed groups, attention always first and always above the
// fold. "Found in terminal" (no record) and "Stopped" are their own groups
// rather than folded into idle, so an unadopted session or a dead one never
// hides among live ones. Still used by the Grid view (untouched by plan 5).
type GroupId =
  | 'needs-answer'
  | 'errored'
  | 'your-turn'
  | 'working'
  | 'done'
  | 'external'
  | 'found-in-terminal'
  | 'stopped'
  | 'other'

const GROUP_ORDER: GroupId[] = [
  'needs-answer',
  'errored',
  'your-turn',
  'working',
  'done',
  'external',
  'found-in-terminal',
  'stopped',
  'other'
]

// The same words as the status badges. The grid said "Idle" over cards that
// each said "your turn" — two names for one state, on one screen.
const GROUP_LABEL: Record<GroupId, string> = {
  'needs-answer': 'Needs an answer',
  errored: 'Errored',
  'your-turn': 'Your turn',
  working: 'Working',
  done: 'Done',
  external: 'External sessions',
  'found-in-terminal': 'Found in terminal',
  stopped: 'Stopped',
  other: 'Other'
}

function groupOf(session: LiveSession): GroupId {
  if (session.status === 'stopped' || session.status === 'missing') return 'stopped'
  if (session.status === 'external') return 'external'
  if (!session.record) return 'found-in-terminal'
  switch (session.status) {
    case 'needs_attention':
      return 'needs-answer'
    case 'errored':
      return 'errored'
    case 'ready':
    case 'idle':
      return 'your-turn'
    case 'working':
      return 'working'
    case 'done':
      return 'done'
    default:
      return 'other'
  }
}

// How the list is ordered. "Needs you" was the only order there was: blocked
// first, then finished. "Unread" and "Last active" exist because the thing
// you were looking for could sit five projects down.
type SortMode = 'attention' | 'unread' | 'recent'

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'attention', label: 'Needs you' },
  { value: 'unread', label: 'Unread' },
  { value: 'recent', label: 'Last active' }
]

function compareSessions(mode: SortMode): (a: LiveSession, b: LiveSession) => number {
  return (a, b) => {
    // Pinned sorts first, ahead of the sort mode itself — pinning is a
    // promise this stays at the top, in every mode, not just a tiebreak
    // inside whatever the mode already put next to each other.
    const aPinned = Boolean(a.record?.pinned)
    const bPinned = Boolean(b.record?.pinned)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    if (mode === 'unread' && a.unread !== b.unread) return a.unread ? -1 : 1
    if (mode !== 'recent') {
      const rank = attentionRank(a.status) - attentionRank(b.status)
      if (rank !== 0) return rank
    }
    return activityTime(b) - activityTime(a)
  }
}

function sortSessions(list: LiveSession[], mode: SortMode): LiveSession[] {
  return [...list].sort(compareSessions(mode))
}

// Status filter. "your turn" is two statuses underneath (see Badge.tsx) and
// "stopped" covers a deleted worktree too, so a filter is a set of statuses
// under the one word people see.
export type StatusFilterId =
  'needs_attention' | 'your_turn' | 'working' | 'done' | 'errored' | 'stopped' | 'external'

const STATUS_FILTERS: { id: StatusFilterId; statuses: SessionStatus[]; tone: string }[] = [
  { id: 'needs_attention', statuses: ['needs_attention'], tone: 'var(--status-attention)' },
  { id: 'your_turn', statuses: ['ready', 'idle'], tone: 'var(--status-done)' },
  { id: 'working', statuses: ['working'], tone: 'var(--status-working)' },
  { id: 'done', statuses: ['done'], tone: 'var(--status-done)' },
  { id: 'errored', statuses: ['errored'], tone: 'var(--status-error)' },
  { id: 'stopped', statuses: ['stopped', 'missing'], tone: 'var(--text-muted)' },
  { id: 'external', statuses: ['external'], tone: 'var(--text-muted)' }
]

function sentenceCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function matchesStatus(session: LiveSession, filter: StatusFilterId | null): boolean {
  if (!filter) return true
  return STATUS_FILTERS.find((f) => f.id === filter)!.statuses.includes(session.status)
}

function sessionTitle(session: LiveSession): string {
  return session.record?.title ?? session.agentName ?? session.cwd
}

interface ProjectGroup {
  project: Project
  sessions: LiveSession[]
  hasAttention: boolean
}

// Plan 5 — "a container per project, rows inside it": every session lands
// under the project it belongs to (its record's own projectId, or a match
// on cwd for a discovered-but-unregistered one); anything left over — no
// record and no cwd match — goes in a single trailing "Other sessions"
// container instead of being scattered. Projects holding a needs-you
// session sort first; "Other sessions" always renders last regardless.
function buildProjectGroups(
  sessions: LiveSession[],
  projects: Project[],
  mode: SortMode
): { groups: ProjectGroup[]; other: LiveSession[] } {
  const byProjectId = new Map<string, LiveSession[]>()
  const other: LiveSession[] = []
  for (const session of sessions) {
    const projectId = resolveSessionProjectId(session, projects)
    const project = projectId ? projects.find((p) => p.id === projectId) : undefined
    if (project) {
      const list = byProjectId.get(project.id) ?? []
      list.push(session)
      byProjectId.set(project.id, list)
    } else {
      other.push(session)
    }
  }
  const groups: ProjectGroup[] = []
  for (const project of projects) {
    const list = byProjectId.get(project.id)
    if (!list || list.length === 0) continue
    const sorted = sortSessions(list, mode)
    groups.push({
      project,
      sessions: sorted,
      hasAttention: sorted.some((s) => wantsYou(s.status))
    })
  }
  // Attention first (a session waiting on the user is the thing the app
  // exists to surface), then pinned (a preference about where you like to
  // look), then whatever order they arrived in. Array.prototype.sort is
  // stable — projects that agree on both keep the relative order they
  // arrived in (the `projects` prop's order).
  // Under the other sorts, a project goes where its top session would: the
  // project holding the newest unread, or the most recent activity, first.
  const compare = compareSessions(mode)
  groups.sort((a, b) => {
    if (mode !== 'attention') {
      const byTop = compare(a.sessions[0], b.sessions[0])
      if (byTop !== 0) return byTop
    }
    if (a.hasAttention !== b.hasAttention) return Number(b.hasAttention) - Number(a.hasAttention)
    const aPinned = Boolean(a.project.pinned)
    const bPinned = Boolean(b.project.pinned)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    return 0
  })
  return { groups, other: sortSessions(other, mode) }
}

interface OverflowAction {
  label: string
  onClick: () => void
  danger?: boolean
}

// Shared by the project container header and each session row — plan 5's
// "hover-revealed overflow menu". Renders nothing (not even the button)
// when there's nothing it can do: a control that can't act on anything
// isn't a control, it's clutter.
function OverflowMenu({
  actions,
  label,
  className
}: {
  actions: OverflowAction[]
  label: string
  className?: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  // Popover owns outside-click and Escape; this ref is only the anchor.
  const ref = useRef<HTMLDivElement>(null)

  if (actions.length === 0) return null

  return (
    <div
      className={className ? `overflow-menu ${className}` : 'overflow-menu'}
      ref={ref}
      onClick={(e) => e.stopPropagation()}
    >
      <Tooltip label={label}>
        <button
          type="button"
          className="overflow-menu-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="MoreHorizontal" size={16} />
        </button>
      </Tooltip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        placement="bottom-end"
        className="overflow-menu-list"
        aria-label={label}
      >
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            className={
              action.danger ? 'overflow-menu-item overflow-menu-item-danger' : 'overflow-menu-item'
            }
            onClick={() => {
              setOpen(false)
              action.onClick()
            }}
          >
            {action.label}
          </button>
        ))}
      </Popover>
    </div>
  )
}

/**
 * Sessions picked for a bulk action, by record id. Only sessions Control
 * Room has a record for can be picked: they're the ones a delete can act on.
 */
const SessionSelection = createContext<{
  selected: Set<string>
  /** `range`: everything on screen between the last one picked and this. */
  toggle: (recordId: string, range?: boolean) => void
}>({ selected: new Set(), toggle: () => {} })

interface SessionListRowProps {
  session: LiveSession
  /** `background`: ⌘- or middle-click — open it in a tab without switching. */
  onOpen: (background?: boolean) => void
  onAdopt?: () => void
  onOpenInIde?: () => void
  onFocusTerminal?: () => void
  onDeleted?: () => void
  onRenamed?: () => void
}

// Plan 7 B4 — session row: two-line layout with fixed-width columns, one flex
// title column, 2px status rail on the left showing the session's STATUS color.
function SessionListRow({
  session,
  onOpen,
  onAdopt,
  onOpenInIde,
  onFocusTerminal,
  onDeleted,
  onRenamed
}: SessionListRowProps): React.JSX.Element {
  const [confirmNode, confirm] = useConfirm()
  const title = sessionTitle(session)
  const selection = useContext(SessionSelection)
  const recordId = session.record?.id ?? null
  const picked = recordId !== null && selection.selected.has(recordId)
  // Once anything is picked, a plain click picks too, as on the Backlog.
  const picking = selection.selected.size > 0
  const branch = session.record?.investigation
    ? 'no worktree'
    : (session.record?.branch ?? session.agentName ?? null)
  // Never `updatedAt`: it is stamped with `now` on every poll.
  const activity = activityLabel(session)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteConfirmType, setDeleteConfirmType] = useState<
    'window' | 'background' | 'process' | null
  >(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  // Job 2 — sub-agents nested under this session. Collapsed by default: the
  // count on the row is the thing that must not be missed, the list itself
  // is opt-in detail.
  const [subagentsExpanded, setSubagentsExpanded] = useState(false)
  const activeSubagentCount = session.subagents.filter((s) => s.active).length

  const startRename = (): void => {
    setRenameValue(title)
    setRenameError(null)
    setRenaming(true)
  }

  // Renames in place: this row turns its own title into a field, which beats
  // a dialog when there is a title right there to borrow.
  const [sessionActionNode, sessionActions] = useSessionActions({
    onChanged: () => onRenamed?.(),
    onRename: startRename
  })

  const cancelRename = (): void => {
    setRenaming(false)
    setRenameError(null)
  }

  const submitRename = async (): Promise<void> => {
    if (!session.record) return
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setRenameError('name cannot be empty')
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      const result = await renameSession(session.record.id, trimmed)
      if (!result.ok) {
        setRenameError(result.error ?? 'failed to rename session')
        return
      }
      setRenaming(false)
      onRenamed?.()
    } catch {
      setRenameError('failed to rename session')
    } finally {
      setRenameBusy(false)
    }
  }

  // Found live in a terminal but never adopted into a project: no
  // SessionRecord for sessions:delete to act on, but it always has a real
  // tmux window — ending that window is how you delete one of these. A
  // user must always be able to remove a session they can see, adopted or
  // not (never leave "Delete" simply missing).
  const handleKillWindow = async (): Promise<void> => {
    if (!session.tmux) return
    setDeleteConfirmType('window')
  }

  const confirmKillWindow = async (): Promise<void> => {
    if (!session.tmux) return
    setDeleteConfirmType(null)
    const result = await killSessionWindow(session.tmux.windowId)
    if (!result.ok) {
      window.alert(result.error ?? 'Failed to end the session.')
      return
    }
    onDeleted?.()
  }

  // A background agent (no tmux window at all, no pid we can act on) has
  // only its own agent id as a handle — `claude stop` ends it and keeps
  // the conversation, resumable later with `claude attach`.
  const handleStopBackgroundAgent = async (): Promise<void> => {
    if (!session.backgroundAgentId) return
    setDeleteConfirmType('background')
  }

  const confirmStopBackgroundAgent = async (): Promise<void> => {
    if (!session.backgroundAgentId) return
    setDeleteConfirmType(null)
    const result = await stopBackgroundAgent(session.backgroundAgentId)
    if (!result.ok) {
      // claude stop's own background service can be wedged — it fails to
      // stop agents like this indefinitely. Offer the one thing that IS
      // guaranteed to work: stop showing it here.
      const hideAnyway = await confirm({
        title: result.error ?? 'Failed to stop the agent.',
        body: 'Hide it from this list instead? This does not stop the agent - only Control Room stops showing it.',
        confirmLabel: 'Hide it'
      })
      if (!hideAnyway) return
      const dismissed = await dismissBackgroundAgent(session.backgroundAgentId)
      if (!dismissed.ok) {
        window.alert(dismissed.error ?? 'Failed to hide the agent.')
        return
      }
    }
    onDeleted?.()
  }

  // Last resort: found live via a session file, no record, terminal
  // confirmed gone, and not an `agents --json` background agent either —
  // only the pid is left. SIGTERM, not a graceful `claude stop`.
  const handleKillProcess = async (): Promise<void> => {
    if (!session.claudePid) return
    setDeleteConfirmType('process')
  }

  const confirmKillProcess = async (): Promise<void> => {
    if (!session.claudePid) return
    setDeleteConfirmType(null)
    const result = await killSessionProcess(session.claudePid)
    if (!result.ok) {
      window.alert(result.error ?? 'Failed to end the process.')
      return
    }
    onDeleted?.()
  }

  // A registered session gets the one shared menu — the same actions, in the
  // same order, as the session detail screen and the session cards. These
  // three used to be three different lists over the same object. Adopt stays
  // outside it: it only exists for a session that has no record yet, which is
  // precisely the case the shared list does not cover.
  const actions: OverflowAction[] = []
  if (onAdopt) actions.push({ label: 'Adopt', onClick: onAdopt })
  if (!session.record) actions.push(readAction(session, onRenamed))
  if (session.record) {
    actions.push(...(sessionActions(session) ?? []))
  } else if (session.tmux) {
    if (onOpenInIde) actions.push({ label: 'Open in IDE', onClick: onOpenInIde })
    if (onFocusTerminal) actions.push({ label: 'Focus terminal', onClick: onFocusTerminal })
    actions.push({
      label: 'Delete',
      danger: true,
      onClick: () => void handleKillWindow()
    })
  } else if (session.backgroundAgentId) {
    actions.push({
      label: 'Delete',
      danger: true,
      onClick: () => void handleStopBackgroundAgent()
    })
  } else if (session.claudePid) {
    actions.push({
      label: 'Delete',
      danger: true,
      onClick: () => void handleKillProcess()
    })
  }

  return (
    <>
      {confirmNode}
      <div
        className={[
          'sessions-row sessions-row-clickable',
          session.unread ? 'sessions-row-unread' : '',
          picked ? 'sessions-row--picked' : '',
          picking ? 'sessions-row--picking' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        role="button"
        tabIndex={0}
        data-session-item
        data-record-id={recordId ?? undefined}
        // As on the Backlog: ⇧-click picks the run up to this row, and once
        // anything is picked a plain click picks too. ⌘-click still opens
        // it in a background tab, as it always has here.
        onClick={(e) => {
          if (recordId && e.shiftKey) selection.toggle(recordId, true)
          else if (picking && recordId && !e.metaKey && !e.ctrlKey) selection.toggle(recordId)
          else onOpen(e.metaKey || e.ctrlKey)
        }}
        onAuxClick={(e) => {
          if (e.button === 1) onOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
      >
        {recordId && (
          <PickCheck
            on={picked}
            label={`Select ${title}`}
            className="sessions-row-pick"
            onToggle={() => selection.toggle(recordId)}
          />
        )}
        {/* Line 1: the title. The status chip used to sit before it in a
            column sized for "external session", so a short chip like "done"
            left a wide hole; it now leads the second line instead. */}
        <div className="sessions-row-line1">
          {renaming ? (
            <form
              className="sessions-row-rename-form"
              onSubmit={(e) => {
                e.preventDefault()
                void submitRename()
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelRename()
                }}
                disabled={renameBusy}
              />
              <button type="submit" disabled={renameBusy}>
                {renameBusy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={cancelRename} disabled={renameBusy}>
                Cancel
              </button>
            </form>
          ) : (
            <span className="sessions-row-title" title={title}>
              {title}
            </span>
          )}
          {!renaming && session.record?.pinned && (
            <span className="sessions-row-pinned" aria-label="Pinned">
              <Icon name="Pin" size={12} />
            </span>
          )}
        </div>

        {/* Line 2: [status chip] [branch] [elapsed] ["N agents working", only when a sub-agent is active] [⋯] */}
        <div className="sessions-row-line2">
          <div className="sessions-row-badge">
            <Badge status={session.status} />
          </div>
          {branch && (
            <div className="sessions-row-branch-cell">
              <Icon name="GitBranch" size={14} />
              <span className="sessions-row-branch" title={branch}>
                {branch}
              </span>
            </div>
          )}

          {activity && (
            <div className="sessions-row-time-cell">
              <Icon name="Clock" size={14} />
              <span className="sessions-row-elapsed">{activity}</span>
            </div>
          )}

          {activeSubagentCount > 0 && (
            <button
              type="button"
              className="sessions-row-subagents-toggle"
              aria-expanded={subagentsExpanded}
              onClick={(e) => {
                e.stopPropagation()
                setSubagentsExpanded((v) => !v)
              }}
            >
              <Icon name="Bot" size={14} />
              <span>
                {activeSubagentCount} agent{activeSubagentCount === 1 ? '' : 's'} working
              </span>
              <Icon name={subagentsExpanded ? 'ChevronDown' : 'ChevronRight'} size={14} />
            </button>
          )}

          <OverflowMenu
            actions={actions}
            label={`${title} actions`}
            className="sessions-row-overflow"
          />
        </div>
      </div>

      {subagentsExpanded && activeSubagentCount > 0 && (
        <ul className="sessions-row-subagents-list" onClick={(e) => e.stopPropagation()}>
          {session.subagents.map((sub) => (
            <li key={sub.agentId} className="sessions-row-subagent">
              <Badge status={sub.active ? 'working' : 'done'} variant="bare" />
              <span className="sessions-row-subagent-desc">
                {sub.description ?? sub.agentType ?? 'Sub-agent'}
              </span>
              {sub.agentType && <span className="sessions-row-subagent-type">{sub.agentType}</span>}
            </li>
          ))}
        </ul>
      )}

      {renameError && <p className="sessions-row-inline-error">{renameError}</p>}

      {sessionActionNode}
      {confirmingDelete && session.record && (
        <DeleteSessionDialog
          record={session.record}
          branch={branch}
          onCancel={() => setConfirmingDelete(false)}
          onDeleted={() => {
            setConfirmingDelete(false)
            onDeleted?.()
          }}
        />
      )}

      {deleteConfirmType === 'window' && session.tmux && (
        <Modal title="End this session?" onClose={() => setDeleteConfirmType(null)} width={520}>
          <div className="delete-modal-content">
            <p>
              This closes its terminal window ({session.tmux.sessionName}:{session.tmux.windowName})
              and stops the process running in it.
            </p>
            <div className="delete-modal-actions">
              <Button variant="outlined" onClick={() => setDeleteConfirmType(null)}>
                Cancel
              </Button>
              <Button variant="filled" onClick={() => void confirmKillWindow()}>
                End session
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {deleteConfirmType === 'background' && session.backgroundAgentId && (
        <Modal
          title="Stop this background agent?"
          onClose={() => setDeleteConfirmType(null)}
          width={520}
        >
          <div className="delete-modal-content">
            <p>Its conversation is kept - resume it later from the CLI with `claude attach`.</p>
            <div className="delete-modal-actions">
              <Button variant="outlined" onClick={() => setDeleteConfirmType(null)}>
                Cancel
              </Button>
              <Button variant="filled" onClick={() => void confirmStopBackgroundAgent()}>
                Stop agent
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {deleteConfirmType === 'process' && session.claudePid && (
        <Modal title="End this session?" onClose={() => setDeleteConfirmType(null)} width={520}>
          <div className="delete-modal-content">
            <p>
              Its terminal is already gone, so this stops the process directly (pid{' '}
              {session.claudePid}) rather than closing a window.
            </p>
            <div className="delete-modal-actions">
              <Button variant="outlined" onClick={() => setDeleteConfirmType(null)}>
                Cancel
              </Button>
              <Button variant="filled" onClick={() => void confirmKillProcess()}>
                End process
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

/**
 * Whether one project's rows are folded away, remembered between runs.
 *
 * localStorage rather than the app's own state file: it is a per-window view
 * preference, not something a session or a project owns, and losing it costs
 * one click.
 */
function useCollapsedProject(projectId: string): [boolean, (next: boolean) => void] {
  const key = `sessions-collapsed:${projectId}`
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const set = (next: boolean): void => {
    setCollapsed(next)
    try {
      localStorage.setItem(key, next ? '1' : '0')
    } catch {
      // Private window or blocked site data — it just won't be remembered.
    }
  }
  return [collapsed, set]
}

interface ProjectContainerProps {
  group: ProjectGroup
  /** A filter is on: show the matches even in a project you collapsed. */
  forceOpen: boolean
  onOpenSession: (liveKey: string, background?: boolean) => void
  /** Offers Adopt on every record-less row here — every session in this
   * container matched this project's cwd or record, so this project is
   * always the right adopt target (fixes Adopt never rendering in List
   * view: this container used to not pass onAdopt at all). */
  onAdopt: (session: LiveSession, projectId: string) => void
  /** Refreshes the live sessions list after a row's delete/rename —
   * onProjectsChanged alone leaves a stale title, or a deleted row still
   * showing, until the next ~2s poll. */
  onRowChanged: () => void
  onNewSession?: (projectId?: string) => void
  onProjectsChanged?: () => void
  onOpenInIde?: (session: LiveSession) => void
  onFocusTerminal?: (session: LiveSession) => void
  pushToast?: (message: string) => void
}

function ProjectContainer({
  group,
  forceOpen,
  onOpenSession,
  onAdopt,
  onRowChanged,
  onNewSession,
  onProjectsChanged,
  onOpenInIde,
  onFocusTerminal,
  pushToast
}: ProjectContainerProps): React.JSX.Element {
  const { project, sessions, hasAttention } = group
  const [storedCollapsed, setCollapsed] = useCollapsedProject(project.id)
  const collapsed = storedCollapsed && !forceOpen
  const [confirmNode, confirm] = useConfirm()
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  const startRename = (): void => {
    setRenameValue(project.name)
    setRenameError(null)
    setRenaming(true)
  }

  const cancelRename = (): void => {
    setRenaming(false)
    setRenameError(null)
  }

  const submitRename = async (): Promise<void> => {
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setRenameError('name cannot be empty')
      return
    }
    if (trimmed === project.name) {
      setRenaming(false)
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      const result = await updateProject(project.id, { name: trimmed })
      if (!result) {
        setRenameError('failed to rename project')
        return
      }
      setRenaming(false)
      onProjectsChanged?.()
    } catch {
      setRenameError('failed to rename project')
    } finally {
      setRenameBusy(false)
    }
  }

  const handlePin = (): void => {
    void updateProject(project.id, { pinned: !project.pinned }).then(() => {
      pushToast?.(project.pinned ? `${project.name} unpinned` : `${project.name} pinned`)
      onProjectsChanged?.()
    })
  }

  const handleRemove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: `Remove ${project.name}?`,
      body: 'This only removes it from Control Room. The repo on disk is never touched.',
      confirmLabel: 'Remove project',
      danger: true
    })
    if (!confirmed) return
    void removeProject(project.id).then(() => onProjectsChanged?.())
  }

  const headerActions: OverflowAction[] = onProjectsChanged
    ? [
        { label: project.pinned ? 'Unpin' : 'Pin to the top', onClick: handlePin },
        { label: 'Rename', onClick: startRename },
        { label: 'Remove', onClick: () => void handleRemove(), danger: true }
      ]
    : []

  return (
    <section className="sessions-project">
      {confirmNode}
      <div className="sessions-project-header">
        {/* Folding a project away is the only way to get a long list under
            control when one project has twenty sessions and you care about
            another. Remembered per project, so it stays folded across polls
            and restarts. */}
        <button
          type="button"
          className="sessions-project-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon
            name="ChevronRight"
            size={14}
            className={`sessions-project-chevron${collapsed ? '' : ' sessions-project-chevron--open'}`}
          />
        </button>
        <span className="sessions-project-glyph" aria-hidden="true">
          <Icon name={project.id === 'general' ? 'Terminal' : 'Folder'} size={14} />
        </span>
        {renaming ? (
          <form
            className="sessions-project-rename-form"
            onSubmit={(e) => {
              e.preventDefault()
              void submitRename()
            }}
          >
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelRename()
              }}
              disabled={renameBusy}
            />
            <button type="submit" disabled={renameBusy}>
              {renameBusy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={cancelRename} disabled={renameBusy}>
              Cancel
            </button>
          </form>
        ) : (
          <span className="sessions-project-name" title={project.name}>
            {project.name}
          </span>
        )}
        {project.pinned && (
          <Tooltip label="Pinned">
            <span className="sessions-project-pin-indicator" role="img" aria-label="Pinned">
              <Icon name="Pin" size={12} />
            </span>
          </Tooltip>
        )}
        {hasAttention && (
          <Tooltip label="Needs attention">
            <span
              className="sessions-project-attention-dot"
              role="img"
              aria-label="Needs attention"
            />
          </Tooltip>
        )}
        <span className="sessions-project-count">
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </span>
        <div className="sessions-project-header-actions">
          {onNewSession && (
            <Button variant="ghost" size="compact" onClick={() => onNewSession(project.id)}>
              + New session
            </Button>
          )}
          <OverflowMenu actions={headerActions} label={`${project.name} actions`} />
        </div>
      </div>
      {renameError && <p className="sessions-project-inline-error">{renameError}</p>}
      {/* Not the `hidden` attribute: it is only `display: none` from the user
          agent stylesheet, and this element sets `display: flex`, so the rows
          stayed exactly where they were. */}
      {!collapsed && (
        <div className="sessions-project-rows">
          {sessions.map((session) => (
            <SessionListRow
              key={session.key}
              session={session}
              onOpen={(background) => onOpenSession(session.key, background)}
              onAdopt={session.record ? undefined : () => onAdopt(session, project.id)}
              onOpenInIde={onOpenInIde ? () => onOpenInIde(session) : undefined}
              onFocusTerminal={onFocusTerminal ? () => onFocusTerminal(session) : undefined}
              onDeleted={onRowChanged}
              onRenamed={onRowChanged}
            />
          ))}
        </div>
      )}
    </section>
  )
}

interface SessionCardProps {
  session: LiveSession
  projectName: string | null
  /** `background`: ⌘- or middle-click — open it in a tab without switching. */
  onOpen: (background?: boolean) => void
  onAdopt?: () => void
}

// Plan 2.4 — "sessions as cards in a responsive grid, same card as the
// ACTIVE grid" (2.3). The full ACTIVE-grid card (context-usage bar) belongs
// to ProjectDetail's own milestone; this is that card's shape — status,
// title, branch in mono, project, elapsed time — scoped to what this
// milestone owns. Still used by the Grid view (untouched by plan 5).
function SessionCard({
  session,
  projectName,
  onOpen,
  onAdopt
}: SessionCardProps): React.JSX.Element {
  const title = sessionTitle(session)
  const branch = session.record?.investigation
    ? 'no worktree'
    : (session.record?.branch ?? session.agentName ?? null)
  return (
    <div
      className={session.unread ? 'session-card session-card-unread' : 'session-card'}
      role="button"
      tabIndex={0}
      data-session-item
      onClick={(e) => onOpen(e.metaKey || e.ctrlKey)}
      onAuxClick={(e) => {
        if (e.button === 1) onOpen(true)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="session-card-top">
        <Badge status={session.status} />
        {activityLabel(session) && (
          <span className="session-card-time">{activityLabel(session)}</span>
        )}
      </div>
      <div className="session-card-title" title={title}>
        {title}
        {session.record?.pinned && (
          <span className="sessions-row-pinned" aria-label="Pinned">
            <Icon name="Pin" size={12} />
          </span>
        )}
      </div>
      {branch && (
        <div className="session-card-branch" title={branch}>
          {branch}
        </div>
      )}
      <div className="session-card-bottom">
        {projectName && <span className="cr-project-pill">{projectName}</span>}
        {onAdopt && (
          <button
            type="button"
            className="session-card-adopt"
            onClick={(e) => {
              e.stopPropagation()
              onAdopt()
            }}
          >
            Adopt
          </button>
        )}
      </div>
    </div>
  )
}

// Designed empty state (not just worded) for when there is nothing to show.
// Two variants: a genuinely empty session list (no filter active) gets the
// full "what a session is" explainer and a primary CTA; a project filter
// that happens to match nothing gets a specific message and a way to clear
// it, never the generic copy — a filtered-to-zero list is not the same
// problem as an actually empty app.
interface SessionsEmptyStateProps {
  filtered: boolean
  /** Distinct from a project filter matching nothing — this is a GOOD
   * outcome (nothing needs the user right now), so it reads like one rather
   * than like an empty/broken screen. Takes priority over `filtered`. */
  attentionOnly?: boolean
  projectName: string | null
  onNewSession?: () => void
  onClearFilter?: () => void
  onClearAttentionFilter?: () => void
}

function SessionsEmptyState({
  filtered,
  attentionOnly,
  projectName,
  onNewSession,
  onClearFilter,
  onClearAttentionFilter
}: SessionsEmptyStateProps): React.JSX.Element {
  return (
    <div className="sessions-empty-wrap">
      <div className="sessions-empty-box">
        {attentionOnly ? (
          <>
            <h2 className="sessions-empty-title">Nothing is waiting on you</h2>
            <p className="sessions-empty-caption">
              Every session is either working on its own or already done. This list updates as that
              changes.
            </p>
            <Button variant="outlined" onClick={onClearAttentionFilter}>
              Show all sessions
            </Button>
          </>
        ) : filtered ? (
          <>
            <h2 className="sessions-empty-title">No sessions match this filter</h2>
            <p className="sessions-empty-caption">
              {projectName
                ? `${projectName} has no sessions right now. Clear the filter to see sessions from every project.`
                : 'Clear the filter to see sessions from every project.'}
            </p>
            <Button variant="outlined" onClick={onClearFilter}>
              Clear filter
            </Button>
          </>
        ) : (
          <>
            <h2 className="sessions-empty-title">No sessions yet</h2>
            <p className="sessions-empty-caption">
              A session is a worktree, a branch, and a Claude Code agent running in a tmux window.
              Start one to see it here.
            </p>
            <Button variant="filled" size="primary" onClick={onNewSession}>
              New session
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export default function SessionsScreen({
  sessions,
  projects,
  selectedProjectId,
  onAdopted,
  onOpenSession,
  onClearFilter,
  onNewSession,
  onProjectsChanged,
  onOpenInIde,
  onFocusTerminal,
  pushToast,
  attentionOnly = false,
  onClearAttentionFilter,
  unreadOnly,
  onUnreadOnlyChange,
  statusFilter,
  onStatusFilterChange
}: Props): React.JSX.Element {
  // Plan 5 — List is the default: it's the one that uses a wide window
  // properly. Grid stays available (untouched card grid) via the toggle.
  const [view, setView] = useState<'grid' | 'list'>('list')

  // The project filter lives in App (the ProjectsScreen sidebar owns
  // selection) — this screen only reads it, so there is exactly one place
  // selection state can live and nothing here can drift out of sync with
  // the sidebar (this used to also keep its own local copy in an internal
  // rail, which could show a different project selected than the sidebar —
  // removed, see sessions-list.css). attentionOnly overrides it rather than
  // combining with it — the bell means "show me what needs me", not "what
  // needs me in whatever project happened to be selected".
  const effectiveProjectId = attentionOnly ? null : selectedProjectId

  // "active 5m ago" is worked out at render. The list used to redraw every
  // 2s whether anything changed or not, which kept these fresh by accident;
  // now it only redraws on real changes, so a slow clock keeps them honest.
  const [, setClock] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setClock((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const [sortMode, setSortMode] = useStoredState<SortMode>('sessions-sort', 'attention')
  // Owned by App, so the bell can switch Unread on from anywhere.
  const setUnreadOnly = onUnreadOnlyChange
  const setStatusFilter = onStatusFilterChange
  const filtersOn = unreadOnly || statusFilter !== null
  const [sortOpen, setSortOpen] = useState(false)
  const sortAnchor = useRef<HTMLDivElement>(null)

  // Everything in scope (project, or the bell) before this screen's own filters.
  const scopedSessions = useMemo(() => {
    if (attentionOnly) return sessions.filter((s) => wantsYou(s.status))
    if (!effectiveProjectId) return sessions
    return sessions.filter((s) => resolveSessionProjectId(s, projects) === effectiveProjectId)
  }, [sessions, effectiveProjectId, projects, attentionOnly])

  const visibleSessions = useMemo(
    () => scopedSessions.filter((s) => (!unreadOnly || s.unread) && matchesStatus(s, statusFilter)),
    [scopedSessions, unreadOnly, statusFilter]
  )

  // Each count answers "what would I get if I clicked this", so it honours
  // the other filter but not its own.
  const unreadCount = scopedSessions.filter(
    (s) => s.unread && matchesStatus(s, statusFilter)
  ).length
  const allCount = scopedSessions.filter((s) => !unreadOnly || s.unread).length
  const statusCounts = new Map<StatusFilterId, number>()
  for (const f of STATUS_FILTERS) {
    statusCounts.set(
      f.id,
      scopedSessions.filter((s) => (!unreadOnly || s.unread) && matchesStatus(s, f.id)).length
    )
  }

  const groups = useMemo(() => {
    const map = new Map<GroupId, LiveSession[]>()
    for (const id of GROUP_ORDER) map.set(id, [])
    for (const session of visibleSessions) {
      map.get(groupOf(session))!.push(session)
    }
    for (const id of GROUP_ORDER) map.set(id, sortSessions(map.get(id)!, sortMode))
    return map
  }, [visibleSessions, sortMode])

  const { groups: projectGroups, other: otherSessions } = useMemo(
    () => buildProjectGroups(visibleSessions, projects, sortMode),
    [visibleSessions, projects, sortMode]
  )

  const handleAdopt = async (session: LiveSession, projectId: string): Promise<void> => {
    const record = await adoptSession(session.key, projectId)
    if (record) {
      onAdopted()
      return
    }
    // sessions:adopt returns null for three reasons — project gone,
    // already adopted, or no longer live — without saying which, and it
    // reruns a full discovery pass keyed on this liveKey rather than
    // trusting the poll this screen holds. Never fail silently: say it
    // failed, and name the exact reason wherever the evidence lets us
    // tell them apart.
    let message = 'Could not adopt this session.'
    if (!projects.some((p) => p.id === projectId)) {
      message = 'Could not adopt: that project no longer exists.'
    } else {
      const fresh = await listSessions().catch(() => null)
      const match = fresh?.find((s) => s.key === session.key)
      if (match?.record) {
        message = 'This session has already been adopted.'
      } else if (!match) {
        message = 'Could not adopt: this session is no longer running.'
      }
    }
    if (pushToast) pushToast(message)
    else window.alert(message)
  }

  // A session's own delete/rename changes the sessions list (a title, or
  // the row itself) — wiring this only to onProjectsChanged left it stale
  // until the next ~2s poll. onAdopted is this screen's only sessions-
  // refresh hook (App.tsx wires it to refreshSessions); reuse it here too.
  const handleSessionRowChanged = (): void => {
    onProjectsChanged?.()
    onAdopted()
  }

  // Bulk delete: sessions picked by their row's checkbox.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [deletingPicked, setDeletingPicked] = useState(false)
  const lastPicked = useRef<string | null>(null)
  const pickedSessions = sessions.filter((s) => s.record && picked.has(s.record.id))
  const pickedRecords = pickedSessions.map((s) => s.record!)
  const selection = useMemo(
    () => ({
      selected: picked,
      toggle: (id: string, range = false) => {
        // The rows in the order they're on screen, for a ⇧-click run.
        const onScreen = [...document.querySelectorAll<HTMLElement>('[data-record-id]')].map(
          (el) => el.dataset.recordId!
        )
        const from = lastPicked.current ? onScreen.indexOf(lastPicked.current) : -1
        const to = onScreen.indexOf(id)
        setPicked((cur) => {
          const next = new Set(cur)
          if (range && from >= 0 && to >= 0) {
            for (const k of onScreen.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(k)
          } else if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        lastPicked.current = id
      }
    }),
    [picked]
  )
  useDismissible(picked.size > 0 && !deletingPicked, 'overlay', () => {
    setPicked(new Set())
  })
  const openPicked = (): void => {
    for (const s of pickedSessions) onOpenSession(s.key, true)
    setPicked(new Set())
  }
  // X picks the focused row; with anything picked, ⌫ deletes and O opens
  // them all in tabs. Never while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || deletingPicked) return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (target?.isContentEditable) return
      const key = e.key.toLowerCase()
      if (key === 'x') {
        const row = target?.closest<HTMLElement>('[data-record-id]')
        if (!row) return
        e.preventDefault()
        selection.toggle(row.dataset.recordId!, e.shiftKey)
      } else if (picked.size > 0 && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault()
        setDeletingPicked(true)
      } else if (picked.size > 0 && key === 'o') {
        e.preventDefault()
        openPicked()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const hasAnySessions = visibleSessions.length > 0
  const filteredToNothing = !hasAnySessions && scopedSessions.length > 0 && filtersOn
  const clearFilters = (): void => {
    setUnreadOnly(false)
    setStatusFilter(null)
  }
  const filterProjectName = effectiveProjectId
    ? (projects.find((p) => p.id === effectiveProjectId)?.name ?? null)
    : null

  return (
    <SessionSelection.Provider value={selection}>
      <div className="sessions-view">
        {pickedRecords.length > 0 && (
          <SelectionBar
            count={pickedRecords.length}
            label="Selected sessions"
            onClear={() => setPicked(new Set())}
          >
            <SelectionAction shortcut="O" onClick={openPicked}>
              Open in tabs
            </SelectionAction>
            <SelectionAction shortcut="⌫" onClick={() => setDeletingPicked(true)}>
              Delete
            </SelectionAction>
          </SelectionBar>
        )}
        {deletingPicked && pickedRecords.length > 0 && (
          <DeleteSessionsDialog
            records={pickedRecords}
            onCancel={() => setDeletingPicked(false)}
            onDone={(failed) => {
              setDeletingPicked(false)
              setPicked(new Set(failed.map((f) => f.record.id)))
              handleSessionRowChanged()
              const done = pickedRecords.length - failed.length
              if (failed.length === 0) {
                pushToast?.(`Deleted ${done} session${done === 1 ? '' : 's'}`)
              } else {
                pushToast?.(
                  `Deleted ${done}. Couldn't delete ${failed
                    .map((f) => `${f.record.title} (${f.error})`)
                    .join(', ')}`
                )
              }
            }}
          />
        )}
        <div className="sessions-main">
          <div className="sessions-main-header">
            <div className="sessions-main-heading">
              <h1 className="sessions-main-title">Sessions</h1>
              {attentionOnly ? (
                <p className="sessions-main-caption">
                  {visibleSessions.length === 0
                    ? 'Nothing is waiting on you'
                    : `${visibleSessions.length} session${visibleSessions.length === 1 ? '' : 's'} need${visibleSessions.length === 1 ? 's' : ''} you`}
                  {' - '}
                  <button
                    type="button"
                    className="sessions-main-caption-clear"
                    onClick={onClearAttentionFilter}
                  >
                    show all sessions
                  </button>
                </p>
              ) : (
                <p className="sessions-main-caption">
                  {filtersOn ? `${visibleSessions.length} of ` : ''}
                  {scopedSessions.length} session{scopedSessions.length === 1 ? '' : 's'}
                  {effectiveProjectId ? ' in this project' : ' across all projects'}
                </p>
              )}
            </div>
            <div className="sessions-main-controls">
              {scopedSessions.length > 0 && (
                <div className="sessions-sort" ref={sortAnchor}>
                  <button
                    type="button"
                    className="sessions-sort-button"
                    aria-haspopup="menu"
                    aria-expanded={sortOpen}
                    onClick={() => setSortOpen((v) => !v)}
                  >
                    <Icon name="ArrowUpDown" size={14} />
                    {SORT_OPTIONS.find((o) => o.value === sortMode)?.label}
                    <Icon name="ChevronDown" size={14} />
                  </button>
                  <Popover
                    open={sortOpen}
                    onClose={() => setSortOpen(false)}
                    anchorRef={sortAnchor}
                    placement="bottom-end"
                    className="sessions-sort-menu"
                    aria-label="Sort sessions"
                  >
                    {SORT_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={sortMode === o.value}
                        className="cr-popover-item sessions-sort-item"
                        onClick={() => {
                          setSortMode(o.value)
                          setSortOpen(false)
                        }}
                      >
                        <span>Sort by {o.label.toLowerCase()}</span>
                        {sortMode === o.value && <Icon name="Check" size={14} />}
                      </button>
                    ))}
                  </Popover>
                </div>
              )}
              <div className="sessions-view-toggle" role="radiogroup" aria-label="View">
                {(
                  [
                    { value: 'list', icon: 'List', label: 'List view' },
                    { value: 'grid', icon: 'LayoutGrid', label: 'Grid view' }
                  ] as const
                ).map((o) => (
                  <Tooltip key={o.value} label={o.label}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={view === o.value}
                      aria-label={o.label}
                      className={
                        view === o.value
                          ? 'sessions-view-option sessions-view-option--selected'
                          : 'sessions-view-option'
                      }
                      onClick={() => setView(o.value)}
                    >
                      <Icon name={o.icon} size={16} />
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>

          {/* One quiet row: status tabs (pick one, or All), and Unread as a
            toggle on the end so it still combines with a status. */}
          {scopedSessions.length > 0 && (
            <div className="sessions-filters">
              <div className="sessions-filter-tabs" role="radiogroup" aria-label="Filter by status">
                <button
                  type="button"
                  role="radio"
                  aria-checked={statusFilter === null}
                  className={
                    statusFilter === null
                      ? 'sessions-filter-tab sessions-filter-tab--selected'
                      : 'sessions-filter-tab'
                  }
                  onClick={() => setStatusFilter(null)}
                >
                  All
                  <span className="sessions-filter-count">{allCount}</span>
                </button>
                {/* Only statuses something actually has — plus the selected
                  one, so it can always be switched off again. */}
                {STATUS_FILTERS.filter(
                  (f) => (statusCounts.get(f.id) ?? 0) > 0 || statusFilter === f.id
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={statusFilter === f.id}
                    className={
                      statusFilter === f.id
                        ? 'sessions-filter-tab sessions-filter-tab--selected'
                        : 'sessions-filter-tab'
                    }
                    onClick={() => setStatusFilter(statusFilter === f.id ? null : f.id)}
                  >
                    <StatusDot status={f.statuses[0]} size={8} />
                    {sentenceCase(STATUS_WORDS[f.statuses[0]])}
                    <span className="sessions-filter-count">{statusCounts.get(f.id) ?? 0}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={unreadOnly}
                className={
                  unreadOnly
                    ? 'sessions-unread-toggle sessions-unread-toggle--on'
                    : 'sessions-unread-toggle'
                }
                onClick={() => setUnreadOnly(!unreadOnly)}
              >
                <span className="sessions-unread-switch" aria-hidden="true" />
                Unread only
                <span className="sessions-filter-count">{unreadCount}</span>
              </button>
            </div>
          )}

          {filteredToNothing && (
            <div className="sessions-empty-wrap">
              <div className="sessions-empty-box">
                <h2 className="sessions-empty-title">No sessions match these filters</h2>
                <Button variant="outlined" onClick={clearFilters}>
                  Clear filters
                </Button>
              </div>
            </div>
          )}

          {!hasAnySessions && !filteredToNothing && (
            <SessionsEmptyState
              filtered={effectiveProjectId !== null}
              attentionOnly={attentionOnly}
              projectName={filterProjectName}
              onNewSession={onNewSession ? () => onNewSession() : undefined}
              onClearFilter={onClearFilter}
              onClearAttentionFilter={onClearAttentionFilter}
            />
          )}

          {hasAnySessions && view === 'list' && (
            <div className="sessions-groups-list">
              {projectGroups.map((group) => (
                <ProjectContainer
                  key={group.project.id}
                  group={group}
                  forceOpen={filtersOn}
                  onOpenSession={onOpenSession}
                  onAdopt={handleAdopt}
                  onRowChanged={handleSessionRowChanged}
                  onNewSession={onNewSession}
                  onProjectsChanged={onProjectsChanged}
                  pushToast={pushToast}
                  onOpenInIde={onOpenInIde}
                  onFocusTerminal={onFocusTerminal}
                />
              ))}

              {otherSessions.length > 0 && (
                <section className="sessions-project sessions-project-other">
                  <div className="sessions-project-header">
                    <span className="sessions-project-name">Other sessions</span>
                    <span className="sessions-project-count">
                      {otherSessions.length} session{otherSessions.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="sessions-project-rows">
                    {otherSessions.map((session) => {
                      const adoptableProject = !session.record
                        ? projectForCwd(session.cwd, projects)
                        : null
                      return (
                        <SessionListRow
                          key={session.key}
                          session={session}
                          onOpen={(background) => onOpenSession(session.key, background)}
                          onAdopt={
                            adoptableProject
                              ? () => handleAdopt(session, adoptableProject.id)
                              : undefined
                          }
                          onOpenInIde={onOpenInIde ? () => onOpenInIde(session) : undefined}
                          onFocusTerminal={
                            onFocusTerminal ? () => onFocusTerminal(session) : undefined
                          }
                          onDeleted={handleSessionRowChanged}
                          onRenamed={handleSessionRowChanged}
                        />
                      )
                    })}
                  </div>
                </section>
              )}
            </div>
          )}

          {hasAnySessions &&
            view === 'grid' &&
            GROUP_ORDER.map((groupId) => {
              const groupSessions = groups.get(groupId) ?? []
              if (groupSessions.length === 0) return null
              return (
                <section key={groupId} className="sessions-group-section">
                  <div className="sessions-group-header">
                    <span className="sessions-group-label">{GROUP_LABEL[groupId]}</span>
                    <span className="sessions-group-count">{groupSessions.length}</span>
                  </div>

                  <div className="sessions-card-grid">
                    {groupSessions.map((session) => {
                      const adoptableProject = !session.record
                        ? projectForCwd(session.cwd, projects)
                        : null
                      return (
                        <SessionCard
                          key={session.key}
                          session={session}
                          projectName={
                            session.record
                              ? (projects.find((p) => p.id === session.record!.projectId)?.name ??
                                null)
                              : null
                          }
                          onOpen={(background) => onOpenSession(session.key, background)}
                          onAdopt={
                            adoptableProject
                              ? () => handleAdopt(session, adoptableProject.id)
                              : undefined
                          }
                        />
                      )
                    })}
                  </div>
                </section>
              )
            })}
        </div>
      </div>
    </SessionSelection.Provider>
  )
}
