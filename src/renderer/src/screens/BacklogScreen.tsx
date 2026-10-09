import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Popover,
  ProgressBar,
  StatusDot,
  Textarea,
  Tooltip,
  useConfirm,
  SegmentedControl,
  type IconName
} from '../components/primitives'
import { STATUS_WORDS } from '../components/primitives/Badge'
import {
  addJiraComment,
  addJiraBlockLink,
  addJiraSlackLink,
  removeJiraBlockLink,
  loadTicketPullRequests,
  type TicketPullRequest,
  assignJiraIssue,
  loadAssignablePeople,
  searchJiraPeople,
  configureJira,
  disconnectJira,
  getAppSettings,
  getGitStatus,
  getBacklogPrefs,
  getJiraStatus,
  getSessionPullRequest,
  getSessionTicketLinks,
  linkSessionToTicket,
  loadJiraBoard,
  loadJiraDetail,
  moveJiraIssue,
  openExternal,
  saveBacklogPrefs,
  setJiraEstimate,
  setJiraLabels,
  setJiraParent,
  setJiraPriority,
  setJiraSprint,
  createJiraSprint,
  setJiraSprintGoal,
  updateJiraText,
  type BacklogPrefs,
  type BlockDirection,
  type JiraBlockLink,
  type JiraBoardData,
  type JiraColumn,
  type PullRequestInfo,
  type SavedView,
  type JiraIssue,
  type JiraPerson,
  type JiraIssueDetail,
  type JiraResult,
  type JiraStatus
} from '../api'
import { createJiraSubtask } from '../api-backlog'
import { useDismissible } from '../keyboard'
import { useStoredState } from '../state/useStoredState'
import {
  Avatar,
  EpicMark,
  PriorityGlyph,
  GitHubGlyph,
  SlackGlyph,
  StatusGlyph,
  WikiText
} from './backlogGlyphs'
import { DRAG_TYPE } from './backlogStatus'
import { ColumnsEditor } from './backlog/ColumnsEditor'
import { CreateTicket } from './backlog/CreateTicket'
import { CycleStrip, PlanningBar } from './backlog/CyclePlanning'
import { Picker, type PickerOption } from './backlog/Picker'
import {
  branchFor,
  seedFor,
  sessionsForTicket,
  type ComposerSeed,
  type SessionEntry
} from './backlog/ticketSessions'
import { PickCheck, SelectionAction, SelectionBar } from '../components/selection'
import './backlog.css'

export type { ComposerSeed } from './backlog/ticketSessions'

/** What a toast can offer, beyond the dismiss it always has. */
export interface ToastActionLike {
  label: string
  onClick: () => void
}

interface Props {
  sessions: LiveSession[]
  onStartSession: (seed: ComposerSeed) => void
  onOpenSession: (liveKey: string) => void
  pushToast?: (message: string, action?: ToastActionLike) => void
  /** Opened from elsewhere (a session's ticket pill): show this ticket's panel. */
  openTicket?: string | null
  onTicketOpened?: () => void
  /** The app's sidebar setting, shared with Sessions (title-bar button, ⌘B). */
  sidebarHidden?: boolean
  sidebarWidth?: number
  onSidebarResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void
  onSidebarResizeReset?: () => void
  /**
   * Just the ticket panel, over whatever screen is showing (a session's
   * ticket opens this way, so you stay in the session). Same board, edits
   * and panel as the Backlog itself, without the list.
   */
  panelOnly?: boolean
  /** Panel only: the panel was closed. */
  onPanelClose?: () => void
  /** Panel only: carry on with this ticket on the full Backlog. */
  onExpand?: (key: string) => void
}

type Who = 'all' | 'mine' | 'unassigned'
type View = 'list' | 'board'
type GroupBy = 'status' | 'epic' | 'cycle'
/** These projects work in one cycle at a time, plus the backlog. */
/** 'backlog' is tickets in no cycle; `sprint:<id>` is one upcoming cycle. */
type CycleFilter = 'all' | 'current' | 'backlog' | `sprint:${number}`

/** The open cycles people plan into: the active one first, then upcoming. */
const cycleLabel = (s: { name: string; state: string }): string =>
  s.state === 'active' ? `Current cycle (${s.name})` : s.name
type StatusOption = { name: string; category: string }

/**
 * What a group stands for, so a card dropped into it can become part of it:
 * a status (a transition), an epic (the parent), or the cycle (in or out).
 */
type LaneValue =
  | { kind: 'column'; column: JiraColumn; category: string }
  | { kind: 'epic'; key: string | null }
  | { kind: 'cycle'; sprintId: number | null }
  | null

interface Lane {
  id: string
  title: string
  /** Quiet detail after the title: an epic's key, the cycle's name. */
  hint?: string
  items: JiraIssue[]
  value: LaneValue
}

