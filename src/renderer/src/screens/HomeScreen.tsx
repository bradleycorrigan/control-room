import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  attentionRank,
  wantsYou,
  type LiveSession,
  type Project,
  type SessionRecord
} from '../../../main/store/types'
import {
  Button,
  Icon,
  Input,
  IconButton,
  IconTile,
  Pill,
  Popover,
  SegmentedControl,
  Textarea
} from '../components/primitives'
import {
  createSession,
  getAppSettings,
  listCheckoutBranches,
  type CheckoutBranch,
  resolveBranch,
  getDefaultBranch,
  getJiraStatus,
  getSessionTicketLinks,
  loadJiraBoard,
  type JiraBoardData
} from '../api'
import { useProjects } from '../state/useProjects'
import SessionCard from '../components/SessionCard'
import { useAttachments } from '../components/useAttachments'
import AttachmentChips from '../components/AttachmentChips'
import { useSessionActions } from '../components/useSessionActions'
import { useWorktreeChoice } from '../state/useWorktreeChoice'
import { useStoredState } from '../state/useStoredState'
import { useDevContainer } from '../state/useDevContainer'
import { Picker } from './backlog/Picker'
import './home.css'
import HomeTickets from './HomeTickets'
import { type ComposerSeed } from './backlog/ticketSessions'

type Model = 'opus' | 'sonnet' | 'haiku'
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// localStorage keys for toggle persistence
// v2: the v1 key defaulted to worktree mode ON, which silently made every
// "Start" on this screen do a real git fetch/worktree add before launching
// the agent — a bad regression from the old always-instant investigate-mode
// behaviour. Renamed so anyone who already had v1's "true" persisted gets
// the corrected (off) default instead of carrying the bad value forward.
const STORAGE_PLAN_MODE = 'homescreen-plan-mode'

const MODEL_LABEL: Record<Model, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku'
}

const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-high',
  max: 'Max'
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * When the cycle ends, as you'd say it: today, tomorrow, the weekday within
 * the next six days, else the date. Null once it has passed or when the date
 * won't parse.
 */
function cycleEndWords(endDate: string, now = new Date()): string | null {
  const end = new Date(endDate)
  if (Number.isNaN(end.getTime())) return null
  const midnight = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(end) - midnight(now)) / 86_400_000)
  if (days < 0) return null
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days <= 6) return WEEKDAYS[end.getDay()]
  return end.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
}

export interface HomeScreenProps {
  // Optional — the app shell wires these to navigation once a session
  // exists. Home works without them (the new session still lands under its
  // project everywhere else); they only control what happens right after
  // "Send" is pressed.
  onSessionCreated?: (record: SessionRecord) => void
  onViewAllProjects?: () => void
  /**
   * 'page' is the landing screen. 'sheet' is the same composer inside a modal,
   * opened by the top bar's + and by every "New session" button — one creation
   * surface, not two. In a sheet the "View all projects" link is dropped: you
   * are already somewhere, and it would navigate out from under the modal.
   */
  variant?: 'page' | 'sheet'
  /** Preselects the project when a specific project's button opened the sheet. */
  initialProjectId?: string | null
  /** Pre-filled from a Jira issue (Backlog → Start session): the prompt, a
   * branch name for worktree mode, and the session's starting title. */
  initialPrompt?: string
  initialBranch?: string
  initialTitle?: string
  /**
   * Preselects "On a branch" mode with this branch as the run branch, for
   * this sheet only — it does not touch the persisted worktree-choice
   * preference. Used by the command palette's branch presets, alongside
   * `initialProjectId`.
   */
  initialRunBranch?: string
  /**
   * Fixes the composer to `initialProjectId`: the chip cannot be cleared and
   * the picker is gone. Used on a project's own page, where "which project"
   * is already answered by the page you are on.
   */
  lockProject?: boolean
  /**
   * Shown under the composer on the landing page. Home was a composer and a
   * screenful of nothing, which made it a worse place to land than Sessions —
   * so the one thing you always want on arrival goes here.
   */
  sessions?: LiveSession[]
  onOpenSession?: (liveKey: string, background?: boolean) => void
  onViewAllSessions?: () => void
  /** Called after a recent card's action changes a record, so the list reloads. */
  onSessionsChanged?: () => void
  /** "Your tickets": start a session for one, or look at it first. */
  onStartTicketSession?: (seed: ComposerSeed) => void
  onOpenTicket?: (key: string) => void
  /** Opens the Tickets screen, for the summary's review and cycle clauses. */
  onViewTickets?: () => void
  pushToast?: (message: string) => void
}

