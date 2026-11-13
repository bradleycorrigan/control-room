import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import type { ContextWindowUsage } from '../../../main/exec/transcripts'
import TerminalFrame from '../components/TerminalFrame'
import ChatView from '../components/ChatView'
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
  EmptyState,
  Popover,
  SegmentedControl
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
  getSessionPullRequest,
  type JiraBoardData,
  type PullRequestInfo
} from '../api'
import {
  getShipInfo,
  getLinkedPullRequests,
  getSessionArtifacts,
  type TranscriptArtifact,
  draftTicketFromSession,
  type TicketDraftResult,
  askClaude
} from '../api-sessions'
import type { LinkedPullRequest } from '../../../main/exec/pullRequests'
import PrChip from '../components/PrChip'
import { ArtifactPills } from '../components/ArtifactChip'
import { PillFolder } from '../components/PillFolder'
import type { PrPanelTarget } from '../components/prPanelTarget'
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
import { useTitleSuggestion } from '../components/useTitleSuggestion'
import { MenuItems } from '../components/MenuItems'
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
  /** A pull request panel to open straight away: a PR chip clicked on a list. */
  openPrPanel?: PrPanelTarget | null
  /** Called once that panel is open, so it doesn't open again. */
  onPrPanelOpened?: () => void
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
  onOpenTicket,
  openPrPanel,
  onPrPanelOpened
}: Props): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  // The pull request panel: which PR it's about. `branch` is this session's
  // own branch (its PR, or the form to open one); `linked` is a PR the agent
  // opened elsewhere. Null when closed.
  type ShipTarget = PrPanelTarget
  const [shipTarget, setShipTarget] = useState<ShipTarget | null>(openPrPanel ?? null)
  // Asked for again while this session is already open: open it on render,
  // then tell App it's done so it doesn't open again.
  const [askedPrPanel, setAskedPrPanel] = useState(openPrPanel)
  if (openPrPanel !== askedPrPanel) {
    setAskedPrPanel(openPrPanel)
    if (openPrPanel) setShipTarget(openPrPanel)
  }
  useEffect(() => {
    if (openPrPanel) onPrPanelOpened?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPrPanel])
  // Set when "View diff" is clicked from inside the panel, so closing the
  // diff brings the panel back rather than leaving it dismissed.
  const shipReopenAfterDiff = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameField = useRef<HTMLInputElement>(null)
  // A suggested title lands selected, so Enter keeps it and typing replaces
  // it. Selected once React has put it in the field: selecting on the next
  // frame instead raced the commit in a busy window, and the text arrived
  // after the select, with the cursor at its end.
  const selectSuggestion = useRef(false)
  const titleSuggestion = useTitleSuggestion(
    renaming ? (session.record?.id ?? null) : null,
    (t) => {
      selectSuggestion.current = true
      setRenameValue(t)
    }
  )
  useLayoutEffect(() => {
    if (!selectSuggestion.current) return
    selectSuggestion.current = false
    renameField.current?.focus()
    renameField.current?.select()
  }, [renameValue])
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
  // Chat or Terminal: the same session either way. Remembered across
  // sessions and launches. A check or screenshot run keeps it to that launch,
  // so one run's choice never decides what the next run's checks see.
  const viewStore = (): Storage => (window.api.isShotMode ? sessionStorage : localStorage)
  const [paneView, setPaneView] = useState<'chat' | 'terminal'>(() => {
    try {
      return viewStore().getItem('cr-session-view') === 'chat' ? 'chat' : 'terminal'
    } catch {
      return 'terminal'
    }
  })
  const choosePaneView = (v: 'chat' | 'terminal'): void => {
    setPaneView(v)
    try {
      viewStore().setItem('cr-session-view', v)
    } catch {
      // private storage: the choice lasts until the window closes
    }
  }
  const canChat = !!paneId && !!session.tmux && !!session.claudeSessionId
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
  // Bumped when the diff closes: a commit made there can be the first one.
  const [shipCheck, setShipCheck] = useState(0)
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
    // Checked again when the agent finishes a turn or changes status, since
    // that's when its commits land: checked only on open, Ship stayed hidden
    // until you left the session and came back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, session.status, session.activityAt, shipCheck])
  // Pull requests the agent opened, in any repo. One opened in another repo
  // never reaches this worktree's branch; this finds it in the transcript.
  // Checked when a turn ends, status changes, or the PR panel closes.
  const [linkedPrs, setLinkedPrs] = useState<LinkedPullRequest[]>([])
  useEffect(() => {
    if (!recordId) return
    let cancelled = false
    void getLinkedPullRequests(recordId).then((prs) => {
      if (!cancelled) setLinkedPrs(prs ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [recordId, session.status, session.activityAt, shipCheck])

  // Pages the agent published with the Artifact tool: a pill each, after the PRs.
  const [artifacts, setArtifacts] = useState<TranscriptArtifact[]>([])
  useEffect(() => {
    if (!recordId) return
    let cancelled = false
    void getSessionArtifacts(recordId).then((list) => {
      if (!cancelled) setArtifacts(list ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [recordId, session.status, session.activityAt])

  const hasCommitsAhead =
    !!session.record && !session.record.investigation && rawCommitsAhead === true

  // This branch's own pull request, if it has one. Only looked for once the
  // branch has commits: before that there's nothing a PR could hold.
  // undefined until asked; null once we know there isn't one.
  const [branchPr, setBranchPr] = useState<PullRequestInfo | null | undefined>(undefined)
  useEffect(() => {
    if (!recordId || !hasCommitsAhead) return
    let cancelled = false
    void getSessionPullRequest(recordId).then((pr) => {
      if (!cancelled) setBranchPr(pr)
    })
    return () => {
      cancelled = true
    }
  }, [recordId, hasCommitsAhead, session.status, session.activityAt, shipCheck])
  // Opening a PR is Claude's job: while it's running here and the branch has
  // work but no PR, the menu asks it to, in so many words.
  const askPrItem =
    session.record && session.tmux && hasCommitsAhead && branchPr === null
      ? [
          {
            label: 'Ask Claude to open a pull request',
            icon: 'GitPullRequest' as const,
            group: 'pr',
            onClick: () => {
              const id = session.record!.id
              void askClaude(id, 'open-pr').then((r) =>
                pushToast?.(
                  r.ok
                    ? 'Asked Claude to open a pull request.'
                    : (r.error ?? 'Couldn’t ask Claude.')
                )
              )
            }
          }
        ]
      : []
  // Every pill: the branch's PR first, then the ones the agent opened
  // elsewhere. The branch's PR can be in both lists; it keeps its own pill.
  const otherPrs = linkedPrs.filter((pr) => pr.url !== branchPr?.url)
  // Every PR the header shows, branch's first, each with the panel it opens
  // and its state in one word.
  const allPrs = [
    ...(branchPr && hasCommitsAhead
      ? [
          {
            pr: {
              ...branchPr,
              state: ['OPEN', 'MERGED', 'CLOSED'].includes(branchPr.state)
                ? (branchPr.state as 'OPEN' | 'MERGED' | 'CLOSED')
                : null
            },
            isDraft: branchPr.isDraft,
            repository: '',
            target: { kind: 'branch' } as PrPanelTarget
          }
        ]
      : []),
    ...otherPrs.map((pr) => ({
      pr,
      isDraft: pr.isDraft,
      repository: pr.repository,
      target: { kind: 'linked', pr } as PrPanelTarget
    }))
  ].map((p) => {
    const repoName = p.repository.split('/').pop() || projectName || ''
    return {
      ...p,
      repoName,
      repo: repoName && repoName !== projectName ? repoName : undefined,
      word: p.isDraft ? 'draft' : (p.pr.state ?? 'unknown').toLowerCase()
    }
  })

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
  // Haiku's draft for "Create a new ticket", started as soon as the ticket
  // button is pressed, so most of its ~10s passes while the menu is open.
  // Kept for a few minutes, so reopening the form doesn't draft again.
  const ticketDraft = useRef<{ at: number; result: Promise<TicketDraftResult> } | null>(null)
  const startTicketDraft = (board: JiraBoardData): void => {
    if (!session.record) return
    if (ticketDraft.current && Date.now() - ticketDraft.current.at < 5 * 60_000) return
    ticketDraft.current = {
      at: Date.now(),
      result: draftTicketFromSession(session.record.id, {
        epics: board.epics,
        labels: board.labels,
        priorities: board.priorities
      })
    }
  }
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
          emptyText="No tickets match. Type a key, like PROJ-123"
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
            draft={() => {
              startTicketDraft(ticketBoard)
              return ticketDraft.current!.result
            }}
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
            <IconTile icon="Folder" size={28} tone={accent} />
          </button>
        ) : (
          <IconTile icon="Folder" size={28} tone={accent} />
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
                  ref={renameField}
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') cancelRename()
                  }}
                  disabled={renameBusy}
                />
                <button
                  type="button"
                  onClick={titleSuggestion.suggest}
                  disabled={renameBusy || titleSuggestion.state === 'waiting'}
                  title={titleSuggestion.error ?? 'A name from what this session asked and did'}
                >
                  {titleSuggestion.state === 'waiting'
                    ? 'Suggesting…'
                    : titleSuggestion.state === 'error'
                      ? 'Try again'
                      : 'Suggest'}
                </button>
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
                  if (ticketBoard && ticketBoard !== 'loading') {
                    startTicketDraft(ticketBoard)
                    return setTicketMenu(anchor)
                  }
                  setTicketBoard('loading')
                  void loadJiraBoard().then((r) => {
                    if (r.ok) {
                      startTicketDraft(r.value)
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
            {/* One PR: its pill. More: one "N PRs" dropdown, a row each with
                number, repo and state. Either opens that PR's panel. */}
            {allPrs.length === 1 ? (
              <PrChip
                pr={allPrs[0].pr}
                size={20}
                repo={allPrs[0].repo}
                onOpen={() => setShipTarget(allPrs[0].target)}
              />
            ) : (
              allPrs.length > 1 && (
                <PillFolder
                  icon="GitPullRequest"
                  label={`${allPrs.length} PRs`}
                  menuLabel="Pull requests"
                >
                  {(close) =>
                    allPrs.map(({ pr, repoName, target, word }) => (
                      <button
                        key={pr.url}
                        type="button"
                        role="menuitem"
                        className="cr-popover-item cr-pill-folder-main"
                        title={pr.url}
                        onClick={() => {
                          close()
                          setShipTarget(target)
                        }}
                      >
                        <span
                          className={`cr-pr-chip-dot cr-pr-chip-dot--${word}`}
                          aria-hidden="true"
                        />
                        <span className="cr-pill-folder-number">#{pr.number}</span>
                        <span className="cr-artifact-chip-title">{repoName}</span>
                        <span className="cr-pill-folder-meta">{word}</span>
                      </button>
                    ))
                  }
                </PillFolder>
              )
            )}
            <ArtifactPills artifacts={artifacts} ticketKey={ticketKey} pushToast={pushToast} />
          </div>
          {renameError && <p className="session-detail-inline-error">{renameError}</p>}
        </div>
        {/* One group, spaced apart from the title block rather than every
            control sharing the header's own gap — that read as a single row
            of equally-weighted tiles instead of a primary action (the model
            picker) beside a quiet cluster of secondary ones. 28px: this row
            sits inside the session header, not the app's own title bar. */}
        <div className="session-detail-actions">
          {canChat && (
            <SegmentedControl
              aria-label="Show the session as"
              options={[
                { value: 'chat', label: 'Chat' },
                { value: 'terminal', label: 'Terminal' }
              ]}
              value={paneView}
              onChange={choosePaneView}
            />
          )}
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
          <MenuItems
            items={[
              ...sessionActions(session).filter((a) => a.group !== 'end'),
              ...askPrItem,
              // Lived in the header as a "claude ▾" pill: a lot of room for a
              // panel you open now and then. Sits above End and Delete, which
              // stay last.
              { label: 'Token usage', group: 'usage', onClick: () => setContextPanelOpen(true) },
              ...sessionActions(session).filter((a) => a.group === 'end')
            ]}
            onPicked={() => setMenuOpen(false)}
          />
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

      {canChat && paneView === 'chat' ? (
        <ChatView
          claudeSessionId={session.claudeSessionId}
          paneId={paneId}
          working={session.status === 'working'}
        />
      ) : paneId && session.tmux ? (
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
          projectId={session.record.projectId}
          open={diffOpen}
          onClose={() => {
            setDiffOpen(false)
            setShipCheck((n) => n + 1)
            // "View diff" from the PR panel hides the panel to show the
            // diff on top of it (neither uses a portal, so they'd otherwise
            // share a layer and the panel — opened later — would win).
            // Bring it back once the diff closes.
            if (shipReopenAfterDiff.current) {
              shipReopenAfterDiff.current = false
              setShipTarget({ kind: 'branch' })
            }
          }}
        />
      )}

      {shipTarget && session.record && (shipTarget.kind === 'linked' || branch) && (
        <ShipPanel
          key={shipTarget.kind === 'linked' ? shipTarget.pr.url : 'branch'}
          session={session}
          branch={branch ?? ''}
          ticketKey={ticketKey}
          jiraReady={jiraReady}
          linkedPr={shipTarget.kind === 'linked' ? shipTarget.pr : undefined}
          linkedRepo={
            shipTarget.kind === 'linked'
              ? (() => {
                  const name = shipTarget.pr.repository.split('/').pop() ?? ''
                  return name && name !== projectName ? name : undefined
                })()
              : undefined
          }
          onClose={() => {
            setShipTarget(null)
            // Opening a PR or taking one out of draft changes its pill.
            setShipCheck((n) => n + 1)
          }}
          onOpenDiff={() => {
            shipReopenAfterDiff.current = true
            setShipTarget(null)
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