/** "5m ago", "3d ago", or "on 23 Jul" once it's two months old. */
function when(iso: string): string {
  const short = ago(iso)
  if (!short) return ''
  return /\d[mhd]$/.test(short) ? `${short} ago` : `on ${short}`
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const m = Math.round(ms / 60000)
  if (m < 60) return `${Math.max(m, 1)}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 60) return `${d}d`
  // Older than that, the date; with the year once it isn't this year's.
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {})
  })
}

function fullDate(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : ''
}

/** Jira request types often lead with an emoji; the word is enough here. */
const typeName = (issue: JiraIssue): string =>
  (issue.requestType ?? issue.issueType).replace(/^[^\p{L}\p{N}]+/u, '').trim()

const isSlack = (url: string): boolean => /\.slack\.com\//.test(url)
const slackLink = (issue: JiraIssue): string | undefined =>
  issue.links.find((l) => isSlack(l.url))?.url

const LIST_RANK = (category: string): number =>
  category === 'indeterminate' ? 0 : category === 'new' ? 1 : 2

const UNASSIGNED = '__unassigned'
/** You, in Filter → Assignee: what the Mine tab picks. */
const ME = '__me'

/** Whether a ticket is one of these people's ([] is everyone). */
const assignedTo = (i: JiraIssue, people: string[]): boolean =>
  people.length === 0 ||
  people.some((p) =>
    p === ME ? i.assignedToMe : p === UNASSIGNED ? !i.assignee : i.assignee === p
  )

/** Whether a ticket is in any of these cycles ([] is every open ticket). */
const inCycles = (i: JiraIssue, cycles: CycleFilter[]): boolean =>
  cycles.length === 0 ||
  cycles.some((c) =>
    c === 'current'
      ? i.sprint?.state === 'active'
      : c === 'backlog'
        ? !i.sprint
        : c === 'all' || i.sprint?.id === Number(c.slice(7))
  )

/** The same people or cycles, in any order. */
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')
const NO_EPIC = '__none'
/** After this long away, coming back to the window fetches fresh tickets. */
const STALE_MS = 2 * 60 * 1000

function matches(issue: JiraIssue, query: string): boolean {
  if (!query) return true
  return [
    issue.key,
    issue.summary,
    issue.assignee ?? '',
    issue.parent?.summary ?? '',
    issue.requestType ?? '',
    issue.status,
    ...issue.labels
  ].some((v) => v.toLowerCase().includes(query))
}

/**
 * Backlog — a lightweight Jira on top of Jira. Every open ticket in your
 * projects as a list or a board, grouped by status, epic or cycle. Drag a
 * ticket into another group and it becomes part of it — a new status, a new
 * epic, into or out of the current cycle — in Jira. Click a ticket to peek at
 * it beside the list; J and K walk the list and the panel follows. Right-click
 * for everything you can do to a ticket. Sessions link to tickets locally
 * (Jira never hears about the link).
 */
/**
 * Ids in the order they first appeared, including ones that have since
 * gone, until `resetKey` changes. Lists that re-sort or drop rows as tickets
 * move (an epic's count reaching 0, a group's last ticket leaving) read this
 * to hold still while you work; they settle when you change the view.
 */
function useSettledOrder(ids: string[], resetKey: string): string[] {
  const [state, setState] = useState<{ key: string; order: string[] }>({
    key: resetKey,
    order: ids
  })
  const base = state.key === resetKey ? state.order : []
  const missing = ids.filter((id) => !base.includes(id))
  if (state.key !== resetKey || missing.length > 0) {
    const order = [...base, ...missing]
    // Storing what earlier renders saw: React's pattern for state derived
    // from a changing input, set during render rather than in an effect.
    setState({ key: resetKey, order })
    return order
  }
  return base
}

export default function BacklogScreen({
  sessions,
  onStartSession,
  onOpenSession,
  pushToast,
  openTicket,
  onTicketOpened,
  sidebarHidden = false,
  sidebarWidth = 260,
  onSidebarResizeStart,
  onSidebarResizeReset,
  panelOnly = false,
  onPanelClose,
  onExpand
}: Props): React.JSX.Element {
  const [status, setStatus] = useState<JiraStatus | null>(null)
  const [board, setBoard] = useState<JiraBoardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [links, setLinks] = useState<Record<string, string>>({})
  // Everyone a ticket can be assigned to, for the assignee pickers.
  const [assignable, setAssignable] = useState<JiraPerson[]>([])
  const [who, setWho] = useStoredState<Who>('backlog-who', 'all')
  // Opens the way Settings → Views says; the switch changes it from there.
  const [view, setView] = useState<View>('list')
  useEffect(() => {
    let live = true
    void getAppSettings().then((settings) => {
      if (live && settings.ticketsView) setView(settings.ticketsView)
    })
    return () => {
      live = false
    }
  }, [])
  // Group by one thing, or two: the second splits each group into sub-groups.
  const [grouping, setGrouping] = useStoredState<GroupBy[]>('backlog-grouping', ['status'])
  const groupBy: GroupBy = grouping[0] ?? 'status'
  const subGroup: GroupBy | null = grouping[1] && grouping[1] !== groupBy ? grouping[1] : null
  const [collapsed, setCollapsed] = useStoredState<string[]>('backlog-collapsed', [])
  // Filters sit on top of the tab you're on (Everyone / Mine / Unassigned or
  // a saved view) and last while you're on the Backlog: leave and come back
  // and they're gone, the way Linear drops unsaved filters. Remembering them
  // hid tickets behind filters nobody could see were on. Hide done is the
  // exception — a standing preference, like Linear's completed-issues option.
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [hideDone, setHideDone] = useStoredState<boolean>('backlog-hide-done', false)
  // People picked in Filter → Assignee (empty: everyone). UNASSIGNED stands
  // for tickets with nobody on them.
  const [assignees, setAssignees] = useState<string[]>([])
  // Sidebar → Epics: one epic's tickets (NO_EPIC for those without), or all.
  const [epicFilter, setEpicFilter] = useState<string | null>(null)
  const sidebarOpen = !sidebarHidden
  // Cycles picked in the sidebar or Filter → Cycle; [] is every open ticket.
  // The sidebar picks one; the filter can add more ("current + kestrel").
  const [cycleSet, setCycleSet] = useState<CycleFilter[]>([])
  const setCycle = useCallback((c: CycleFilter) => setCycleSet(c === 'all' ? [] : [c]), [])
  const [query, setQuery] = useState('')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [prefs, setPrefs] = useState<BacklogPrefs>({ columns: null, views: [], capacity: {} })
  // Tickets picked with ⌘-click, ⇧-click or X, for changing several at once.
  const [selected, setSelected] = useState<string[]>([])
  const lastPicked = useRef<string | null>(null)
  const [picker, setPicker] = useState<{
    title: string
    anchor: HTMLElement
    options: PickerOption[]
    onPick: (value: string) => void
    custom?: (text: string) => string | null
  } | null>(null)
  const [creating, setCreating] = useState(false)
  // Open pull requests of sessions that belong to tickets, by session record id.
  const [prs, setPrs] = useState<Record<string, PullRequestInfo | null>>({})
  // Tickets whose sub-tasks are unfolded under them in the list.
  const [expandedSubtasks, setExpandedSubtasks] = useState<string[]>([])
  // "KEY:number" for every open PR already offered as a toast, so it never
  // nags twice — remembered on this Mac, not per session.
  const [offeredPrs, setOfferedPrs] = useStoredState<string[]>('backlog-pr-offered', [])
  const [editingColumns, setEditingColumns] = useState(false)
  // The cycle open in the planning view, or null when it's closed.
  // Planning: the list grouped by cycle, with each cycle's facts and the next
  // one's load under its title. Holds the cycle being planned and the view
  // to go back to.
  const [planning, setPlanning] = useState<{
    nextId: number | null
    restore: {
      grouping: GroupBy[]
      view: View
      cycleSet: CycleFilter[]
      who: Who
      assignees: string[]
    }
  } | null>(null)
  const [planningSince] = useState(() => Date.now())
  // Planning's folds, kept apart from your saved ones so leaving planning any
  // way at all (quitting, switching screen) leaves your view as it was. The
  // current cycle starts folded: its unfinished tickets are listed in the
  // next one, so the cycle being planned comes first.
  const [planFolds, setPlanFolds] = useState<Record<string, boolean>>({})
  // Planning's "N without an estimate": only tickets with no estimate.
  const [noEstimateOnly, setNoEstimateOnly] = useState(false)
  // While a ticket is being dragged, empty groups show too, as drop targets.
  const [dragging, setDragging] = useState(false)
  const loadedAt = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const [confirmNode, confirm] = useConfirm()
  // The top filter row must stay on one line even as the ticket panel eats
  // its width. Rather than wrap, the search collapses to an icon button. A
  // callback ref (not useRef) because the row doesn't exist on first mount
  // (status is still null then) — this re-runs the measuring effect once it
  // actually appears, and again if it's ever torn down and rebuilt (Jira
  // disconnect/reconnect).
  const [filtersEl, setFiltersEl] = useState<HTMLDivElement | null>(null)
  const [searchCompact, setSearchCompact] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  const searchCompactRef = useRef(false)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    const result = await loadJiraBoard(refresh)
    setLoading(false)
    if (refresh) setPrs({})
    if (result.ok) {
      loadedAt.current = Date.now()
      setBoard(result.value)
      setError(null)
    } else setError(result.error)
  }, [])

  useEffect(() => {
    void getJiraStatus().then((s) => {
      setStatus(s)
      if (s.configured) void load()
    })
    void getSessionTicketLinks().then(setLinks)
    void getBacklogPrefs().then(setPrefs)
  }, [load])

  // Back at the window after a while: fetch what changed in Jira meanwhile.
  useEffect(() => {
    if (!status?.configured) return
    const onFocus = (): void => {
      if (Date.now() - loadedAt.current > STALE_MS) void load(true)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [status, load])

  // With the panel open, it follows keyboard focus (J / K, Tab) onto
  // whichever ticket gets it. A document listener rather than each row's
  // onFocus, which missed some moves and left the panel behind.
  useEffect(() => {
    const onFocusIn = (e: Event): void => {
      const el = e.target as HTMLElement | null
      const key = el?.matches?.('[data-issue][data-nav-item]') ? el.dataset.issue : undefined
      if (key) setOpenKey((cur) => (cur && cur !== key ? key : cur))
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('cr:nav-focus', onFocusIn as EventListener)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('cr:nav-focus', onFocusIn as EventListener)
    }
  }, [])

  // A drag always ends, however it ends. After a drop the dragged row moves
  // to its new group — a different element — so its own dragend never
  // bubbles up here, and the empty "Drop here" groups stayed on screen.
  //
  // Cleared after the drop has been handled, not before: this listener runs
  // first (capture), and React re-renders in the gap before the group's own
  // drop handler. The empty groups only exist while dragging, so the one
  // under the pointer vanished and a drop onto it was lost.
  useEffect(() => {
    const end = (): void => {
      setTimeout(() => setDragging(false), 0)
    }
    window.addEventListener('dragend', end, true)
    window.addEventListener('drop', end, true)
    return () => {
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('drop', end, true)
    }
  }, [])

  // "/" jumps to search, as in Linear and most of the web.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !typing) {
        e.preventDefault()
        // Only compact search needs "opening" (the floating overlay); a full
        // search box is already there to focus.
        if (searchCompactRef.current) setSearchOpen(true)
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    searchOpenRef.current = searchOpen
  }, [searchOpen])

  useEffect(() => {
    searchCompactRef.current = searchCompact
  }, [searchCompact])

  // Focus lands on the search input the moment it (re)appears — after "/",
  // after clicking the collapsed search icon, or once the row has room again.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen, searchCompact])

  // Keep tabs + search + Filter/Display/view on one line: when the row (not
  // the window — the panel changes the space, not the viewport) runs short,
  // collapse the search box to an icon button rather than wrapping or
  // clipping the tabs. Tabs and the rest of the menus group never shrink
  // (see backlog.css); only the search collapses, so the threshold is worked
  // out from their real measured widths rather than relying on the row ever
  // visibly overflowing.
  useEffect(() => {
    const el = filtersEl
    if (!el) return
    const tabsEl = el.querySelector<HTMLElement>('.backlog-filter-tabs')
    const menusEl = el.querySelector<HTMLElement>('.backlog-filter-menus')
    const slotEl = el.querySelector<HTMLElement>('.backlog-search-slot')
    if (!tabsEl || !menusEl || !slotEl) return
    const measure = (): void => {
      const slotStyle = getComputedStyle(slotEl)
      const fullWidth =
        parseFloat(slotStyle.getPropertyValue('--search-width')) ||
        slotEl.getBoundingClientRect().width
      const gap = parseFloat(getComputedStyle(el).columnGap || getComputedStyle(el).gap) || 12
      const slotWidth = slotEl.getBoundingClientRect().width
      // The rest of the menus group (Filter/Display/view toggle + their
      // gaps), with the search slot's own width taken back out — accurate
      // whichever state the search is currently in.
      const restWidth = menusEl.scrollWidth - slotWidth
      const neededExpanded = tabsEl.scrollWidth + restWidth + fullWidth + gap
      const available = el.clientWidth
      setSearchCompact((compact) => {
        if (searchOpenRef.current) return true
        if (!compact) return neededExpanded > available
        // A little hysteresis so it doesn't flicker right at the boundary.
        return neededExpanded > available - 4
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [filtersEl])

  // A ticket opened from elsewhere: adopt it during render, then tell the
  // parent it's been taken so the same key can open again later.
  const [takenTicket, setTakenTicket] = useState<string | null>(null)
  if (openTicket && openTicket !== takenTicket) {
    setTakenTicket(openTicket)
    setOpenKey(openTicket)
  }
  if (!openTicket && takenTicket) setTakenTicket(null)
  useEffect(() => {
    if (openTicket) onTicketOpened?.()
  }, [openTicket, onTicketOpened])
  // Panel only: closing the panel (its X, Escape) closes the whole thing.
  useEffect(() => {
    if (panelOnly && takenTicket && openKey === null) onPanelClose?.()
  }, [panelOnly, takenTicket, openKey, onPanelClose])

  const apply = useCallback((issue: JiraIssue) => {
    setBoard((b) =>
      b
        ? {
            ...b,
            issues: b.issues.map((i) =>
              i.key === issue.key
                ? {
                    ...issue,
                    pullRequests: issue.pullRequests ?? i.pullRequests,
                    // A single-issue write (loadIssue) doesn't recompute the
                    // sub-task list the full board search does — keep what's
                    // already on screen rather than wiping it to none.
                    subtasks: issue.subtasks?.length ? issue.subtasks : i.subtasks
                  }
                : i
            )
          }
        : b
    )
  }, [])

  /**
   * Runs a Jira write. The change shows at once (when `optimistic` is given);
   * on failure it says why and reloads, so nothing on screen lies. Success
   * says nothing: the change is already there.
   */
  const write = useCallback(
    async (run: () => Promise<JiraResult<JiraIssue>>, optimistic?: JiraIssue): Promise<boolean> => {
      if (optimistic) apply(optimistic)
      const result = await run()
      if (result.ok) {
        apply(result.value)
        return true
      }
      pushToast?.(`Jira: ${result.error}`)
      void load(true)
      return false
    },
    [apply, load, pushToast]
  )

  /** Adds a sub-task under a ticket and puts it straight on the board. */
  const addSubtask = useCallback(
    async (issue: JiraIssue, summary: string): Promise<boolean> => {
      const result = await createJiraSubtask(issue.project, issue.key, summary)
      if (!result.ok) {
        pushToast?.(`Jira: ${result.error}`)
        return false
      }
      const child = result.value
      setBoard((b) =>
        b
          ? {
              ...b,
              issues: [
                child,
                ...b.issues.map((i) =>
                  i.key === issue.key ? { ...i, subtasks: [...(i.subtasks ?? []), child.key] } : i
                )
              ]
            }
          : b
      )
      return true
    },
    [pushToast]
  )

  /**
   * Links two tickets as blocker and blocked. Jira keeps one link and shows it
   * from both ends, so the ticket at the other end changes here too.
   */
  const addBlock = useCallback(
    async (issue: JiraIssue, other: string, direction: BlockDirection): Promise<boolean> => {
      const result = await addJiraBlockLink(issue.key, other, direction)
      if (!result.ok) {
        pushToast?.(`Jira: ${result.error}`)
        return false
      }
      apply(result.value)
      const added = result.value[direction].find(
        (l) =>
          l.key === other.trim().toUpperCase() &&
          !issue[direction].some((o) => o.linkId === l.linkId)
      )
      if (added) {
        const mirror: BlockDirection = direction === 'blockedBy' ? 'blocking' : 'blockedBy'
        const self: JiraBlockLink = {
          linkId: added.linkId,
          key: issue.key,
          summary: issue.summary,
          status: issue.status,
          statusCategory: issue.statusCategory
        }
        setBoard((b) =>
          b
            ? {
                ...b,
                issues: b.issues.map((i) =>
                  i.key === added.key && !i[mirror].some((l) => l.linkId === added.linkId)
                    ? { ...i, [mirror]: [...i[mirror], self] }
                    : i
                )
              }
            : b
        )
      }
      return true
    },
    [apply, pushToast]
  )

  const removeBlock = useCallback(
    async (issue: JiraIssue, link: JiraBlockLink): Promise<boolean> => {
      const without = (i: JiraIssue): JiraIssue => ({
        ...i,
        blockedBy: i.blockedBy.filter((l) => l.linkId !== link.linkId),
        blocking: i.blocking.filter((l) => l.linkId !== link.linkId)
      })
      const ok = await write(() => removeJiraBlockLink(issue.key, link.linkId), without(issue))
      if (ok) {
        setBoard((b) =>
          b ? { ...b, issues: b.issues.map((i) => (i.key === link.key ? without(i) : i)) } : b
        )
      }
      return ok
    },
    [write]
  )

  const activeSprint = board?.sprints.find((s) => s.state === 'active') ?? null
  const sprints = useMemo(() => board?.sprints ?? [], [board])
  // A remembered upcoming cycle that has since started or closed falls back to everything.
  // A remembered upcoming cycle that has since started or closed drops out.
  const cycles = cycleSet.filter(
    (c) =>
      !c.startsWith('sprint:') ||
      !board ||
      sprints.some((sp) => `sprint:${sp.id}` === c && sp.state !== 'active')
  )
  // One cycle picked: that one; none or several: 'all', for what shows a
  // single cycle (the sidebar's highlight, the cycle pill on each row).
  const cycle: CycleFilter = cycles.length === 1 ? cycles[0] : 'all'
  const myName = board?.issues.find((i) => i.assignedToMe)?.assignee ?? 'You'
  const boardLoaded = Boolean(board)
  useEffect(() => {
    if (!boardLoaded) return
    let live = true
    void loadAssignablePeople().then((r) => {
      if (live && r.ok) setAssignable(r.value)
    })
    return () => {
      live = false
    }
  }, [boardLoaded])

  // Every edit, in one place, so the row menu and the panel do the same thing.
  const actions = useMemo(
    () => ({
      status: (issue: JiraIssue, s: StatusOption) =>
        issue.status === s.name
          ? Promise.resolve(true)
          : write(() => moveJiraIssue(issue.key, s.name), {
              ...issue,
              status: s.name,
              statusCategory: s.category
            }),
      /** Into a cycle by id, or (null) out to the backlog. */
      cycle: (issue: JiraIssue, sprintId: number | null) => {
        if ((issue.sprint?.id ?? null) === sprintId) return Promise.resolve(true)
        const sprint = board?.sprints.find((sp) => sp.id === sprintId) ?? null
        return write(() => setJiraSprint(issue.key, sprint ? sprint.id : null), {
          ...issue,
          sprint: sprint ? { id: sprint.id, name: sprint.name, state: sprint.state } : null
        })
      },
      setAssignee: (issue: JiraIssue, who: 'me' | 'none' | JiraPerson) => {
        const name = who === 'me' ? myName : who === 'none' ? null : who.name
        const toMe = who === 'me' || name === myName
        if (issue.assignee === name && issue.assignedToMe === toMe) return Promise.resolve(true)
        return write(
          () =>
            assignJiraIssue(
              issue.key,
              who === 'me' ? true : who === 'none' ? false : who.accountId
            ),
          { ...issue, assignedToMe: toMe, assignee: name }
        )
      },
      assign: (issue: JiraIssue) =>
        write(() => assignJiraIssue(issue.key, !issue.assignedToMe), {
          ...issue,
          assignedToMe: !issue.assignedToMe,
          assignee: issue.assignedToMe ? null : myName
        }),
      parent: (issue: JiraIssue, key: string | null) => {
        const epic = board?.epics.find((e) => e.key === key)
        return write(() => setJiraParent(issue.key, key), {
          ...issue,
          parent: key ? { key, summary: epic?.summary ?? key } : null
        })
      },
      priority: (issue: JiraIssue, priority: string) =>
        issue.priority === priority
          ? Promise.resolve(true)
          : write(() => setJiraPriority(issue.key, priority), { ...issue, priority }),
      labels: (issue: JiraIssue, labels: string[]) =>
        write(() => setJiraLabels(issue.key, labels), { ...issue, labels }),
      estimate: (issue: JiraIssue, estimate: string | null) =>
        write(() => setJiraEstimate(issue.key, estimate), { ...issue, estimate })
    }),
    [write, myName, board]
  )

  const copy = useCallback(
    (text: string, what: string) => {
      void navigator.clipboard.writeText(text).then(
        () => pushToast?.(`Copied ${what}`),
        () => pushToast?.(`Couldn’t copy ${what}`)
      )
    },
    [pushToast]
  )

  // Sessions a ticket belongs to: ones you linked (kept locally), then any
  // whose title or branch carries the ticket's key.
  const sessionsFor = useCallback(
    (issue: JiraIssue): SessionEntry[] => sessionsForTicket(issue, sessions, links),
    [sessions, links]
  )

  // Columns: yours if you've set them up, else the Jira board's, else one
  // per status. A status in no column is hidden, tickets and all — as on a
  // Jira board.
  const columns = useMemo((): JiraColumn[] => {
    const list =
      prefs.columns ??
      board?.columns ??
      (board?.statuses ?? []).map((st) => ({ name: st.name, statuses: [st.name] }))
    return list.filter((c) => c.statuses.length > 0)
  }, [prefs.columns, board])
  const mappedStatuses = useMemo(() => new Set(columns.flatMap((c) => c.statuses)), [columns])
  const categoryOf = useCallback(
    (status: string) => board?.statuses.find((st) => st.name === status)?.category ?? 'new',
    [board]
  )
  // The statuses one ticket can be in: its project's own, in workflow order.
  const statusesFor = useCallback(
    (issue: JiraIssue): StatusOption[] => {
      const own = board?.projectStatuses[issue.project]
      const all = board?.statuses ?? []
      return own?.length ? all.filter((st) => own.includes(st.name)) : all
    },
    [board]
  )
  /** Where a ticket dropped in this column lands: the first of its statuses the ticket's project has. */
  const statusInColumn = useCallback(
    (issue: JiraIssue, column: JiraColumn): StatusOption | null => {
      if (column.statuses.includes(issue.status)) return null
      const own = board?.projectStatuses[issue.project]
      const name = column.statuses.find((st) => !own?.length || own.includes(st))
      return name ? { name, category: categoryOf(name) } : null
    },
    [board, categoryOf]
  )

  const columnNameOf = useCallback(
    (status: string): string => columns.find((c) => c.statuses.includes(status))?.name ?? '',
    [columns]
  )
  const doneColumns = useMemo(
    () => columns.filter((c) => categoryOf(c.statuses[0]) === 'done').map((c) => c.name),
    [columns, categoryOf]
  )
  /** Columns filtered out: the ones picked, plus the done ones when hiding done. */
  const hidden = useMemo(
    () => (hideDone ? [...new Set([...hiddenColumns, ...doneColumns])] : hiddenColumns),
    [hideDone, hiddenColumns, doneColumns]
  )
  const setHidden = useCallback(
    (names: string[]) => {
      const allDone = doneColumns.length > 0 && doneColumns.every((n) => names.includes(n))
      setHideDone(allDone)
      setHiddenColumns(allDone ? names.filter((n) => !doneColumns.includes(n)) : names)
    },
    [doneColumns, setHideDone]
  )
  // The columns still on screen once the status filter has had its say.
  const shownColumns = useMemo(
    () => columns.filter((c) => !hidden.includes(c.name)),
    [columns, hidden]
  )

  const allTickets = useMemo(
    () => (board?.issues ?? []).filter((i) => !i.isEpic && !i.isSubtask),
    [board]
  )
  const tickets = useMemo(
    () => allTickets.filter((i) => mappedStatuses.has(i.status)),
    [allTickets, mappedStatuses]
  )

  // Ask GitHub about the branches of sessions that have a ticket, a few at a
  // time, once per session (again after a refresh from Jira).
  const branchRecords = useMemo(() => {
    const ids = new Set<string>()
    for (const t of tickets) {
      for (const { session } of sessionsFor(t)) {
        const r = session.record
        if (r && !r.investigation && r.branch) ids.add(r.id)
      }
    }
    return [...ids]
  }, [tickets, sessionsFor])
  useEffect(() => {
    const missing = branchRecords.filter((id) => !(id in prs))
    if (missing.length === 0) return
    let live = true
    void (async () => {
      for (let i = 0; i < missing.length; i += 3) {
        const batch = missing.slice(i, i + 3)
        const found = await Promise.all(batch.map((id) => getSessionPullRequest(id)))
        if (!live) return
        setPrs((cur) => {
          const next = { ...cur }
          batch.forEach((id, k) => (next[id] = found[k]))
          return next
        })
      }
    })()
    return () => {
      live = false
    }
  }, [branchRecords, prs])

  // A session's PR opens for a ticket that isn't in review yet: offer to
  // move it, once per PR (never twice for the same PR on this Mac).
  useEffect(() => {
    for (const issue of tickets) {
      if (issue.statusCategory === 'done') continue
      const review = statusesFor(issue).find((st) => /review/i.test(st.name))
      if (!review || issue.status === review.name) continue
      for (const { session } of sessionsFor(issue)) {
        const recordId = session.record?.id
        const pr = recordId ? (prs[recordId] ?? null) : null
        if (!pr || pr.state !== 'OPEN') continue
        const offerId = `${issue.key}:${pr.number}`
        if (offeredPrs.includes(offerId)) continue
        setOfferedPrs([...offeredPrs, offerId])
        const key = issue.key
        pushToast?.(`PR #${pr.number} is open for ${key}`, {
          label: `Move to ${review.name}`,
          onClick: () => {
            const current = allTickets.find((i) => i.key === key) ?? issue
            const from = { name: current.status, category: current.statusCategory }
            void write(() => moveJiraIssue(key, review.name), {
              ...current,
              status: review.name,
              statusCategory: review.category
            }).then((ok) => {
              if (!ok) return
              pushToast?.(`Moved ${key} to ${review.name}`, {
                label: 'Undo',
                onClick: () => {
                  const latest = allTickets.find((i) => i.key === key) ?? current
                  void write(() => moveJiraIssue(key, from.name), {
                    ...latest,
                    status: from.name,
                    statusCategory: from.category
                  })
                }
              })
            })
          }
        })
        return // one at a time — the next render picks up any more
      }
    }
  }, [
    tickets,
    allTickets,
    sessionsFor,
    prs,
    statusesFor,
    offeredPrs,
    setOfferedPrs,
    write,
    pushToast
  ])

  const hiddenCount = allTickets.length - tickets.length
  const q = query.trim().toLowerCase()
  // Cycle and search narrow everything; the Everyone / Mine / Unassigned
  // counts are taken after them, so each count is what its tab will show.
  // Everything but the epic, so the sidebar can count each epic.
  // Everyone / Mine / Unassigned and Filter → Assignee are one filter: the
  // tab is where it starts, the filter changes it. On Mine, adding someone
  // gives you and them, not the empty overlap of two separate filters.
  const people = useMemo(
    () =>
      assignees.length > 0
        ? assignees
        : who === 'mine'
          ? [ME]
          : who === 'unassigned'
            ? [UNASSIGNED]
            : [],
    [assignees, who]
  )
  // The tab you're on, or none once the filter has moved off it.
  const whoTab: Who | null = assignees.length === 0 ? who : null
  const narrowedAnyone = useMemo(
    () =>
      tickets.filter(
        (i) =>
          matches(i, q) &&
          !hidden.includes(columnNameOf(i.status)) &&
          inCycles(i, cycles) &&
          (!noEstimateOnly || !i.estimate)
      ),
    [tickets, cycles, q, hidden, columnNameOf, noEstimateOnly]
  )
  const narrowedAnyEpic = useMemo(
    () => narrowedAnyone.filter((i) => assignedTo(i, people)),
    [narrowedAnyone, people]
  )
  const narrowed = useMemo(
    () =>
      epicFilter
        ? narrowedAnyEpic.filter((i) => (i.parent?.key ?? NO_EPIC) === epicFilter)
        : narrowedAnyEpic,
    [narrowedAnyEpic, epicFilter]
  )
  const visible = narrowed

  /** Splits tickets into groups by status (your columns), epic or cycle. */
  const groupInto = useCallback(
    (items: JiraIssue[], by: GroupBy): Lane[] => {
      const visible = items
      if (by === 'epic') {
        const map = new Map<string, Lane>()
        for (const epic of board?.epics ?? []) {
          map.set(epic.key, {
            id: epic.key,
            title: epic.summary,
            hint: epic.key,
            items: [],
            value: { kind: 'epic', key: epic.key }
          })
        }
        for (const issue of visible) {
          const id = issue.parent?.key ?? ''
          const lane = map.get(id) ?? {
            id: id || 'none',
            title: issue.parent ? issue.parent.summary : 'No epic',
            hint: issue.parent?.key,
            items: [],
            value: { kind: 'epic' as const, key: issue.parent?.key ?? null }
          }
          lane.items.push(issue)
          map.set(id, lane)
        }
        if (!map.has('')) {
          map.set('', {
            id: 'none',
            title: 'No epic',
            items: [],
            value: { kind: 'epic', key: null }
          })
        }
        // Epics with tickets first (busiest first), empty ones after as drop
        // targets, "No epic" last.
        return [...map.values()].sort((a, b) =>
          a.value?.kind === 'epic' && a.value.key === null
            ? 1
            : b.value?.kind === 'epic' && b.value.key === null
              ? -1
              : b.items.length - a.items.length
        )
      }
      if (by === 'cycle') {
        return [
          ...sprints.map((sp) => ({
            id: sp.state === 'active' ? 'current' : `sprint-${sp.id}`,
            title: sp.state === 'active' ? 'Current cycle' : sp.name,
            hint: sp.state === 'active' ? sp.name : 'Upcoming',
            items: visible.filter((i) => i.sprint?.id === sp.id),
            value: { kind: 'cycle' as const, sprintId: sp.id }
          })),
          {
            id: 'backlog',
            title: 'Backlog',
            items: visible.filter(
              (i) => !i.sprint || !sprints.some((sp) => sp.id === i.sprint!.id)
            ),
            value: { kind: 'cycle', sprintId: null }
          }
        ]
      }
      // By status, in your columns. A list leads with what's in progress.
      return shownColumns
        .map((c) => ({ c, category: categoryOf(c.statuses[0]) }))
        .sort((a, b) => LIST_RANK(a.category) - LIST_RANK(b.category))
        .map(({ c, category }) => ({
          id: c.name,
          title: c.name,
          items: visible.filter((i) => c.statuses.includes(i.status)),
          value: { kind: 'column' as const, column: c, category }
        }))
    },
    [board, sprints, shownColumns, categoryOf]
  )
  // Tickets whose status, epic, cycle or assignee changed since the last
  // load (from Jira, or another screen) glow for a moment, so you see what moved.
  const [changed, setChanged] = useState<Set<string>>(() => new Set())
  const lastSeen = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (!board) return
    const now = new Map(
      board.issues.map((i) => [
        i.key,
        [i.status, i.parent?.key ?? '', i.sprint?.id ?? '', i.assignee ?? ''].join('|')
      ])
    )
    const before = lastSeen.current
    lastSeen.current = now
    if (!before) return
    const moved = [...now].filter(([k, v]) => before.has(k) && before.get(k) !== v).map(([k]) => k)
    if (!moved.length) return
    const show = setTimeout(() => setChanged(new Set(moved)), 0)
    const hide = setTimeout(() => setChanged(new Set()), 2200)
    return () => {
      clearTimeout(show)
      clearTimeout(hide)
    }
  }, [board])
  const lanes = useMemo(() => groupInto(visible, groupBy), [groupInto, visible, groupBy])
  // What you're looking at: change any of it and lists may re-sort and drop
  // emptied groups; until then they hold still as tickets move.
  const settleKey = JSON.stringify([
    who,
    view,
    grouping,
    hiddenColumns,
    hideDone,
    assignees,
    epicFilter,
    cycleSet,
    query
  ])
  const keptLaneOrder = useSettledOrder(
    lanes.filter((l) => l.items.length > 0).map((l) => l.id),
    settleKey
  )
  const keptLaneIds = useMemo(() => new Set(keptLaneOrder), [keptLaneOrder])
  // Emptied groups you collapsed: hidden until the view changes. Kept apart
  // from the stored collapsed list, so the group comes back open when it
  // next has tickets.
  const [dismissedFor, setDismissedFor] = useState<{ key: string; ids: string[] }>({
    key: '',
    ids: []
  })
  const dismissed = useMemo(
    () => new Set(dismissedFor.key === settleKey ? dismissedFor.ids : []),
    [dismissedFor, settleKey]
  )
  const dismiss = (id: string): void =>
    setDismissedFor((d) => ({
      key: settleKey,
      ids: d.key === settleKey ? [...d.ids, id] : [id]
    }))
  const keptSubLaneOrder = useSettledOrder(
    subGroup
      ? lanes.flatMap((lane) =>
          groupInto(lane.items, subGroup)
            .filter((l) => l.items.length > 0)
            .map((l) => `${lane.id}/${l.id}`)
        )
      : [],
    settleKey
  )
  const keptSubLaneIds = useMemo(() => new Set(keptSubLaneOrder), [keptSubLaneOrder])
  /** A group's sub-groups, when sub-grouping: the non-empty ones, or all while dragging. */
  const subLanesFor = useCallback(
    (lane: Lane): Lane[] | null =>
      subGroup
        ? groupInto(lane.items, subGroup).filter(
            (l) =>
              l.items.length > 0 ||
              (keptSubLaneIds.has(`${lane.id}/${l.id}`) &&
                !dismissed.has(subLaneId(lane, l)) &&
                !collapsed.includes(subLaneId(lane, l))) ||
              (dragging && l.value)
          )
        : null,
    [groupInto, subGroup, dragging, keptSubLaneIds, dismissed, collapsed]
  )

  // What the list shows: empty groups only while something is being dragged
  // (as drop targets), except the two cycle groups, which always show. A
  // group you just emptied holds its place until the view changes, unless
  // it's collapsed: then it goes, as an empty group would anywhere else.
  const shownLanes = useMemo(
    () =>
      lanes.filter(
        (l) =>
          l.items.length > 0 ||
          groupBy === 'cycle' ||
          (keptLaneIds.has(l.id) && !dismissed.has(l.id) && !collapsed.includes(l.id)) ||
          (dragging && l.value)
      ),
    [lanes, groupBy, dragging, keptLaneIds, dismissed, collapsed]
  )
  const boardLanes = useMemo(
    () =>
      // The board's columns are statuses, so its swimlanes are the grouping —
      // or, grouped by status, the sub-grouping.
      groupBy === 'status'
        ? subGroup
          ? groupInto(visible, subGroup).filter(
              (l) => l.items.length > 0 || subGroup === 'cycle' || dragging
            )
          : [{ id: 'all', title: '', items: visible, value: null } as Lane]
        : lanes.filter((l) => l.items.length > 0 || groupBy === 'cycle' || dragging),
    [groupBy, subGroup, groupInto, visible, lanes, dragging]
  )

  // Top-to-bottom order on screen, for stepping through tickets in the panel.
  const order = useMemo(() => {
    if (view === 'list') {
      return shownLanes
        .filter((l) => !collapsed.includes(l.id))
        .flatMap((l) =>
          (subLanesFor(l) ?? [l])
            .filter((sub) => sub === l || !collapsed.includes(subLaneId(l, sub)))
            .flatMap((sub) => sub.items.map((i) => i.key))
        )
    }
    return boardLanes.flatMap((l) =>
      collapsed.includes(l.id)
        ? []
        : shownColumns.flatMap((c) =>
            l.items.filter((i) => c.statuses.includes(i.status)).map((i) => i.key)
          )
    )
  }, [view, shownLanes, boardLanes, shownColumns, collapsed, subLanesFor])

  const step = useCallback(
    (delta: number) => {
      const next = order[order.indexOf(openKey ?? '') + delta]
      if (!next) return
      setOpenKey(next)
      const el = document.querySelector<HTMLElement>(`[data-issue="${next}"]`)
      el?.focus({ preventScroll: true })
      el?.scrollIntoView({ block: 'nearest' })
    },
    [order, openKey]
  )

  /**
   * A ticket dropped into a group (and, on the board, a status column):
   * whatever differs is changed in Jira — shown at once, put back if Jira
   * refuses.
   */
  const dropInto = useCallback(
    async (key: string, values: LaneValue[], boardColumn?: JiraColumn) => {
      const issue = board?.issues.find((i) => i.key === key)
      if (!issue) return
      const next = { ...issue }
      const writes: (() => Promise<JiraResult<JiraIssue>>)[] = []
      const laneColumn = values.find((v) => v?.kind === 'column')
      const column = boardColumn ?? (laneColumn?.kind === 'column' ? laneColumn.column : null)
      const toStatus = column ? statusInColumn(issue, column) : null
      if (toStatus) {
        next.status = toStatus.name
        next.statusCategory = toStatus.category
        writes.push(() => moveJiraIssue(key, toStatus.name))
      }
      for (const lane of values) {
        if (lane?.kind === 'epic' && (issue.parent?.key ?? null) !== lane.key) {
          const epic = board?.epics.find((e) => e.key === lane.key)
          next.parent = lane.key ? { key: lane.key, summary: epic?.summary ?? lane.key } : null
          writes.push(() => setJiraParent(key, lane.key))
        }
        if (lane?.kind === 'cycle' && (issue.sprint?.id ?? null) !== lane.sprintId) {
          const sprint = sprints.find((sp) => sp.id === lane.sprintId) ?? null
          next.sprint = sprint ? { id: sprint.id, name: sprint.name, state: sprint.state } : null
          writes.push(() => setJiraSprint(key, lane.sprintId))
        }
      }
      if (column && !toStatus && !column.statuses.includes(issue.status)) {
        pushToast?.(`${issue.project} has no status in “${column.name}”`)
      }
      if (writes.length === 0) return
      apply(next)
      for (const w of writes) {
        if (!(await write(w))) return
      }
    },
    [board, sprints, apply, write, statusInColumn, pushToast]
  )

  const openIssue = board?.issues.find((i) => i.key === openKey) ?? null
  const menuIssue = menu ? (board?.issues.find((i) => i.key === menu.key) ?? null) : null

  // ---- Several at once, and the keys that act on them ----

  const byKey = useCallback(
    (k: string): JiraIssue | null => board?.issues.find((i) => i.key === k) ?? null,
    [board]
  )
  /** What a shortcut acts on: the selection when the ticket is part of it, else the ticket. */
  const targetsFor = useCallback(
    (key: string | null): JiraIssue[] => {
      const keys =
        selected.length > 0 && (!key || selected.includes(key)) ? selected : key ? [key] : []
      return keys.map(byKey).filter((i): i is JiraIssue => Boolean(i))
    },
    [selected, byKey]
  )
  const runAll = useCallback(
    async (issues: JiraIssue[], fn: (issue: JiraIssue) => Promise<boolean>): Promise<void> => {
      // All at once: each write puts its change on screen as it starts, so
      // every ticket updates now and Jira catches up behind. A write Jira
      // refuses says so and reloads.
      await Promise.all(issues.map(fn))
    },
    []
  )
  const selectTicket = useCallback(
    (key: string, mode: 'toggle' | 'range') => {
      setSelected((cur) => {
        if (mode === 'range' && lastPicked.current && order.includes(lastPicked.current)) {
          const a = order.indexOf(lastPicked.current)
          const b = order.indexOf(key)
          const span = order.slice(Math.min(a, b), Math.max(a, b) + 1)
          return [...new Set([...cur, ...span])]
        }
        return cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
      })
      lastPicked.current = key
    },
    [order]
  )
  useDismissible(selected.length > 0 && !openKey, 'overlay', () => setSelected([]))

  const statusPicker = useCallback(
    (anchor: HTMLElement, issues: JiraIssue[]) => {
      const allowed = new Set(issues.flatMap((i) => statusesFor(i).map((st) => st.name)))
      setPicker({
        title: issues.length > 1 ? `Status for ${issues.length} tickets` : 'Change status',
        anchor,
        options: (board?.statuses ?? [])
          .filter((st) => allowed.has(st.name))
          .map((st) => ({
            value: st.name,
            label: st.name,
            icon: <StatusGlyph name={st.name} category={st.category} />,
            checked: issues.every((i) => i.status === st.name)
          })),
        onPick: (name) =>
          void runAll(issues, (i) => {
            const st = statusesFor(i).find((x) => x.name === name)
            return st ? actions.status(i, st) : Promise.resolve(true)
          })
      })
    },
    [board, statusesFor, runAll, actions]
  )
  const priorityPicker = useCallback(
    (anchor: HTMLElement, issues: JiraIssue[]) => {
      setPicker({
        title: issues.length > 1 ? `Priority for ${issues.length} tickets` : 'Change priority',
        anchor,
        options: (board?.priorities ?? []).map((pr) => ({
          value: pr,
          label: pr,
          icon: <PriorityGlyph priority={pr} />,
          checked: issues.every((i) => i.priority === pr)
        })),
        onPick: (pr) => void runAll(issues, (i) => actions.priority(i, pr))
      })
    },
    [board, runAll, actions]
  )
  const assignAll = useCallback(
    (issues: JiraIssue[]) => {
      const toMe = !issues.every((i) => i.assignedToMe)
      void runAll(issues, (i) =>
        i.assignedToMe === toMe ? Promise.resolve(true) : actions.assign(i)
      )
    },
    [runAll, actions]
  )
  const cycleAll = useCallback(
    (issues: JiraIssue[]) => {
      if (!activeSprint) return
      const toCurrent = !issues.every((i) => i.sprint?.state === 'active')
      void runAll(issues, (i) => actions.cycle(i, toCurrent ? activeSprint.id : null))
    },
    [activeSprint, runAll, actions]
  )

  /** Which cycle: any open one, or the backlog. */
  const cyclePicker = useCallback(
    (anchor: HTMLElement, issues: JiraIssue[]) => {
      if (sprints.length === 0) return
      const n = issues.length > 1 ? ` for ${issues.length} tickets` : ''
      setPicker({
        title: `Set cycle${n}`,
        anchor,
        options: [
          ...sprints.map((sp) => ({
            value: String(sp.id),
            label: cycleLabel(sp),
            checked: issues.every((i) => i.sprint?.id === sp.id)
          })),
          { value: '', label: 'Backlog', checked: issues.every((i) => !i.sprint) }
        ],
        onPick: (v) => void runAll(issues, (i) => actions.cycle(i, v ? Number(v) : null))
      })
    },
    [sprints, runAll, actions]
  )

  /** A row's value clicked: its picker, acting on the selection if the ticket is in it. */
  const editField = useCallback(
    (field: EditField, issue: JiraIssue, anchor: HTMLElement) => {
      const issues = targetsFor(issue.key)
      const n = issues.length > 1 ? ` for ${issues.length} tickets` : ''
      if (field === 'status') return statusPicker(anchor, issues)
      if (field === 'priority') return priorityPicker(anchor, issues)
      if (field === 'epic') {
        return setPicker({
          title: `Set epic${n}`,
          anchor,
          options: [
            { value: '', label: 'No epic', checked: issues.every((i) => !i.parent) },
            ...(board?.epics ?? []).map((ep) => ({
              value: ep.key,
              label: ep.summary,
              icon: <EpicMark />,
              checked: issues.every((i) => i.parent?.key === ep.key)
            }))
          ],
          onPick: (key) =>
            void runAll(issues, (i) =>
              (i.parent?.key ?? '') === key ? Promise.resolve(true) : actions.parent(i, key || null)
            )
        })
      }
      if (field === 'cycle') return cyclePicker(anchor, issues)
      if (field === 'assignee') {
        return setPicker({
          title: `Assignee${n}`,
          anchor,
          options: [
            { value: 'me', label: 'Assign to me', checked: issues.every((i) => i.assignedToMe) },
            { value: 'none', label: 'Unassign', checked: issues.every((i) => !i.assignee) },
            ...assignable
              .filter((p) => p.name !== myName)
              .map((p) => ({
                value: p.accountId,
                label: p.name,
                icon: <Avatar name={p.name} size={16} />,
                checked: issues.every((i) => i.assignee === p.name)
              }))
          ],
          onPick: (v) =>
            void runAll(issues, (i) =>
              actions.setAssignee(
                i,
                v === 'me' || v === 'none'
                  ? v
                  : (assignable.find((p) => p.accountId === v) ?? 'none')
              )
            )
        })
      }
      if (field === 'estimate') {
        return setPicker({
          title: `Estimate${n}`,
          anchor,
          options: [
            ...['30m', '1h', '2h', '4h', '1d', '2d', '3d', '1w'].map((v) => ({
              value: v,
              label: v,
              checked: issues.every((i) => i.estimate === v)
            })),
            { value: '', label: 'No estimate' }
          ],
          custom: (text) => (/^(\d+(\.\d+)?\s*[wdhm]\s*)+$/i.test(text) ? `Set to ${text}` : null),
          onPick: (v) => void runAll(issues, (i) => actions.estimate(i, v || null))
        })
      }
    },
    [
      targetsFor,
      statusPicker,
      priorityPicker,
      cyclePicker,
      board,
      runAll,
      actions,
      assignable,
      myName
    ]
  )

  // ---- Saved views ----

  const trimmedQuery = query.trim()
  // The saved view you're in. Changing a filter keeps you in it, marked as
  // changed (Save or Reset); leaving the Backlog and coming back brings back
  // the view as saved. Picking a tab or a sidebar entry leaves it.
  const [activeViewId, setActiveViewId] = useStoredState<string | null>('backlog-active-view', null)
  const activeView = prefs.views.find((v) => v.id === activeViewId)
  const viewCycles = (v: SavedView): string[] =>
    v.cycles ?? (v.cycle && v.cycle !== 'all' ? [v.cycle] : [])
  const viewChanged =
    Boolean(activeView) &&
    !(
      activeView!.who === who &&
      sameSet(viewCycles(activeView!), cycles) &&
      activeView!.groupBy === groupBy &&
      activeView!.view === view &&
      (activeView!.subGroup ?? 'none') === (subGroup ?? 'none') &&
      sameSet(activeView!.hidden ?? [], hidden) &&
      sameSet(activeView!.assignees ?? [], assignees) &&
      (activeView!.epic ?? null) === epicFilter &&
      activeView!.query === trimmedQuery
    )
  const applyView = useCallback(
    (v: SavedView) => {
      setActiveViewId(v.id)
      setWho(v.who as Who)
      setCycleSet((v.cycles ?? (v.cycle && v.cycle !== 'all' ? [v.cycle] : [])) as CycleFilter[])
      setGrouping(
        [v.groupBy, v.subGroup].filter(
          (g): g is GroupBy => g === 'status' || g === 'epic' || g === 'cycle'
        )
      )
      setView(v.view as View)
      setHidden(v.hidden ?? [])
      setAssignees(v.assignees ?? [])
      setEpicFilter(v.epic ?? null)
      setQuery(v.query)
    },
    [setWho, setGrouping, setView, setHidden, setActiveViewId]
  )
  // Coming back to the Backlog: the view you were in, as saved. Edits made
  // in it last time were for that visit.
  // Done during render, once the saved views have loaded (the same pattern
  // as a ticket opened from elsewhere, above), not in an effect.
  const [viewRestored, setViewRestored] = useState(false)
  if (!viewRestored && prefs.views.length > 0) {
    setViewRestored(true)
    const v = prefs.views.find((x) => x.id === activeViewId)
    if (v) applyView(v)
  }
  /** Picking a tab, or a sidebar entry: starts afresh there, out of any saved view. */
  const chooseWho = useCallback(
    (w: Who) => {
      setWho(w)
      setAssignees([])
      setActiveViewId(null)
    },
    [setWho, setActiveViewId]
  )
  const chooseCycle = useCallback(
    (c: CycleFilter) => {
      setCycle(c)
      setActiveViewId(null)
    },
    [setCycle, setActiveViewId]
  )
  /** Filter → Assignee. Landing back on exactly a tab's people selects that tab. */
  const pickPeople = (next: string[]): void => {
    if (next.length === 0) {
      setWho('all')
      setAssignees([])
    } else if (sameSet(next, [ME])) {
      setWho('mine')
      setAssignees([])
    } else if (sameSet(next, [UNASSIGNED])) {
      setWho('unassigned')
      setAssignees([])
    } else setAssignees(next)
  }
  const currentAsView = (): Omit<SavedView, 'id' | 'name'> => ({
    who,
    cycle,
    cycles,
    groupBy,
    subGroup: subGroup ?? 'none',
    hidden,
    assignees,
    epic: epicFilter,
    view,
    query: trimmedQuery
  })
  /** Save the changes made in the view you're in, over it. */
  const updateView = (): void => {
    if (!activeView) return
    void saveBacklogPrefs({
      views: prefs.views.map((v) => (v.id === activeView.id ? { ...v, ...currentAsView() } : v))
    }).then(setPrefs)
  }
  const saveView = (name: string): void => {
    const v: SavedView = {
      id: crypto.randomUUID(),
      name,
      who,
      cycle,
      cycles,
      groupBy,
      subGroup: subGroup ?? 'none',
      hidden,
      assignees,
      epic: epicFilter,
      view,
      query: trimmedQuery
    }
    void saveBacklogPrefs({ views: [...prefs.views, v] }).then(setPrefs)
    setActiveViewId(v.id)
  }
  const deleteView = (id: string): void => {
    void saveBacklogPrefs({ views: prefs.views.filter((v) => v.id !== id) }).then(setPrefs)
  }

  // S status, P priority, E epic, A assign to me, M current cycle ↔ backlog, X select,
  // O open (or start) its session, C new ticket, ⌥1–9 a saved view. On the
  // focused ticket, or the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || !board) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (creating || editingColumns || picker || document.querySelector('.cr-modal')) return
      // Over another screen, the keys belong to the panel only while you're in it.
      if (panelOnly && !t?.closest('.backlog-drawer')) return
      if (e.altKey) {
        const m = e.code.match(/^Digit([1-9])$/)
        const v = m ? prefs.views[Number(m[1]) - 1] : undefined
        if (v) {
          e.preventDefault()
          applyView(v)
        }
        return
      }
      const k = e.key.toLowerCase()
      if (e.shiftKey || !'cxspameo'.includes(k) || k.length !== 1) return
      if (k === 'c') {
        e.preventDefault()
        setCreating(true)
        return
      }
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
        '[data-issue]'
      )
      const key = focused?.dataset.issue ?? openKey
      if (k === 'x') {
        if (focused?.dataset.issue) {
          e.preventDefault()
          selectTicket(focused.dataset.issue, 'toggle')
        }
        return
      }
      if (k === 'o') {
        const issue = key ? byKey(key) : undefined
        if (!issue) return
        e.preventDefault()
        const entries = sessionsFor(issue)
        if (entries[0]) onOpenSession(entries[0].session.key)
        else onStartSession(seedFor(issue))
        return
      }
      const issues = targetsFor(key)
      if (issues.length === 0) return
      const anchor =
        focused ?? document.querySelector<HTMLElement>(`[data-issue="${issues[0].key}"]`)
      if (!anchor) return
      e.preventDefault()
      if (k === 's') statusPicker(anchor, issues)
      if (k === 'p') priorityPicker(anchor, issues)
      if (k === 'a') assignAll(issues)
      if (k === 'm') cycleAll(issues)
      if (k === 'e') editField('epic', issues[0], anchor)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    panelOnly,
    board,
    creating,
    editingColumns,
    picker,
    prefs.views,
    applyView,
    openKey,
    selectTicket,
    targetsFor,
    statusPicker,
    priorityPicker,
    assignAll,
    cycleAll,
    editField,
    byKey,
    sessionsFor,
    onOpenSession,
    onStartSession
  ])

  // Over another screen, render nothing until Jira answers: the Backlog's
  // page container fills the page, and for that moment it squeezed the
  // session beneath to zero height, which wiped its terminal.
  if (!status) return <div className={panelOnly ? 'backlog-panel-only' : 'backlog'} />
  if (!status.configured) {
    return (
      <div className="backlog">
        <JiraSetup
          encryptionUnavailable={status.encryptionUnavailable}
          onConnected={(s) => {
            setStatus(s)
            void load(true)
          }}
        />
      </div>
    )
  }

  // Every filter narrowing the list, as a chip you can see and clear. The tab
  // you're on is shown by the tabs themselves.
  const clearFilters = (): void => {
    setNoEstimateOnly(false)
    setCycle('all')
    setHidden([])
    setAssignees([])
    setEpicFilter(null)
  }
  const filterChips: {
    id: string
    label: React.ReactNode
    clearLabel: string
    clear: () => void
  }[] = []
  if (cycles.length > 0) {
    const nameOf = (c: CycleFilter): string =>
      c === 'current'
        ? (activeSprint?.name ?? 'current')
        : c === 'backlog'
          ? 'none (backlog)'
          : (sprints.find((sp) => `sprint:${sp.id}` === c)?.name ?? 'upcoming')
    filterChips.push({
      id: 'cycle',
      label: `Cycle: ${cycles.map(nameOf).join(' + ')}`,
      clearLabel: 'Clear the cycle filter',
      clear: () => setCycle('all')
    })
  }
  if (noEstimateOnly) {
    filterChips.push({
      id: 'no-estimate',
      label: 'No estimate',
      clearLabel: 'Show tickets with an estimate too',
      clear: () => setNoEstimateOnly(false)
    })
  }
  if (hideDone) {
    filterChips.push({
      id: 'done',
      label: 'Done hidden',
      clearLabel: 'Show done tickets',
      clear: () => setHideDone(false)
    })
  }
  if (hiddenColumns.length > 0) {
    filterChips.push({
      id: 'status',
      label:
        hiddenColumns.length === 1
          ? `Status: not ${hiddenColumns[0]}`
          : `Status: ${hiddenColumns.length} hidden`,
      clearLabel: 'Show every status',
      clear: () => setHiddenColumns([])
    })
  }
  if (assignees.length > 0) {
    const names = assignees.map((a) => (a === UNASSIGNED ? 'Unassigned' : a === ME ? 'You' : a))
    filterChips.push({
      id: 'assignee',
      label: `Assignee: ${names.length > 2 ? `${names.length} people` : names.join(', ')}`,
      clearLabel: 'Show every assignee',
      clear: () => setAssignees([])
    })
  }
  if (epicFilter) {
    filterChips.push({
      id: 'epic',
      label:
        epicFilter === NO_EPIC ? (
          'No epic'
        ) : (
          <>
            <EpicMark />
            {board?.epics.find((e) => e.key === epicFilter)?.summary ??
              board?.issues.find((i) => i.parent?.key === epicFilter)?.parent?.summary ??
              epicFilter}
          </>
        ),
      clearLabel: 'Show every epic',
      clear: () => setEpicFilter(null)
    })
  }
  // Search results the tab or filters are keeping out of sight — so a search
  // never comes up short without saying where the rest are.
  const outsideMatches = q ? tickets.filter((i) => matches(i, q)).length - visible.length : 0
  const showEverything = (): void => {
    clearFilters()
    setWho('all')
  }

  // What each tab would show: the same filters, that tab's people.
  const narrowedAnyoneInEpic = epicFilter
    ? narrowedAnyone.filter((i) => (i.parent?.key ?? NO_EPIC) === epicFilter)
    : narrowedAnyone
  const counts = {
    all: narrowedAnyoneInEpic.length,
    mine: narrowedAnyoneInEpic.filter((i) => i.assignedToMe).length,
    unassigned: narrowedAnyoneInEpic.filter((i) => !i.assignee).length
  }
  const rowProps: RowActions = {
    sessionsFor,
    openKey,
    selected,
    onSelect: selectTicket,
    onEdit: editField,
    onFilter: ({ epic, cycle }) => {
      if (epic) setEpicFilter(epic)
      else if (cycle) setCycle(cycle)
    },
    changed,
    prFor: (recordId: string) => prs[recordId] ?? null,
    onCopy: copy,
    onOpen: (key: string) => {
      lastPicked.current = key
      setOpenKey(key)
    },
    onMenu: (key: string, x: number, y: number) => setMenu({ key, x, y }),
    onStartSession: (issue: JiraIssue) => onStartSession(seedFor(issue)),
    onOpenSession,
    byKey,
    expandedSubtasks,
    onToggleSubtasks: (key: string) =>
      setExpandedSubtasks((cur) =>
        cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
      ),
    showStatus: groupBy !== 'status' && subGroup !== 'status',
    showEpic: groupBy !== 'epic' && subGroup !== 'epic',
    showCycle: groupBy !== 'cycle' && subGroup !== 'cycle' && cycle !== 'current'
  }

  const disconnect = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Disconnect Jira?',
      body: 'Control Room forgets your Jira token and stops showing tickets. Nothing changes in Jira, and your session links stay on this Mac.',
      confirmLabel: 'Disconnect',
      danger: true
    })
    if (!ok) return
    await disconnectJira()
    setStatus(await getJiraStatus())
    setBoard(null)
  }

  const drawer =
    openIssue && board ? (
      <IssueDrawer
        key={openIssue.key}
        issue={openIssue}
        board={board}
        people={assignable}
        myName={myName}
        sessions={sessions}
        linkedSessions={sessionsFor(openIssue)}
        position={{ index: order.indexOf(openIssue.key), total: order.length }}
        onStep={panelOnly ? undefined : step}
        onClose={() => setOpenKey(null)}
        onExpand={panelOnly && onExpand ? () => onExpand(openIssue.key) : undefined}
        write={write}
        actions={actions}
        statuses={statusesFor(openIssue)}
        copy={copy}
        onError={(m) => pushToast?.(m)}
        onLink={async (recordId, key) => setLinks(await linkSessionToTicket(recordId, key))}
        onStartSession={() => onStartSession(seedFor(openIssue))}
        onOpenSession={onOpenSession}
        onOpenKey={(key) => {
          lastPicked.current = key
          setOpenKey(key)
        }}
        onAddSubtask={addSubtask}
        onAddBlock={addBlock}
        onRemoveBlock={removeBlock}
      />
    ) : null

  if (panelOnly) {
    return (
      <div className="backlog-panel-only">
        {confirmNode}
        {picker && <Picker {...picker} onClose={() => setPicker(null)} />}
        {drawer ?? (
          // The board is still loading, or the ticket isn't on it (done, or
          // in a project the Backlog doesn't follow).
          <aside className="backlog-drawer" role="dialog" aria-label={openTicket ?? 'Ticket'}>
            <div className="backlog-drawer-header">
              <span className="backlog-drawer-key">{openTicket}</span>
              <IconButton
                icon="X"
                label="Close"
                size={28}
                variant="ghost"
                onClick={() => onPanelClose?.()}
              />
            </div>
            <p className="backlog-note">
              {board
                ? `${openTicket} isn't on your Backlog.`
                : `Loading ${openTicket ?? 'the ticket'}…`}
            </p>
          </aside>
        )}
      </div>
    )
  }

  // The cycle being planned: the one picked, or from the current cycle's
  // Plan action, the first upcoming one.
  const firstUpcoming =
    [...sprints]
      .filter((sp) => sp.state === 'future')
      .sort((x, y) => (x.startDate ?? '9').localeCompare(y.startDate ?? '9'))[0] ?? null
  const planningNext = planning
    ? (sprints.find((sp) => sp.id === planning.nextId) ?? firstUpcoming)
    : null
  // Plans the cycle you picked: the current one too, while it has time left.
  const startPlanning = (sprintId: number): void => {
    const nextId = sprints.some((sp) => sp.id === sprintId) ? sprintId : (firstUpcoming?.id ?? null)
    setPlanning((p) => ({
      nextId,
      restore: p?.restore ?? { grouping, view, cycleSet, who, assignees }
    }))
    // A cycle is the team's: plan it with everyone's tickets in view.
    setWho('all')
    setAssignees([])
    setPlanFolds({ current: true })
    setGrouping(['cycle'])
    setView('list')
    setCycleSet([])
  }
  const stopPlanning = (): void => {
    if (!planning) return
    setGrouping(planning.restore.grouping)
    setView(planning.restore.view)
    setCycleSet(planning.restore.cycleSet)
    setWho(planning.restore.who)
    setAssignees(planning.restore.assignees)
    setNoEstimateOnly(false)
    setPlanning(null)
  }
  // Planning's numbers are the whole cycle's, never just what the filters
  // leave on screen: the totals say what's in Jira.
  const topLevel = allTickets.filter((i) => !i.isSubtask)
  const inCycle = (sprintId: number | null): JiraIssue[] =>
    topLevel.filter((i) =>
      sprintId === null
        ? (!i.sprint || !sprints.some((sp) => sp.id === i.sprint!.id)) &&
          i.statusCategory !== 'done'
        : i.sprint?.id === sprintId
    )
  // The current cycle's unfinished tickets: Jira moves them to the next one
  // when the current one is completed, so planning lists them there too.
  const carryingAll =
    planning && activeSprint && planningNext && planningNext.state !== 'active'
      ? inCycle(activeSprint.id).filter((i) => i.statusCategory !== 'done')
      : []
  const carryKeys = new Set(carryingAll.map((i) => i.key))
  /** The lane as planning shows it: the next cycle lists what carries over. */
  const planningLane = (lane: Lane): Lane =>
    planning &&
    groupBy === 'cycle' &&
    lane.value?.kind === 'cycle' &&
    lane.value.sprintId !== null &&
    lane.value.sprintId === planningNext?.id
      ? {
          ...lane,
          items: [...lane.items, ...visible.filter((i) => carryKeys.has(i.key) && !i.isSubtask)]
        }
      : lane
  // Under each cycle group's title while planning.
  const planningStrip = (lane: Lane): React.ReactNode => {
    if (!planning || groupBy !== 'cycle' || lane.value?.kind !== 'cycle') return null
    const sprintId = lane.value.sprintId
    const cycle = sprints.find((sp) => sp.id === sprintId) ?? null
    const kind =
      sprintId === null
        ? ('backlog' as const)
        : cycle?.id === planningNext?.id
          ? ('next' as const)
          : cycle?.state === 'active'
            ? ('current' as const)
            : ('other' as const)
    const all = inCycle(sprintId)
    return (
      <CycleStrip
        kind={kind}
        cycle={cycle}
        next={planningNext}
        items={all}
        carrying={kind === 'next' ? carryingAll : []}
        hidden={Math.max(
          0,
          all.length + (kind === 'next' ? carryingAll.length : 0) - planningLane(lane).items.length
        )}
        now={planningSince}
        prefs={prefs}
        onSavePrefs={(patch) => void saveBacklogPrefs(patch).then(setPrefs)}
        onNoEstimate={() => setNoEstimateOnly(true)}
        onSetGoal={async (id, goal) => {
          const r = await setJiraSprintGoal(id, goal)
          if (!r.ok) {
            pushToast?.(`Jira: ${r.error}`)
            return false
          }
          setBoard((b) =>
            b
              ? {
                  ...b,
                  sprints: b.sprints.map((sp) =>
                    sp.id === id ? { ...sp, goal: r.value.goal } : sp
                  )
                }
              : b
          )
          return true
        }}
      />
    )
  }

  return (
    <div
      className="backlog-layout"
      style={
        {
          '--backlog-sidebar-width': sidebarOpen && board ? `${sidebarWidth}px` : '0px'
        } as React.CSSProperties
      }
    >
      {sidebarOpen && board && (
        <BacklogSidebar
          board={board}
          settleKey={settleKey}
          who={whoTab}
          onWho={chooseWho}
          counts={counts}
          views={
            <SavedViews
              views={prefs.views}
              activeId={activeView?.id ?? null}
              changed={viewChanged}
              onApply={applyView}
              onSave={saveView}
              onUpdate={updateView}
              onDelete={deleteView}
            />
          }
          cycle={cycles.length > 1 ? null : cycle}
          onCycle={chooseCycle}
          activeSprint={activeSprint}
          allTickets={allTickets}
          epicTickets={narrowedAnyEpic}
          epicFilter={epicFilter}
          onEpic={setEpicFilter}
          onDrop={(key, value) => void dropInto(key, [value])}
          onPlanCycle={startPlanning}
          width={sidebarWidth}
          onResizeStart={onSidebarResizeStart}
          onResizeReset={onSidebarResizeReset}
        />
      )}
      <div
        className={[
          'backlog',
          view === 'board' ? 'backlog--board' : '',
          openIssue ? 'backlog--peek' : ''
        ].join(' ')}
        onDragStart={(e) => {
          // Not in the same tick: showing the drop targets moves the rows,
          // and Chromium cancels a drag whose page changes as it starts
          // (dragstart, then dragend at once, and the ticket never moves).
          if ((e.target as HTMLElement).dataset?.issue) setTimeout(() => setDragging(true), 0)
        }}
        onDragEnd={() => setDragging(false)}
        onDrop={() => setDragging(false)}
      >
        {confirmNode}
        {creating && board && (
          <CreateTicket
            projects={status.projects}
            board={board}
            defaultInCycle={cycle === 'current' || groupBy === 'cycle'}
            onCreated={(issue, skipped) => {
              setBoard((b) => (b ? { ...b, issues: [issue, ...b.issues] } : b))
              setOpenKey(issue.key)
              pushToast?.(
                skipped.length
                  ? `Created ${issue.key}. Jira wouldn’t set: ${skipped.join(', ')}`
                  : `Created ${issue.key}`
              )
            }}
            onClose={() => setCreating(false)}
          />
        )}
        {editingColumns && board && (
          <ColumnsEditor
            columns={columns}
            statuses={board.statuses}
            jiraColumns={board.columns}
            jiraBoardName={board.columnsFrom}
            onSave={(cols) => void saveBacklogPrefs({ columns: cols }).then(setPrefs)}
            onReset={() => void saveBacklogPrefs({ columns: null }).then(setPrefs)}
            onClose={() => setEditingColumns(false)}
          />
        )}
        {picker && <Picker {...picker} onClose={() => setPicker(null)} />}
        <div className="backlog-header">
          <div className="backlog-heading">
            <h1 className="backlog-title">Tickets</h1>
            {loading && board && (
              <span className="backlog-loading" role="status" aria-label="Refreshing from Jira">
                <Icon name="Loader2" size={14} />
              </span>
            )}
          </div>
          <div className="backlog-header-actions">
            <Button
              variant="filled"
              size="compact"
              title="New ticket (C)"
              disabled={!board}
              onClick={() => setCreating(true)}
            >
              <Icon name="Plus" size={14} /> New ticket
            </Button>
            <OverflowMenu
              items={[
                { label: 'Refresh from Jira', icon: 'RefreshCw', run: () => void load(true) },
                {
                  label: 'Open Jira',
                  icon: 'ExternalLink',
                  run: () => void openExternal(`https://${status.site}/jira/your-work`)
                },
                { label: 'Disconnect Jira…', icon: 'Unplug', run: () => void disconnect() }
              ]}
            />
          </div>
        </div>

        <div className="backlog-filters" ref={setFiltersEl}>
          <div className="backlog-filter-tabs" role="radiogroup" aria-label="Whose tickets">
            {(
              [
                ['all', 'Everyone'],
                ['mine', 'Mine'],
                ['unassigned', 'Unassigned']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={whoTab === value}
                className={
                  whoTab === value ? 'backlog-filter backlog-filter--selected' : 'backlog-filter'
                }
                onClick={() => chooseWho(value)}
              >
                {label}
                <span className="backlog-filter-count">{counts[value]}</span>
              </button>
            ))}
            <SavedViews
              views={prefs.views}
              activeId={activeView?.id ?? null}
              changed={viewChanged}
              onApply={applyView}
              onSave={saveView}
              onUpdate={updateView}
              onDelete={deleteView}
            />
          </div>
          <div className="backlog-filter-menus">
            <div className="backlog-search-slot">
              {searchCompact && !searchOpen ? (
                <IconButton
                  icon="Search"
                  label="Search tickets"
                  tooltip="Search (/)"
                  size={28}
                  onClick={() => setSearchOpen(true)}
                />
              ) : (
                <label
                  className={
                    searchCompact ? 'backlog-search backlog-search--floating' : 'backlog-search'
                  }
                >
                  <Icon name="Search" size={14} />
                  <input
                    ref={searchRef}
                    type="search"
                    aria-label="Search tickets"
                    placeholder="Search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onBlur={() => {
                      if (!query) setSearchOpen(false)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setQuery('')
                        e.currentTarget.blur()
                      }
                      if (e.key === 'Enter' || e.key === 'ArrowDown') {
                        e.preventDefault()
                        document.querySelector<HTMLElement>('[data-nav-item]')?.focus()
                      }
                    }}
                  />
                  {!query && <kbd>/</kbd>}
                </label>
              )}
            </div>
            <FilterMenu
              cycles={cycles}
              onCycles={(next) => setCycleSet(next)}
              sprintName={activeSprint?.name ?? null}
              activeSprintId={activeSprint?.id ?? null}
              onPlanCycle={startPlanning}
              upcoming={sprints.filter((sp) => sp.state !== 'active')}
              columns={columns.map((c) => ({
                name: c.name,
                category: categoryOf(c.statuses[0]),
                count: tickets.filter((i) => c.statuses.includes(i.status)).length
              }))}
              hidden={hidden}
              onHidden={setHidden}
              people={[
                ...[
                  ...new Set(tickets.map((i) => i.assignee).filter((a): a is string => Boolean(a)))
                ]
                  .sort((a, b) => (a === myName ? -1 : b === myName ? 1 : a.localeCompare(b)))
                  .map((name) => ({
                    value: name === myName ? ME : name,
                    label: name,
                    count: tickets.filter((i) => i.assignee === name).length
                  })),
                {
                  value: UNASSIGNED,
                  label: 'Unassigned',
                  count: tickets.filter((i) => !i.assignee).length
                }
              ]}
              assignees={people}
              assigneesNarrowed={assignees.length > 0}
              onAssignees={pickPeople}
              epicActive={Boolean(epicFilter)}
              onClearEpic={() => setEpicFilter(null)}
            />
            <DisplayMenu
              grouping={grouping}
              onGrouping={setGrouping}
              onCollapseAll={(all) => setCollapsed(all ? lanes.map((l) => l.id) : [])}
              anyCollapsed={collapsed.length > 0}
              onColumns={() => setEditingColumns(true)}
            />
            <div className="backlog-view-toggle" role="radiogroup" aria-label="View">
              {(
                [
                  ['list', 'List', 'List'],
                  ['board', 'Board', 'Columns3']
                ] as const
              ).map(([value, label, icon]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={view === value}
                  aria-label={`${label} view`}
                  title={`${label} view`}
                  className={
                    view === value
                      ? 'backlog-view-option backlog-view-option--selected'
                      : 'backlog-view-option'
                  }
                  onClick={() => setView(value)}
                >
                  <Icon name={icon} size={16} />
                </button>
              ))}
            </div>
          </div>
        </div>

        {planning && board && (
          <PlanningBar
            next={planningNext}
            current={activeSprint}
            boardId={(activeSprint?.boardId ?? sprints.find((sp) => sp.boardId)?.boardId) || null}
            onCreate={async (input) => {
              const r = await createJiraSprint(input)
              if (!r.ok) {
                pushToast?.(`Jira: ${r.error}`)
                return false
              }
              await load(true)
              setPlanning((p) => (p ? { ...p, nextId: r.value.id } : p))
              return true
            }}
            cycles={sprints}
            onPick={(id) => {
              setPlanning((p) => (p ? { ...p, nextId: id } : p))
              setPlanFolds(
                sprints.find((sp) => sp.id === id)?.state === 'active' ? {} : { current: true }
              )
            }}
            onDone={stopPlanning}
          />
        )}
        {filterChips.length > 0 && (
          <div className="backlog-filter-bar" role="group" aria-label="Active filters">
            {filterChips.map((c) => (
              <span key={c.id} className="backlog-active-chip" data-filter-chip={c.id}>
                {c.label}
                <button type="button" aria-label={c.clearLabel} onClick={c.clear}>
                  <Icon name="X" size={12} />
                </button>
              </span>
            ))}
            {filterChips.length > 1 && (
              <button
                type="button"
                className="backlog-link backlog-link--quiet"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {error && (
          <EmptyState
            icon="CloudOff"
            title="Couldn’t load tickets"
            body={error}
            action={
              <Button variant="outlined" onClick={() => void load(true)}>
                Try again
              </Button>
            }
          />
        )}
        {!error && !board && (
          <EmptyState icon="Loader2" iconSpins title="Loading tickets" body="Fetching from Jira" />
        )}
        {board && visible.length === 0 && !dragging && (
          <EmptyState
            icon="SearchX"
            title={q ? `Nothing matches “${query.trim()}”` : 'No tickets here'}
            body={
              q
                ? 'Search looks at keys, summaries, people, epics and labels.'
                : 'Try another filter, or a different cycle.'
            }
            action={
              q && outsideMatches > 0 ? (
                <Button variant="outlined" onClick={showEverything}>
                  Show {outsideMatches} outside {who === 'all' ? 'these filters' : 'this tab'}
                </Button>
              ) : q ? (
                <Button variant="outlined" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              ) : filterChips.length > 0 ? (
                <Button variant="outlined" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}

        {board && view === 'list' && visible.length > 0 && (
          <div className="backlog-list">
            {shownLanes.map((shownLane) => {
              const lane = planningLane(shownLane)
              const subs = subLanesFor(lane)
              const isCollapsed = planning
                ? (planFolds[lane.id] ?? false)
                : collapsed.includes(lane.id)
              return (
                <DropGroup
                  key={lane.id}
                  lane={lane}
                  values={[lane.value]}
                  extra={planningStrip(lane)}
                  collapsed={isCollapsed}
                  onToggle={() =>
                    planning
                      ? setPlanFolds((f) => ({ ...f, [lane.id]: !isCollapsed }))
                      : lane.items.length === 0 && !isCollapsed
                        ? dismiss(lane.id)
                        : setCollapsed(
                            isCollapsed
                              ? collapsed.filter((id) => id !== lane.id)
                              : [...collapsed, lane.id]
                          )
                  }
                  onDropIssue={(key, values) => void dropInto(key, values)}
                >
                  {!isCollapsed && (
                    <div className="backlog-rows">
                      {subs
                        ? subs.map((sub) => {
                            const subId = subLaneId(lane, sub)
                            const subCollapsed = collapsed.includes(subId)
                            return (
                              <DropGroup
                                key={sub.id}
                                lane={sub}
                                values={[lane.value, sub.value]}
                                nested
                                collapsed={subCollapsed}
                                onToggle={() =>
                                  sub.items.length === 0 && !subCollapsed
                                    ? dismiss(subId)
                                    : setCollapsed(
                                        subCollapsed
                                          ? collapsed.filter((id) => id !== subId)
                                          : [...collapsed, subId]
                                      )
                                }
                                onDropIssue={(key, values) => void dropInto(key, values)}
                              >
                                {!subCollapsed &&
                                  sub.items.map((issue) => (
                                    <IssueRow key={issue.key} issue={issue} {...rowProps} />
                                  ))}
                                {sub.items.length === 0 && (
                                  <p className="backlog-empty-lane">
                                    {dragging ? 'Drop here' : 'Nothing left here'}
                                  </p>
                                )}
                              </DropGroup>
                            )
                          })
                        : lane.items.map((issue) => (
                            <IssueRow
                              key={issue.key}
                              issue={issue}
                              {...rowProps}
                              carriesOver={
                                lane !== shownLane &&
                                carryKeys.has(issue.key) &&
                                issue.sprint?.id === activeSprint?.id
                              }
                            />
                          ))}
                      {lane.items.length === 0 && (
                        <p className="backlog-empty-lane">
                          {dragging
                            ? 'Drop here'
                            : planning && lane.value?.kind === 'cycle'
                              ? 'Drag tickets here'
                              : 'No tickets'}
                        </p>
                      )}
                    </div>
                  )}
                </DropGroup>
              )
            })}
          </div>
        )}

        {board && view === 'board' && visible.length > 0 && (
          <div className="backlog-board-lanes">
            {/* With swimlanes, the column headers show once, above them all. */}
            {boardLanes.some((l) => l.title) && (
              <div className="backlog-board backlog-board-heads">
                {columns.map((c) => (
                  <h3 key={c.name} className="backlog-column-title" data-status-head={c.name}>
                    <StatusGlyph name={c.name} category={categoryOf(c.statuses[0])} />
                    <span className="backlog-group-name" title={c.statuses.join(', ')}>
                      {c.name}
                    </span>
                    <span className="backlog-group-count">
                      {visible.filter((i) => c.statuses.includes(i.status)).length}
                    </span>
                  </h3>
                ))}
              </div>
            )}
            {boardLanes.map((lane) => (
              <section key={lane.id} className="backlog-lane" data-lane={lane.id}>
                {lane.title && (
                  <LaneTitle
                    lane={lane}
                    collapsed={collapsed.includes(lane.id)}
                    onToggle={() =>
                      setCollapsed(
                        collapsed.includes(lane.id)
                          ? collapsed.filter((id) => id !== lane.id)
                          : [...collapsed, lane.id]
                      )
                    }
                  />
                )}
                {!collapsed.includes(lane.id) && (
                  <div className="backlog-board">
                    {columns.map((c) => (
                      <BoardColumn
                        filteredOut={hidden.includes(c.name)}
                        key={c.name}
                        column={c}
                        category={categoryOf(c.statuses[0])}
                        items={lane.items.filter((i) => c.statuses.includes(i.status))}
                        onDropIssue={(key) => void dropInto(key, [lane.value], c)}
                        headless={Boolean(lane.title)}
                        {...rowProps}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {board && visible.length > 0 && outsideMatches > 0 && (
          <p className="backlog-hidden-note" data-outside-matches>
            {outsideMatches} more {outsideMatches === 1 ? 'ticket matches' : 'tickets match'} “
            {query.trim()}” outside {who === 'all' ? 'these filters' : 'this tab'}.{' '}
            <button type="button" className="backlog-link" onClick={showEverything}>
              Show {outsideMatches === 1 ? 'it' : 'them'}
            </button>
          </p>
        )}

        {board && hiddenCount > 0 && (
          <p className="backlog-hidden-note">
            {hiddenCount} {hiddenCount === 1 ? 'ticket is' : 'tickets are'} in statuses your columns
            leave out.{' '}
            <button type="button" className="backlog-link" onClick={() => setEditingColumns(true)}>
              Edit columns
            </button>
          </p>
        )}

        {selected.length > 0 && board && (
          <BulkBar
            issues={targetsFor(null)}
            hasCycle={Boolean(activeSprint)}
            onPickCycle={sprints.length > 1 ? (el) => cyclePicker(el, targetsFor(null)) : undefined}
            onStatus={(el) => statusPicker(el, targetsFor(null))}
            onPriority={(el) => priorityPicker(el, targetsFor(null))}
            onEpic={(el) => {
              const [first] = targetsFor(null)
              if (first) editField('epic', first, el)
            }}
            onAssign={() => assignAll(targetsFor(null))}
            onCycle={() => cycleAll(targetsFor(null))}
            onClear={() => setSelected([])}
          />
        )}

        {menu && menuIssue && board && (
          <IssueMenu
            issue={menuIssue}
            x={menu.x}
            y={menu.y}
            statuses={statusesFor(menuIssue)}
            activeSprint={activeSprint}
            upcoming={sprints.filter((sp) => sp.state !== 'active')}
            sessions={sessionsFor(menuIssue)}
            onClose={() => setMenu(null)}
            onOpen={() => setOpenKey(menuIssue.key)}
            onStartSession={() => onStartSession(seedFor(menuIssue))}
            onOpenSession={onOpenSession}
            actions={actions}
            copy={copy}
          />
        )}

        {drawer}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

type Actions = {
  status: (issue: JiraIssue, s: StatusOption) => Promise<boolean>
  cycle: (issue: JiraIssue, sprintId: number | null) => Promise<boolean>
  assign: (issue: JiraIssue) => Promise<boolean>
  setAssignee: (issue: JiraIssue, who: 'me' | 'none' | JiraPerson) => Promise<boolean>
  parent: (issue: JiraIssue, key: string | null) => Promise<boolean>
  priority: (issue: JiraIssue, priority: string) => Promise<boolean>
  labels: (issue: JiraIssue, labels: string[]) => Promise<boolean>
  estimate: (issue: JiraIssue, estimate: string | null) => Promise<boolean>
}

interface RowActions {
  sessionsFor: (issue: JiraIssue) => SessionEntry[]
  openKey: string | null
  selected: string[]
  onSelect: (key: string, mode: 'toggle' | 'range') => void
  onEdit: (field: EditField, issue: JiraIssue, anchor: HTMLElement) => void
  onFilter: (f: { epic?: string; cycle?: CycleFilter }) => void
  /** Tickets that changed since the last load, for a brief highlight. */
  changed: Set<string>
  prFor: (recordId: string) => PullRequestInfo | null
  onCopy: (text: string, what: string) => void
  onOpen: (key: string) => void
  onMenu: (key: string, x: number, y: number) => void
  onStartSession: (issue: JiraIssue) => void
  onOpenSession: (liveKey: string) => void
  byKey: (key: string) => JiraIssue | null
  /** Ticket keys whose sub-tasks are unfolded in the list. */
  expandedSubtasks: string[]
  onToggleSubtasks: (key: string) => void
  /** Grouped by something else, so the row names its status / epic / cycle itself. */
  showStatus: boolean
  showEpic: boolean
  showCycle: boolean
}

/** Handlers every ticket (row or card) shares: open, peek, drag, menu. */
function ticketHandlers(
  issue: JiraIssue,
  {
    onOpen,
    onMenu,
    onSelect,
    selected
  }: Pick<RowActions, 'onOpen' | 'onMenu' | 'onSelect' | 'selected'>
): React.HTMLAttributes<HTMLDivElement> & { draggable: true } {
  return {
    role: 'button',
    tabIndex: 0,
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(DRAG_TYPE, issue.key)
      e.dataTransfer.effectAllowed = 'move'
      // A tidy chip under the pointer instead of the browser's see-through
      // copy of the whole row. It has to be in the page when the drag image
      // is taken, and goes again straight after.
      const ghost = document.createElement('div')
      ghost.className = 'backlog-drag-ghost'
      const key = document.createElement('span')
      key.className = 'backlog-drag-ghost-key'
      key.textContent = issue.key
      const title = document.createElement('span')
      title.textContent = issue.summary
      ghost.append(key, title)
      document.body.appendChild(ghost)
      e.dataTransfer.setDragImage(ghost, 14, 14)
      setTimeout(() => ghost.remove(), 0)
    },
    // Picking works as it does on Sessions (and in Linear): the check, X,
    // or ⇧-click for the run up to it. Once anything is picked, a plain
    // click picks too. ⌘-click always opens, as it does on Sessions.
    onClick: (e) => {
      if (e.shiftKey) onSelect(issue.key, 'range')
      else if (selected.length > 0 && !e.metaKey && !e.ctrlKey) onSelect(issue.key, 'toggle')
      else onOpen(issue.key)
    },
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen(issue.key)
      }
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        onMenu(issue.key, r.left + 48, r.bottom)
      }
    },
    onContextMenu: (e) => {
      e.preventDefault()
      onMenu(issue.key, e.clientX, e.clientY)
    }
  }
}

function LaneMark({ lane }: { lane: Lane }): React.JSX.Element | null {
  const v = lane.value
  if (v?.kind === 'column') return <StatusGlyph name={v.column.name} category={v.category} />
  if (v?.kind === 'epic') return v.key ? <EpicMark /> : null
  if (lane.id === 'current') return <Icon name="RefreshCw" size={14} />
  if (lane.id === 'backlog') return <Icon name="Inbox" size={14} />
  return null
}

function LaneTitle({
  lane,
  collapsed,
  onToggle,
  nested = false
}: {
  lane: Lane
  collapsed?: boolean
  onToggle?: () => void
  nested?: boolean
}): React.JSX.Element {
  const Tag = nested ? 'h3' : 'h2'
  return (
    <Tag
      className={[
        nested ? 'backlog-subgroup-title' : 'backlog-group-title',
        onToggle ? 'backlog-group-title--toggle' : ''
      ].join(' ')}
      onClick={onToggle}
    >
      {onToggle && (
        <button
          type="button"
          className="backlog-group-toggle"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${lane.title}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        >
          <Icon name={collapsed ? 'ChevronRight' : 'ChevronDown'} size={14} />
        </button>
      )}
      <LaneMark lane={lane} />
      <span className="backlog-group-name">{lane.title}</span>
      {lane.hint && (
        <span
          className={
            lane.value?.kind === 'cycle'
              ? 'backlog-group-hint backlog-group-hint--name'
              : 'backlog-group-hint'
          }
        >
          {lane.hint}
        </span>
      )}
      <span className="backlog-group-count">{lane.items.length}</span>
    </Tag>
  )
}

/**
 * A sub-group's key in the collapsed list. Scoped to its parent, so folding
 * Backlog in one epic leaves Backlog open in the others.
 */
function subLaneId(parent: Lane, sub: Lane): string {
  return `${parent.id}/${sub.id}`
}

/** A group that is also a drop target: drop a ticket in and it joins. */
function DropGroup({
  lane,
  values,
  nested = false,
  collapsed,
  onToggle,
  onDropIssue,
  extra,
  children
}: {
  lane: Lane
  /** Under the title: planning's facts and load for a cycle. */
  extra?: React.ReactNode
  /** Everything a ticket dropped here becomes: the group's, and its parent group's. */
  values: LaneValue[]
  nested?: boolean
  collapsed?: boolean
  onToggle?: () => void
  onDropIssue: (key: string, values: LaneValue[]) => void
  children: React.ReactNode
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  // A drop in a group nested inside this one never reaches this one, so its
  // highlight stayed on after the drop. Any drag ending clears it.
  useEffect(() => {
    if (!over) return
    const clear = (): void => setOver(false)
    window.addEventListener('drop', clear, true)
    window.addEventListener('dragend', clear, true)
    return () => {
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('dragend', clear, true)
    }
  }, [over])
  const base = nested ? 'backlog-subgroup' : 'backlog-group'
  return (
    <section
      className={over ? `${base} ${base}--over` : base}
      data-lane={lane.id}
      onDragOver={(e) => {
        if (!values.some(Boolean) || !e.dataTransfer.types.includes(DRAG_TYPE)) return
        // The innermost group takes it.
        e.stopPropagation()
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const key = e.dataTransfer.getData(DRAG_TYPE)
        if (key) onDropIssue(key, values)
      }}
    >
      <LaneTitle lane={lane} nested={nested} collapsed={collapsed} onToggle={onToggle} />
      {extra}
      {children}
    </section>
  )
}

/** The session a ticket is in: its status in colour and words, and a way in. */
function SessionChip({
  entries,
  onOpenSession
}: {
  entries: SessionEntry[]
  onOpenSession: (liveKey: string) => void
}): React.JSX.Element | null {
  const first = entries[0]
  if (!first) return null
  const others = entries.length - 1
  return (
    <button
      type="button"
      className="backlog-session-chip"
      title={`Open session: ${first.session.record?.title ?? ''} (${STATUS_WORDS[first.session.status]})${others ? `, and ${others} more` : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onOpenSession(first.session.key)
      }}
    >
      <StatusDot status={first.session.status} size={8} />
      <span className="backlog-session-chip-word">{STATUS_WORDS[first.session.status]}</span>
      {others > 0 && <span className="backlog-session-chip-more">+{others}</span>}
    </button>
  )
}

/**
 * The ticket's code: its session's pull request when there is one (open it),
 * else the branch it's on (click to copy the name).
 */
function BranchMark({
  issue,
  entries,
  prFor,
  onCopy
}: {
  issue: JiraIssue
  entries: SessionEntry[]
  prFor: (recordId: string) => PullRequestInfo | null
  onCopy: (text: string, what: string) => void
}): React.JSX.Element | null {
  const record = entries.find((e) => e.session.record?.branch && !e.session.record.investigation)
    ?.session.record
  const pr = record ? prFor(record.id) : null
  // No PR from the session's own branch — but Jira may know of one (its
  // GitHub integration links PRs by key, from whatever branch or repo).
  if ((!pr || pr.state === 'CLOSED') && issue.pullRequests) {
    const state = issue.pullRequests
    return (
      <button
        type="button"
        className={`backlog-icon-link backlog-pr backlog-pr--${state}`}
        aria-label={`Pull request (${state})`}
        title={`${state === 'open' ? 'Open' : 'Merged'} pull request - click to open it`}
        onClick={(e) => {
          e.stopPropagation()
          void loadTicketPullRequests(issue.key).then((r) => {
            const first = r.ok ? r.value[0] : undefined
            if (first) void openExternal(first.url)
            else void openExternal(issue.url)
          })
        }}
      >
        <Icon name={state === 'merged' ? 'GitMerge' : 'GitPullRequest'} size={14} />
      </button>
    )
  }
  if (!record) return null
  if (pr && pr.state !== 'CLOSED') {
    const state = pr.state === 'MERGED' ? 'merged' : pr.isDraft ? 'draft' : 'open'
    return (
      <button
        type="button"
        className={`backlog-icon-link backlog-pr backlog-pr--${state}`}
        aria-label={`Pull request #${pr.number} (${state})`}
        title={`Pull request #${pr.number}, ${state}: ${pr.title}`}
        onClick={(e) => {
          e.stopPropagation()
          void openExternal(pr.url)
        }}
      >
        <Icon name={state === 'merged' ? 'GitMerge' : 'GitPullRequest'} size={14} />
      </button>
    )
  }
  return (
    <button
      type="button"
      className="backlog-icon-link backlog-branch"
      aria-label={`Branch ${record.branch}`}
      title={`Branch ${record.branch}. Click to copy`}
      onClick={(e) => {
        e.stopPropagation()
        onCopy(record.branch, 'the branch name')
      }}
    >
      <Icon name="GitBranch" size={14} />
    </button>
  )
}

function SlackButton({ issue }: { issue: JiraIssue }): React.JSX.Element | null {
  const url = slackLink(issue)
  if (!url) return null
  return (
    <button
      type="button"
      className="backlog-icon-link"
      aria-label="Open in Slack"
      title="Open the Slack thread"
      onClick={(e) => {
        e.stopPropagation()
        void openExternal(url)
      }}
    >
      <SlackGlyph size={14} />
    </button>
  )
}

/** Every value on a ticket sits in its own contained pill. */
function Pill({
  children,
  tone,
  className = '',
  title
}: {
  children: React.ReactNode
  tone?: 'accent'
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <span
      className={['backlog-pill', tone ? `backlog-pill--${tone}` : '', className].join(' ')}
      title={title}
    >
      {children}
    </span>
  )
}

type EditField = 'status' | 'priority' | 'epic' | 'cycle' | 'estimate' | 'assignee'

/** A value on a row or card that edits in place: click it for its picker. */
function Editable({
  label,
  className = '',
  onEdit,
  onFilter,
  children
}: {
  label: string
  className?: string
  onEdit?: (anchor: HTMLElement) => void
  /** ⌥-click: show only the tickets that share this value. */
  onFilter?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  if (!onEdit) return <span className={className}>{children}</span>
  return (
    <button
      type="button"
      className={`backlog-edit ${className}`}
      aria-label={label}
      title={onFilter ? `${label}. ⌥-click to show only these` : label}
      draggable={false}
      onClick={(e) => {
        if (e.altKey && onFilter) {
          e.preventDefault()
          e.stopPropagation()
          onFilter()
          return
        }
        // ⌘/⇧-click still picks the ticket, wherever on the row it lands.
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.stopPropagation()
        onEdit(e.currentTarget)
      }}
    >
      {children}
    </button>
  )
}

function IssuePills({
  issue,
  showStatus,
  showEpic,
  showCycle,
  compact = false,
  onEdit,
  onFilter
}: {
  issue: JiraIssue
  showStatus: boolean
  showEpic: boolean
  showCycle: boolean
  compact?: boolean
  onEdit?: (field: EditField, anchor: HTMLElement) => void
  /** ⌥-click a chip: filter to its epic or cycle. */
  onFilter?: (f: { epic?: string; cycle?: CycleFilter }) => void
}): React.JSX.Element {
  const edit = (field: EditField): ((a: HTMLElement) => void) | undefined =>
    onEdit ? (a) => onEdit(field, a) : undefined
  return (
    <div className="backlog-pills">
      {showStatus && (
        <Editable
          label={`Status: ${issue.status}`}
          className="backlog-pill backlog-pill--status"
          onEdit={edit('status')}
        >
          <StatusGlyph name={issue.status} category={issue.statusCategory} size={12} />
          {issue.status}
        </Editable>
      )}
      {!compact && typeName(issue) && <Pill className="backlog-pill--type">{typeName(issue)}</Pill>}
      {showEpic && issue.parent && (
        <Editable
          label={`Epic: ${issue.parent.summary} (${issue.parent.key})`}
          className="backlog-pill backlog-pill--accent"
          onEdit={edit('epic')}
          onFilter={onFilter ? () => onFilter({ epic: issue.parent!.key }) : undefined}
        >
          <EpicMark />
          <span className="backlog-pill-text">{issue.parent.summary}</span>
        </Editable>
      )}
      {showCycle && issue.sprint?.state === 'active' && (
        <Editable
          label={`Cycle: ${issue.sprint.name}`}
          className="backlog-pill"
          onEdit={edit('cycle')}
          onFilter={onFilter ? () => onFilter({ cycle: 'current' }) : undefined}
        >
          <Icon name="RefreshCw" size={12} />
          {issue.sprint.name}
        </Editable>
      )}
      {issue.estimate && (
        <Editable
          label={`Estimate: ${issue.estimate}`}
          className="backlog-pill"
          onEdit={edit('estimate')}
        >
          {issue.estimate}
        </Editable>
      )}
    </div>
  )
}

function IssueRow({
  issue,
  carriesOver = false,
  ...p
}: {
  issue: JiraIssue
  /** Planning: still in the current cycle, and Jira moves it here when that's completed. */
  carriesOver?: boolean
} & RowActions): React.JSX.Element {
  const entries = p.sessionsFor(issue)
  const selected = p.openKey === issue.key
  const picked = p.selected.includes(issue.key)
  // While picking, a click anywhere on the row picks it; the bar does the edits.
  const selecting = p.selected.length > 0
  const edit = (field: EditField): ((anchor: HTMLElement) => void) | undefined =>
    selecting ? undefined : (anchor) => p.onEdit(field, issue, anchor)
  const subtasks = (issue.subtasks ?? [])
    .map((k) => p.byKey(k))
    .filter((i): i is JiraIssue => Boolean(i))
  const subtasksOpen = subtasks.length > 0 && p.expandedSubtasks.includes(issue.key)
  return (
    <>
      <div
        className={[
          'backlog-row',
          entries.length ? 'backlog-row--in-session' : '',
          selected ? 'backlog-row--selected' : '',
          picked ? 'backlog-row--picked' : '',
          selecting ? 'backlog-row--picking' : '',
          p.changed.has(issue.key) ? 'backlog-row--changed' : ''
        ].join(' ')}
        data-issue={issue.key}
        data-nav-item=""
        aria-current={selected || undefined}
        aria-selected={picked || undefined}
        {...ticketHandlers(issue, p)}
      >
        <PickCheck
          on={picked}
          label={`Select ${issue.key}`}
          className="backlog-row-pick"
          onToggle={() => p.onSelect(issue.key, 'toggle')}
        />
        <Editable label={`Priority: ${issue.priority ?? 'none'}`} onEdit={edit('priority')}>
          <PriorityGlyph priority={issue.priority} />
        </Editable>
        <span className="backlog-row-key">{issue.key}</span>
        <Editable label={`Status: ${issue.status}`} onEdit={edit('status')}>
          <StatusGlyph name={issue.status} category={issue.statusCategory} />
        </Editable>
        {carriesOver && (
          <span
            className="backlog-row-carry"
            title="Still in the current cycle. Jira moves it here when that cycle is completed."
          >
            Carries over
          </span>
        )}
        <span className="backlog-row-summary" title={issue.summary}>
          {issue.summary}
        </span>
        <div className="backlog-row-meta">
          <IssuePills
            issue={issue}
            showStatus={p.showStatus}
            showEpic={p.showEpic}
            showCycle={p.showCycle}
            onEdit={selecting ? undefined : (field, anchor) => p.onEdit(field, issue, anchor)}
            onFilter={selecting ? undefined : p.onFilter}
          />
          {subtasks.length > 0 && (
            <button
              type="button"
              className="backlog-subtask-count"
              aria-expanded={subtasksOpen}
              onClick={(e) => {
                e.stopPropagation()
                p.onToggleSubtasks(issue.key)
              }}
            >
              <Icon name={subtasksOpen ? 'ChevronDown' : 'ChevronRight'} size={12} />
              {subtasks.length}
              <span className="backlog-subtask-count-word">
                {' '}
                sub-task{subtasks.length > 1 ? 's' : ''}
              </span>
            </button>
          )}
          <SessionChip entries={entries} onOpenSession={p.onOpenSession} />
          <div className="backlog-row-end">
            <BranchMark issue={issue} entries={entries} prFor={p.prFor} onCopy={p.onCopy} />
            <SlackButton issue={issue} />
            <span className="backlog-row-updated" title={`Updated ${fullDate(issue.updated)}`}>
              {issue.updated && ago(issue.updated)}
            </span>
            <Editable
              label={`Assignee: ${issue.assignee ?? 'unassigned'}`}
              onEdit={edit('assignee')}
            >
              <Avatar name={issue.assignee} />
            </Editable>
            {/* Its own slot, so it never covers anything; shown on hover or focus. */}
            <span className="backlog-row-start">
              {entries.length === 0 && (
                <button
                  type="button"
                  className="backlog-icon-link"
                  aria-label="Start session"
                  title="Start a session on this ticket"
                  onClick={(e) => {
                    e.stopPropagation()
                    p.onStartSession(issue)
                  }}
                >
                  <Icon name="SquareTerminal" size={15} />
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
      {subtasksOpen &&
        subtasks.map((sub) => (
          <div
            key={sub.key}
            className="backlog-subtask-row"
            role="button"
            tabIndex={0}
            onClick={() => p.onOpen(sub.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') p.onOpen(sub.key)
            }}
          >
            <StatusGlyph name={sub.status} category={sub.statusCategory} size={12} />
            <span className="backlog-row-key">{sub.key}</span>
            <span className="backlog-subtask-summary" title={sub.summary}>
              {sub.summary}
            </span>
          </div>
        ))}
    </>
  )
}

function BoardColumn({
  column,
  category,
  items,
  onDropIssue,
  headless = false,
  filteredOut = false,
  ...p
}: {
  column: JiraColumn
  category: string
  items: JiraIssue[]
  onDropIssue: (key: string) => void
  /** In a swimlane: the header is shown once above all lanes instead. */
  headless?: boolean
  /** Its tickets are hidden by the status filter; it's still a drop target. */
  filteredOut?: boolean
} & RowActions): React.JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <div
      className={[
        'backlog-column',
        over ? 'backlog-column--over' : '',
        filteredOut ? 'backlog-column--filtered' : ''
      ].join(' ')}
      data-status={column.name}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const key = e.dataTransfer.getData(DRAG_TYPE)
        if (key) onDropIssue(key)
      }}
    >
      {!headless && (
        <h3 className="backlog-column-title">
          <StatusGlyph name={column.name} category={category} />
          <span className="backlog-group-name" title={column.statuses.join(', ')}>
            {column.name}
          </span>
          <span className="backlog-group-count">{filteredOut ? 'hidden' : items.length}</span>
        </h3>
      )}
      {filteredOut && (
        <p className="backlog-column-note">Filtered out. Drop a ticket here to move it.</p>
      )}
      <div className="backlog-column-cards">
        {items.map((issue) => {
          const entries = p.sessionsFor(issue)
          return (
            <div
              key={issue.key}
              className={[
                'backlog-card',
                entries.length ? 'backlog-card--in-session' : '',
                p.openKey === issue.key ? 'backlog-card--selected' : '',
                p.selected.includes(issue.key) ? 'backlog-card--picked' : ''
              ].join(' ')}
              data-issue={issue.key}
              data-nav-item=""
              {...ticketHandlers(issue, p)}
            >
              {/* In the bottom-right corner, the one spot on a card that does
                  nothing else (priority and assignee are both click-to-edit);
                  it takes no room until it shows. */}
              <PickCheck
                on={p.selected.includes(issue.key)}
                label={`Select ${issue.key}`}
                className={`backlog-card-pick${p.selected.length ? ' backlog-card-pick--shown' : ''}`}
                onToggle={() => p.onSelect(issue.key, 'toggle')}
              />
              <div className="backlog-card-top">
                <Editable
                  label={`Priority: ${issue.priority ?? 'none'}`}
                  onEdit={p.selected.length ? undefined : (a) => p.onEdit('priority', issue, a)}
                >
                  <PriorityGlyph priority={issue.priority} />
                </Editable>
                <span className="backlog-row-key">{issue.key}</span>
                <span className="backlog-card-spacer" />
                <BranchMark issue={issue} entries={entries} prFor={p.prFor} onCopy={p.onCopy} />
                <SlackButton issue={issue} />
                <Editable
                  label={`Assignee: ${issue.assignee ?? 'unassigned'}`}
                  onEdit={p.selected.length ? undefined : (a) => p.onEdit('assignee', issue, a)}
                >
                  <Avatar name={issue.assignee} />
                </Editable>
              </div>
              <div className="backlog-card-summary">{issue.summary}</div>
              <IssuePills
                issue={issue}
                showStatus={false}
                showEpic={p.showEpic}
                showCycle={p.showCycle}
                compact
                onEdit={
                  p.selected.length ? undefined : (field, anchor) => p.onEdit(field, issue, anchor)
                }
              />
              <SessionChip entries={entries} onOpenSession={p.onOpenSession} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The Backlog's sidebar: whose tickets and saved views, the cycles and the
 * epics. Each cycle and epic is a filter to click and a place to drop a
 * ticket — onto an epic to set it, onto a cycle to move it in or out.
 *
 * Built from the Sessions rail's own parts (sidebar-column, projects-rail,
 * its rows and section titles) and shown/hidden by the same title-bar
 * button, so the two read as one app with different content.
 */
function BacklogSidebar({
  board,
  who,
  onWho,
  counts,
  views,
  cycle,
  onCycle,
  activeSprint,
  allTickets,
  epicTickets,
  epicFilter,
  settleKey,
  onEpic,
  onDrop,
  onPlanCycle,
  width,
  onResizeStart,
  onResizeReset
}: {
  board: JiraBoardData
  /** The tab the people filter sits on; null once it has moved off every tab. */
  who: Who | null
  onWho: (w: Who) => void
  counts: Record<Who, number>
  views: React.ReactNode
  /** The one cycle picked; null when the filter has several. */
  cycle: CycleFilter | null
  onCycle: (c: CycleFilter) => void
  activeSprint: { id: number; name: string; endDate?: string } | null
  allTickets: JiraIssue[]
  /** The tickets every other filter lets through, for the epic counts. */
  epicTickets: JiraIssue[]
  epicFilter: string | null
  /** Changes when the view does; until then the epic list holds its order. */
  settleKey: string
  onEpic: (key: string | null) => void
  onDrop: (key: string, value: LaneValue) => void
  /** Opens the planning view for that cycle — the sidebar row's hover action. */
  onPlanCycle: (sprintId: number) => void
  width: number
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void
  onResizeReset?: () => void
}): React.JSX.Element {
  const [showEmpty, setShowEmpty] = useState(false)
  const epics = new Map<string, string>()
  for (const e of board.epics) epics.set(e.key, e.summary)
  for (const i of allTickets) if (i.parent) epics.set(i.parent.key, i.parent.summary)
  const epicRows = [...epics.entries()]
    .map(([key, summary]) => {
      const mine = allTickets.filter((i) => i.parent?.key === key)
      return {
        key,
        summary,
        count: epicTickets.filter((i) => i.parent?.key === key).length,
        done: mine.length ? mine.filter((i) => i.statusCategory === 'done').length / mine.length : 0
      }
    })
    .sort((a, b) => b.count - a.count || a.summary.localeCompare(b.summary))
  // Sorted by count when you arrive, then held still: moving a ticket only
  // changes the numbers, and an epic whose last ticket left stays put at 0
  // until you change the view.
  const epicOrder = useSettledOrder(
    epicRows.filter((e) => e.count > 0 || e.key === epicFilter).map((e) => e.key),
    settleKey
  )
  const withTickets = epicOrder
    .map((key) => epicRows.find((e) => e.key === key))
    .filter((e): e is (typeof epicRows)[number] => Boolean(e))
  const empty = epicRows.filter((e) => !epicOrder.includes(e.key))
  const noEpic = epicTickets.filter((i) => !i.parent).length
  const inCycle = allTickets.filter((i) => i.sprint?.state === 'active')
  return (
    <div className="sidebar-column backlog-sidebar" style={{ flexBasis: `${width}px` }}>
      <nav className="projects-rail" aria-label="Tickets sidebar">
        <div className="projects-rail-header">
          <h2 className="projects-rail-title">Views</h2>
        </div>
        <div
          className="projects-rail-items backlog-rail-items"
          role="radiogroup"
          aria-label="Whose tickets"
        >
          {(
            [
              ['all', 'Everyone', 'Users'],
              ['mine', 'Mine', 'User'],
              ['unassigned', 'Unassigned', 'UserX']
            ] as const
          ).map(([value, label, icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={who === value}
              className={`projects-rail-item backlog-filter${who === value ? ' projects-rail-item-selected backlog-filter--selected' : ''}`}
              onClick={() => onWho(value)}
            >
              <span className="projects-rail-label-wrapper">
                <Icon name={icon} size={16} />
                <span className="projects-rail-label backlog-rail-label">{label}</span>
              </span>
              <span className="projects-rail-count">{counts[value]}</span>
            </button>
          ))}
          {views}
        </div>

        <div className="projects-rail-header backlog-rail-section">
          <h2 className="projects-rail-title">Cycles</h2>
        </div>
        <div className="projects-rail-items backlog-rail-items">
          <SidebarItem
            label="All open"
            icon={<Icon name="Layers" size={16} />}
            active={cycle === 'all'}
            onClick={() => onCycle('all')}
          />
          {activeSprint && (
            <SidebarItem
              label={activeSprint.name}
              icon={<Icon name="RefreshCw" size={16} />}
              active={cycle === 'current'}
              onClick={() => onCycle('current')}
              drop={{ kind: 'cycle', sprintId: activeSprint.id }}
              onDrop={onDrop}
              dataCycle="current"
              onPlan={() => onPlanCycle(activeSprint.id)}
            >
              <CycleProgress sprint={activeSprint} issues={inCycle} compact />
            </SidebarItem>
          )}
          {board.sprints
            .filter((sp) => sp.state !== 'active')
            .map((sp) => (
              <SidebarItem
                key={sp.id}
                label={sp.name}
                icon={<Icon name="CalendarClock" size={16} />}
                active={cycle === `sprint:${sp.id}`}
                onClick={() => onCycle(`sprint:${sp.id}`)}
                drop={{ kind: 'cycle', sprintId: sp.id }}
                onDrop={onDrop}
                dataCycle={`sprint-${sp.id}`}
                onPlan={() => onPlanCycle(sp.id)}
              />
            ))}
          <SidebarItem
            label="Backlog"
            icon={<Icon name="Inbox" size={16} />}
            active={cycle === 'backlog'}
            onClick={() => onCycle('backlog')}
            drop={{ kind: 'cycle', sprintId: null }}
            onDrop={onDrop}
            dataCycle="backlog"
          />
        </div>

        <div className="projects-rail-header backlog-rail-section">
          <h2 className="projects-rail-title">Epics</h2>
        </div>
        <div className="projects-rail-items backlog-rail-items">
          <SidebarItem
            label="All epics"
            icon={<Icon name="Diamond" size={16} />}
            active={!epicFilter}
            onClick={() => onEpic(null)}
          />
          {withTickets.map((e) => (
            <SidebarItem
              key={e.key}
              label={e.summary}
              title={e.key}
              icon={<EpicMark />}
              count={e.count}
              progress={e.done}
              active={epicFilter === e.key}
              onClick={() => onEpic(epicFilter === e.key ? null : e.key)}
              drop={{ kind: 'epic', key: e.key }}
              onDrop={onDrop}
              dataEpic={e.key}
            />
          ))}
          <SidebarItem
            label="No epic"
            icon={<span className="backlog-epic-mark backlog-epic-mark--none" />}
            count={noEpic}
            active={epicFilter === NO_EPIC}
            onClick={() => onEpic(epicFilter === NO_EPIC ? null : NO_EPIC)}
            drop={{ kind: 'epic', key: null }}
            onDrop={onDrop}
            dataEpic="none"
          />
          {empty.length > 0 && (
            <button
              type="button"
              className="projects-rail-item backlog-sidebar-more"
              onClick={() => setShowEmpty((v) => !v)}
            >
              <span className="projects-rail-label backlog-rail-label">
                {showEmpty ? 'Hide' : 'Show'} {empty.length} epics with nothing here
              </span>
            </button>
          )}
          {showEmpty &&
            empty.map((e) => (
              <SidebarItem
                key={e.key}
                label={e.summary}
                title={e.key}
                icon={<EpicMark />}
                count={0}
                active={false}
                onClick={() => onEpic(e.key)}
                drop={{ kind: 'epic', key: e.key }}
                onDrop={onDrop}
                dataEpic={e.key}
              />
            ))}
        </div>
      </nav>
      {onResizeStart && (
        <div
          className="sidebar-resize-handle"
          onPointerDown={onResizeStart}
          onDoubleClick={onResizeReset}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
      )}
    </div>
  )
}

function SidebarItem({
  label,
  title,
  icon,
  count,
  progress,
  active,
  onClick,
  drop,
  onDrop,
  dataEpic,
  dataCycle,
  onPlan,
  children
}: {
  label: string
  title?: string
  icon: React.ReactNode
  count?: number
  /** Share of the epic's tickets that are done, for the thin bar. */
  progress?: number
  active: boolean
  onClick: () => void
  drop?: LaneValue
  onDrop?: (key: string, value: LaneValue) => void
  dataEpic?: string
  dataCycle?: string
  /** A cycle row only: opens its planning view. Shows on hover/focus. */
  onPlan?: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <div
      className={[
        'backlog-sidebar-item-wrap',
        onPlan ? 'backlog-sidebar-item-wrap--plannable' : ''
      ].join(' ')}
    >
      <button
        type="button"
        className={[
          'projects-rail-item',
          'backlog-sidebar-item',
          active ? 'projects-rail-item-selected' : '',
          children ? 'backlog-sidebar-item--tall' : '',
          over ? 'backlog-sidebar-item--over' : ''
        ].join(' ')}
        aria-pressed={active}
        title={title ?? label}
        data-sidebar-epic={dataEpic}
        data-sidebar-cycle={dataCycle}
        onClick={onClick}
        onDragOver={(e) => {
          if (!drop || !e.dataTransfer.types.includes(DRAG_TYPE)) return
          e.preventDefault()
          if (!over) setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!drop || !onDrop) return
          e.preventDefault()
          setOver(false)
          const key = e.dataTransfer.getData(DRAG_TYPE)
          if (key) onDrop(key, drop)
        }}
      >
        <span className="projects-rail-label-wrapper">
          <span className="backlog-sidebar-icon">{icon}</span>
          <span className="backlog-rail-text">
            <span className="projects-rail-label backlog-rail-label">{label}</span>
            {children}
            {progress !== undefined && progress > 0 && (
              <span className="backlog-sidebar-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </span>
            )}
          </span>
        </span>
        {count !== undefined && <span className="projects-rail-count">{count}</span>}
      </button>
      {onPlan && (
        <IconButton
          icon="LayoutList"
          label={`Plan ${label}`}
          tooltip="Plan cycle"
          size={28}
          className="backlog-sidebar-item-plan"
          data-sidebar-plan={dataCycle}
          onClick={(e) => {
            e.stopPropagation()
            onPlan()
          }}
        />
      )}
    </div>
  )
}

/** Cycle and status filters, in one menu; the button counts what's active. */
function FilterMenu({
  cycles,
  onCycles,
  sprintName,
  activeSprintId,
  onPlanCycle,
  upcoming,
  columns,
  hidden,
  onHidden,
  people,
  assignees,
  assigneesNarrowed,
  onAssignees,
  epicActive,
  onClearEpic
}: {
  /** [] is every open ticket. */
  cycles: CycleFilter[]
  onCycles: (c: CycleFilter[]) => void
  sprintName: string | null
  /** The active cycle's id, for "Plan cycle" on that row — null with none open. */
  activeSprintId: number | null
  /** Opens the planning view for a cycle — reachable here even with the
   * sidebar hidden, where the sidebar row's own hover action isn't. */
  onPlanCycle: (sprintId: number) => void
  upcoming: { id: number; name: string }[]
  columns: { name: string; category: string; count: number }[]
  hidden: string[]
  onHidden: (names: string[]) => void
  people: { value: string; label: string; count: number }[]
  /** The people shown: the tab's, or the ones picked here. */
  assignees: string[]
  /** Picked here, beyond a tab: counts as a filter. */
  assigneesNarrowed: boolean
  onAssignees: (picked: string[]) => void
  epicActive: boolean
  onClearEpic: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const active =
    (cycles.length > 0 ? 1 : 0) +
    (hidden.length > 0 ? 1 : 0) +
    (assigneesNarrowed ? 1 : 0) +
    (epicActive ? 1 : 0)
  const doneColumns = columns.filter((c) => c.category === 'done').map((c) => c.name)
  const doneHidden = doneColumns.length > 0 && doneColumns.every((n) => hidden.includes(n))
  // "All open" clears the cycle filter; each cycle is a checkbox, so several
  // can be shown together.
  const radio = (value: CycleFilter, label: string): React.JSX.Element => {
    const on = value === 'all' ? cycles.length === 0 : cycles.includes(value)
    return (
      <button
        type="button"
        role={value === 'all' ? 'menuitemradio' : 'menuitemcheckbox'}
        aria-checked={on}
        className="cr-popover-item backlog-menu-item"
        onClick={() =>
          onCycles(
            value === 'all' ? [] : on ? cycles.filter((c) => c !== value) : [...cycles, value]
          )
        }
      >
        {value === 'all' ? (
          <>
            <span>{label}</span>
            {on && <Icon name="Check" size={14} />}
          </>
        ) : (
          <span className="backlog-menu-item-label">
            <span className={`backlog-check-box${on ? ' backlog-check-box--on' : ''}`}>
              {on && <Icon name="Check" size={11} />}
            </span>
            {label}
          </span>
        )}
      </button>
    )
  }
  /** A cycle's filter row, with a "Plan" action reachable here too — the
   * only way in when the sidebar (whose row has its own hover action) is
   * hidden. */
  const cycleRow = (
    value: CycleFilter,
    label: string,
    planId: number | null
  ): React.JSX.Element => (
    <div className="backlog-menu-cycle-row">
      {radio(value, label)}
      {planId !== null && (
        <IconButton
          icon="LayoutList"
          label={`Plan ${label}`}
          tooltip="Plan cycle"
          size={28}
          onClick={() => {
            setOpen(false)
            onPlanCycle(planId)
          }}
        />
      )}
    </div>
  )
  return (
    <div ref={anchor}>
      <button
        type="button"
        className={`backlog-menu-button${active ? ' backlog-menu-button--active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Filter${active ? `: ${active} active` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="ListFilter" size={14} />
        Filter
        {active > 0 && <span className="backlog-menu-badge">{active}</span>}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="bottom-end"
        className="backlog-menu backlog-filter-menu"
        aria-label="Filter"
      >
        <div className="backlog-menu-heading">Cycle</div>
        {radio('all', 'All open')}
        {cycleRow(
          'current',
          sprintName ? `Current cycle (${sprintName})` : 'Current cycle',
          activeSprintId
        )}
        {upcoming.map((sp) => (
          <Fragment key={sp.id}>{cycleRow(`sprint:${sp.id}`, sp.name, sp.id)}</Fragment>
        ))}
        {radio('backlog', 'Backlog')}
        <div className="backlog-menu-separator" role="separator" />
        <div className="backlog-menu-heading backlog-menu-heading--row">
          Status
          {doneColumns.length > 0 && (
            <button
              type="button"
              className="backlog-link backlog-link--quiet"
              onClick={() =>
                onHidden(
                  doneHidden
                    ? hidden.filter((n) => !doneColumns.includes(n))
                    : [...new Set([...hidden, ...doneColumns])]
                )
              }
            >
              {doneHidden ? 'Show done' : 'Hide done'}
            </button>
          )}
        </div>
        {columns.map((c) => {
          const shown = !hidden.includes(c.name)
          return (
            <button
              key={c.name}
              type="button"
              role="menuitemcheckbox"
              data-status-option=""
              aria-checked={shown}
              className="cr-popover-item backlog-menu-item"
              onClick={() =>
                onHidden(shown ? [...hidden, c.name] : hidden.filter((n) => n !== c.name))
              }
            >
              <span className="backlog-menu-item-label">
                <span className={`backlog-check-box${shown ? ' backlog-check-box--on' : ''}`}>
                  {shown && <Icon name="Check" size={11} />}
                </span>
                <StatusGlyph name={c.name} category={c.category} />
                {c.name}
              </span>
              <span className="backlog-group-count">{c.count}</span>
            </button>
          )
        })}
        <div className="backlog-menu-separator" role="separator" />
        <div className="backlog-menu-heading backlog-menu-heading--row">
          Assignee
          {assignees.length > 0 && (
            <button
              type="button"
              className="backlog-link backlog-link--quiet"
              onClick={() => onAssignees([])}
            >
              Everyone
            </button>
          )}
        </div>
        <div className="backlog-filter-people">
          {people.map((p) => {
            // No pick means everyone, so everyone shows ticked; untick one to
            // leave them out, and ticking the last one back is Everyone again.
            const everyone = assignees.length === 0
            const on = everyone || assignees.includes(p.value)
            const toggle = (): void => {
              const picked = everyone
                ? people.map((x) => x.value).filter((v) => v !== p.value)
                : on
                  ? assignees.filter((a) => a !== p.value)
                  : [...assignees, p.value]
              onAssignees(people.every((x) => picked.includes(x.value)) ? [] : picked)
            }
            return (
              <button
                key={p.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                className="cr-popover-item backlog-menu-item"
                onClick={toggle}
              >
                <span className="backlog-menu-item-label">
                  <span className={`backlog-check-box${on ? ' backlog-check-box--on' : ''}`}>
                    {on && <Icon name="Check" size={11} />}
                  </span>
                  <Avatar name={p.value === UNASSIGNED ? null : p.label} size={16} />
                  {p.label}
                </span>
                {/* Just them, in one click, without unticking everyone else. */}
                <span
                  role="button"
                  tabIndex={-1}
                  className="backlog-filter-only"
                  onClick={(e) => {
                    e.stopPropagation()
                    onAssignees([p.value])
                  }}
                >
                  Only
                </span>
                <span className="backlog-group-count">{p.count}</span>
              </button>
            )
          })}
        </div>
        {active > 0 && (
          <>
            <div className="backlog-menu-separator" role="separator" />
            <button
              type="button"
              className="cr-popover-item"
              onClick={() => {
                onCycles([])
                onHidden([])
                onAssignees([])
                onClearEpic()
              }}
            >
              Clear filters
            </button>
          </>
        )}
      </Popover>
    </div>
  )
}

const GROUP_LABELS: Record<GroupBy, string> = { status: 'Status', epic: 'Epic', cycle: 'Cycle' }

/**
 * How the list is laid out: group by one thing or two (the second splits
 * each group; numbers show the order), fold every group, set up columns.
 */
function DisplayMenu({
  grouping,
  onGrouping,
  onCollapseAll,
  anyCollapsed,
  onColumns
}: {
  grouping: GroupBy[]
  onGrouping: (next: GroupBy[]) => void
  onCollapseAll: (collapse: boolean) => void
  anyCollapsed: boolean
  onColumns: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const toggle = (g: GroupBy): void => {
    if (grouping.includes(g)) {
      const next = grouping.filter((x) => x !== g)
      onGrouping(next.length ? next : ['status'])
    } else {
      onGrouping(grouping.length >= 2 ? [grouping[0], g] : [...grouping, g])
    }
  }
  return (
    <div ref={anchor}>
      <button
        type="button"
        className="backlog-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Display: grouped by ${grouping.map((g) => GROUP_LABELS[g]).join(', then ')}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="SlidersHorizontal" size={14} />
        Display
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="bottom-end"
        className="backlog-menu backlog-display-menu"
        aria-label="Display"
      >
        <div className="backlog-menu-heading backlog-menu-heading--row">
          Group by, up to two in order
          {grouping.length === 2 && (
            <button
              type="button"
              className="backlog-link backlog-link--quiet"
              aria-label={`Swap order: ${GROUP_LABELS[grouping[1]]} first`}
              onClick={() => onGrouping([grouping[1], grouping[0]])}
            >
              Swap order
            </button>
          )}
        </div>
        {(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => {
          const at = grouping.indexOf(g)
          return (
            <button
              key={g}
              type="button"
              role="menuitemcheckbox"
              aria-checked={at >= 0}
              className="cr-popover-item backlog-menu-item"
              onClick={() => toggle(g)}
            >
              <span>{GROUP_LABELS[g]}</span>
              {at >= 0 && <span className="backlog-group-order">{at + 1}</span>}
            </button>
          )
        })}
        <div className="backlog-menu-separator" role="separator" />
        <button
          type="button"
          role="menuitem"
          className="cr-popover-item"
          onClick={() => onCollapseAll(!anyCollapsed)}
        >
          <Icon name={anyCollapsed ? 'ChevronsUpDown' : 'ChevronsDownUp'} size={14} />
          {anyCollapsed ? 'Expand all groups' : 'Collapse all groups'}
        </button>
        <button
          type="button"
          role="menuitem"
          className="cr-popover-item"
          onClick={() => {
            setOpen(false)
            onColumns()
          }}
        >
          <Icon name="Columns3" size={14} />
          Columns…
        </button>
      </Popover>
    </div>
  )
}

function OverflowMenu({
  items
}: {
  items: { label: string; icon: IconName; run: () => void }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  return (
    <div ref={anchor}>
      <IconButton
        icon="Ellipsis"
        label="More"
        size={36}
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="bottom-end"
        className="backlog-menu"
        aria-label="More"
      >
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className="cr-popover-item"
            onClick={() => {
              setOpen(false)
              it.run()
            }}
          >
            <Icon name={it.icon} size={14} />
            {it.label}
          </button>
        ))}
      </Popover>
    </div>
  )
}

/** Right-click on a ticket: everything you can do to it, without opening it. */
function IssueMenu({
  issue,
  x,
  y,
  statuses,
  activeSprint,
  upcoming,
  sessions,
  onClose,
  onOpen,
  onStartSession,
  onOpenSession,
  actions,
  copy
}: {
  issue: JiraIssue
  x: number
  y: number
  statuses: StatusOption[]
  activeSprint: { id: number; name: string } | null
  upcoming: { id: number; name: string }[]
  sessions: SessionEntry[]
  onClose: () => void
  onOpen: () => void
  onStartSession: () => void
  onOpenSession: (liveKey: string) => void
  actions: Actions
  copy: (text: string, what: string) => void
}): React.JSX.Element {
  const anchor = useRef<HTMLDivElement>(null)
  const slack = slackLink(issue)
  const inCurrent = issue.sprint?.state === 'active'
  const item = (label: string, run: () => void, extra?: React.ReactNode): React.JSX.Element => (
    <button
      type="button"
      role="menuitem"
      className="cr-popover-item backlog-menu-item"
      onClick={() => {
        onClose()
        run()
      }}
    >
      <span>{label}</span>
      {extra}
    </button>
  )
  return (
    <>
      <div ref={anchor} className="backlog-menu-anchor" style={{ left: x, top: y }} />
      <Popover
        open
        onClose={onClose}
        anchorRef={anchor}
        placement="bottom-start"
        gap={2}
        className="backlog-menu backlog-context-menu"
        aria-label={`${issue.key} actions`}
      >
        <div className="backlog-menu-heading">{issue.key}</div>
        {item('Open', onOpen, <kbd>↵</kbd>)}
        {sessions[0]
          ? item('Open session', () => onOpenSession(sessions[0].session.key), <kbd>O</kbd>)
          : item('Start session', onStartSession, <kbd>O</kbd>)}
        <div className="backlog-menu-separator" role="separator" />
        <div className="backlog-menu-heading">
          Status <kbd>S</kbd>
        </div>
        {statuses.map((s) => (
          <button
            key={s.name}
            type="button"
            role="menuitemradio"
            aria-checked={issue.status === s.name}
            className="cr-popover-item backlog-menu-item"
            onClick={() => {
              onClose()
              void actions.status(issue, s)
            }}
          >
            <span className="backlog-menu-item-label">
              <StatusGlyph name={s.name} category={s.category} />
              {s.name}
            </span>
            {issue.status === s.name && <Icon name="Check" size={14} />}
          </button>
        ))}
        <div className="backlog-menu-separator" role="separator" />
        {item(
          issue.assignedToMe ? 'Unassign me' : 'Assign to me',
          () => void actions.assign(issue),
          <kbd>A</kbd>
        )}
        {activeSprint &&
          (inCurrent
            ? item('Move to backlog', () => void actions.cycle(issue, null), <kbd>M</kbd>)
            : item(
                'Move to current cycle',
                () => void actions.cycle(issue, activeSprint.id),
                <kbd>M</kbd>
              ))}
        {upcoming
          .filter((sp) => issue.sprint?.id !== sp.id)
          .map((sp) => (
            <Fragment key={sp.id}>
              {item(`Move to ${sp.name}`, () => void actions.cycle(issue, sp.id))}
            </Fragment>
          ))}
        {!activeSprint &&
          issue.sprint &&
          item('Move to backlog', () => void actions.cycle(issue, null))}
        <div className="backlog-menu-separator" role="separator" />
        {item('Copy key', () => copy(issue.key, issue.key))}
        {item('Copy link', () => copy(issue.url, 'the link'))}
        {item('Copy branch name', () => copy(branchFor(issue), 'the branch name'))}
        <div className="backlog-menu-separator" role="separator" />
        {item('Open in Jira', () => void openExternal(issue.url))}
        {slack && item('Open in Slack', () => void openExternal(slack))}
      </Popover>
    </>
  )
}

// ---------------------------------------------------------------------------

function IssueDrawer({
  issue,
  board,
  people,
  myName,
  sessions,
  linkedSessions,
  position,
  onStep,
  onClose,
  onExpand,
  write,
  actions,
  statuses,
  copy,
  onError,
  onLink,
  onStartSession,
  onOpenSession,
  onOpenKey,
  onAddSubtask,
  onAddBlock,
  onRemoveBlock
}: {
  issue: JiraIssue
  board: JiraBoardData
  /** Everyone the ticket can be assigned to; @-mentions add the ticket's own people. */
  people: JiraPerson[]
  myName: string
  sessions: LiveSession[]
  linkedSessions: SessionEntry[]
  position: { index: number; total: number }
  /** Left out when there's no list to step through (the panel over a session). */
  onStep?: (delta: number) => void
  onClose: () => void
  /** Shown as "Open in Tickets" when the panel sits over another screen. */
  onExpand?: () => void
  write: (run: () => Promise<JiraResult<JiraIssue>>, optimistic?: JiraIssue) => Promise<boolean>
  actions: Actions
  /** The statuses this ticket's project has. */
  statuses: StatusOption[]
  copy: (text: string, what: string) => void
  onError: (message: string) => void
  onLink: (recordId: string, issueKey: string | null) => Promise<void>
  onStartSession: () => void
  onOpenSession: (liveKey: string) => void
  /** Opens a different ticket (a sub-task) in this same panel. */
  onOpenKey: (key: string) => void
  onAddSubtask: (issue: JiraIssue, summary: string) => Promise<boolean>
  onAddBlock: (issue: JiraIssue, other: string, direction: BlockDirection) => Promise<boolean>
  onRemoveBlock: (issue: JiraIssue, link: JiraBlockLink) => Promise<boolean>
}): React.JSX.Element {
  const [detail, setDetail] = useState<JiraIssueDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [editingSummary, setEditingSummary] = useState(false)
  const [summary, setSummary] = useState(issue.summary)
  const [editingDescription, setEditingDescription] = useState(false)
  const [description, setDescription] = useState('')
  const [comment, setComment] = useState('')
  // Internal notes by default: only the team sees them. Reply is for the
  // person who raised the ticket (service desk projects).
  const [asNote, setAsNote] = useState(true)
  // @-mentions in the comment box: the names you picked, and the one being typed.
  const [mentions, setMentions] = useState<Record<string, string>>({})
  const [mention, setMention] = useState<{ query: string; start: number; index: number } | null>(
    null
  )
  // Anyone on the Jira site matching what's typed after @, looked up once
  // the typing pauses.
  const [found, setFound] = useState<{ query: string; people: JiraPerson[] }>({
    query: '',
    people: []
  })
  const mentionQuery = mention?.query ?? null
  useEffect(() => {
    if (mentionQuery === null || mentionQuery.length < 2) return
    let live = true
    const t = setTimeout(() => {
      void searchJiraPeople(mentionQuery).then((r) => {
        if (live && r.ok) setFound({ query: mentionQuery, people: r.value })
      })
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [mentionQuery])
  // Who @ offers: everyone on this ticket first (the person who raised it
  // usually can't be assigned it, so the team list alone missed them), then
  // the team, then whoever the site search found.
  const mentionMatches = ((): JiraPerson[] => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const named = (p: JiraPerson): boolean => p.name.toLowerCase().includes(q)
    const candidates = [
      ...(detail?.participants ?? []).filter(named),
      ...people.filter(named),
      ...(found.query === mention.query ? found.people : [])
    ]
    return candidates
      .filter((p, i) => candidates.findIndex((x) => x.accountId === p.accountId) === i)
      .slice(0, 6)
  })()
  const pickMention = (person: JiraPerson, el: HTMLTextAreaElement | null): void => {
    if (!mention) return
    const end = mention.start + 1 + mention.query.length
    const next = `${comment.slice(0, mention.start)}@${person.name} ${comment.slice(end)}`
    setComment(next)
    setMentions((m) => ({ ...m, [person.name]: person.accountId }))
    setMention(null)
    const caret = mention.start + person.name.length + 2
    requestAnimationFrame(() => el?.setSelectionRange(caret, caret))
  }
  const [busy, setBusy] = useState(false)
  const [addingSubtask, setAddingSubtask] = useState(false)
  const [subtaskSummary, setSubtaskSummary] = useState('')
  const panel = useRef<HTMLElement>(null)
  // Escape drops an edited summary; the blur that follows must not save it.
  const dropSummary = useRef(false)

  useEffect(() => {
    let cancelled = false
    void loadJiraDetail(issue.key).then((r) => {
      if (cancelled) return
      if (r.ok) {
        setDetail(r.value)
        setDescription(r.value.descriptionWiki)
      } else setDetailError(r.error)
    })
    return () => {
      cancelled = true
    }
  }, [issue.key])

  // Escape leaves a field first (dropping a half-edited summary), and only
  // closes the panel from outside one — so a half-typed comment survives a
  // stray press. Anything stacked above (a menu) takes the press before this.
  useDismissible(true, 'overlay', () => {
    const active = document.activeElement as HTMLElement | null
    if (
      active &&
      panel.current?.contains(active) &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
    ) {
      if (editingSummary) {
        dropSummary.current = true
        setSummary(issue.summary)
        setEditingSummary(false)
      }
      active.blur()
      return true
    }
    onClose()
    return true
  })

  const run = async (fn: () => Promise<boolean>): Promise<void> => {
    setBusy(true)
    await fn()
    setBusy(false)
  }

  const saveSummary = (): void => {
    if (dropSummary.current) {
      dropSummary.current = false
      return
    }
    const next = summary.trim()
    if (!next || next === issue.summary) {
      setSummary(issue.summary)
      setEditingSummary(false)
      return
    }
    setEditingSummary(false)
    void write(() => updateJiraText(issue.key, { summary: next }), { ...issue, summary: next })
  }

  const sendComment = (): void => {
    if (!comment.trim() || !detail) return
    void run(async () => {
      // @Name → [~accountid:…], which Jira shows as a mention and notifies.
      let body = comment
      for (const [name, id] of Object.entries(mentions)) {
        body = body.split(`@${name}`).join(`[~accountid:${id}]`)
      }
      const r = await addJiraComment(issue.key, body, asNote)
      if (r.ok) {
        setDetail((d) =>
          d
            ? {
                ...d,
                comments: [...d.comments, r.value],
                people: {
                  ...d.people,
                  ...Object.fromEntries(Object.entries(mentions).map(([n, id]) => [id, n]))
                }
              }
            : d
        )
        setComment('')
        setMentions({})
      } else onError(`Jira: ${r.error}`)
      return r.ok
    })
  }

  const links = detail?.links ?? issue.links
  const slack = links.find((l) => isSlack(l.url))
  const linkable = sessions.filter(
    (s) => s.record && !s.record.deletedAt && !linkedSessions.some((l) => l.session.key === s.key)
  )
  const prs = useTicketPullRequests(issue, linkedSessions)
  const noteWithLink = async (body: string): Promise<boolean> => {
    const r = await addJiraComment(issue.key, body, true)
    if (r.ok) setDetail((d) => (d ? { ...d, comments: [...d.comments, r.value] } : d))
    else onError(`Jira: ${r.error}`)
    return r.ok
  }
  // The header's GitHub button opens the PR that matters most: an open one,
  // else the latest merged one.
  const headPr =
    prs.rows.find((r) => r.state === 'open' || r.state === 'draft') ??
    prs.rows.find((r) => r.state === 'merged') ??
    prs.rows[0]
  const priorities = board.priorities.includes(issue.priority ?? '')
    ? board.priorities
    : [...(issue.priority ? [issue.priority] : []), ...board.priorities]

  return (
    <aside
      ref={panel}
      className="backlog-drawer"
      role="dialog"
      aria-label={`${issue.key} ${issue.summary}`}
    >
      <div className="backlog-drawer-header">
        <div className="backlog-drawer-nav">
          {onStep && (
            <>
              <IconButton
                icon="ChevronUp"
                label="Previous ticket"
                tooltip="Previous ticket (K)"
                size={28}
                variant="ghost"
                disabled={position.index <= 0}
                onClick={() => onStep(-1)}
              />
              <IconButton
                icon="ChevronDown"
                label="Next ticket"
                tooltip="Next ticket (J)"
                size={28}
                variant="ghost"
                disabled={position.index < 0 || position.index >= position.total - 1}
                onClick={() => onStep(1)}
              />
            </>
          )}
          {/* Where it sits: its epic, its parent ticket for a sub-task, then
              its own key. */}
          {(() => {
            const parentIssue = issue.isSubtask
              ? board.issues.find((i) => i.key === issue.parent?.key)
              : null
            const epic = issue.isSubtask ? parentIssue?.parent : issue.parent
            return (
              <span className="backlog-drawer-crumbs">
                {epic && (
                  <span className="backlog-drawer-crumb" title={`Epic ${epic.key}`}>
                    <EpicMark />
                    <span className="backlog-drawer-crumb-text">{epic.summary}</span>
                  </span>
                )}
                {issue.isSubtask && issue.parent && (
                  <button
                    type="button"
                    className="backlog-drawer-crumb backlog-drawer-crumb--link"
                    title={issue.parent.summary}
                    onClick={() => onOpenKey(issue.parent!.key)}
                  >
                    {issue.parent.key}
                  </button>
                )}
                <button
                  type="button"
                  className="backlog-drawer-key"
                  title="Copy key"
                  onClick={() => copy(issue.key, issue.key)}
                >
                  {issue.key}
                </button>
              </span>
            )
          })()}
        </div>
        <div className="backlog-drawer-header-actions">
          {onExpand && (
            <IconButton
              icon="PanelRight"
              label="Open in Tickets"
              tooltip="Open in Tickets"
              size={28}
              variant="ghost"
              onClick={onExpand}
            />
          )}
          {headPr && (
            <Tooltip label={`Open ${headPr.number || 'pull request'} in GitHub (${headPr.state})`}>
              <button
                type="button"
                className="cr-icon-button cr-icon-button--28 cr-icon-button--ghost"
                aria-label="Open in GitHub"
                onClick={() => void openExternal(headPr.url)}
              >
                <GitHubGlyph size={15} />
              </button>
            </Tooltip>
          )}
          {slack ? (
            <Tooltip label="Open in Slack">
              <button
                type="button"
                className="cr-icon-button cr-icon-button--28 cr-icon-button--ghost"
                aria-label="Open in Slack"
                onClick={() => void openExternal(slack.url)}
              >
                <SlackGlyph size={15} />
              </button>
            </Tooltip>
          ) : (
            <AddSlackLink
              onAdd={async (url) => {
                const ok = await write(() => addJiraSlackLink(issue.key, url))
                if (ok)
                  setDetail((d) =>
                    d ? { ...d, links: [...d.links, { url, title: 'Open in Slack' }] } : d
                  )
                return ok
              }}
            />
          )}
          <IconButton
            icon="ExternalLink"
            label={`Open ${issue.key} in Jira`}
            size={28}
            variant="ghost"
            onClick={() => void openExternal(issue.url)}
          />
          <IconButton
            icon="X"
            label="Close"
            tooltip="Close (Esc)"
            size={28}
            variant="ghost"
            onClick={onClose}
          />
        </div>
      </div>

      {editingSummary ? (
        <form
          className="backlog-drawer-summary-form"
          onSubmit={(e) => {
            e.preventDefault()
            saveSummary()
          }}
        >
          <Input
            autoFocus
            aria-label="Summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onBlur={saveSummary}
          />
          <Button
            variant="filled"
            size="compact"
            type="submit"
            disabled={!summary.trim()}
            onMouseDown={(e) => e.preventDefault()}
          >
            Save
          </Button>
        </form>
      ) : (
        <h2
          className="backlog-drawer-summary"
          title="Click to edit"
          tabIndex={0}
          onClick={() => {
            setSummary(issue.summary)
            setEditingSummary(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setSummary(issue.summary)
              setEditingSummary(true)
            }
          }}
        >
          {issue.summary}
        </h2>
      )}

      <p className="backlog-drawer-byline">
        <span className="backlog-person">
          <Pill>{typeName(issue)}</Pill>
          <Avatar name={issue.reporter} size={16} />
          <span title={issue.created ? fullDate(issue.created) : undefined}>
            {issue.reporter ?? 'Someone'} reported this
            {issue.created ? ` ${when(issue.created)}` : ''}
          </span>
        </span>
        {issue.updated && (
          <span title={fullDate(issue.updated)}>Updated {when(issue.updated)}</span>
        )}
      </p>

      {/* The ticket's fields as a ruled grid, label over value, each cell as wide
          as its content needs: small values in thirds, people and labels in
          halves, cycle and epic across. */}
      <div className="backlog-props">
        <div className="backlog-prop backlog-prop--third">
          <span className="backlog-prop-label">Status</span>
          <div className="backlog-prop-value">
            <StatusGlyph name={issue.status} category={issue.statusCategory} />
            <select
              aria-label="Status"
              className="backlog-select"
              value={issue.status}
              onChange={(e) => {
                const s = statuses.find((x) => x.name === e.target.value)
                if (s) void actions.status(issue, s)
              }}
            >
              {statuses.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="backlog-prop backlog-prop--third">
          <span className="backlog-prop-label">Priority</span>
          <div className="backlog-prop-value">
            <PriorityGlyph priority={issue.priority} />
            <select
              aria-label="Priority"
              className="backlog-select"
              value={issue.priority ?? ''}
              onChange={(e) => void actions.priority(issue, e.target.value)}
            >
              {!issue.priority && <option value="">No priority</option>}
              {priorities.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="backlog-prop backlog-prop--third">
          <span className="backlog-prop-label">Estimate</span>
          <div className="backlog-prop-value">
            <EstimateField issue={issue} onSave={(v) => actions.estimate(issue, v)} />
          </div>
        </div>
        <div className="backlog-prop">
          <span className="backlog-prop-label">Assignee</span>
          <div className="backlog-prop-value">
            <Avatar name={issue.assignee} size={20} />
            {people.length > 0 ? (
              <select
                aria-label="Assignee"
                className="backlog-select"
                value={
                  issue.assignedToMe
                    ? 'me'
                    : (people.find((p) => p.name === issue.assignee)?.accountId ??
                      (issue.assignee ? 'other' : 'none'))
                }
                onChange={(e) => {
                  const v = e.target.value
                  const person = people.find((p) => p.accountId === v)
                  if (v === 'me' || v === 'none') void actions.setAssignee(issue, v)
                  else if (person) void actions.setAssignee(issue, person)
                }}
              >
                <option value="none">Unassigned</option>
                <option value="me">{myName === 'You' ? 'You' : `${myName} (you)`}</option>
                {issue.assignee &&
                  !issue.assignedToMe &&
                  !people.some((p) => p.name === issue.assignee) && (
                    <option value="other">{issue.assignee}</option>
                  )}
                {people
                  .filter((p) => p.name !== myName)
                  .map((p) => (
                    <option key={p.accountId} value={p.accountId}>
                      {p.name}
                    </option>
                  ))}
              </select>
            ) : (
              <span className="backlog-person backlog-prop-text">
                {issue.assignee ?? 'Unassigned'}
              </span>
            )}
            <button
              type="button"
              className="backlog-link backlog-link--quiet backlog-prop-action"
              onClick={() => void actions.assign(issue)}
            >
              {issue.assignedToMe ? 'Unassign' : 'Assign to me'}
            </button>
          </div>
        </div>
        <div className="backlog-prop">
          <span className="backlog-prop-label">Labels</span>
          <div className="backlog-prop-value">
            <LabelsField
              issue={issue}
              suggestions={board.labels}
              onSave={(labels) => actions.labels(issue, labels)}
            />
          </div>
        </div>
        {issue.isSubtask ? (
          <>
            <div className="backlog-prop backlog-prop--wide">
              <span className="backlog-prop-label">Cycle</span>
              <div className="backlog-prop-value">
                <Icon name={issue.sprint ? 'RefreshCw' : 'Inbox'} size={14} />
                <span className="backlog-drawer-field-note">
                  {issue.sprint ? `Follows ${issue.parent?.key ?? 'its parent'}` : 'Backlog'}
                </span>
              </div>
            </div>
            <div className="backlog-prop backlog-prop--wide">
              <span className="backlog-prop-label">Parent</span>
              <div className="backlog-prop-value">
                {issue.parent ? (
                  <button
                    type="button"
                    className="backlog-link backlog-prop-text"
                    onClick={() => onOpenKey(issue.parent!.key)}
                  >
                    {issue.parent.key} {issue.parent.summary}
                  </button>
                ) : (
                  <span className="backlog-drawer-field-note">None</span>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="backlog-prop backlog-prop--wide">
              <span className="backlog-prop-label">Cycle</span>
              <div className="backlog-prop-value">
                <Icon name={issue.sprint ? 'RefreshCw' : 'Inbox'} size={14} />
                <select
                  aria-label="Cycle"
                  className="backlog-select"
                  value={issue.sprint ? String(issue.sprint.id) : ''}
                  disabled={board.sprints.length === 0}
                  onChange={(e) =>
                    void actions.cycle(issue, e.target.value ? Number(e.target.value) : null)
                  }
                >
                  <option value="">Backlog</option>
                  {issue.sprint && !board.sprints.some((sp) => sp.id === issue.sprint!.id) && (
                    <option value={String(issue.sprint.id)}>{issue.sprint.name}</option>
                  )}
                  {board.sprints.map((sp) => (
                    <option key={sp.id} value={String(sp.id)}>
                      {sp.state === 'active'
                        ? `Current cycle · ${sp.name}`
                        : `${sp.name} · upcoming`}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="backlog-prop backlog-prop--wide">
              <span className="backlog-prop-label">Epic</span>
              <div className="backlog-prop-value">
                {issue.parent ? <EpicMark /> : <span className="backlog-drawer-field-blank" />}
                <select
                  aria-label="Parent"
                  className="backlog-select"
                  value={issue.parent?.key ?? ''}
                  onChange={(e) => void actions.parent(issue, e.target.value || null)}
                >
                  <option value="">No epic</option>
                  {issue.parent && !board.epics.some((ep) => ep.key === issue.parent!.key) && (
                    <option value={issue.parent.key}>
                      {issue.parent.summary} ({issue.parent.key})
                    </option>
                  )}
                  {board.epics.map((ep) => (
                    <option key={ep.key} value={ep.key}>
                      {ep.summary} ({ep.key})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </>
        )}
      </div>

      {/* One click to the next steps in the workflow, alongside the dropdown. */}
      {(() => {
        const at = statuses.findIndex((st) => st.name === issue.status)
        const next = at >= 0 ? statuses.slice(at + 1, at + 3) : []
        if (!next.length) return null
        return (
          <div className="backlog-next-status" role="group" aria-label="Move to">
            <span className="backlog-next-status-label">Move to</span>
            {next.map((st) => (
              <button
                key={st.name}
                type="button"
                className="backlog-next-status-option"
                onClick={() => void actions.status(issue, st)}
              >
                <StatusGlyph name={st.name} category={st.category} size={12} />
                {st.name}
              </button>
            ))}
          </div>
        )
      })()}

      {/* Work: the sessions on this ticket and their pull requests, in one box. */}
      <section className="backlog-drawer-group" aria-label="Work">
        {/* Heading first, then what to do. With sessions, the adds are quiet
            and sit beside the heading; with none, Start session is the body. */}
        {(() => {
          const linkSelect = linkable.length > 0 && (
            <select
              aria-label="Link a session"
              className="backlog-select backlog-select--flat"
              value=""
              onChange={(e) => {
                const id = e.target.value
                if (id) void onLink(id, issue.key)
              }}
            >
              <option value="">Link a session…</option>
              {linkable.map((s) => (
                <option key={s.key} value={s.record!.id}>
                  {s.record!.title}
                </option>
              ))}
            </select>
          )
          return linkedSessions.length > 0 || prs.rows.length > 0 ? (
            <div className="backlog-drawer-section-head">
              <h3>
                Work{' '}
                {linkedSessions.length > 1 && (
                  <span className="backlog-group-count">{linkedSessions.length}</span>
                )}
              </h3>
              <div className="backlog-drawer-section-actions">
                <Button variant="ghost" size="compact" onClick={onStartSession}>
                  <Icon name="Plus" size={12} />
                  Start session
                </Button>
                {linkSelect}
              </div>
            </div>
          ) : (
            <>
              <div className="backlog-drawer-section-head">
                <h3>Work</h3>
              </div>
              <div className="backlog-work-empty">
                <Button variant="filled" size="compact" onClick={onStartSession}>
                  Start session
                </Button>
                {linkSelect}
              </div>
            </>
          )
        })()}
        {(linkedSessions.length > 0 || prs.rows.length > 0 || prs.jiraError) && (
          <div className="backlog-work">
            {linkedSessions.map(({ session, linked }) => (
              <div key={session.key} className="backlog-work-item">
                <div className="backlog-work-row">
                  <button
                    type="button"
                    className="backlog-work-open"
                    onClick={() => onOpenSession(session.key)}
                  >
                    <StatusDot status={session.status} size={8} />
                    <span className="backlog-work-title">{session.record?.title}</span>
                    <span className="backlog-state-chip">{STATUS_WORDS[session.status]}</span>
                  </button>
                  {/* Always laid out, shown on hover: nothing shifts as you point. */}
                  <span className="backlog-work-tools">
                    {session.record?.branch && !session.record.investigation && (
                      <BranchCopy
                        branch={session.record.branch}
                        projectId={session.record.projectId}
                        recordId={session.record.id}
                        hasPr={prs.ownRecordId === session.record.id}
                        onCopy={(b) => copy(b, 'Branch name')}
                      />
                    )}
                    {linked && (
                      <IconButton
                        icon="Unlink"
                        label="Unlink this session"
                        tooltip="Unlink"
                        size={28}
                        variant="ghost"
                        onClick={() => void onLink(session.record!.id, null)}
                      />
                    )}
                  </span>
                </div>
              </div>
            ))}
            <TicketPullRequests prs={prs} show="all" onComment={noteWithLink} />
          </div>
        )}
      </section>

      {!issue.isSubtask && ((issue.subtasks?.length ?? 0) > 0 || addingSubtask) && (
        <section className="backlog-drawer-section">
          <div className="backlog-drawer-section-head">
            <h3>
              Sub-tasks{' '}
              {(issue.subtasks?.length ?? 0) > 0 && (
                <span className="backlog-group-count">{issue.subtasks!.length}</span>
              )}
            </h3>
            {!addingSubtask && (
              <Button variant="ghost" size="compact" onClick={() => setAddingSubtask(true)}>
                Add sub-task
              </Button>
            )}
          </div>
          {(issue.subtasks ?? [])
            .map((k) => board.issues.find((i) => i.key === k))
            .filter((i): i is JiraIssue => Boolean(i))
            .map((sub) => (
              <button
                key={sub.key}
                type="button"
                className="backlog-drawer-subtask"
                onClick={() => onOpenKey(sub.key)}
              >
                <StatusGlyph name={sub.status} category={sub.statusCategory} size={12} />
                <span className="backlog-row-key">{sub.key}</span>
                <span className="backlog-drawer-subtask-summary">{sub.summary}</span>
              </button>
            ))}
          {addingSubtask && (
            <form
              className="backlog-drawer-summary-form"
              onSubmit={(e) => {
                e.preventDefault()
                const text = subtaskSummary.trim()
                if (!text) return
                void onAddSubtask(issue, text).then((ok) => {
                  if (ok) {
                    setSubtaskSummary('')
                    setAddingSubtask(false)
                  }
                })
              }}
            >
              <Input
                autoFocus
                aria-label="Sub-task summary"
                placeholder="Sub-task summary"
                value={subtaskSummary}
                onChange={(e) => setSubtaskSummary(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setAddingSubtask(false)
                    setSubtaskSummary('')
                  }
                }}
              />
              <Button
                variant="filled"
                size="compact"
                type="submit"
                disabled={!subtaskSummary.trim()}
              >
                Add
              </Button>
            </form>
          )}
        </section>
      )}

      {(['blockedBy', 'blocking'] as const)
        .filter((direction) => issue[direction].length > 0)
        .map((direction) => (
          <BlockSection
            key={direction}
            issue={issue}
            direction={direction}
            board={board}
            onOpenKey={onOpenKey}
            onAdd={(other) => onAddBlock(issue, other, direction)}
            onRemove={(link) => onRemoveBlock(issue, link)}
          />
        ))}

      {/* What's empty and rarely used takes one row of adds, not a section
          each. A section appears once it has something in it. */}
      {((!issue.isSubtask && (issue.subtasks?.length ?? 0) === 0 && !addingSubtask) ||
        issue.blockedBy.length === 0 ||
        issue.blocking.length === 0) && (
        <div className="backlog-drawer-adds" role="group" aria-label="Add to this ticket">
          {!issue.isSubtask && (issue.subtasks?.length ?? 0) === 0 && !addingSubtask && (
            <Button
              variant="ghost"
              size="compact"
              aria-label="Add sub-task"
              onClick={() => setAddingSubtask(true)}
            >
              <Icon name="Plus" size={12} />
              Sub-task
            </Button>
          )}
          {(['blockedBy', 'blocking'] as const)
            .filter((direction) => issue[direction].length === 0)
            .map((direction) => (
              <BlockSection
                key={direction}
                inline
                issue={issue}
                direction={direction}
                board={board}
                onOpenKey={onOpenKey}
                onAdd={(other) => onAddBlock(issue, other, direction)}
                onRemove={(link) => onRemoveBlock(issue, link)}
              />
            ))}
        </div>
      )}

      {issue.why && (
        <section className="backlog-drawer-section">
          <div className="backlog-drawer-section-head">
            <h3 title="Jira calls this field “Data source”">Why it matters</h3>
          </div>
          <WikiText source={issue.why} />
        </section>
      )}

      <section className="backlog-drawer-section">
        <div className="backlog-drawer-section-head">
          <h3>Description</h3>
          {!editingDescription && detail && (
            <Button variant="ghost" size="compact" onClick={() => setEditingDescription(true)}>
              Edit
            </Button>
          )}
        </div>
        {detailError && <p className="backlog-error">{detailError}</p>}
        {!detail && !detailError && <p className="backlog-note">Loading…</p>}
        {detail &&
          (editingDescription ? (
            <>
              <Textarea
                aria-label="Description"
                className="backlog-drawer-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.metaKey) {
                    e.preventDefault()
                    ;(
                      e.currentTarget
                        .closest('.backlog-drawer-section')
                        ?.querySelector('[data-save]') as HTMLButtonElement | null
                    )?.click()
                  }
                }}
                rows={10}
              />
              <p className="backlog-note">
                Jira formatting: <code>*bold*</code> <code>_italic_</code> <code>h3. Heading</code>{' '}
                <code>* list</code> <code>[text|https://…]</code>
              </p>
              <div className="backlog-drawer-buttons">
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => {
                    setDescription(detail.descriptionWiki)
                    setEditingDescription(false)
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="filled"
                  size="compact"
                  data-save=""
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const ok = await write(() =>
                        updateJiraText(issue.key, { descriptionWiki: description })
                      )
                      if (ok) {
                        setDetail({ ...detail, descriptionWiki: description })
                        setEditingDescription(false)
                      }
                      return ok
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </>
          ) : detail.descriptionWiki.trim() ? (
            <FoldedText>
              <WikiText source={detail.descriptionWiki} people={detail.people} />
            </FoldedText>
          ) : (
            <p className="backlog-note">No description.</p>
          ))}
      </section>

      {detail && detail.attachments.length > 0 && (
        <section className="backlog-drawer-section">
          <div className="backlog-drawer-section-head">
            <h3>
              Attachments <span className="backlog-group-count">{detail.attachments.length}</span>
            </h3>
          </div>
          <div className="backlog-pills">
            {detail.attachments.map((a) => (
              <button
                key={a.name}
                type="button"
                className="backlog-pill backlog-pill--link"
                title="Open in Jira"
                onClick={() => void openExternal(a.url)}
              >
                <Icon name="Paperclip" size={12} />
                {a.name}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="backlog-drawer-section">
        <div className="backlog-drawer-section-head">
          <h3>
            Comments{' '}
            {detail && <span className="backlog-group-count">{detail.comments.length}</span>}
          </h3>
        </div>
        <div className="backlog-comment-box">
          <Textarea
            aria-label="Add a comment"
            className="backlog-drawer-textarea"
            placeholder={
              asNote
                ? 'Add an internal note. Type @ to mention someone'
                : 'Reply to the person who raised this. Type @ to mention someone'
            }
            value={comment}
            onChange={(e) => {
              setComment(e.target.value)
              // An @ at the start or after a space, then the name so far.
              const upTo = e.target.value.slice(0, e.target.selectionStart ?? 0)
              const m = /(^|\s)@([^\s@]{0,30})$/.exec(upTo)
              setMention(m ? { query: m[2], start: upTo.length - m[2].length - 1, index: 0 } : null)
            }}
            onKeyDown={(e) => {
              if (mention && mentionMatches.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : -1
                  const n = mentionMatches.length
                  setMention({ ...mention, index: (mention.index + step + n) % n })
                  return
                }
                if ((e.key === 'Enter' && !e.metaKey) || e.key === 'Tab') {
                  e.preventDefault()
                  pickMention(mentionMatches[mention.index] ?? mentionMatches[0], e.currentTarget)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setMention(null)
                  return
                }
              }
              if (e.key === 'Enter' && e.metaKey) {
                e.preventDefault()
                sendComment()
              }
            }}
            onBlur={() => setMention(null)}
            rows={3}
          />
          {mention && mentionMatches.length > 0 && (
            <div className="backlog-mention-list" role="listbox" aria-label="Mention someone">
              {mentionMatches.map((p, i) => (
                <button
                  key={p.accountId}
                  type="button"
                  role="option"
                  aria-selected={i === mention.index}
                  className={
                    i === mention.index
                      ? 'backlog-mention-option backlog-mention-option--active'
                      : 'backlog-mention-option'
                  }
                  // mousedown, not click: the textarea's blur would close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickMention(
                      p,
                      e.currentTarget.closest('.backlog-comment-box')?.querySelector('textarea') ??
                        null
                    )
                  }}
                >
                  <Avatar name={p.name} size={18} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="backlog-drawer-buttons">
          <SegmentedControl<'note' | 'reply'>
            aria-label="Comment type"
            options={[
              { value: 'note', label: 'Internal note' },
              { value: 'reply', label: 'Reply' }
            ]}
            value={asNote ? 'note' : 'reply'}
            onChange={(v) => setAsNote(v === 'note')}
          />
          <span className="backlog-note">⌘↩ to send</span>
          <Button
            variant="outlined"
            size="compact"
            disabled={busy || !comment.trim() || !detail}
            onClick={sendComment}
          >
            {asNote ? 'Add note' : 'Reply'}
          </Button>
        </div>
        {/* Newest first, like a feed; the box to add one sits above them. */}
        {[...(detail?.comments ?? [])].reverse().map((c) => (
          <div
            key={c.id}
            className={c.internal ? 'backlog-comment backlog-comment--internal' : 'backlog-comment'}
          >
            <div className="backlog-comment-head">
              <span className="backlog-person">
                <Avatar name={c.author} size={18} />
                <strong>{c.author}</strong>
                {c.internal && <span className="backlog-comment-tag">Internal note</span>}
              </span>
              <span title={fullDate(c.created)}>{when(c.created)}</span>
            </div>
            <div className="backlog-drawer-text">
              <WikiText source={c.body} people={detail?.people} />
            </div>
          </div>
        ))}
      </section>
    </aside>
  )
}

// ---------------------------------------------------------------------------

/** For tickets without a Slack thread: paste one, and it goes on the ticket in Jira. */
function AddSlackLink({ onAdd }: { onAdd: (url: string) => Promise<boolean> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  // Loose on purpose: main parses every shape Slack hands out, with or
  // without https://, and says if it can't.
  const valid = /(^|[/.])slack\.com\//i.test(url.trim())
  const submit = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    const ok = await onAdd(url.trim())
    setBusy(false)
    if (ok) {
      setUrl('')
      setOpen(false)
    }
  }
  return (
    <div ref={anchor}>
      <Tooltip label="Add Slack link">
        <button
          type="button"
          className="cr-icon-button cr-icon-button--28 cr-icon-button--ghost backlog-slack-add"
          aria-label="Add Slack link"
          onClick={() => setOpen(true)}
        >
          <SlackGlyph size={15} />
          <Icon name="Plus" size={10} />
        </button>
      </Tooltip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="bottom-end"
        role="dialog"
        className="backlog-menu backlog-save-view"
        aria-label="Add Slack link"
      >
        <input
          autoFocus
          className="backlog-picker-input"
          aria-label="Slack message link"
          placeholder="Paste a Slack message link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <p className="backlog-note">
          {url.trim() && !valid
            ? 'That isn’t a Slack link. In Slack, open the message’s More actions menu and choose Copy link.'
            : 'It’s added in Jira the way the Zapier links are, so it shows there too.'}
        </p>
        <div className="backlog-drawer-buttons">
          <Button
            variant="filled"
            size="compact"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add link'}
          </Button>
        </div>
      </Popover>
    </div>
  )
}

/** One row of the ticket's pull requests, from a linked session or Jira. */
interface TicketPrRow {
  url: string
  number: string
  title: string
  state: string
}

/**
 * The ticket's pull requests: an open (or else merged) one from a linked
 * session's branch, then whatever Jira's development panel knows of.
 */
function useTicketPullRequests(
  issue: JiraIssue,
  entries: SessionEntry[]
): {
  rows: TicketPrRow[]
  own: PullRequestInfo | null
  /** The session whose branch the `own` pull request is from. */
  ownRecordId: string | null
  jiraError: string | null
} {
  const [fromJira, setFromJira] = useState<TicketPullRequest[] | null>(null)
  const [jiraError, setJiraError] = useState<string | null>(null)
  // Keyed by the sessions it came from, so unlinking one drops its PR.
  const [ownFor, setOwnFor] = useState<{
    ids: string
    pr: PullRequestInfo
    recordId: string
  } | null>(null)
  const hasJiraPrs = Boolean(issue.pullRequests)
  useEffect(() => {
    if (!hasJiraPrs) return
    let live = true
    void loadTicketPullRequests(issue.key).then((r) => {
      if (!live) return
      setFromJira(r.ok ? r.value : [])
      setJiraError(r.ok ? null : r.error)
    })
    return () => {
      live = false
    }
  }, [issue.key, hasJiraPrs])
  const idsKey = entries
    .map((e) => e.session.record?.id)
    .filter((id): id is string => Boolean(id))
    .join(',')
  useEffect(() => {
    let live = true
    void (async () => {
      // An open one wins; failing that, the first merged one still belongs here.
      let merged: { pr: PullRequestInfo; recordId: string } | null = null
      for (const id of idsKey ? idsKey.split(',') : []) {
        const found = await getSessionPullRequest(id)
        if (!live) return
        if (found?.state === 'OPEN') {
          setOwnFor({ ids: idsKey, pr: found, recordId: id })
          return
        }
        if (found?.state === 'MERGED') merged ??= { pr: found, recordId: id }
      }
      if (merged) setOwnFor({ ids: idsKey, ...merged })
    })()
    return () => {
      live = false
    }
  }, [idsKey])
  const own = ownFor && ownFor.ids === idsKey ? ownFor.pr : null
  const ownRecordId = own ? ownFor!.recordId : null

  const rows: TicketPrRow[] = []
  if (own) {
    rows.push({
      url: own.url,
      number: `#${own.number}`,
      title: own.title,
      state: own.state === 'MERGED' ? 'merged' : own.isDraft ? 'draft' : 'open'
    })
  }
  for (const pr of fromJira ?? []) {
    if (pr.url === own?.url) continue
    const n = /\/pull\/(\d+)/.exec(pr.url)?.[1]
    rows.push({
      url: pr.url,
      number: n ? `#${n}` : '',
      title: pr.name,
      state: pr.status === 'MERGED' ? 'merged' : pr.status === 'OPEN' ? 'open' : 'closed'
    })
  }
  return { rows, own, ownRecordId, jiraError }
}

/**
 * Pull request rows for the Work tree: `own` is the one from a linked
 * session's branch (it sits under that branch, with what to do next),
 * `others` the ones Jira knows of from anywhere else.
 */
function TicketPullRequests({
  prs,
  show,
  onComment
}: {
  prs: ReturnType<typeof useTicketPullRequests>
  show: 'own' | 'others' | 'all'
  onComment: (body: string) => Promise<boolean>
}): React.JSX.Element | null {
  const { own, jiraError } = prs
  const [commented, setCommented] = useState(false)
  const rows = prs.rows.filter((r) =>
    show === 'all' ? true : show === 'own' ? r.url === own?.url : r.url !== own?.url
  )
  if (!rows.length && !(show !== 'own' && jiraError)) return null

  return (
    <>
      {!rows.length && jiraError && (
        <p className="backlog-note backlog-work-note">
          Couldn’t load pull requests from Jira: {jiraError}
        </p>
      )}
      {rows.map((pr) => (
        <div key={pr.url} className="backlog-work-row backlog-ticket-pr">
          <button
            type="button"
            className="backlog-work-open"
            title={`Open ${pr.number || 'the pull request'} on GitHub`}
            onClick={() => void openExternal(pr.url)}
          >
            <Icon
              name={pr.state === 'merged' ? 'GitMerge' : 'GitPullRequest'}
              size={14}
              className={`backlog-pr--${pr.state}`}
            />
            {pr.number && <span className="backlog-ticket-pr-number">{pr.number}</span>}
            <span className="backlog-work-title">{pr.title}</span>
            <span className={`backlog-state-chip backlog-state-chip--${pr.state}`}>{pr.state}</span>
          </button>
          <span className="backlog-work-tools">
            {own && own.state === 'OPEN' && pr.url === own.url && !commented && (
              <IconButton
                icon="MessageSquarePlus"
                label="Add note with link"
                tooltip="Add an internal note with this PR's link"
                size={28}
                variant="ghost"
                onClick={() =>
                  void onComment(`Pull request: [#${own.number} ${own.title}|${own.url}]`).then(
                    (ok) => ok && setCommented(true)
                  )
                }
              />
            )}
          </span>
        </div>
      ))}
    </>
  )
}

/** Long text folds to about eight lines, with Show all to open it. */
function FoldedText({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setLong(el.scrollHeight > el.clientHeight + 4)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <>
      <div
        ref={ref}
        className={open ? 'backlog-drawer-text' : 'backlog-drawer-text backlog-drawer-text--folded'}
      >
        {children}
      </div>
      {(long || open) && (
        <button
          type="button"
          className="backlog-link backlog-link--quiet backlog-fold-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  )
}

/**
 * A session's branch, as a small icon that copies its name. The tooltip
 * says the name and, before there's a PR, how far it got.
 */
function BranchCopy({
  branch,
  projectId,
  recordId,
  hasPr,
  onCopy
}: {
  branch: string
  projectId: string
  recordId: string
  hasPr: boolean
  onCopy: (branch: string) => void
}): React.JSX.Element {
  const [progress, setProgress] = useState<string | null>(null)
  useEffect(() => {
    if (hasPr) return
    let live = true
    void getGitStatus(projectId, recordId).then((r) => {
      if (!live || !r) return
      setProgress(
        !r.upstream
          ? 'local only'
          : r.ahead > 0
            ? `${r.ahead} commit${r.ahead === 1 ? '' : 's'} not pushed`
            : 'pushed, no PR'
      )
    })
    return () => {
      live = false
    }
  }, [projectId, recordId, hasPr])
  return (
    <IconButton
      icon="GitBranch"
      label={`Copy branch ${branch}`}
      tooltip={`Copy ${branch}${progress ? `, ${progress}` : ''}`}
      size={28}
      variant="ghost"
      onClick={() => onCopy(branch)}
    />
  )
}

/** Where the current cycle stands: done out of total, and the days left. */
function CycleProgress({
  sprint,
  issues,
  compact = false
}: {
  sprint: { name: string; endDate?: string }
  issues: JiraIssue[]
  /** In the sidebar: just the bar and the numbers, under the cycle's name. */
  compact?: boolean
}): React.JSX.Element | null {
  const [now] = useState(() => Date.now())
  const inCycle = issues.filter((i) => i.sprint?.state === 'active')
  if (inCycle.length === 0) return null
  const done = inCycle.filter((i) => i.statusCategory === 'done').length
  const end = sprint.endDate ? Date.parse(sprint.endDate) : NaN
  const days = Number.isFinite(end) ? Math.ceil((end - now) / 86_400_000) : null
  return (
    <div
      className={`backlog-cycle${compact ? ' backlog-cycle--compact' : ''}`}
      aria-label={`Current cycle ${sprint.name}`}
    >
      {!compact && <Icon name="RefreshCw" size={12} />}
      {!compact && <span className="backlog-cycle-name">{sprint.name}</span>}
      <ProgressBar
        value={done / inCycle.length}
        tone={days !== null && days <= 2 ? 'var(--status-attention)' : 'var(--status-done)'}
        height={4}
        className="backlog-cycle-bar"
      />
      <span>
        {done} of {inCycle.length} done
      </span>
      {days !== null && (
        <span
          className={
            days !== null && days <= 2
              ? 'backlog-cycle-days backlog-cycle-days--soon'
              : 'backlog-cycle-days'
          }
        >
          {days > 1
            ? `${days} days left`
            : days === 1
              ? '1 day left'
              : days === 0
                ? 'Ends today'
                : 'Ended'}
        </span>
      )}
    </div>
  )
}

/** Saved views as tabs beside Everyone / Mine / Unassigned; ⌥1–9 to jump. */
function SavedViews({
  views,
  activeId,
  changed,
  onApply,
  onSave,
  onUpdate,
  onDelete
}: {
  views: SavedView[]
  activeId: string | null
  /** The view you're in has been changed since it was opened. */
  changed: boolean
  onApply: (v: SavedView) => void
  onSave: (name: string) => void
  /** Save the changes over the view you're in. */
  onUpdate: () => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const anchor = useRef<HTMLDivElement>(null)
  return (
    <>
      {views.length > 0 && <span className="backlog-filter-divider" aria-hidden="true" />}
      {views.map((v, i) => (
        <span
          key={v.id}
          className={`backlog-view-tab${v.id === activeId ? ' backlog-view-tab--selected' : ''}`}
        >
          <button
            type="button"
            className="backlog-filter"
            title={i < 9 ? `${v.name} (⌥${i + 1})` : v.name}
            aria-pressed={v.id === activeId}
            onClick={() => onApply(v)}
          >
            {v.name}
            {v.id === activeId && changed && (
              <span
                className="backlog-view-tab-changed"
                aria-label="changed"
                title="Changed since you opened it"
              />
            )}
          </button>
          {v.id === activeId && changed && (
            <>
              <button
                type="button"
                className="backlog-link backlog-link--quiet backlog-view-tab-action"
                onClick={onUpdate}
              >
                Save
              </button>
              <button
                type="button"
                className="backlog-link backlog-link--quiet backlog-view-tab-action"
                title="Back to the view as saved"
                onClick={() => onApply(v)}
              >
                Reset
              </button>
            </>
          )}
          <button
            type="button"
            className="backlog-view-tab-remove"
            aria-label={`Delete view ${v.name}`}
            title="Delete view"
            onClick={() => onDelete(v.id)}
          >
            <Icon name="X" size={12} />
          </button>
        </span>
      ))}
      {!activeId && (
        <div ref={anchor}>
          <button
            type="button"
            className="backlog-filter backlog-filter--add"
            title="Save these filters as a view"
            onClick={() => setNaming(true)}
          >
            <Icon name="Plus" size={12} /> Save view
          </button>
          <Popover
            open={naming}
            onClose={() => setNaming(false)}
            anchorRef={anchor}
            placement="bottom-start"
            role="dialog"
            className="backlog-menu backlog-save-view"
            aria-label="Save view"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!name.trim()) return
                onSave(name.trim())
                setName('')
                setNaming(false)
              }}
            >
              <input
                autoFocus
                className="backlog-picker-input"
                aria-label="View name"
                placeholder="Name this view"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.currentTarget.form?.requestSubmit()
                  }
                }}
              />
              <p className="backlog-note">Keeps who, cycle, grouping, list or board, and search.</p>
            </form>
          </Popover>
        </div>
      )}
    </>
  )
}

/** Shown while tickets are picked: change them all at once. */
function BulkBar({
  issues,
  hasCycle,
  onStatus,
  onPriority,
  onEpic,
  onAssign,
  onCycle,
  onPickCycle,
  onClear
}: {
  issues: JiraIssue[]
  hasCycle: boolean
  onStatus: (anchor: HTMLElement) => void
  onPriority: (anchor: HTMLElement) => void
  onEpic: (anchor: HTMLElement) => void
  onAssign: () => void
  onCycle: () => void
  /** With upcoming cycles too: choose one, rather than toggling current ⇄ backlog. */
  onPickCycle?: (anchor: HTMLElement) => void
  onClear: () => void
}): React.JSX.Element {
  const allMine = issues.every((i) => i.assignedToMe)
  const allCurrent = issues.every((i) => i.sprint?.state === 'active')
  return (
    <SelectionBar
      count={issues.length}
      label="Selected tickets"
      className="backlog-bulk"
      onClear={onClear}
    >
      <SelectionAction shortcut="S" onClick={onStatus}>
        Status
      </SelectionAction>
      <SelectionAction shortcut="P" onClick={onPriority}>
        Priority
      </SelectionAction>
      <SelectionAction shortcut="E" onClick={onEpic}>
        Epic
      </SelectionAction>
      <SelectionAction shortcut="A" onClick={onAssign}>
        {allMine ? 'Unassign me' : 'Assign to me'}
      </SelectionAction>
      {hasCycle && (
        <SelectionAction shortcut="M" onClick={onCycle}>
          {allCurrent ? 'Move to backlog' : 'Move to current cycle'}
        </SelectionAction>
      )}
      {onPickCycle && <SelectionAction onClick={onPickCycle}>Cycle</SelectionAction>}
    </SelectionBar>
  )
}

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

/**
 * "Blocked by" or "Blocking": the tickets on one side of this one's Blocks
 * links. Add picks a ticket off the board or takes a typed key (the other
 * ticket can be in any project); a row's X removes the link in Jira.
 */
function BlockSection({
  issue,
  direction,
  board,
  inline = false,
  onOpenKey,
  onAdd,
  onRemove
}: {
  /** Nothing linked yet: just the add button, for the panel's row of adds. */
  inline?: boolean
  issue: JiraIssue
  direction: BlockDirection
  board: JiraBoardData
  onOpenKey: (key: string) => void
  onAdd: (other: string) => Promise<boolean>
  onRemove: (link: JiraBlockLink) => Promise<boolean>
}): React.JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const links = issue[direction]
  const title = direction === 'blockedBy' ? 'Blocked by' : 'Blocking'
  const linked = new Set(links.map((l) => l.key))
  const options: PickerOption[] = board.issues
    .filter((i) => i.key !== issue.key && !i.isEpic && !linked.has(i.key))
    .map((i) => ({
      value: i.key,
      label: `${i.key} ${i.summary}`,
      icon: <StatusGlyph name={i.status} category={i.statusCategory} size={12} />
    }))
  const picker = anchor && (
    <Picker
      anchor={anchor}
      title={direction === 'blockedBy' ? 'Blocked by which ticket' : 'Blocking which ticket'}
      options={options}
      emptyText="No tickets match. Type a key, like DSD-123"
      custom={(text) =>
        ISSUE_KEY.test(text) && !linked.has(text.toUpperCase())
          ? `Link ${text.toUpperCase()}`
          : null
      }
      onPick={(value) => void onAdd(value)}
      onClose={() => setAnchor(null)}
    />
  )
  if (inline) {
    return (
      <>
        <Button
          variant="ghost"
          size="compact"
          aria-label={`Add ${title.toLowerCase()}`}
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          <Icon name="Plus" size={12} />
          {title}
        </Button>
        {picker}
      </>
    )
  }
  return (
    <section className="backlog-drawer-section" data-blocks={direction}>
      <div className="backlog-drawer-section-head">
        <h3>
          {title} {links.length > 0 && <span className="backlog-group-count">{links.length}</span>}
        </h3>
        <Button
          variant="ghost"
          size="compact"
          aria-label={`Add ${title.toLowerCase()}`}
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          Add
        </Button>
      </div>
      {links.map((link) => {
        const onBoard = board.issues.some((i) => i.key === link.key)
        return (
          <div key={link.linkId} className="backlog-drawer-block" data-block={link.key}>
            <button
              type="button"
              className="backlog-drawer-subtask"
              title={onBoard ? undefined : 'Not on this board: opens in Jira'}
              onClick={() =>
                onBoard
                  ? onOpenKey(link.key)
                  : void openExternal(issue.url.replace(/[^/]+$/, link.key))
              }
            >
              <StatusGlyph name={link.status} category={link.statusCategory} size={12} />
              <span className="backlog-row-key">{link.key}</span>
              <span className="backlog-drawer-subtask-summary">{link.summary}</span>
            </button>
            <IconButton
              icon="X"
              label={`Remove ${link.key} from ${title.toLowerCase()}`}
              tooltip="Remove link"
              size={28}
              className="backlog-drawer-block-remove"
              onClick={() => void onRemove(link)}
            />
          </div>
        )
      })}
      {picker}
    </section>
  )
}

/** The estimate: click to edit in Jira's shorthand; empty clears it. */
function EstimateField({
  issue,
  onSave
}: {
  issue: JiraIssue
  onSave: (value: string | null) => Promise<boolean>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(issue.estimate ?? '')
  if (!editing) {
    return (
      <button
        type="button"
        className="backlog-pill backlog-pill--link"
        aria-label={issue.estimate ? `Estimate ${issue.estimate}, edit` : 'Add an estimate'}
        onClick={() => {
          setValue(issue.estimate ?? '')
          setEditing(true)
        }}
      >
        {issue.estimate ?? <span className="backlog-note">Add estimate</span>}
      </button>
    )
  }
  const save = (): void => {
    // Enter saves, then the field unmounts and blurs; save once.
    if (!editing) return
    setEditing(false)
    const next = value.trim() || null
    if (next !== issue.estimate) void onSave(next)
  }
  return (
    <input
      autoFocus
      className="backlog-inline-input"
      aria-label="Estimate"
      placeholder="4h, 1d, 1d 4h"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        // Save here rather than by blurring: a blur isn't delivered while the
        // window is in the background.
        if (e.key === 'Enter') {
          e.preventDefault()
          save()
        }
        if (e.key === 'Escape') {
          e.stopPropagation()
          setEditing(false)
        }
      }}
    />
  )
}

/** Labels as pills: × removes one, typing adds (with the site's labels suggested). */
function LabelsField({
  issue,
  suggestions,
  onSave
}: {
  issue: JiraIssue
  suggestions: string[]
  onSave: (labels: string[]) => Promise<boolean>
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const next = draft.trim().replace(/\s+/g, '-')
    setDraft('')
    if (next && !issue.labels.includes(next)) void onSave([...issue.labels, next])
  }
  return (
    <div className="backlog-pills">
      {issue.labels.map((l) => (
        <span key={l} className="backlog-pill backlog-pill--removable">
          {l}
          <button
            type="button"
            aria-label={`Remove label ${l}`}
            onClick={() => void onSave(issue.labels.filter((x) => x !== l))}
          >
            <Icon name="X" size={10} />
          </button>
        </span>
      ))}
      <input
        className="backlog-inline-input backlog-inline-input--label"
        aria-label="Add a label"
        placeholder="Add label"
        list="backlog-label-suggestions"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={() => draft.trim() && add()}
      />
      <datalist id="backlog-label-suggestions">
        {suggestions
          .filter((l) => !issue.labels.includes(l))
          .map((l) => (
            <option key={l} value={l} />
          ))}
      </datalist>
    </div>
  )
}

// ---------------------------------------------------------------------------

function JiraSetup({
  encryptionUnavailable,
  onConnected
}: {
  encryptionUnavailable: boolean
  onConnected: (status: JiraStatus) => void
}): React.JSX.Element {
  const [site, setSite] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [projects, setProjects] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await configureJira({ site, email, token, projects: projects.split(/[\s,]+/) })
    setBusy(false)
    if (result.ok) onConnected(result.value)
    else setError(result.error)
  }

  return (
    <form
      className="backlog-setup"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="backlog-setup-icon">
        <Icon name="ListTodo" size={20} />
      </div>
      <h1 className="backlog-title">Connect Jira</h1>
      <p className="backlog-caption">
        See every ticket in your projects, edit them, move them across the board, and start a
        session from any of them.
      </p>
      <label className="backlog-field">
        <span>Jira site</span>
        <Input
          placeholder="yourcompany.atlassian.net"
          value={site}
          onChange={(e) => setSite(e.target.value)}
        />
      </label>
      <label className="backlog-field">
        <span>Your Jira email</span>
        <Input
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="backlog-field">
        <span>Projects</span>
        <Input
          placeholder="DSD, TEAMDATA"
          value={projects}
          onChange={(e) => setProjects(e.target.value)}
        />
      </label>
      <label className="backlog-field">
        <span>
          API token ·{' '}
          <button
            type="button"
            className="backlog-link"
            onClick={() =>
              void openExternal('https://id.atlassian.com/manage-profile/security/api-tokens')
            }
          >
            create one
          </button>
        </span>
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <p className="backlog-note">
        The token is encrypted with your Mac&rsquo;s Keychain and only ever sent to your Jira site.
        Changes you make here are made in Jira as you.
      </p>
      {encryptionUnavailable && (
        <p className="backlog-error">
          This Mac isn&rsquo;t letting Control Room encrypt anything right now, so the token
          can&rsquo;t be saved.
        </p>
      )}
      {error && <p className="backlog-error">{error}</p>}
      <div>
        <Button variant="filled" type="submit" disabled={busy || encryptionUnavailable}>
          {busy ? 'Checking with Jira…' : 'Connect'}
        </Button>
      </div>
    </form>
  )
}
