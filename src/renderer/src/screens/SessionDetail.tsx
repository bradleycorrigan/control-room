import { useEffect, useMemo, useRef, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import type { ContextWindowUsage } from '../../../main/exec/transcripts'
import TerminalFrame from '../components/TerminalFrame'
import DiffOverlay from '../components/DiffOverlay'
import ShipPanel from '../components/ShipPanel'
import ContextWindowPanel from '../components/ContextWindowPanel'
import { useSessionActions } from '../components/useSessionActions'
import DeleteSessionDialog from '../components/DeleteSessionDialog'
import {
  Button,
  Icon,
  IconButton,
  IconTile,
  Badge,
  Pill,
  EmptyState,
  Popover
} from '../components/primitives'
import './session-detail.css'
import { accentByCursorThemeName, themes } from '../theme/themes'
import {
  acknowledgeSession,
  renameSession,
  resumeSession,
  openSessionInIde,
  relaunchSession,
  getSessionContextWindow,
  getJiraStatus,
  getSessionTicketLinks,
  linkSessionToTicket,
  loadJiraBoard,
  type JiraBoardData
} from '../api'
import { getShipInfo } from '../api-sessions'
// Every disabled control below is gated by a condition named after one of
// these — never a literal true/false or a "not implemented yet" string
// (CLAUDE.md non-negotiable). NOT_LIVE and TERMINAL_REACHABLE key
// PRECONDITION_REASON. The plan (Part 5) also named LIFECYCLE_ACTIVE and
// ATTACH_LOCK_FREE for a *disabled* Resume, but neither is readable from the
// renderer — lifecycle is main's own computeInteractiveStatus, and the
// attach lock is an in-memory main-process Set with no IPC to read it. So
// Resume takes the harder CLAUDE.md route instead of guessing: it only
// renders when it can actually work (`canResume` below, all renderer-visible
// state), and any precondition it can't see in advance — already resuming,
// mid-transition, archived — surfaces as the real error the handler returns
// once clicked, never a pre-emptive disabled state. WORKTREE_EXISTS is real
// for Diff, though: `diffEligible` below hides the control entirely for an
// investigate-mode session, which has no worktree to diff.
import { useDismissible } from '../keyboard'
import { CreateTicket } from './backlog/CreateTicket'
import { Picker, type PickerOption } from './backlog/Picker'

interface Props {
  session: LiveSession
  onClose: () => void
  onDeleted: () => void
  // Rename/Archive/Resume change a SessionRecord in main's state without
  // necessarily ending the detail view — App.tsx's sessions list needs a
  // refresh to pick that up, same as onDeleted but without navigating away.
  onSessionUpdated?: () => void
  pushToast?: (message: string) => void
  /** The project it belongs to, by name — from App, which has the projects. */
  projectName: string | null
  /** Opens this ticket's panel on Backlog. */
  onOpenTicket?: (key: string) => void
}

// Plan 1.5 — deterministic fallback accent when there's no Cursor theme match
// (or no workspace file at all): hash a stable per-session string into the
// theme accent list, so the same session always lands on the same colour,
// across restarts. Never Math.random()/Date.now() — must be reproducible.
function hashString(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  return hash >>> 0
}

const FALLBACK_ACCENTS = themes.map((t) => t.accent)

/** How long after a record is created the session still counts as starting. */
const STARTING_WINDOW_MS = 90_000

function accentForSession(session: LiveSession): string {
  if (session.cursorTheme) {
    const matched = accentByCursorThemeName[session.cursorTheme]
    if (matched) return matched
  }
  const seed = session.record?.branch || session.cwd || session.key
  const index = hashString(seed) % FALLBACK_ACCENTS.length
  return FALLBACK_ACCENTS[index]
}

// SessionDetail only receives `session` (no `project`) from App.tsx, which
// is a shared/off-limits file for this milestone — see the final report for
// why this is an approximation rather than the real project name. A
// worktree path looks like `<repoPath>.worktrees/<dirName>`, so the segment
// ending in ".worktrees" is the project's repo basename, which is also
// Project.name's default.

// Terminal reachability (plan 4 Part 2): `session.tmux` populated means the
// discovery pass could see the pane in this poll ("yes"); a `waitingReason` on
// the record means a probe already came back "no" and explained why;
// anything else is "unknown" — never collapsed to a false "no".
type TerminalStatus = 'yes' | 'no' | 'unknown'

function terminalStatusOf(session: LiveSession): TerminalStatus {
  if (session.tmux) return 'yes'
  if (session.record?.waitingReason) return 'no'
  return 'unknown'
}

// The reason shown in a disabled control's title, keyed by the precondition
// that failed — every disabled attribute below is driven by one of these
// constants, never a literal true/false (CLAUDE.md non-negotiable).

/**
 * The Jira ticket a session works on: the one you linked it to (kept locally),
 * else a key from one of your Jira projects in its title or branch.
 */
/** The Create or link menu's first option: make a new ticket rather than link one. */
const CREATE_TICKET = '__create__'

function useTicketKey(
  session: LiveSession,
  refresh: number
): { key: string | null; jiraReady: boolean; jiraProjects: string[] } {
  const [key, setKey] = useState<string | null>(null)
  const [jiraReady, setJiraReady] = useState(false)
  const [jiraProjects, setJiraProjects] = useState<string[]>([])
  const recordId = session.record?.id
  const named = `${session.record?.title ?? ''} ${session.record?.branch ?? ''}`
  useEffect(() => {
    let live = true
    void Promise.all([getJiraStatus(), getSessionTicketLinks()]).then(([status, links]) => {
      if (!live || !status.configured) return
      setJiraReady(true)
      setJiraProjects(status.projects)
      const linked = recordId ? links[recordId] : undefined
      if (linked) return setKey(linked)
      const projects = status.projects.map((p) => p.toUpperCase())
      const found = named
        .toUpperCase()
        .match(/\b[A-Z][A-Z0-9]+-\d+\b/g)
        ?.find((k) => projects.includes(k.split('-')[0]))
      setKey(found ?? null)
    })
    return () => {
      live = false
    }
  }, [recordId, named, refresh])
  return { key, jiraReady, jiraProjects }
}

export default function SessionDetail({
  session,
  onClose,
  onDeleted,
  onSessionUpdated,
  pushToast,
  projectName,
  onOpenTicket
}: Props): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [shipOpen, setShipOpen] = useState(false)
  // Set when "View diff" is clicked from inside the Ship panel, so closing
  // the diff brings the panel back rather than leaving it dismissed.
  const shipReopenAfterDiff = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  // Plan 4 Part 7.4 — context window panel. `undefined` = not yet fetched
  // (button not shown), `null` = fetched but no transcript data available
  // (button shown, panel renders its own "no usage data" state on open).
  const [contextUsage, setContextUsage] = useState<ContextWindowUsage | null | undefined>(undefined)
  const [contextPanelOpen, setContextPanelOpen] = useState(false)
  const [sessionActionNode, sessionActions] = useSessionActions({
    pushToast,
    onChanged: () => onSessionUpdated?.(),
    onRename: () => startRename()
  })
  // The "⋯" trigger, which Popover anchors to and treats as inside the menu
  // so the button keeps toggling. Outside-click and Escape live in Popover.
  const menuRef = useRef<HTMLDivElement>(null)
  // Plan 4, Part 10.2 — app shortcuts (⌘⏎ toggle, esc-while-expanded shrink)
  // only fire when the terminal itself doesn't have keyboard focus; a ref
  // (not state) so the keydown listener reads the latest value without
  // re-subscribing on every focus change.
  const terminalFocusedRef = useRef(false)
  const paneId = session.tmux?.paneId ?? null
  const accent = useMemo(() => accentForSession(session), [session])
  const terminalStatus = terminalStatusOf(session)
  // Ticks so `startingUp` below stops being true once the window has passed,
  // even if nothing else about the session changes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Starting up: the record names a tmux window but discovery has not joined a
  // pane to it yet, and the record was made moments ago.
  //
  // The status is deliberately not consulted. A session that has just been
  // created reports 'stopped', because there is no session file for it yet and
  // rule 2 in status.ts calls anything not alive stopped — which is how the
  // one moment you most want reassurance was showing "Not running".
  //
  // The clock is held in state rather than read during render: Date.now() in a
  // render body is unstable, and the lint rule that says so is right.
  const startingUp =
    !!session.record?.tmuxWindowId &&
    !session.tmux &&
    !session.alive &&
    terminalStatus !== 'no' &&
    now - session.record.createdAt < STARTING_WINDOW_MS

  // Resume (Part 3/5) — only when there's actually something to resume:
  // 'stopped' (the process is gone) or a lost terminal (waitingReason set,
  // via terminalStatus 'no' — the process may still be alive, only its tmux
  // window isn't), and a Claude session id survived to resume from. Checked
  // here, not just server-side, so the control never appears only to fail
  // immediately on click.
  // Claude has exited (Ctrl-C, /exit, a crash) but the session is still
  // there: offer to start it again, fresh or where it left off. Marked-done
  // sessions too — starting one again un-marks it.
  const claudeExited = !!session.record && session.status === 'stopped'
  const canResumeConversation =
    !!session.record && !!(session.record.claudeSessionId || session.record.originalClaudeSessionId)

  // The header's Resume is now only for a process that's alive but whose
  // window was lost — an exited Claude gets the banner above the terminal.
  const canResume =
    !!session.record &&
    !session.record.archivedAt &&
    !claudeExited &&
    terminalStatus === 'no' &&
    canResumeConversation

  // Diff (Part 2.4) — an investigate-mode session has no worktree/branch of
  // its own (worktreePath is just the project's own repoPath), so there's no
  // merge base and nothing to diff. Hide the control rather than open a
  // sheet that can only ever say "no changes".
  const diffEligible = !!session.record && !session.record.investigation

  // Ship (plan 7 step 3) — only when the branch actually has something to
  // ship. `undefined` while unchecked keeps the header exactly as it is
  // until we know, rather than flashing the control in and out.
  const [rawCommitsAhead, setRawCommitsAhead] = useState<boolean | undefined>(undefined)
  const recordId = session.record?.id
  useEffect(() => {
    if (!recordId || session.record?.investigation) return
    let cancelled = false
    void getShipInfo(recordId).then((info) => {
      if (!cancelled) setRawCommitsAhead((info?.git?.commits.length ?? 0) > 0)
    })
    return () => {
      cancelled = true
    }
    // Keyed on the record's id, not the object — sessions:changed replaces
    // session.record on every push, which would otherwise re-run merge-base,
    // git log and git diff --numstat on every status/transcript update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId])
  const hasCommitsAhead =
    !!session.record && !session.record.investigation && rawCommitsAhead === true

  // Opening a session marks it read (and decays M5's 'done'). Again whenever
  // its status changes while it is open: a turn that finishes in front of you
  // is not unread. Not on `unread` itself, or "Mark as unread" from this
  // screen's own menu would undo itself on the spot.
  useEffect(() => {
    acknowledgeSession(session.key)
  }, [session.key, session.status])

  // Plan 4 Part 7.4 — fetch the transcript-derived context window usage once
  // per session, so the header control can show a real percentage rather
  // than a bare "open this to find out" affordance.
  useEffect(() => {
    if (!session.record) return
    let cancelled = false
    getSessionContextWindow(session.record.id).then((usage) => {
      if (!cancelled) setContextUsage(usage)
    })
    return () => {
      cancelled = true
    }
  }, [session.record])

  // Plan 2.5 — ⌘⏎ expands the terminal to fill the window; esc while
  // maximized shrinks it back (esc-esc-to-unfocus is Terminal.tsx's own
  // concern, scoped to releasing keyboard focus rather than the layout).
  // The esc half goes through the dismiss stack so a menu or dialog opened
  // over the maximized terminal closes first.
  useDismissible(maximized, 'overlay', () => {
    // Declined while the terminal has focus, so Escape reaches the agent
    // rather than shrinking the pane out from under it. Read on the press,
    // not at registration — this is a ref, so it never re-renders.
    if (terminalFocusedRef.current) return false
    setMaximized(false)
    return true
  })

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (terminalFocusedRef.current) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        setMaximized((m) => !m)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const startRename = (): void => {
    setMenuOpen(false)
    setRenameValue(session.record?.title ?? title)
    setRenameError(null)
    setRenaming(true)
  }

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
      pushToast?.('Session renamed.')
      onSessionUpdated?.()
    } catch {
      setRenameError('failed to rename session')
    } finally {
      setRenameBusy(false)
    }
  }

  // Resume relaunches a tmux window running `claude --resume <id>` (Part 3).
  // The main handler already guards "already resuming", "just
  // created/resumed", archived and no-session-id — this only adds its own
  // busy flag so a second click here can't race the first. `result.error`
  // is shown verbatim whether ok is true (e.g. a poll-confirm timeout, still
  // worth knowing) or false (a real failure) — only a clean success falls
  // back to our own copy.
  const handleResume = async (): Promise<void> => {
    if (!session.record || resuming) return
    setResuming(true)
    try {
      const result = await resumeSession(session.record.id)
      pushToast?.(result.error ?? 'Session resumed.')
      if (result.ok) onSessionUpdated?.()
    } catch {
      pushToast?.('Failed to resume session.')
    } finally {
      setResuming(false)
    }
  }

  const [relaunching, setRelaunching] = useState<'new' | 'resume' | null>(null)
  const handleRelaunch = async (mode: 'new' | 'resume'): Promise<void> => {
    if (!session.record || relaunching) return
    setRelaunching(mode)
    try {
      const result = await relaunchSession(session.record.id, mode)
      if (!result.ok) pushToast?.(result.error ?? 'Could not start Claude.')
      else if (result.error) pushToast?.(result.error)
      else pushToast?.(mode === 'resume' ? 'Resuming the conversation.' : 'Starting a new Claude.')
      if (result.ok) onSessionUpdated?.()
    } catch {
      pushToast?.('Could not start Claude.')
    } finally {
      setRelaunching(null)
    }
  }

  const title = session.record?.title ?? session.agentName ?? session.cwd
  const [ticketRefresh, setTicketRefresh] = useState(0)
  const { key: ticketKey, jiraReady, jiraProjects } = useTicketKey(session, ticketRefresh)
  // Create or link ticket: the board (tickets to link; epics, priorities and
  // cycle for the form), loaded once asked.
  const [ticketBoard, setTicketBoard] = useState<JiraBoardData | 'loading' | null>(null)
  const [ticketMenu, setTicketMenu] = useState<HTMLElement | null>(null)
  const [creatingTicket, setCreatingTicket] = useState(false)
  const linkTicket = (key: string): void => {
    if (!session.record) return
    void linkSessionToTicket(session.record.id, key).then(() => {
      setTicketRefresh((n) => n + 1)
      pushToast?.(`Linked ${key} to this session`)
    })
  }
  const branch = session.record?.branch ?? null

  return (
    <div
      className={maximized ? 'session-detail session-detail-maximized' : 'session-detail'}
      style={{ '--session-accent': accent } as React.CSSProperties}
    >
      {ticketMenu && ticketBoard && ticketBoard !== 'loading' && (
        <Picker
          anchor={ticketMenu}
          title="Create or link a ticket"
          options={[
            ...(jiraProjects.length > 0
              ? [
                  {
                    value: CREATE_TICKET,
                    label: 'Create a new ticket',
                    icon: <Icon name="Plus" size={12} />
                  }
                ]
              : []),
            ...ticketBoard.issues
              .filter((i) => !i.isEpic && i.statusCategory !== 'done')
              .map((i): PickerOption => ({
                value: i.key,
                label: `${i.key} ${i.summary}`
              }))
          ]}
          emptyText="No tickets match. Type a key, like DSD-123"
          custom={(text) =>
            /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(text) ? `Link ${text.toUpperCase()}` : null
          }
          onPick={(value) =>
            value === CREATE_TICKET ? setCreatingTicket(true) : linkTicket(value.toUpperCase())
          }
          onClose={() => setTicketMenu(null)}
        />
      )}
      {creatingTicket &&
        ticketBoard &&
        ticketBoard !== 'loading' &&
        session.record &&
        jiraProjects.length > 0 && (
          <CreateTicket
            projects={jiraProjects}
            board={ticketBoard}
            defaultInCycle
            initialSummary={title}
            initialDescription={[
              session.record.lastPrompt ?? '',
              session.record.branch && !session.record.investigation
                ? `Branch: {{${session.record.branch}}}`
                : ''
            ]
              .filter(Boolean)
              .join('\n\n')}
            onCreated={(issue) => {
              void linkSessionToTicket(session.record!.id, issue.key).then(() =>
                setTicketRefresh((n) => n + 1)
              )
              pushToast?.(`Created ${issue.key} and linked it to this session`)
            }}
            onClose={() => setCreatingTicket(false)}
          />
        )}
      {maximized && (
        <div className="session-detail-maximize-backdrop" onClick={() => setMaximized(false)} />
      )}
      <div className="session-detail-header">
        {/* No back arrow: tabs are how you move now, and ⌘[ still goes back. */}
        {/* The folder opens the worktree in your IDE — it looked clickable
            and did nothing. Plain decoration for a session with no record. */}
        {session.record ? (
          <button
            type="button"
            className="session-detail-folder"
            aria-label="Open in IDE"
            title="Open in IDE"
            onClick={() => {
              void openSessionInIde(session.record!.id).then((result) => {
                if (!result.ok) pushToast?.(result.error ?? 'Could not open in your IDE.')
              })
            }}
          >
            <IconTile icon="Folder" size={36} tone={accent} />
          </button>
        ) : (
          <IconTile icon="Folder" size={36} tone={accent} />
        )}
        <div className="session-detail-breadcrumb-column">
          <div className="session-detail-breadcrumb">
            {/* The project's own name. This used to be guessed from the path —
                a General session came out as "Users" or "github". */}
            <span className="session-detail-breadcrumb-project">{projectName ?? 'No project'}</span>
            <span className="session-detail-breadcrumb-sep">/</span>
            {renaming ? (
              <form
                className="session-detail-rename-form"
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
              // Double-click renames in place, as a tab's title does. The
              // menu's Rename stays for anyone who looks there first.
              <span
                className={
                  session.record
                    ? 'session-detail-breadcrumb-title session-detail-breadcrumb-title--renamable'
                    : 'session-detail-breadcrumb-title'
                }
                title={session.record ? 'Double-click to rename' : undefined}
                onDoubleClick={session.record ? startRename : undefined}
              >
                {title}
              </span>
            )}
          </div>
          <div className="session-detail-status-row">
            <Badge status={session.status} variant="bare" />
            {ticketKey && onOpenTicket && (
              <button
                type="button"
                className="session-detail-ticket"
                title={`Open ${ticketKey} in Tickets`}
                onClick={() => onOpenTicket(ticketKey)}
              >
                {ticketKey}
              </button>
            )}
            {!ticketKey && jiraReady && session.record && (
              <button
                type="button"
                className="session-detail-ticket session-detail-ticket--create"
                title="Make a Jira ticket from this session, or link one you already have"
                disabled={ticketBoard === 'loading'}
                onClick={(e) => {
                  const anchor = e.currentTarget
                  if (ticketBoard && ticketBoard !== 'loading') return setTicketMenu(anchor)
                  setTicketBoard('loading')
                  void loadJiraBoard().then((r) => {
                    if (r.ok) {
                      setTicketBoard(r.value)
                      setTicketMenu(anchor)
                    } else {
                      setTicketBoard(null)
                      pushToast?.(`Jira: ${r.error}`)
                    }
                  })
                }}
              >
                <Icon name="Plus" size={12} />
                {ticketBoard === 'loading' ? 'Opening…' : 'Create or link ticket'}
              </button>
            )}
          </div>
          {renameError && <p className="session-detail-inline-error">{renameError}</p>}
        </div>
        {/* One group, spaced apart from the title block rather than every
            control sharing the header's own gap — that read as a single row
            of equally-weighted tiles instead of a primary action (the model
            picker) beside a quiet cluster of secondary ones. 28px: this row
            sits inside the session header, not the app's own title bar. */}
        <div className="session-detail-actions">
          <Pill
            size={28}
            tone="var(--text-muted)"
            className="session-detail-context-button"
            onClick={() => setContextPanelOpen(true)}
          >
            claude ▾
          </Pill>
          <div className="session-detail-actions-icons">
            {diffEligible && (
              <IconButton
                icon="FileDiff"
                label="View diff"
                size={28}
                variant="ghost"
                onClick={() => setDiffOpen(true)}
              />
            )}
            {hasCommitsAhead && (
              <IconButton
                icon="Rocket"
                label="Ship"
                size={28}
                variant="ghost"
                onClick={() => setShipOpen(true)}
              />
            )}
            {canResume && (
              <IconButton
                icon="RotateCw"
                label={resuming ? 'Resuming…' : 'Resume session'}
                size={28}
                variant="ghost"
                onClick={() => void handleResume()}
                disabled={resuming}
              />
            )}
            <div ref={menuRef}>
              <IconButton
                icon="MoreHorizontal"
                label="More actions"
                size={28}
                variant="ghost"
                onClick={() => setMenuOpen((o) => !o)}
              />
            </div>
            {/* Close means close: this tab goes, the session keeps running
                (same as Cmd+W). This button used to stop the session while
                looking exactly like this; stopping and deleting live in the
                More actions menu. */}
            <IconButton
              icon="X"
              label="Close tab (⌘W)"
              size={28}
              variant="ghost"
              onClick={onClose}
            />
          </div>
        </div>
        <Popover
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={menuRef}
          placement="bottom-end"
          className="session-detail-menu"
          aria-label="Session actions"
        >
          {/* One list, built by useSessionActions and shared with the session
              cards and the sessions list. These three used to be three
              different menus over the same object: different actions, in
              different orders, so what you could do to a session depended on
              where you happened to be looking at it. Rename stays in place
              here — there is a title on screen to turn into a field. */}
          {[
            // "Write hand-off note…" is one of the shared actions from
            // useSessionActions now — it renders the same on this menu, the
            // sessions list rows and the session cards.
            ...sessionActions(session)
          ].map((action) => (
            <button
              key={action.label}
              role="menuitem"
              className={action.danger ? 'session-detail-menu-destructive' : undefined}
              disabled={Boolean(action.disabled)}
              title={action.disabled}
              onClick={() => {
                setMenuOpen(false)
                action.onClick()
              }}
            >
              {action.label}
            </button>
          ))}
        </Popover>
      </div>

      {confirmingDelete && session.record && (
        <DeleteSessionDialog
          record={session.record}
          branch={branch}
          onCancel={() => setConfirmingDelete(false)}
          onDeleted={() => {
            onDeleted()
            onClose()
          }}
        />
      )}

      {claudeExited && (
        <div className="session-detail-exited" role="status">
          <span className="session-detail-exited-text">
            Claude has exited.{' '}
            {session.tmux
              ? 'Its terminal is still open below.'
              : 'Its window has closed; starting again opens a new one in the same worktree.'}
          </span>
          <div className="session-detail-exited-actions">
            {canResumeConversation && (
              <Button
                variant="outlined"
                size="compact"
                disabled={relaunching !== null}
                onClick={() => void handleRelaunch('resume')}
              >
                {relaunching === 'resume' ? 'Resuming…' : 'Resume conversation'}
              </Button>
            )}
            <Button
              variant="filled"
              size="compact"
              disabled={relaunching !== null}
              onClick={() => void handleRelaunch('new')}
            >
              {relaunching === 'new' ? 'Starting…' : 'Start new Claude'}
            </Button>
          </div>
        </div>
      )}

      {paneId && session.tmux ? (
        <TerminalFrame
          tmuxSessionName={session.tmux.sessionName}
          paneId={paneId}
          maximized={maximized}
          onToggleMaximize={() => setMaximized((m) => !m)}
          onFocusChange={(f) => {
            terminalFocusedRef.current = f
          }}
        />
      ) : startingUp ? (
        // The window exists but discovery has not seen its pane yet, and the
        // agent is still booting. Showing "Not running" here was the opposite
        // of the truth at the one moment you most want reassurance.
        <EmptyState
          icon="Loader2"
          iconSpins
          title="Starting up"
          body="The worktree and tmux window are ready and the agent is booting. Its terminal appears here as soon as it answers."
        />
      ) : (
        // "No live pane" read as breakage. Three separate things land here and
        // only one of them is wrong, so say which: a session running outside
        // tmux can never be mirrored (its terminal belongs to the terminal you
        // started it in), a stopped session has nothing left to show, and a
        // session whose window went away is the only real fault.
        <EmptyState
          icon={session.alive ? 'Terminal' : 'Moon'}
          title={
            session.alive
              ? 'Running outside tmux'
              : terminalStatus === 'no'
                ? 'Its terminal is gone'
                : 'Not running'
          }
          body={
            session.alive
              ? 'This agent was started straight from a terminal rather than inside tmux, so there is no pane to mirror here. Everything else on this screen is live. Start a session from Control Room, or with your wt helpers, and its terminal appears here.'
              : terminalStatus === 'no'
                ? 'The tmux window hosting this session was closed. Start Claude again above, fresh or where it left off.'
                : 'This session is not running. Its worktree and history are still here - start Claude again above.'
          }
        />
      )}

      {sessionActionNode}

      {session.record && (
        <DiffOverlay
          sessionId={session.record.id}
          open={diffOpen}
          onClose={() => {
            setDiffOpen(false)
            // "View diff" from the Ship panel hides the panel to show the
            // diff on top of it (neither uses a portal, so they'd otherwise
            // share a layer and the panel — opened later — would win).
            // Bring it back once the diff closes.
            if (shipReopenAfterDiff.current) {
              shipReopenAfterDiff.current = false
              setShipOpen(true)
            }
          }}
        />
      )}

      {shipOpen && session.record && branch && (
        <ShipPanel
          session={session}
          branch={branch}
          ticketKey={ticketKey}
          jiraReady={jiraReady}
          onClose={() => setShipOpen(false)}
          onOpenDiff={() => {
            shipReopenAfterDiff.current = true
            setShipOpen(false)
            setDiffOpen(true)
          }}
          pushToast={pushToast}
        />
      )}

      {contextPanelOpen && (
        <div
          className="context-window-backdrop"
          onClick={() => setContextPanelOpen(false)}
          role="presentation"
        >
          <div onClick={(e) => e.stopPropagation()}>
            <ContextWindowPanel
              usage={contextUsage ?? null}
              onClose={() => setContextPanelOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