/**
 * HomeScreen — the landing composer (plan 7, stage B1).
 *
 * Centred "what should the agent do" card. Submitting always creates an
 * investigate-mode session (no worktree, no branch — runs straight in the
 * chosen project's own checkout, or in General's repoPath when nothing is
 * chosen) via the same `sessions:create` path the New Session form uses.
 */
export default function HomeScreen({
  onSessionCreated,
  onViewAllProjects,
  variant = 'page',
  initialProjectId = null,
  initialPrompt = '',
  initialBranch = '',
  initialTitle,
  initialRunBranch,
  lockProject = false,
  sessions = [],
  onOpenSession,
  onViewAllSessions,
  onSessionsChanged,
  pushToast,
  onStartTicketSession,
  onOpenTicket,
  onViewTickets
}: HomeScreenProps): React.JSX.Element {
  const { projects } = useProjects()
  const [prompt, setPrompt] = useState(initialPrompt)
  const [pickedProject, setPickedProject] = useState<Project | null>(
    () => projects.find((p) => p.id === initialProjectId) ?? null
  )
  // Derived, not synced. A locked composer's project is whatever the page it
  // sits on says it is, so holding a copy in state only created the problem of
  // keeping it in step — and `projects` arrives after the first render, so
  // there is always a moment where the copy is wrong.
  const lockedProject = lockProject
    ? (projects.find((p) => p.id === initialProjectId) ?? null)
    : null
  // `projects` arrives after the first render, so a sheet opened with a
  // project already chosen (⌘K → a branch, Backlog → Start session) finds
  // nothing in the initializer above. Adopt it once the list is in — during
  // render, not in an effect, and only once, so clearing the chip sticks.
  const [adoptedInitialProject, setAdoptedInitialProject] = useState(
    () => !initialProjectId || pickedProject !== null
  )
  if (!adoptedInitialProject && projects.length > 0) {
    setAdoptedInitialProject(true)
    const initial = projects.find((p) => p.id === initialProjectId)
    if (initial) setPickedProject(initial)
  }
  const selectedProject = lockProject ? lockedProject : pickedProject
  // Dev container toggle: offered only where it can work. Its starting state
  // comes from the Settings default.
  const devContainer = useDevContainer(selectedProject?.id ?? 'general')
  const containerByDefault = devContainer.available && devContainer.byDefault
  // The composer's dev container toggle starts where the Settings default says.
  // A press holds only for this project and default: change either and it
  // goes back to the default, with no effect needed to reset it.
  const [containerPress, setContainerPress] = useState<{ key: string; on: boolean } | null>(null)
  const containerKey = `${selectedProject?.id ?? 'general'}:${containerByDefault}`
  const inContainer = containerPress?.key === containerKey ? containerPress.on : containerByDefault

  // Seeded from the app's default below, not hardcoded. The picker still
  // overrides it for this one session; changing what every new session starts
  // with is Settings' job.
  const [model, setModel] = useState<Model>('opus')
  const touchedModel = useRef(false)
  const [background, setBackground] = useState(false)

  const [effort, setEffort] = useState<Effort>('medium')

  // Shared with the project screen's composer — see WorktreeChoice for why
  // it is off by default and why both places now answer the same question.
  const [worktreeMode, setWorktreeMode] = useWorktreeChoice()
  // A branch preset (from the command palette) forces "On a branch" display
  // for this sheet only, without writing the persisted worktree-choice
  // preference — clears the moment the person touches the switch themselves.
  const [checkoutOverride, setCheckoutOverride] = useState(
    () => !!(initialProjectId && initialRunBranch)
  )
  const effectiveWorktreeMode = checkoutOverride ? false : worktreeMode
  const [branch, setBranch] = useState(initialBranch)
  // Existing branches to start on (open PRs first), fetched when the picker
  // first opens for a project.
  const [checkoutBranches, setCheckoutBranches] = useState<{
    projectId: string
    list: CheckoutBranch[] | null
  } | null>(null)
  const [branchPickerAt, setBranchPickerAt] = useState<HTMLElement | null>(null)
  // "On a branch": the branch to run on (null = the repo's default), and what
  // GitHub said about a picked or pasted one.
  const [runBranch, setRunBranch] = useState<{ projectId: string; name: string } | null>(() =>
    initialProjectId && initialRunBranch
      ? { projectId: initialProjectId, name: initialRunBranch }
      : null
  )
  const [defaultBranch, setDefaultBranch] = useState<{ projectId: string; name: string } | null>(
    null
  )
  const [branchCheck, setBranchCheck] = useState<{
    name: string
    state: 'checking' | 'ok' | 'invalid'
    error?: string
  } | null>(() =>
    initialProjectId && initialRunBranch ? { name: initialRunBranch, state: 'checking' } : null
  )

  // Initialize planMode from localStorage
  const [planMode, setPlanMode] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PLAN_MODE)
      return saved !== null ? JSON.parse(saved) : false
    } catch {
      return false
    }
  })

  // Pick up the configured defaults once, and only while the picker is
  // untouched — a choice made for this session outranks a setting.
  useEffect(() => {
    let cancelled = false
    void getAppSettings().then((settings) => {
      if (cancelled || touchedModel.current) return
      setModel(settings.defaultModel)
      setEffort(settings.defaultEffort)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  // Two-level drill-down (plan-app style): pick a model, then its thinking
  // level, one screen at a time — both lists together were tall enough to
  // clip off the top of the upward-opening popover.
  const [modelMenuStep, setModelMenuStep] = useState<'model' | 'effort'>('model')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  // Both menus are portalled, so Popover positions them from these anchors
  // rather than from a `position: relative` parent.
  const modelMenuAnchor = useRef<HTMLDivElement>(null)
  const projectMenuAnchor = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const attach = useAttachments(setError)
  const attachments = attach.chips

  // Persist planMode to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_PLAN_MODE, JSON.stringify(planMode))
  }, [planMode])

  // Auto-grow from 3 rows up to about half the window, measured off the
  // textarea's own scrollHeight (not by counting newlines, so long wrapped
  // lines grow it too); past that it scrolls. Drag its corner to make it
  // taller still, and it keeps that height while you type. The Textarea
  // primitive doesn't forward a ref, so the card's ref finds it.
  const composerCardRef = useRef<HTMLDivElement>(null)
  // Height you dragged it to, or null to size to the text.
  const draggedHeight = useRef<number | null>(null)
  const grownHeight = useRef<number | null>(null)
  const autoGrow = (el: HTMLTextAreaElement): void => {
    const lineHeight = 20 // --text-body-line
    const min = lineHeight * 3 + 4
    const max = Math.max(lineHeight * 12 + 4, Math.round(window.innerHeight * 0.5))
    el.style.height = 'auto'
    const fit = Math.min(Math.max(el.scrollHeight, min), max)
    const height = Math.max(fit, draggedHeight.current ?? 0)
    el.style.height = `${height}px`
    grownHeight.current = height
  }
  // A prompt that arrives filled in (from a ticket) is sized from the start,
  // not after the first keystroke. Before, it sat at three rows, then
  // jumped to fit the moment you typed.
  useLayoutEffect(() => {
    const el = composerCardRef.current?.querySelector('textarea')
    if (el && initialPrompt) autoGrow(el)
    // Once, on open: typing resizes it from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const otherProjects = projects.filter((p) => p.id !== selectedProject?.id)

  // Needs-you first, then ready, then everything else by recency. Stopped and
  // missing sessions are left out: this is a place to resume from, and a dead
  // row is not something to resume. So are the ones you have marked done —
  // that is the whole point of marking one, and Home is the surface it has to
  // clear off.
  //
  // Sessions in another terminal show like any other: discovery only keeps
  // ones working in your projects, so they're yours.
  const [homeFilter, setHomeFilter] = useStoredState<'all' | 'unread' | 'your-turn'>(
    'home-recent-filter',
    'all'
  )
  const resumable = sessions.filter(
    (s) => s.status !== 'stopped' && s.status !== 'missing' && !s.record?.archivedAt
  )
  const recent = resumable
    .filter((s) =>
      homeFilter === 'unread'
        ? s.unread
        : homeFilter === 'your-turn'
          ? wantsYou(s.status) || s.status === 'idle'
          : true
    )
    // Never `updatedAt` — it is stamped with now on every poll, so it sorted nothing.
    // Pinned sorts first, ahead of attention rank — pinning is a promise this
    // stays at the top, not just a tiebreak inside whatever rank it's already in.
    .sort(
      (a, b) =>
        Number(Boolean(b.record?.pinned)) - Number(Boolean(a.record?.pinned)) ||
        attentionRank(a.status) - attentionRank(b.status) ||
        recency(b) - recency(a)
    )
    .slice(0, 6)
  function recency(s: LiveSession): number {
    // Working is as recent as it gets.
    if (s.status === 'working') return Number.MAX_SAFE_INTEGER
    return s.activityAt ?? s.record?.createdAt ?? 0
  }
  const toggleFilter = (next: 'unread' | 'your-turn'): void =>
    setHomeFilter(homeFilter === next ? 'all' : next)

  // The Jira board, for "Your tickets", the summary line and the composer's
  // suggestions. Nothing loads until Jira is connected, and only on the page.
  const [board, setBoard] = useState<JiraBoardData | null>(null)
  const [ticketLinks, setTicketLinks] = useState<Record<string, string>>({})
  useEffect(() => {
    if (variant !== 'page') return
    let cancelled = false
    void getJiraStatus().then(async (status) => {
      if (cancelled || !status.configured) return
      const [loaded, linked] = await Promise.all([loadJiraBoard(), getSessionTicketLinks()])
      if (cancelled) return
      setTicketLinks(linked)
      if (loaded.ok) setBoard(loaded.value)
    })
    // A fresher board loaded behind the one shown: take it.
    const off = window.api.on('jira:boardRefreshed', () => {
      void loadJiraBoard().then((r) => {
        if (!cancelled && r.ok) setBoard(r.value)
      })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [variant])
  const showsTickets = variant === 'page' && Boolean(onStartTicketSession && onOpenTicket)

  // The day in one line: what's waiting on you, and when the
  // cycle ends. A clause with nothing to say is left out.
  const needYou = resumable.filter((s) => wantsYou(s.status)).length
  const activeSprint = board?.sprints.find((s) => s.state === 'active')
  const cycleEnds = activeSprint?.endDate ? cycleEndWords(activeSprint.endDate) : null
  const showTickets = (): void => {
    if (onViewTickets) onViewTickets()
    else
      document
        .querySelector('.home-tickets')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const showYourTurn = (): void => {
    setHomeFilter('your-turn')
    document
      .querySelector('.home-recent:not(.home-tickets)')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const summary: { key: string; text: string; onClick?: () => void }[] = []
  if (needYou > 0) {
    summary.push({
      key: 'sessions',
      text: `${needYou} ${needYou === 1 ? 'session needs' : 'sessions need'} you.`,
      onClick: showYourTurn
    })
  }
  if (cycleEnds) {
    summary.push({
      key: 'cycle',
      text: `Cycle ends ${cycleEnds}.`,
      onClick: onViewTickets || showsTickets ? showTickets : undefined
    })
  }

  const [sessionActionNode, sessionActions] = useSessionActions({
    pushToast,
    onChanged: () => onSessionsChanged?.()
  })

  const hasPendingAttachments = attach.pending

  // The branch "On a branch" runs on: what you picked for this project, else
  // its default on GitHub.
  const projectId = selectedProject?.id ?? null
  const runOn =
    (runBranch?.projectId === projectId ? runBranch?.name : null) ??
    (defaultBranch?.projectId === projectId ? defaultBranch?.name : null) ??
    null
  useEffect(() => {
    if (!projectId || projectId === 'general') return
    let live = true
    void getDefaultBranch(projectId).then((name) => {
      if (live) setDefaultBranch({ projectId, name })
    })
    return () => {
      live = false
    }
  }, [projectId])
  const pickBranch = (id: string, name: string): void => {
    setRunBranch({ projectId: id, name })
    setBranchCheck({ name, state: 'checking' })
    void resolveBranch(id, name).then((r) => {
      if (r.ok) {
        setRunBranch({ projectId: id, name: r.branch })
        setBranchCheck({ name: r.branch, state: 'ok' })
      } else {
        setBranchCheck({ name, state: 'invalid', error: r.error })
      }
    })
  }
  // Branch preset from the command palette: the initial state above already
  // shows it as picked and "checking" so there's no flash of the default —
  // this just runs the same GitHub check a manual pick does, once, and
  // updates to 'ok' or 'invalid' when it resolves.
  useEffect(() => {
    if (!initialProjectId || !initialRunBranch) return
    void resolveBranch(initialProjectId, initialRunBranch).then((r) => {
      if (r.ok) {
        setRunBranch({ projectId: initialProjectId, name: r.branch })
        setBranchCheck({ name: r.branch, state: 'ok' })
      } else {
        setBranchCheck({ name: initialRunBranch, state: 'invalid', error: r.error })
      }
    })
    // Runs once, for this sheet's initial mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = useCallback(async () => {
    const text = prompt.trim()
    if ((!text && attachments.length === 0) || busy || hasPendingAttachments) return

    setBusy(true)
    setError(null)
    setNotice(null)
    const creationId = crypto.randomUUID()

    try {
      const attachmentPaths = attach.readyPaths()

      // With no project there is no repo, so there is no worktree to make —
      // whatever the switch last remembered. The switch is not even on screen
      // in that state, but its value persists, so a worktree session was being
      // requested in ~/ and the run died on "fatal: not a git repository".
      const makesWorktree = !!selectedProject && effectiveWorktreeMode
      const onBranch = !!selectedProject && !effectiveWorktreeMode
      if (onBranch && branchCheck && branchCheck.state !== 'ok') {
        setError(
          branchCheck.state === 'checking'
            ? 'Still checking that branch with GitHub.'
            : (branchCheck.error ?? 'That branch isn’t on GitHub.')
        )
        return
      }

      const result = await createSession({
        creationId,
        projectId: selectedProject?.id ?? 'general',
        // On a branch: the engine runs it in the project's own checkout when
        // that's the branch there, and in a worktree of that branch otherwise.
        // New worktree: always a fresh branch.
        investigate: !selectedProject || (onBranch && !runOn),
        branch: makesWorktree
          ? branch.trim() || undefined
          : onBranch
            ? (runOn ?? undefined)
            : undefined,
        basedOn: makesWorktree ? 'new' : onBranch && runOn ? 'existing' : undefined,
        prompt: text,
        title: initialTitle,
        model,
        planMode,
        effort,
        attachmentPaths,
        devContainer: devContainer.available && inContainer
      })

      if (!result.ok || !result.record) {
        setError(result.error ?? 'Failed to start the session.')
        return
      }

      setPrompt('')
      setBranch('')
      attach.clear()
      if (background) {
        setNotice(`Started in ${selectedProject?.name ?? 'General'}.`)
      } else {
        onSessionCreated?.(result.record)
      }
    } catch {
      setError('Failed to start the session.')
    } finally {
      setBusy(false)
    }
  }, [
    prompt,
    initialTitle,
    busy,
    attach,
    attachments,
    hasPendingAttachments,
    selectedProject,
    model,
    background,
    onSessionCreated,
    effectiveWorktreeMode,
    runOn,
    branchCheck,
    // Missing, and it is the whole point of the branch box: the callback is
    // rebuilt on every prompt keystroke, so filling the prompt and then the
    // branch name captured the branch as it was before you typed it — empty.
    // The engine then auto-named the branch and your name was thrown away.
    branch,
    planMode,
    effort,
    devContainer.available,
    inContainer
  ])

  // ⌘⏎ starts the session from anywhere in the composer, not only from the
  // prompt box. It used to be bound to the textarea alone, so the moment you
  // touched the branch field, the run-location switch or the project chip —
  // which is a normal thing to do on the way to starting — the shortcut
  // silently stopped working and you had to reach for the button.
  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Escape clears the prompt, and only from the prompt box: elsewhere in the
    // composer Escape belongs to whatever is open over it.
    if (e.key === 'Escape') {
      setPrompt('')
    }
  }

  const ctaLabel = selectedProject
    ? effectiveWorktreeMode
      ? 'Start in a new worktree'
      : `Start on ${runOn ?? 'default branch'}`
    : 'Start in General'

  return (
    <div className={`home-screen home-screen--${variant}`}>
      <div className="home-composer" onKeyDown={handleComposerKeyDown}>
        {variant === 'page' && summary.length > 0 && (
          <p className="home-summary" data-home-summary>
            {summary.map((clause) =>
              clause.onClick ? (
                <button
                  key={clause.key}
                  type="button"
                  className="home-summary-clause"
                  data-summary={clause.key}
                  onClick={clause.onClick}
                >
                  {clause.text}
                </button>
              ) : (
                <span key={clause.key} className="home-summary-clause" data-summary={clause.key}>
                  {clause.text}
                </span>
              )
            )}
          </p>
        )}
        <div
          ref={composerCardRef}
          className={`home-composer-card${attach.dragOver ? ' home-composer-card--drag-over' : ''}`}
          {...attach.dropProps}
        >
          <Textarea
            className="home-composer-input"
            placeholder="What should the agent do?"
            rows={3}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value)
              autoGrow(e.target)
            }}
            onKeyDown={handleKeyDown}
            onPaste={attach.onPaste}
            onMouseUp={(e) => {
              // A height we didn't set came from dragging the corner: keep it.
              const h = e.currentTarget.offsetHeight
              if (grownHeight.current !== null && Math.abs(h - grownHeight.current) > 2) {
                draggedHeight.current = h
                grownHeight.current = h
              }
            }}
            autoFocus
          />

          <AttachmentChips attachments={attach} />

          <div className="home-composer-footer">
            <div className="home-composer-toggles">
              <IconButton
                icon="Paperclip"
                label="Attach files"
                title="Attach files"
                variant="ghost"
                size={28}
                onClick={() => void attach.pick()}
              />

              <div className="home-composer-menu" ref={modelMenuAnchor}>
                <IconButton
                  icon="Cpu"
                  label={`Model: ${MODEL_LABEL[model]} · Thinking: ${EFFORT_LABEL[effort]}`}
                  title={`Model: ${MODEL_LABEL[model]} · Thinking: ${EFFORT_LABEL[effort]}`}
                  variant={modelMenuOpen ? 'filled' : 'ghost'}
                  size={28}
                  onClick={() => {
                    setModelMenuOpen((v) => !v)
                    setModelMenuStep('model')
                    setProjectMenuOpen(false)
                  }}
                />
                <Popover
                  open={modelMenuOpen && modelMenuStep === 'model'}
                  onClose={() => setModelMenuOpen(false)}
                  anchorRef={modelMenuAnchor}
                  placement="top-start"
                  gap={8}
                  className="home-composer-popover"
                  aria-label="Model"
                >
                  <div className="home-composer-popover-heading">Model</div>
                  {(Object.keys(MODEL_LABEL) as Model[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`home-composer-popover-item${m === model ? ' home-composer-popover-item--active' : ''}`}
                      onClick={() => {
                        touchedModel.current = true
                        setModel(m)
                        setModelMenuStep('effort')
                      }}
                    >
                      {MODEL_LABEL[m]}
                      <Icon name="ChevronRight" size={14} />
                    </button>
                  ))}
                </Popover>
                <Popover
                  open={modelMenuOpen && modelMenuStep === 'effort'}
                  onClose={() => setModelMenuOpen(false)}
                  anchorRef={modelMenuAnchor}
                  placement="top-start"
                  gap={8}
                  className="home-composer-popover"
                  aria-label="Thinking level"
                >
                  <button
                    type="button"
                    className="home-composer-popover-back"
                    onClick={() => setModelMenuStep('model')}
                  >
                    <Icon name="ChevronLeft" size={14} />
                    {MODEL_LABEL[model]}
                  </button>
                  <div className="home-composer-popover-heading">Thinking</div>
                  {(Object.keys(EFFORT_LABEL) as Effort[]).map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      className={`home-composer-popover-item${lvl === effort ? ' home-composer-popover-item--active' : ''}`}
                      onClick={() => {
                        touchedModel.current = true
                        setEffort(lvl)
                        setModelMenuOpen(false)
                      }}
                    >
                      {EFFORT_LABEL[lvl]}
                    </button>
                  ))}
                </Popover>
              </div>

              <IconButton
                icon="FileSearch"
                label={planMode ? 'Plan mode: on' : 'Plan mode: off'}
                title={
                  planMode
                    ? 'Plan mode: on - the agent plans before making changes'
                    : 'Plan mode: off'
                }
                variant={planMode ? 'filled' : 'ghost'}
                size={28}
                aria-pressed={planMode}
                onClick={() => setPlanMode((v) => !v)}
              />

              <IconButton
                icon="EyeOff"
                label={background ? 'Start in background: on' : 'Start in background: off'}
                title={
                  background
                    ? 'Start in background: on - stays here after sending'
                    : 'Start in background: off - opens the session after sending'
                }
                variant={background ? 'filled' : 'ghost'}
                size={28}
                aria-pressed={background}
                onClick={() => setBackground((v) => !v)}
              />

              {devContainer.available && (
                <IconButton
                  icon="Container"
                  data-dev-container-toggle
                  label={inContainer ? 'Dev container: on' : 'Dev container: off'}
                  title={
                    inContainer
                      ? "Dev container: on - the agent runs inside the project's dev container"
                      : 'Dev container: off - the agent runs on this Mac'
                  }
                  variant={inContainer ? 'filled' : 'ghost'}
                  size={28}
                  aria-pressed={inContainer}
                  onClick={() => setContainerPress({ key: containerKey, on: !inContainer })}
                />
              )}
            </div>

            <div className="home-composer-start">
              <Button
                variant="filled"
                size="primary"
                disabled={
                  (!prompt.trim() && attachments.length === 0) || busy || hasPendingAttachments
                }
                onClick={() => void submit()}
              >
                <Icon name="Send" size={16} />
                {busy
                  ? selectedProject && effectiveWorktreeMode
                    ? 'Fetching & creating worktree…'
                    : 'Starting…'
                  : ctaLabel}
              </Button>
            </div>
          </div>
        </div>

        <div className="home-composer-chips">
          <div className="home-composer-menu" ref={projectMenuAnchor}>
            {selectedProject ? (
              <div className="home-project-chip">
                <IconTile icon="Folder" size={28} />
                <span className="home-project-chip-name">{selectedProject.name}</span>
                {!lockProject && (
                  <IconButton
                    icon="X"
                    label="Clear project"
                    size={28}
                    variant="ghost"
                    onClick={() => setPickedProject(null)}
                  />
                )}
              </div>
            ) : lockProject ? null : (
              <button
                type="button"
                className="home-add-project-pill"
                onClick={() => setProjectMenuOpen((v) => !v)}
              >
                <Icon name="Plus" size={14} />
                Project
              </button>
            )}
            <Popover
              open={projectMenuOpen}
              onClose={() => setProjectMenuOpen(false)}
              anchorRef={projectMenuAnchor}
              placement="top-start"
              gap={8}
              className="home-composer-popover"
              aria-label="Project"
            >
              {otherProjects.length === 0 ? (
                <div className="home-composer-popover-empty">No other projects yet.</div>
              ) : (
                otherProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="home-composer-popover-item"
                    onClick={() => {
                      setPickedProject(project)
                      setProjectMenuOpen(false)
                    }}
                  >
                    <Icon name={project.id === 'general' ? 'Terminal' : 'Folder'} size={14} />
                    {project.name}
                  </button>
                ))
              )}
            </Popover>
          </div>

          {selectedProject && (
            <>
              <SegmentedControl
                value={effectiveWorktreeMode ? 'worktree' : 'checkout'}
                onChange={(v) => {
                  setCheckoutOverride(false)
                  setWorktreeMode(v === 'worktree')
                }}
                aria-label="Where this session runs"
                options={[
                  { value: 'checkout', label: 'On a branch' },
                  { value: 'worktree', label: 'New worktree' }
                ]}
              />
              {/* The slot beside the switch holds the same width in both modes.
                  This row is centred, so a field appearing and disappearing
                  re-centred everything: the switch slid out from under the
                  pointer, and the next click hit the other option.

                  On a branch: which branch the session runs on — the repo's
                  default unless you pick or paste another, checked against
                  GitHub. New worktree: a fresh branch, named or not. */}
              {effectiveWorktreeMode ? (
                <div className="home-branch-field">
                  <Input
                    className="home-branch-input"
                    placeholder="New branch name (optional)"
                    aria-label="New branch name"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    disabled={busy}
                  />
                </div>
              ) : (
                <div className="home-branch-field">
                  <button
                    type="button"
                    className={`home-branch-button home-branch-button--${branchCheck?.state ?? 'ok'}`}
                    aria-label={`Branch: ${runOn ?? 'default branch'}`}
                    title={
                      branchCheck?.state === 'invalid'
                        ? branchCheck.error
                        : 'Pick a branch, or paste one - it’s checked against GitHub'
                    }
                    disabled={busy}
                    onClick={(e) => {
                      const id = selectedProject.id
                      setBranchPickerAt(e.currentTarget)
                      if (checkoutBranches?.projectId !== id) {
                        setCheckoutBranches({ projectId: id, list: null })
                        void listCheckoutBranches(id).then((list) =>
                          setCheckoutBranches((cur) =>
                            cur?.projectId === id ? { projectId: id, list } : cur
                          )
                        )
                      }
                    }}
                  >
                    <Icon name="GitBranch" size={14} />
                    <span className="home-branch-name">{runOn ?? '…'}</span>
                    <Icon
                      name={
                        branchCheck?.state === 'checking'
                          ? 'Loader2'
                          : branchCheck?.state === 'invalid'
                            ? 'CircleAlert'
                            : 'ChevronDown'
                      }
                      size={14}
                      className={branchCheck?.state === 'checking' ? 'home-branch-spin' : undefined}
                    />
                  </button>
                  {branchPickerAt && (
                    <Picker
                      anchor={branchPickerAt}
                      title="Branch or pull request on GitHub"
                      emptyText={
                        checkoutBranches?.list ? 'No branches found' : 'Fetching branches…'
                      }
                      options={(checkoutBranches?.list ?? [])
                        .filter((b) => b.where === 'remote')
                        .map((b) => ({
                          value: b.name,
                          label: b.pr ? `#${b.pr.number} ${b.pr.title} (${b.name})` : b.name,
                          icon: <Icon name={b.pr ? 'GitPullRequest' : 'GitBranch'} size={14} />,
                          checked: b.name === runOn,
                          // Merged, closed and quiet branches stay out of
                          // the way until you search for one.
                          searchOnly: b.status === 'closed' || b.status === 'stale'
                        }))}
                      searchHint="merged, closed or quiet for a month"
                      custom={(text) => `Use “${text}”`}
                      onPick={(name) => pickBranch(selectedProject.id, name)}
                      onClose={() => setBranchPickerAt(null)}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {!effectiveWorktreeMode && selectedProject && branchCheck?.state === 'invalid' && (
          <p className="home-composer-error">{branchCheck.error}</p>
        )}

        {error && <p className="home-composer-error">{error}</p>}
        {notice && <p className="home-composer-notice">{notice}</p>}

        {variant === 'page' && (
          <button type="button" className="home-view-all" onClick={onViewAllProjects}>
            View all projects
          </button>
        )}

        {/* Anything that wants you comes first, then whatever ran most
          recently. Capped, because this is a landing pad — the Sessions
          screen is where you go to see everything. */}
        {variant === 'page' && resumable.length > 0 && (
          <div className="home-recent">
            <div className="home-recent-header">
              <h2 className="home-recent-title">Recent sessions</h2>
              <div
                className="home-recent-filters"
                role="toolbar"
                aria-label="Filter recent sessions"
              >
                <Pill
                  active={homeFilter === 'unread'}
                  aria-pressed={homeFilter === 'unread'}
                  onClick={() => toggleFilter('unread')}
                >
                  Unread
                </Pill>
                <Pill
                  active={homeFilter === 'your-turn'}
                  aria-pressed={homeFilter === 'your-turn'}
                  onClick={() => toggleFilter('your-turn')}
                >
                  Your turn
                </Pill>
              </div>
              <button type="button" className="home-view-all" onClick={onViewAllSessions}>
                View all
              </button>
            </div>
            {recent.length === 0 && (
              <p className="home-recent-empty">
                {homeFilter === 'unread'
                  ? 'Nothing unread.'
                  : homeFilter === 'your-turn'
                    ? 'Nothing is waiting on you.'
                    : 'No sessions right now.'}
              </p>
            )}
            {/* The same card the project page's Active board uses — one shape
                for "a session you might go back to", wherever you meet it. */}
            <div className="cr-active-grid">
              {recent.map((session) => (
                <SessionCard
                  key={session.key}
                  session={session}
                  onOpen={(background) => onOpenSession?.(session.key, background)}
                  projectName={
                    projects.find((p) => p.id === session.record?.projectId)?.name ?? undefined
                  }
                  // The same menu a session gets anywhere else — see
                  // useSessionActions. Home used to offer "Mark as done" alone.
                  actions={sessionActions(session)}
                />
              ))}
            </div>
          </div>
        )}
        {showsTickets && onStartTicketSession && onOpenTicket && (
          <HomeTickets
            issues={board?.issues ?? null}
            links={ticketLinks}
            sessions={sessions}
            onOpenSession={(key, background) => onOpenSession?.(key, background)}
            onStartSession={onStartTicketSession}
            onOpenTicket={onOpenTicket}
          />
        )}
        {sessionActionNode}
      </div>
    </div>
  )
}
