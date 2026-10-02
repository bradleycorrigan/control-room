import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LiveSession } from '../../main/store/types'
import ProjectRail from './screens/ProjectRail'
import ProjectsListScreen from './screens/ProjectsListScreen'
import ProjectDetail from './screens/ProjectDetail'
import SessionsScreen, { type StatusFilterId } from './screens/SessionsScreen'
import GridView from './screens/GridView'
import SettingsScreen from './screens/SettingsScreen'
import SessionDetail from './screens/SessionDetail'
import HomeScreen from './screens/HomeScreen'
import { Modal, IconButton, Badge, Button } from './components/primitives'
import AppShell, { type AppView, type MainView } from './components/AppShell'
import CommandPalette from './components/CommandPalette'
import KeyboardHelp from './components/KeyboardHelp'
import { useSessions } from './state/useSessions'
import { useProjects } from './state/useProjects'
import { useToasts } from './state/useToasts'
import {
  onNavigate,
  openSessionInIde,
  focusSessionTerminal,
  installHooks,
  openDataFolder,
  listProjects,
  listSessions,
  createSession,
  setAppSettings,
  unarchiveSession,
  onCloseTabShortcut,
  closeWindow,
  acknowledgeSession
} from './api'
import SessionTabs from './components/SessionTabs'
import BacklogScreen, { type ComposerSeed } from './screens/BacklogScreen'
import { useStoredState } from './state/useStoredState'
import { initShotListener, registerShotScreen, registerShotReset } from './dev/shot'
import { runTabsCheck } from './dev/tabsCheck'
import { runPagesCheck } from './dev/pagesCheck'
import { DEFAULT_TERMINAL_FONT_SIZE } from './components/Terminal'
import PrimitivesGallery from './dev/PrimitivesGallery'
import { useThemeProvider } from './theme/ThemeProvider'
import { useKeyboardMap } from './keyboard'

// Sidebar geometry. The floor is the narrowest the longest project name stays
// readable at; the ceiling stops the rail eating a window it is only a filter
// for.
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 260

function App(): React.JSX.Element {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  const [view, setView] = useState<AppView>('home')
  const [openSessionKey, setOpenSessionKey] = useState<string | null>(null)
  const [lastOpenedSessionKey, setLastOpenedSessionKey] = useState<string | null>(null)
  const [showNewSessionForm, setShowNewSessionForm] = useState(false)
  // Set by the title bar's needs-you count. Deliberately not combined with the
  // project filter: "what needs me" is a question about everything, not about
  // one project, so it replaces the rail's selection rather than narrowing it.
  // The Sessions list's own filters live here rather than in the list, so
  // the bell can switch Unread on from anywhere.
  const [unreadOnly, setUnreadOnly] = useStoredState('sessions-unread-only', false)
  const [statusFilter, setStatusFilter] = useStoredState<StatusFilterId | null>(
    'sessions-status-filter',
    null
  )
  // Sidebar visibility and width persist per viewer. localStorage can throw or
  // come back empty (private window, cleared site data), so every read is
  // guarded and falls back to the default rather than leaving the rail broken.
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem('cr:sidebar-hidden') === '1'
    } catch {
      return false
    }
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('cr:sidebar-width'))
      return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX
        ? saved
        : SIDEBAR_DEFAULT
    } catch {
      return SIDEBAR_DEFAULT
    }
  })

  const toggleSidebar = useCallback(() => {
    setSidebarHidden((hidden) => {
      const next = !hidden
      try {
        localStorage.setItem('cr:sidebar-hidden', next ? '1' : '0')
      } catch {
        /* a remembered preference is a convenience, never a requirement */
      }
      return next
    })
  }, [])

  // Drag the divider. Pointer capture rather than window listeners so the drag
  // survives the cursor leaving the 4px handle, which it does immediately.
  const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = handle.parentElement?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT

    const onMove = (move: PointerEvent): void => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + move.clientX - startX))
      setSidebarWidth(next)
    }
    const onUp = (): void => {
      handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      setSidebarWidth((width) => {
        try {
          localStorage.setItem('cr:sidebar-width', String(width))
        } catch {
          /* see above */
        }
        return width
      })
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }, [])
  // Which project a "+ New session" button was pressed from — set when a
  // project container in the sessions list opens the form, so it lands
  // preselected on that project rather than always defaulting to the first
  // one. null means "no preference" (the global button / palette entry).
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(null)
  // Backlog → Start session: the Jira issue the composer opens pre-filled
  // with, and which repo each Jira project's issues were last started in.
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null)
  // ⌘K → a branch: which project and branch the composer should open on.
  // Passed as `initialRunBranch`, which forces "On a branch" (checkout) mode
  // for this sheet only, without touching the persisted worktree-choice
  // preference — a branch you picked by name is a request to run on it, not
  // a vote for what every future session should default to.
  const [paletteBranchSeed, setPaletteBranchSeed] = useState<{
    projectId: string
    branch: string
  } | null>(null)
  const [repoForJiraProject, setRepoForJiraProject] = useStoredState<Record<string, string>>(
    'backlog-repo-for-project',
    {}
  )
  // Dev shot harness only: which Project Detail tab to land on.
  const [shotProjectTab, setShotProjectTab] = useState<string | undefined>(undefined)
  const [shotHistoryTab, setShotHistoryTab] = useState<'recent' | 'cli' | undefined>(undefined)
  const [gridView, setGridView] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false)
  const { projects, refresh: refreshProjects } = useProjects()
  const { sessions, refresh: refreshSessions } = useSessions()
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts()
  const theme = useThemeProvider()

  // Shell responsiveness (plan 3, 1.5): a ResizeObserver on the shell itself,
  // not viewport media queries — the app is a window, not a page. Three
  // buckets drive both the top bar's own layout (AppShell) and the sidebar /
  // page-container widths (via the data-shell-size attribute in CSS).
  const appRootRef = useRef<HTMLDivElement>(null)
  const [shellSize, setShellSize] = useState<'wide' | 'medium' | 'narrow'>('wide')
  useEffect(() => {
    const el = appRootRef.current
    if (!el) return undefined
    const bucketFor = (width: number): 'wide' | 'medium' | 'narrow' =>
      width >= 1200 ? 'wide' : width >= 840 ? 'medium' : 'narrow'
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') setShellSize(bucketFor(width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // ---------------------------------------------------------------------
  // Where you are, and where you have been.
  //
  // Back used to mean "close the session", which is not the same thing: open
  // a session from a project page and closing it dropped you on the Sessions
  // list, a screen you had not come from. Every place worth returning to is a
  // combination of these three, so that is what gets remembered.
  const location = useMemo(
    () => ({ view, openProjectId, openSessionKey }),
    [view, openProjectId, openSessionKey]
  )
  const historyRef = useRef<(typeof location)[]>([location])
  const indexRef = useRef(0)
  // Set while back/forward is applying a past location, so the effect below
  // does not record the move as a new one and trap you in the history.
  const travellingRef = useRef(false)

  useEffect(() => {
    if (travellingRef.current) {
      travellingRef.current = false
      return
    }
    const current = historyRef.current[indexRef.current]
    if (
      current &&
      current.view === location.view &&
      current.openProjectId === location.openProjectId &&
      current.openSessionKey === location.openSessionKey
    ) {
      return
    }
    // Anything ahead of here is a branch you did not take.
    historyRef.current = [...historyRef.current.slice(0, indexRef.current + 1), location].slice(-50)
    indexRef.current = historyRef.current.length - 1
  }, [location])

  const travelTo = useCallback((step: number) => {
    const next = indexRef.current + step
    const target = historyRef.current[next]
    if (!target) return
    travellingRef.current = true
    indexRef.current = next
    setView(target.view)
    setOpenProjectId(target.openProjectId)
    setOpenSessionKey(target.openSessionKey)
  }, [])

  // Clicking a notification lands here — open that session's detail directly.
  useEffect(() => {
    return onNavigate(({ liveKey }) => {
      setView('sessions')
      setOpenSessionKey(liveKey)
      setLastOpenedSessionKey(liveKey)
    })
  }, [])

  const openSession = sessions.find((s) => s.key === openSessionKey) ?? null
  // The session that "Open in IDE" / "Focus terminal" act on when reached via
  // the palette or a keyboard shortcut rather than a button inside the
  // detail screen itself: the one currently open, or failing that the most
  // recently opened one. No session ever selected → these no-op with a toast.
  const currentSession = openSession ?? sessions.find((s) => s.key === lastOpenedSessionKey) ?? null

  // A session with no terminal Control Room can show — running in some other
  // terminal, or a background agent — used to open as a tab holding nothing
  // but "Running outside tmux". It gets a card instead, and no tab.
  const [externalCardKey, setExternalCardKey] = useState<string | null>(null)
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  const openSessionByKey = useCallback((liveKey: string) => {
    const target = sessionsRef.current.find((s) => s.key === liveKey)
    if (
      target?.alive &&
      !target.tmux &&
      (target.status === 'external' || target.backgroundAgentId)
    ) {
      setExternalCardKey(liveKey)
      void acknowledgeSession(liveKey)
      return
    }
    // Always switch: the session detail only renders under the Sessions view,
    // so leaving the view alone opened the session invisibly — clicking a card
    // on a project page did nothing at all. Returning to where you came from
    // is the history stack's job, not this function's.
    setView('sessions')
    setOpenSessionKey(liveKey)
    setLastOpenedSessionKey(liveKey)
  }, [])

  // A file dropped anywhere that doesn't take one would otherwise load that
  // file in place of the app — Electron's default for a drop. Places that do
  // take drops (the terminal, Home's composer) handle it themselves first.
  useEffect(() => {
    const stop = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  // ---------------------------------------------------------------------
  // Session tabs. Every session you open becomes a tab, however you got
  // there — a card, a notification, back/forward — so this watches
  // openSessionKey rather than each way in. Remembered across restarts.
  const [openTabs, setOpenTabs] = useStoredState<string[]>('session-tabs', [])
  // The session you were on before this one, so a new tab lands beside it
  // rather than at the far end — as a browser does.
  const previousSessionKey = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousSessionKey.current
    previousSessionKey.current = openSessionKey
    if (openSessionKey && !openTabs.includes(openSessionKey)) {
      const at = previous ? openTabs.indexOf(previous) : -1
      const next = [...openTabs]
      next.splice(at >= 0 ? at + 1 : next.length, 0, openSessionKey)
      setOpenTabs(next)
    }
    // Only a newly opened session should add a tab — not a tab being closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionKey])

  // Tabs whose session is gone (deleted, or its window ended) drop out. Not
  // before the first poll lands, or a restart would throw every tab away.
  const tabSessions = useMemo(
    () =>
      openTabs
        .map((key) => sessions.find((s) => s.key === key))
        .filter((s): s is LiveSession => Boolean(s)),
    [openTabs, sessions]
  )

  // Tabs you've closed, newest last, for Reopen closed tab (tab menu, ⌘K).
  const [closedTabs, setClosedTabs] = useState<string[]>([])
  const rememberClosed = useCallback(
    (keys: string[]) =>
      setClosedTabs((prev) => [...prev.filter((k) => !keys.includes(k)), ...keys].slice(-20)),
    []
  )

  const closeTab = useCallback(
    (key: string) => {
      rememberClosed([key])
      const index = openTabs.indexOf(key)
      const remaining = openTabs.filter((k) => k !== key)
      setOpenTabs(remaining)
      if (key !== openSessionKey) return
      // Like a browser: the tab to the right takes its place, else the left.
      const live = remaining.filter((k) => sessions.some((s) => s.key === k))
      const next = live[Math.min(index, live.length - 1)] ?? null
      setOpenSessionKey(next)
      if (next) setLastOpenedSessionKey(next)
    },
    [openTabs, openSessionKey, sessions, setOpenTabs, rememberClosed]
  )

  const reorderTabs = useCallback(
    (from: number, to: number) => {
      // Indexes are positions among the visible tabs; map back to the list.
      const fromKey = tabSessions[from]?.key
      const toKey = tabSessions[to]?.key
      if (!fromKey || !toKey) return
      const next = openTabs.filter((k) => k !== fromKey)
      next.splice(next.indexOf(toKey) + (from < to ? 1 : 0), 0, fromKey)
      setOpenTabs(next)
    },
    [openTabs, tabSessions, setOpenTabs]
  )

  // The pinned list tab is part of the cycle, as a pinned tab is in a browser.
  const stepTab = useCallback(
    (delta: number) => {
      if (view !== 'sessions' || tabSessions.length === 0) return
      const order: (string | null)[] = [null, ...tabSessions.map((s) => s.key)]
      const index = Math.max(0, order.indexOf(openSessionKey))
      const next = order[(index + delta + order.length) % order.length]
      if (next) openSessionByKey(next)
      else setOpenSessionKey(null)
    },
    [view, openSessionKey, tabSessions, openSessionByKey]
  )

  // The pinned list tab. ⌘0, the house, and Sessions when you're already in
  // Sessions all land here.
  // A ticket to open on Backlog, from a session's header pill.
  const [openTicket, setOpenTicket] = useState<string | null>(null)
  // A ticket opened from a session: its panel, over the session.
  const [peekTicket, setPeekTicket] = useState<string | null>(null)
  const clearOpenTicket = useCallback(() => setOpenTicket(null), [])

  const goToSessionsList = useCallback(() => {
    setView('sessions')
    setOpenSessionKey(null)
  }, [])

  // ⌘- or middle-click on any session: a tab without leaving where you are,
  // placed right after the one you're on, as a browser does.
  const openInBackground = useCallback(
    (liveKey: string) => {
      const session = sessions.find((s) => s.key === liveKey)
      if (!openTabs.includes(liveKey)) {
        const at = openSessionKey ? openTabs.indexOf(openSessionKey) + 1 : openTabs.length
        const next = [...openTabs]
        next.splice(at > 0 ? at : next.length, 0, liveKey)
        setOpenTabs(next)
      }
      const title = session?.record?.title ?? session?.agentName ?? 'Session'
      pushToast(`Opened “${title}” in a tab`)
    },
    [sessions, openTabs, openSessionKey, setOpenTabs, pushToast]
  )

  const openSessionFrom = useCallback(
    (liveKey: string, background?: boolean) =>
      background ? openInBackground(liveKey) : openSessionByKey(liveKey),
    [openInBackground, openSessionByKey]
  )

  const closeOtherTabs = useCallback(
    (key: string) => {
      rememberClosed(openTabs.filter((k) => k !== key))
      setOpenTabs([key])
      if (openSessionKey !== key) openSessionByKey(key)
    },
    [openTabs, openSessionKey, openSessionByKey, setOpenTabs, rememberClosed]
  )

  const closeTabsToRight = useCallback(
    (key: string) => {
      const index = openTabs.indexOf(key)
      const kept = openTabs.slice(0, index + 1)
      rememberClosed(openTabs.slice(index + 1))
      setOpenTabs(kept)
      if (openSessionKey && !kept.includes(openSessionKey)) openSessionByKey(key)
    },
    [openTabs, openSessionKey, openSessionByKey, setOpenTabs, rememberClosed]
  )

  // The most recently closed tab whose session still exists.
  const reopenableKey = [...closedTabs].reverse().find((k) => sessions.some((s) => s.key === k))
  const reopenClosedTab = useCallback(() => {
    if (!reopenableKey) return
    setClosedTabs((prev) => prev.filter((k) => k !== reopenableKey))
    openSessionByKey(reopenableKey)
  }, [reopenableKey, openSessionByKey])

  // ⌘W: close the tab you're on, or the window when you're not on one.
  useEffect(
    () =>
      onCloseTabShortcut(() => {
        if (openSessionKey && view === 'sessions') closeTab(openSessionKey)
        else void closeWindow()
      }),
    [openSessionKey, view, closeTab]
  )

  // ⌘⇧T: reopen the last closed session tab, like a browser — everywhere,
  // including while a text field or the terminal has focus. This is ⌘⇧T's
  // only meaning now — "Focus terminal" moved to ⌘⇧E in keyboard.ts so the
  // two shortcuts never collide. When there's no closed tab, ⌘⇧T does
  // nothing. It listens on the capture phase and stops the event there,
  // ahead of xterm's own keydown handling on the pane's textarea (a bubble-
  // phase listener on the terminal itself would run too late to stop it).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!reopenableKey) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        e.stopPropagation()
        reopenClosedTab()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [reopenableKey, reopenClosedTab])

  // Dev-only: `npm run shot -- <screen> <theme>` drives this to reach a
  // screen without clicking through the app by hand.
  useEffect(() => {
    // Runs before every screen in a batch, so none of them inherits what the
    // last one left open. Closing the session detail and the New session
    // modal unmounts them, which is what clears the menu and dialog state
    // living inside those components — there is nothing to reach in here.
    registerShotReset(async () => {
      setShowNewSessionForm(false)
      setNewSessionProjectId(null)
      setPaletteOpen(false)
      setKeyboardHelpOpen(false)
      setGridView(false)
      setOpenSessionKey(null)
      setOpenProjectId(null)
      setSelectedProjectId(null)
      setShotProjectTab(undefined)
      setShotHistoryTab(undefined)
      // The terminal-font-size shot leaves 17px behind on purpose, so the
      // capture can be compared against the same crop at the default. Reset
      // it here rather than in that screen, or a batch run photographs every
      // later terminal at the wrong size.
      await setAppSettings({ terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE })
      // Sessions arrive on a 2s poll, so a shot taken straight after boot
      // caught an empty list and captured "No sessions yet" over a fixture
      // with seven in it. Wait for real data before any screen sets up.
      await refreshSessions()
      await refreshProjects()
      // Let React commit the unmounts before the screen sets itself up, or
      // the reset and the setup land in one batch and cancel each other out.
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    registerShotScreen('home', () => {
      setView('home')
      setOpenProjectId(null)
      setOpenSessionKey(null)
      setPaletteOpen(false)
    })
    registerShotScreen('projects', () => {
      setView('projects')
      setOpenProjectId(null)
      setOpenSessionKey(null)
      setPaletteOpen(false)
    })
    const landOnProjectDetail = async (
      tab?: string,
      historyTab?: 'recent' | 'cli'
    ): Promise<void> => {
      setView('projects')
      setOpenSessionKey(null)
      setPaletteOpen(false)
      setShotProjectTab(tab)
      setShotHistoryTab(historyTab)
      // React's own project list may not have finished its first IPC round
      // trip yet at shot time — fetch fresh rather than trust a possibly
      // stale closure over `projects`. No projects registered in the dev
      // store falls back to the list's own empty state, same as
      // session-detail's shot entry does for sessions.
      const list = projects.length > 0 ? projects : await listProjects()
      setOpenProjectId(list[0]?.id ?? null)
    }
    registerShotScreen('project-detail', () => landOnProjectDetail(undefined))
    registerShotScreen('project-detail-git', () => landOnProjectDetail('git'))
    // The Active board's per-tile actions — the surface that could open a
    // session but never act on one.
    registerShotScreen('project-detail-card-menu', async () => {
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 400))
      document.querySelector<HTMLButtonElement>('.cr-session-card-menu button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    registerShotScreen('project-detail-files', () => landOnProjectDetail('files'))
    // The Git tab could only ever show the project's main checkout. This is
    // the shot that says the picker offers the session worktrees too.
    registerShotScreen('project-detail-git-picker', async () => {
      await landOnProjectDetail('git')
      await new Promise((resolve) => setTimeout(resolve, 400))
      document.querySelector<HTMLButtonElement>('.git-tab-checkout-picker')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    registerShotScreen('project-detail-skills', () => landOnProjectDetail('skills'))
    registerShotScreen('project-detail-rules', () => landOnProjectDetail('rules'))
    registerShotScreen('project-detail-cli', () => landOnProjectDetail('overview', 'cli'))
    registerShotScreen('sessions', () => {
      setView('sessions')
      setOpenSessionKey(null)
      setPaletteOpen(false)
    })
    // Collapse used the `hidden` attribute, which a display:flex rule
    // silently overrode — the chevron turned and nothing moved. This clicks it
    // and reports how many rows are left on screen.
    registerShotScreen('sessions-collapsed', async () => {
      setView('sessions')
      setPaletteOpen(false)
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.sessions-project-collapse')?.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
      pushToast(`Rows on screen: ${document.querySelectorAll('.sessions-row-line1').length}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    // Terminal drops, without a real OS drag (synthetic input can start one
    // it never finishes). -hover stops at the drop target; the other drops
    // a line of text, which the shell check then reads back out of tmux.
    const dropOnTerminal = async (drop: boolean): Promise<void> => {
      setPaletteOpen(false)
      setView('sessions')
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list.find((s) => s.tmux)?.key ?? list[0]?.key ?? null)
      await new Promise((r) => setTimeout(r, 1500))
      const surface = document.querySelector('.terminal-surface')
      if (!surface) return
      const dt = new DataTransfer()
      dt.setData('text/plain', 'echo cr-drop-check')
      surface.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
      )
      await new Promise((r) => setTimeout(r, 300))
      if (!drop) return
      const dropWith = async (build: (d: DataTransfer) => void): Promise<void> => {
        const d = new DataTransfer()
        build(d)
        surface.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: d })
        )
        await new Promise((r) => setTimeout(r, 1200))
      }
      // 1. Plain text.
      await dropWith((d) => d.setData('text/plain', 'echo cr-drop-check'))
      // 2. An image with no path on disk — what a screenshot dragged from
      //    its preview thumbnail looks like. A real 1x1 PNG.
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        ),
        (c) => c.charCodeAt(0)
      )
      await dropWith((d) =>
        d.items.add(new File([png], 'Screenshot 2026-09-24 at 14.30.png', { type: 'image/png' }))
      )
      // 3. A file link.
      await dropWith((d) => d.setData('text/uri-list', 'file:///tmp/cr%20drop%20link.txt'))
    }
    // Idle cost: sit on the Sessions list for 20s and count the updates main
    // pushes. scripts measure CPU between the two log lines.
    registerShotScreen('idle-updates', async () => {
      setPaletteOpen(false)
      setOpenSessionKey(null)
      setView('sessions')
      const api = (
        window as unknown as {
          api: {
            invoke: (c: string, ...a: unknown[]) => Promise<void>
            on: (c: string, fn: (p: unknown) => void) => () => void
          }
        }
      ).api
      // Past the first check and the status dots' opening pulse, so this
      // measures the app at rest.
      await new Promise((r) => setTimeout(r, 12000))
      let updates = 0
      const off = api.on('sessions:changed', () => updates++)
      await api.invoke('dev:log', 'IDLE-START')
      await new Promise((r) => setTimeout(r, 20000))
      off()
      await api.invoke('dev:log', `IDLE-END updates=${updates}`)
    })
    // How long a status change takes to reach the screen: flip the working
    // fixture session to idle and back, timing each until it arrives.
    registerShotScreen('status-latency', async () => {
      setPaletteOpen(false)
      setOpenSessionKey(null)
      setView('sessions')
      const api = (
        window as unknown as {
          api: {
            invoke: (c: string, ...a: unknown[]) => Promise<void>
            on: (c: string, fn: (p: unknown) => void) => () => void
          }
        }
      ).api
      await new Promise((r) => setTimeout(r, 4000))
      const timeTo = async (status: string, expect: string): Promise<number> => {
        const started = performance.now()
        const arrived = new Promise<number>((resolve) => {
          const off = api.on('sessions:changed', (payload) => {
            const s = (payload as LiveSession[]).find((x) => x.agentName === 'fixture-working')
            if (s?.rawStatus === expect) {
              off()
              resolve(performance.now() - started)
            }
          })
          setTimeout(() => {
            off()
            resolve(-1)
          }, 40000)
        })
        await api.invoke('dev:set-fixture-status', 'working.json', status)
        return arrived
      }
      const toIdle = await timeTo('idle', 'idle')
      const toBusy = await timeTo('busy', 'busy')
      await api.invoke(
        'dev:log',
        `LATENCY working→idle ${Math.round(toIdle)}ms, idle→working ${Math.round(toBusy)}ms`
      )
    })
    // Minimise with a session open, come back, capture straight away — the
    // moment the terminal used to show a lost-WebGL placeholder.
    registerShotScreen('terminal-restore', async () => {
      setPaletteOpen(false)
      setView('sessions')
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list.find((s) => s.tmux)?.key ?? list[0]?.key ?? null)
      await new Promise((r) => setTimeout(r, 2000))
      const api = (
        window as unknown as { api: { invoke: (c: string, ...a: unknown[]) => Promise<void> } }
      ).api
      const events: string[] = []
      document
        .querySelector('.terminal-surface canvas')
        ?.addEventListener('webglcontextlost', () => events.push('lost'))
      await api.invoke('dev:window', 'minimize')
      await new Promise((r) => setTimeout(r, 4000))
      const webglCanvas = (): number =>
        [...document.querySelectorAll<HTMLCanvasElement>('.terminal-surface canvas')].filter(
          (c) => c.getContext('webgl2') !== null
        ).length
      await api.invoke(
        'dev:log',
        `minimised: visibility=${document.visibilityState} webgl canvases=${webglCanvas()}`
      )
      await api.invoke('dev:window', 'restore')
      await new Promise((r) => setTimeout(r, 200))
      await api.invoke(
        'dev:log',
        `restore: webgl canvases=${webglCanvas()} ` +
          `events=${events.join(',') || 'none'} visibility=${document.visibilityState}`
      )
    })
    // ⌘F in a session: real keys, a word that's on screen, the match count.
    // Block characters, as Claude Code's banner draws them: rows should touch.
    registerShotScreen('terminal-blocks', async () => {
      setPaletteOpen(false)
      const api = (
        window as unknown as { api: { invoke: (c: string, ...a: unknown[]) => Promise<void> } }
      ).api
      await api.invoke(
        'dev:pane-command',
        "clear; printf ' ▐▛███▜▌\\n▝▜█████▛▘\\n  ▘▘ ▝▝\\n\\n████▀▀▀▀████\\n█  ▄▄▄▄  █\\n╭──────────╮\\n│ > prompt │\\n╰──────────╯\\n'"
      )
      setView('sessions')
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list.find((s) => s.tmux)?.key ?? list[0]?.key ?? null)
      await new Promise((r) => setTimeout(r, 2500))
    })
    registerShotScreen('terminal-search', async () => {
      setPaletteOpen(false)
      setView('sessions')
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list.find((s) => s.tmux)?.key ?? list[0]?.key ?? null)
      await new Promise((r) => setTimeout(r, 2000))
      const api = (
        window as unknown as { api: { invoke: (c: string, ...a: unknown[]) => Promise<void> } }
      ).api
      const send = (e: Record<string, unknown>): Promise<void> => api.invoke('dev:input', e)
      await send({ type: 'keyDown', keyCode: 'f', modifiers: ['meta'] })
      await send({ type: 'keyUp', keyCode: 'f', modifiers: ['meta'] })
      await new Promise((r) => setTimeout(r, 300))
      const opened = Boolean(document.querySelector('.terminal-search'))
      for (const ch of 'feature') {
        await send({ type: 'keyDown', keyCode: ch })
        await send({ type: 'char', keyCode: ch })
        await send({ type: 'keyUp', keyCode: ch })
      }
      await new Promise((r) => setTimeout(r, 500))
      const count = document.querySelector('.terminal-search-count')?.textContent ?? ''
      await api.invoke('dev:log', `SEARCH opened=${opened} count="${count}"`)
    })
    // Claude exited in a session whose pane is still open (the shell script
    // points the Ready fixture at a dead pid first): the banner shows, and
    // Start new Claude types into that same pane.
    registerShotScreen('claude-exited', async () => {
      setPaletteOpen(false)
      setView('sessions')
      setOpenSessionKey('record:fixture-rec-ready')
      await new Promise((r) => setTimeout(r, 2500))
      const api = (
        window as unknown as { api: { invoke: (c: string, ...a: unknown[]) => Promise<void> } }
      ).api
      const banner = document.querySelector('.session-detail-exited')
      const terminal = document.querySelector('.cr-session-body .terminal-surface')
      await api.invoke(
        'dev:log',
        `EXITED banner=${Boolean(banner)} terminal=${Boolean(terminal)} buttons=${[
          ...(banner?.querySelectorAll('button') ?? [])
        ]
          .map((b) => b.textContent)
          .join('|')}`
      )
      {
        const start = [...(banner?.querySelectorAll('button') ?? [])].find((b) =>
          b.textContent?.includes('Start new')
        )
        start?.click()
        await new Promise((r) => setTimeout(r, 1500))
        await api.invoke('dev:log', 'EXITED pressed start')
      }
    })
    // The Sessions list's own card grid (the Grid/List toggle), not the
    // terminal-tile grid behind 'grid'.
    registerShotScreen('sessions-grid', async () => {
      setPaletteOpen(false)
      setOpenSessionKey(null)
      setGridView(false)
      setView('sessions')
      await new Promise((r) => setTimeout(r, 800))
      document
        .querySelector<HTMLButtonElement>('.sessions-view-option[aria-label="Grid view"]')
        ?.click()
      await new Promise((r) => setTimeout(r, 400))
    })
    // Backlog with the sample issues; -start presses Start session on the
    // first one and leaves the pre-filled composer open.
    registerShotScreen('backlog', async () => {
      setPaletteOpen(false)
      setView('backlog')
      await new Promise((r) => setTimeout(r, 800))
    })
    registerShotScreen('backlog-board', async () => {
      setPaletteOpen(false)
      setView('backlog')
      await new Promise((r) => setTimeout(r, 800))
      document.querySelector<HTMLButtonElement>('[aria-label="Board view"]')?.click()
      await new Promise((r) => setTimeout(r, 400))
    })
    registerShotScreen('backlog-drawer', async () => {
      setPaletteOpen(false)
      setView('backlog')
      await new Promise((r) => setTimeout(r, 800))
      document.querySelector<HTMLButtonElement>('[aria-label="List view"]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector<HTMLElement>('.backlog-row[data-issue="DSD-101"]')?.click()
      await new Promise((r) => setTimeout(r, 600))
    })
    registerShotScreen('backlog-columns', async () => {
      setPaletteOpen(false)
      setView('backlog')
      await new Promise((r) => setTimeout(r, 800))
      document.querySelector<HTMLButtonElement>('[aria-label="More"]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      ;[...document.querySelectorAll<HTMLButtonElement>('.backlog-menu .cr-popover-item')]
        .find((b) => b.textContent?.includes('Columns'))
        ?.click()
      await new Promise((r) => setTimeout(r, 500))
    })
    registerShotScreen('backlog-board-epics', async () => {
      setPaletteOpen(false)
      setView('backlog')
      await new Promise((r) => setTimeout(r, 800))
      document.querySelector<HTMLButtonElement>('[aria-label="Board view"]')?.click()
      document
        .querySelector<HTMLButtonElement>('.backlog-menu-button[aria-label^="Display"]')
        ?.click()
      await new Promise((r) => setTimeout(r, 300))
      const item = (n: string): HTMLButtonElement | undefined =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            '.backlog-display-menu [role="menuitemcheckbox"]'
          )
        ].find((b) => b.textContent?.startsWith(n))
      if (item('Epic')?.getAttribute('aria-checked') !== 'true') item('Epic')?.click()
      await new Promise((r) => setTimeout(r, 100))
      if (item('Status')?.getAttribute('aria-checked') === 'true') item('Status')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r) => setTimeout(r, 400))
    })
    registerShotScreen('backlog-create', async () => {
      setPaletteOpen(false)
      setView('backlog')
      await new Promise((r) => setTimeout(r, 800))
      ;[...document.querySelectorAll<HTMLButtonElement>('.backlog-header-actions button')]
        .find((b) => b.textContent?.includes('New ticket'))
        ?.click()
      await new Promise((r) => setTimeout(r, 600))
    })
    registerShotScreen('backlog-start', async () => {
      setPaletteOpen(false)
      setView('backlog')
      await new Promise((r) => setTimeout(r, 800))
      const start = [...document.querySelectorAll<HTMLButtonElement>('.backlog-row button')].find(
        (b) => b.textContent === 'Start session'
      )
      start?.click()
      await new Promise((r) => setTimeout(r, 600))
      const api = (
        window as unknown as { api: { invoke: (c: string, ...a: unknown[]) => Promise<void> } }
      ).api
      const textarea = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
      await api.invoke(
        'dev:log',
        `BACKLOG composer=${Boolean(textarea)} title="${document.querySelector('[role="dialog"] .cr-modal-title')?.textContent}" prompt="${(textarea?.value ?? '').slice(0, 60).replace(/\n/g, ' | ')}"`
      )
    })
    registerShotScreen('terminal-drop-hover', () => dropOnTerminal(false))
    registerShotScreen('terminal-drop', () => dropOnTerminal(true))
    // Page checks (Backlog, Home, Sessions rows, Settings, session header,
    // terminal find) — run by the gate next to the tab checks.
    registerShotScreen('pages-interactions', async () => {
      setPaletteOpen(false)
      setOpenTabs([])
      await runPagesCheck({
        goTo: async (target) => {
          setOpenSessionKey(null)
          setGridView(false)
          setView(target)
        },
        openFirstSession: async () => {
          const list = sessions.length > 0 ? sessions : await listSessions()
          const target = list.find((s) => s.tmux && s.record) ?? list[0]
          if (target) openSessionByKey(target.key)
        },
        refreshSessions: async () => {
          refreshSessions()
          await new Promise((r) => setTimeout(r, 400))
        }
      })
    })
    // Real-input interaction check for tabs; results go to the run output.
    registerShotScreen('tabs-interactions', async () => {
      setPaletteOpen(false)
      setOpenTabs([])
      await runTabsCheck({
        goToSessionsList: async () => {
          setOpenSessionKey(null)
          setGridView(false)
          setSelectedProjectId(null)
          setView('sessions')
        },
        goHome: async () => {
          setOpenSessionKey(null)
          setView('home')
        }
      })
    })
    // Three open tabs, the last one active — the strip only shows from two.
    registerShotScreen('session-tabs', async () => {
      setView('sessions')
      setPaletteOpen(false)
      const list = sessions.length > 0 ? sessions : await listSessions()
      const picks = list.filter((s) => s.record).slice(0, 4)
      setOpenTabs(picks.map((s) => s.key))
      setOpenSessionKey(picks[2]?.key ?? picks[0]?.key ?? null)
    })
    registerShotScreen('session-detail', async () => {
      setView('sessions')
      setPaletteOpen(false)
      // React's own session list may not have finished its first IPC round
      // trip yet at shot time — fetch fresh rather than trust a possibly
      // stale closure over `sessions` (same fix as project-detail's shot
      // entry above; this one used to silently fall back to the plain
      // sessions list instead of opening a card).
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list[0]?.key ?? null)
    })
    // Resume's positive case. The plain 'session-detail' shot opens list[0],
    // which is never the resumable record, so the control shipped verified only
    // in its hidden state. This targets the fixture's stopped-and-resumable
    // session by record id so the visible state is checkable too.
    registerShotScreen('new-session', async () => {
      setView('sessions')
      setPaletteOpen(false)
      setShowNewSessionForm(true)
    })
    // The project picker sits at the very bottom of the New session modal, so
    // it is the one menu whose panel lands outside the modal's clipped box —
    // this is the shot that catches it going missing again.
    registerShotScreen('new-session-projects', async () => {
      setView('sessions')
      setPaletteOpen(false)
      setShowNewSessionForm(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.home-add-project-pill')?.click()
    })
    registerShotScreen('session-detail-menu', async () => {
      setView('sessions')
      setPaletteOpen(false)
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list[0]?.key ?? null)
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')?.click()
    })
    // Proves the menu is arrow-navigable and that the focus ring is visible:
    // open, then step down twice, so the shot lands on the third item.
    registerShotScreen('titlebar-menu-keyboard', async () => {
      setView('sessions')
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.app-titlebar-menu-button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      for (let i = 0; i < 2; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      // Says in the shot which row focus actually landed on, so the check does
      // not rest on spotting a 2px ring in a screenshot.
      pushToast(`Focus: ${document.activeElement?.textContent?.trim() ?? 'nothing'}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    registerShotScreen('history-cli', () => landOnProjectDetail('overview', 'cli'))
    // The worktree choice only exists once a project is picked, so the shot
    // has to pick one before there is anything to look at.
    registerShotScreen('new-session-worktree', async () => {
      setView('sessions')
      setPaletteOpen(false)
      setShowNewSessionForm(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.home-add-project-pill')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      // The longest project name available, because a short one hides a row
      // that is too narrow for a real one.
      const items = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.home-composer-popover-item')
      )
      const longest = items.sort(
        (a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0)
      )[0]
      ;(longest ?? items[0])?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      // Nothing in this row may wrap: an option taller than its 28px means a
      // label broke across lines, which is what "cramped" looked like.
      const measure = (): string => {
        const opts = Array.from(document.querySelectorAll('.cr-segmented__option'))
        const tallest = Math.max(
          0,
          ...opts.map((el) => Math.round(el.getBoundingClientRect().height))
        )
        const row = document.querySelector('.home-composer-chips')
        return `${Math.round(row?.getBoundingClientRect().height ?? 0)}/${tallest}`
      }
      const checkout = measure()
      Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-segmented__option'))
        .find((el) => /new worktree/i.test(el.textContent ?? ''))
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      // row height / tallest option, in both modes. 34/28 is one line; an
      // option above 28 means a label broke, and a row above ~34 means the
      // whole line wrapped.
      pushToast(`checkout ${checkout} · worktree ${measure()}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // Escape precedence: with a menu open inside the New session modal, one
    // Escape must close the menu and leave the modal standing. Before the
    // dismiss stack, both listened separately and both acted on the press.
    registerShotScreen('escape-precedence', async () => {
      setView('sessions')
      setShowNewSessionForm(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.home-add-project-pill')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 150))
      pushToast(
        `Menu: ${document.querySelector('.home-composer-popover') ? 'open' : 'closed'} · Modal: ${
          document.querySelector('.cr-modal') ? 'open' : 'closed'
        }`
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    // Toasts used to render behind the title bar. This is the shot that says
    // whether they are visible, so it deliberately fires one long enough to
    // wrap and one with an action button.
    registerShotScreen('toast', async () => {
      setView('sessions')
      pushToast('Session deleted: feature/working. The worktree was removed.')
      pushToast('Hooks installed. Claude Code will report status to Control Room.')
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    registerShotScreen('titlebar-menu', async () => {
      setView('sessions')
      setPaletteOpen(false)
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.app-titlebar-menu-button')?.click()
    })
    // Why a session's terminal does or does not render — the fixture has had
    // real tmux panes all along and the detail screen still says there is no
    // pane to mirror, which has blocked every terminal check so far.
    // The terminal text size, checked the only way it can be: by looking.
    // This sets 17px on a terminal that is already running and leaves it
    // there, so the capture is compared against the same crop at 13px. Every
    // DOM proxy tried here lied — .xterm-rows has no height under the WebGL
    // renderer, and .xterm-helper-textarea is a constant 7.5x15 whatever the
    // terminal is doing. The setting is restored afterwards so the next shot
    // in a batch starts where it expects to.
    registerShotScreen('terminal-font-size', async () => {
      setView('sessions')
      setPaletteOpen(false)
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list.find((s) => s.tmux)?.key ?? list[0]?.key ?? null)
      await new Promise((resolve) => setTimeout(resolve, 800))
      await setAppSettings({ terminalFontSize: 17 })
      await new Promise((resolve) => setTimeout(resolve, 1200))
    })
    registerShotScreen('session-tmux-join', async () => {
      setView('sessions')
      const list = sessions.length > 0 ? sessions : await listSessions()
      const s0 = list[0]
      setOpenSessionKey(s0?.key ?? null)
      await new Promise((resolve) => setTimeout(resolve, 400))
      pushToast(
        `${s0?.record?.title ?? '?'} cwd=${s0?.cwd ?? '?'} tmux=${JSON.stringify(s0?.tmux)}`
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    // Clicks an OSC 8 hyperlink in a real terminal. The link points at a
    // file:// URL, which main refuses and logs — proving our handler ran,
    // without opening anything. If xterm's own handler were still in play a
    // confirm dialog would appear instead and nothing would be logged.
    registerShotScreen('terminal-link-click', async () => {
      setView('sessions')
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list[0]?.key ?? null)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const screenEl = document.querySelector('.xterm-screen')
      if (!screenEl) {
        pushToast('No terminal on screen')
        return
      }
      const rect = screenEl.getBoundingClientRect()
      const rows = document.querySelectorAll('.xterm-rows > div').length || 24
      const cellH = rect.height / rows
      const cols = 80
      const cellW = rect.width / cols
      // Row 1, a few characters into "CLICKME".
      const x = rect.left + cellW * 3.5
      const y = rect.top + cellH * 0.5
      for (const type of ['mousedown', 'mouseup', 'click']) {
        screenEl.dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      pushToast(`Clicked at ${Math.round(x)},${Math.round(y)}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // One of the asks that used to be a system confirm() dialog.
    // Clicking a card on a project page did nothing: the session detail only
    // renders under the Sessions view, and opening stopped switching to it.
    // Scrolls Home to the very bottom and reports the gap between the last
    // card and the end of the scroll. Padding on a flex scroll container is
    // silently dropped, so this measures rather than trusts the stylesheet.
    // Marking a session done has to clear it off Home. That is the whole
    // point of the action, and it is a filter in one file away from silently
    // not happening — so the round trip is exercised rather than assumed.
    registerShotScreen('home-mark-done', async () => {
      setView('home')
      setPaletteOpen(false)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const titles = (): string[] =>
        Array.from(document.querySelectorAll('.cr-session-card-title')).map(
          (el) => el.textContent?.trim() ?? ''
        )
      const before = titles()
      const list = sessions.length > 0 ? sessions : await listSessions()
      const target = list.find(
        (s) => s.record && !s.record.archivedAt && before.includes(s.record.title)
      )
      if (!target?.record) {
        pushToast('no eligible session on Home to mark done')
        return
      }
      const marked = target.record.title
      // Through the card's own menu, not the API behind it: the point of this
      // check is that the control on Home works, and calling archiveSession
      // directly would pass even with no menu on the card at all.
      const card = Array.from(document.querySelectorAll('.cr-session-card-wrap')).find((el) =>
        el.querySelector('.cr-session-card-title')?.textContent?.includes(marked)
      )
      card?.querySelector<HTMLButtonElement>('.cr-icon-button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const item = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.cr-popover-item')
      ).find((el) => /mark as done/i.test(el.textContent ?? ''))
      if (!item) {
        pushToast('no "Mark as done" on the card menu')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
      item.click()
      await new Promise((resolve) => setTimeout(resolve, 600))
      const after = titles()
      pushToast(
        `"${marked}": on Home ${before.length} -> ${after.length} cards, still listed: ${after.includes(marked)}`
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      await unarchiveSession(target.record.id)
      await refreshSessions()
    })
    // The card menu itself, left open.
    // The sessions list row menu, so the third of the three can be compared
    // with the other two.
    registerShotScreen('sessions-row-menu', async () => {
      setView('sessions')
      setPaletteOpen(false)
      await new Promise((resolve) => setTimeout(resolve, 700))
      // The row's own overflow trigger, not the project header's — the first
      // .overflow-menu-button on the page belongs to the project row above.
      // The row's own trigger. `.sessions-row-overflow` is the row's wrapper —
      // matching on .overflow-menu-button alone opened the project header's
      // menu instead, which is a different menu entirely.
      document
        .querySelector('.sessions-row-overflow')
        ?.querySelector<HTMLButtonElement>('.overflow-menu-button')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    registerShotScreen('home-card-menu', async () => {
      setView('home')
      setPaletteOpen(false)
      await new Promise((resolve) => setTimeout(resolve, 600))
      document
        .querySelector('.cr-session-card-wrap')
        ?.querySelector<HTMLButtonElement>('.cr-icon-button')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    // Rename from a card. It is the one action in that menu that needed new
    // UI to exist there at all, so it is the one most likely to be a menu
    // entry that opens nothing.
    registerShotScreen('home-card-rename', async () => {
      setView('home')
      setPaletteOpen(false)
      await new Promise((resolve) => setTimeout(resolve, 600))
      const card = document.querySelector('.cr-session-card-wrap')
      const was = card?.querySelector('.cr-session-card-title')?.textContent?.trim() ?? '?'
      card?.querySelector<HTMLButtonElement>('.cr-icon-button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
      Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-popover-item'))
        .find((el) => /rename/i.test(el.textContent ?? ''))
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const field = document.querySelector<HTMLInputElement>('input[aria-label="Session name"]')
      if (!field) {
        pushToast('Rename opened no dialog')
        return
      }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      setter?.call(field, `${was} renamed`)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 150))
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((el) => el.textContent?.trim() === 'Rename')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 800))
      const now = document.querySelector('.cr-session-card-title')?.textContent?.trim() ?? '?'
      pushToast(`"${was}" -> "${now}"`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // A big text paste becomes a chip, not a wall of text and not an "empty
    // paste" error. Driven through a real paste event on the textarea.
    registerShotScreen('home-paste-text', async () => {
      setView('home')
      setPaletteOpen(false)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const box = document.querySelector<HTMLTextAreaElement>('.home-composer textarea')
      if (!box) {
        pushToast('no composer textarea')
        return
      }
      box.focus()
      const data = new DataTransfer()
      data.setData(
        'text/plain',
        Array.from({ length: 120 }, (_, i) => `line ${i + 1} of a pasted log`).join('\n')
      )
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 900))
      const chip = document.querySelector('.home-attachment-chip-name')?.textContent?.trim()
      pushToast(`chip: "${chip ?? 'none'}" · composer holds ${box.value.length} chars`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    registerShotScreen('home-scrolled', async () => {
      setView('home')
      await new Promise((resolve) => setTimeout(resolve, 400))
      // Which element actually scrolls, rather than which one the stylesheet
      // says should — padding on the wrong element is invisible.
      const scrollers = Array.from(document.querySelectorAll('*'))
        .filter((el) => el.scrollHeight > el.clientHeight + 4)
        .map((el) => `${el.className || el.tagName}:${el.scrollHeight - el.clientHeight}`)
      pushToast(`Scrolling: ${scrollers.join(' | ').slice(0, 220)}`)
      const scroller = document.querySelector('.home-screen')
      if (!scroller) {
        pushToast('No home scroller')
        return
      }
      scroller.scrollTop = scroller.scrollHeight
      await new Promise((resolve) => setTimeout(resolve, 200))
      const cards = document.querySelectorAll('.cr-session-card')
      const last = cards[cards.length - 1]
      const gap = last
        ? Math.round(scroller.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom)
        : -1
      pushToast(`Gap below last card: ${gap}px`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // Home with a project picked and New worktree selected — the branch box
    // only exists in that state.
    // Creates a session on a new worktree and reports whether the branch and
    // directory actually appeared. This is the path that failed with "branch
    // 'session/…' not found locally or on origin".
    // A sweep of the creation flows as a user drives them, through the
    // composer rather than the API behind it. Each check reports its own
    // toast, so the capture carries the whole run.
    // The starting-up state, caught in the window between the record existing
    // and discovery joining its pane. That window is exactly where "Not
    // running" used to be shown.
    // ⌘⏎ must start the session wherever focus is in the composer. Bound to
    // the prompt box alone, it stopped working the moment you touched the
    // branch field or the run-location switch.
    registerShotScreen('composer-cmd-enter', async () => {
      const results: string[] = []
      for (const spot of ['textarea', 'branch', 'switch']) {
        // The project page's composer: the branch field and the run-location
        // switch only exist once a project is chosen, and those are two of the
        // three places focus can be.
        await landOnProjectDetail(undefined)
        await new Promise((resolve) => setTimeout(resolve, 900))
        const box = document.querySelector<HTMLTextAreaElement>('.home-composer textarea')
        if (!box) {
          results.push(`${spot}: no composer`)
          continue
        }
        Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-segmented__option'))
          .find((el) => /new worktree/i.test(el.textContent ?? ''))
          ?.click()
        await new Promise((resolve) => setTimeout(resolve, 200))
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
          box,
          `cmd-enter from ${spot}`
        )
        box.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 200))

        const target =
          spot === 'textarea'
            ? box
            : spot === 'branch'
              ? document.querySelector<HTMLElement>('.home-branch-input')
              : Array.from(
                  document.querySelectorAll<HTMLButtonElement>('.cr-segmented__option')
                ).find((el) => /new worktree/i.test(el.textContent ?? ''))
        if (!target) {
          results.push(`${spot}: not found`)
          continue
        }
        target.focus()
        // A session either got made or it did not. The button's label is no
        // use as the observable: on success the app navigates to the new
        // session, so the composer — and its button — is gone either way.
        const before = (await listSessions()).length
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
        )
        await new Promise((resolve) => setTimeout(resolve, 4000))
        const after = (await listSessions()).length
        results.push(`${spot}: ${after > before ? 'started' : 'NOTHING HAPPENED'}`)
      }
      pushToast(results.join('  |  '))
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    registerShotScreen('session-starting', async () => {
      const list = projects.length > 0 ? projects : await listProjects()
      const project = list.find((p) => p.id !== 'general')
      if (!project) return pushToast('no project')
      const result = await createSession({
        creationId: crypto.randomUUID(),
        projectId: project.id,
        basedOn: 'new'
      })
      if (!result.ok || !result.record) return pushToast(`create failed: ${result.error}`)
      setView('sessions')
      await refreshSessions()
      setOpenSessionKey(`record:${result.record.id}`)
      // Deliberately short: discovery runs on a 2s poll, so waiting for it
      // would photograph the terminal instead of the state under test.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const live = (await listSessions()).find((x) => x.record?.id === result.record?.id)
      pushToast(
        live
          ? `tmuxWindowId=${Boolean(live.record?.tmuxWindowId)} tmux=${Boolean(live.tmux)} alive=${live.alive} status=${live.status} reason=${live.record?.waitingReason ?? 'none'}`
          : 'no live session for the new record'
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    registerShotScreen('flows-create', async () => {
      const say = (m: string): void => pushToast(m)
      const list = projects.length > 0 ? projects : await listProjects()
      const project = list.find((p) => p.id !== 'general')
      if (!project) return say('no project to create in')

      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 900))

      const type = (text: string): boolean => {
        const box = document.querySelector<HTMLTextAreaElement>('.home-composer textarea')
        if (!box) return false
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
          box,
          text
        )
        box.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      const fill = (sel: string, text: string): boolean => {
        const el = document.querySelector<HTMLInputElement>(sel)
        if (!el) return false
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
          el,
          text
        )
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      const pick = (label: RegExp): void => {
        Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-segmented__option'))
          .find((el) => label.test(el.textContent ?? ''))
          ?.click()
      }
      const start = (): void => {
        Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
          .find((el) => /^Start in/.test(el.textContent?.trim() ?? ''))
          ?.click()
      }
      const countBefore = (await listSessions()).length

      // 1. Worktree session with a branch name of our own.
      const named = `sweep/${Date.now().toString(36)}`
      if (!type('sweep: worktree with a named branch'))
        return say('no composer on the project page')
      pick(/new worktree/i)
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (!fill('.home-branch-input', named)) say('no branch field in worktree mode')
      await new Promise((resolve) => setTimeout(resolve, 200))
      start()
      await new Promise((resolve) => setTimeout(resolve, 6000))
      const after1 = await listSessions()
      const made = after1.find((x) => x.record?.branch === named)
      say(`named worktree: ${made ? `ok on ${made.record?.branch}` : 'NOT CREATED'}`)

      // 2. The same branch name again — must fail cleanly, not half-create.
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 900))
      type('sweep: duplicate branch name')
      pick(/new worktree/i)
      await new Promise((resolve) => setTimeout(resolve, 200))
      fill('.home-branch-input', named)
      await new Promise((resolve) => setTimeout(resolve, 200))
      start()
      await new Promise((resolve) => setTimeout(resolve, 6000))
      const err = document.querySelector('.home-composer-error')?.textContent?.trim()
      const after2 = await listSessions()
      say(`duplicate branch (${after2.length - after1.length} new): ${err ?? 'NO ERROR SHOWN'}`)

      // 3. This-checkout session.
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 900))
      type('sweep: investigate in the checkout')
      pick(/this checkout/i)
      await new Promise((resolve) => setTimeout(resolve, 200))
      start()
      await new Promise((resolve) => setTimeout(resolve, 6000))
      const after3 = await listSessions()
      say(
        `checkout session: ${after3.length - after2.length} new (total ${after3.length - countBefore} this run)`
      )
      await refreshSessions()
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    // Resume and delete, driven from the UI. Delete is the destructive one,
    // so it is checked against the filesystem afterwards, not just the list.
    registerShotScreen('flows-lifecycle', async () => {
      const results: string[] = []
      const say = (m: string): void => {
        results.push(m)
      }
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 900))
      const scroller = document.querySelector('.project-detail')
      scroller?.scrollTo(0, scroller.scrollHeight)
      await new Promise((resolve) => setTimeout(resolve, 400))

      // Resume, from History's Done tab.
      const tab = (label: RegExp): void => {
        Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-segmented__option'))
          .find((el) => label.test(el.textContent?.trim() ?? ''))
          ?.click()
      }
      tab(/^Done/)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const resume = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (el) => el.textContent?.trim() === 'Resume'
      )
      if (!resume) {
        say('resume: no Resume button under Done')
      } else {
        resume.click()
        await new Promise((resolve) => setTimeout(resolve, 25000))
        tab(/^Done/)
        await new Promise((resolve) => setTimeout(resolve, 300))
        const counts = Array.from(document.querySelectorAll('.cr-segmented__option'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((t) => /^(Active|Done|Ended)/.test(t))
          .join(' · ')
        say(`resume: ${counts}`)
      }

      // Delete, from a card menu on the Active board.
      scroller?.scrollTo(0, 0)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const card = document.querySelector('.cr-session-card-wrap')
      const title = card?.querySelector('.cr-session-card-title')?.textContent?.trim() ?? '?'
      card?.querySelector<HTMLButtonElement>('.cr-icon-button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-popover-item'))
        .find((el) => /^Delete/.test(el.textContent?.trim() ?? ''))
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 600))
      // The fixture's worktrees carry uncommitted changes on purpose, so the
      // dialog refuses until this is ticked. That refusal is the guard working;
      // tick it so the destructive path itself gets exercised.
      const discard = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      ).find((el) => /discard/i.test(el.closest('label')?.textContent ?? ''))
      if (discard && !discard.checked) discard.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (el) => /^Confirm delete$/.test(el.textContent?.trim() ?? '')
      )
      if (!confirm) {
        say('delete: no confirm button in the dialog')
      } else {
        confirm.click()
        await new Promise((resolve) => setTimeout(resolve, 5000))
        // A deleted record is kept on purpose, so the check is where it
        // lands, not whether it survived: Ended, never Done.
        const rec = (await listSessions()).find((x) => x.record?.title === title)?.record
        say(
          `delete "${title}": ${rec ? `kept, deletedAt=${Boolean(rec.deletedAt)}` : 'record gone'}`
        )
      }
      await refreshSessions()
      // Where a deleted session lands, and that it is not offered a Resume it
      // could only fail at.
      scroller?.scrollTo(0, scroller.scrollHeight)
      await new Promise((resolve) => setTimeout(resolve, 500))
      tab(/^Ended/)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const rows = Array.from(document.querySelectorAll('.history-row, .cr-history-row'))
      const endedText = document.querySelector('.history-list, .cr-history-list')?.textContent ?? ''
      say(
        `ended tab: has "${title}" = ${endedText.includes(title)}, resume offered = ${/Resume/.test(endedText)} (${rows.length} rows)`
      )
      pushToast(results.join('  |  '))
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    registerShotScreen('create-worktree-session', async () => {
      const list = projects.length > 0 ? projects : await listProjects()
      const project = list.find((p) => p.id !== 'general')
      if (!project) {
        pushToast('No project to create in')
        return
      }
      const result = await createSession({
        creationId: crypto.randomUUID(),
        projectId: project.id,
        basedOn: 'new',
        prompt: undefined
      })
      pushToast(
        result.ok
          ? `Created on ${result.record?.branch ?? '?'} at ${result.record?.worktreePath ?? '?'}`
          : `Failed: ${result.error}`
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    registerShotScreen('home-worktree', async () => {
      setView('home')
      await new Promise((resolve) => setTimeout(resolve, 400))
      document.querySelector<HTMLButtonElement>('.home-add-project-pill')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      document.querySelector<HTMLButtonElement>('.home-composer-popover-item')?.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const segs = (): HTMLButtonElement[] =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-segmented__option'))
      const worktreeX = (): number =>
        Math.round(
          segs()
            .find((el) => /new worktree/i.test(el.textContent ?? ''))
            ?.getBoundingClientRect().left ?? -1
        )
      // The switch must not move when you use it. This row is centred, so a
      // branch field that appears in one mode and not the other used to shift
      // both options ~114px sideways: the one you just clicked slid out from
      // under the pointer. Reported rather than eyeballed, because eyeballing
      // a screenshot is exactly what missed it.
      // Toggle to "This checkout" and back: the composer already opens in
      // worktree mode, so clicking "New worktree" is a no-op that moves
      // nothing and measures nothing.
      const before = worktreeX()
      segs()
        .find((el) => /this checkout/i.test(el.textContent ?? ''))
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      const during = worktreeX()
      segs()
        .find((el) => /new worktree/i.test(el.textContent ?? ''))
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      pushToast(`"New worktree" left: ${before} -> ${during} -> ${worktreeX()}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // Marking a session done has to move its row out of History's Active tab
    // then and there. The list is loaded once per project, so a refresh that
    // reloads live sessions instead of records leaves the row sitting exactly
    // where it was — which is what was reported.
    registerShotScreen('history-mark-done', async () => {
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 600))
      const scroller = document.querySelector('.project-detail')
      scroller?.scrollTo(0, scroller.scrollHeight)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const counts = (): string =>
        Array.from(document.querySelectorAll('.cr-segmented__option'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((t) => /^(Active|Done|Ended)/.test(t))
          .join(' · ')
      const before = counts()
      const markDone = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (el) => el.textContent?.trim() === 'Mark done'
      )
      if (!markDone) {
        pushToast('no "Mark done" button in History')
        return
      }
      markDone.click()
      await new Promise((resolve) => setTimeout(resolve, 800))
      pushToast(`${before}  ->  ${counts()}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    registerShotScreen('history-done', async () => {
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const scroller = document.querySelector('.project-detail')
      scroller?.scrollTo(0, scroller.scrollHeight)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-segmented__option'))
      const doneTab = tabs.find((el) => /^done/i.test(el.textContent?.trim() ?? ''))
      doneTab?.click()
      // Says so rather than photographing whichever tab was already selected,
      // which is what the old /archived/ match quietly started doing the
      // moment the tab was renamed.
      if (!doneTab) console.error('dev-shot: no "Done" tab to click')
      await new Promise((resolve) => setTimeout(resolve, 250))
      scroller?.scrollTo(0, scroller.scrollHeight)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    registerShotScreen('project-scrolled', async () => {
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const scroller = document.querySelector('.project-detail')
      if (!scroller) {
        pushToast('No project scroller')
        return
      }
      scroller.scrollTop = scroller.scrollHeight
      await new Promise((resolve) => setTimeout(resolve, 200))
      const last = scroller.lastElementChild
      const gap = last
        ? Math.round(scroller.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom)
        : -1
      pushToast(`Gap below last section: ${gap}px`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    registerShotScreen('open-from-project', async () => {
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 400))
      document.querySelector<HTMLButtonElement>('.cr-session-card')?.click()
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    registerShotScreen('confirm-remove-project', async () => {
      setView('sessions')
      setPaletteOpen(false)
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.overflow-menu-button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.overflow-menu-item'))
      items.find((el) => /remove/i.test(el.textContent ?? ''))?.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    registerShotScreen('confirm-dialog', async () => {
      await landOnProjectDetail(undefined)
      await new Promise((resolve) => setTimeout(resolve, 400))
      document.querySelector<HTMLButtonElement>('.cr-session-card-menu button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.cr-popover-item'))
      items.find((el) => /delete/i.test(el.textContent ?? ''))?.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    registerShotScreen('session-detail-resumable', async () => {
      setView('sessions')
      setPaletteOpen(false)
      const list = sessions.length > 0 ? sessions : await listSessions()
      const resumable = list.find((s) => s.record?.id === 'fixture-rec-resumable')
      setOpenSessionKey(resumable?.key ?? list[0]?.key ?? null)
    })
    // Plan 4 Part 10 verification — expanded terminal, same screen, plus a
    // synthetic ⌘⏎ (SessionDetail's own maximize shortcut) so the shot
    // harness can capture the expanded state without a private test rig.
    registerShotScreen('session-detail-maximized', async () => {
      setView('sessions')
      setPaletteOpen(false)
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list[0]?.key ?? null)
      await new Promise((resolve) => setTimeout(resolve, 300))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }))
    })
    // Verification shots for plan 4 Part 7.2/7.4 — these two panels are
    // collapsed/closed by default, so land on the screen, wait a tick for
    // the first render, then simulate the same click a person would make to
    // open them, rather than adding a private "start open" test-only prop.
    registerShotScreen('project-detail-worktree-settings', async () => {
      setView('projects')
      setOpenSessionKey(null)
      setPaletteOpen(false)
      setShotProjectTab(undefined)
      setShotHistoryTab(undefined)
      const list = projects.length > 0 ? projects : await listProjects()
      setOpenProjectId(list[0]?.id ?? null)
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Matched on the visible label, which CSS uppercases — so match it
      // case-insensitively rather than on a shape the DOM never had.
      const toggle = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.cr-disclosure-header')
      ).find((el) => /worktree settings/i.test(el.textContent ?? ''))
      toggle?.click()
    })
    // The diff overlay. The fixture's `feature-working` worktree carries a real
    // multi-file diff (added, modified, deleted, untracked) so this shot shows
    // every box shape the overlay has to render.
    registerShotScreen('session-diff', async () => {
      setView('sessions')
      setPaletteOpen(false)
      const list = sessions.length > 0 ? sessions : await listSessions()
      const withDiff = list.find((s) => s.record?.branch === 'fixture/working') ?? list[0]
      setOpenSessionKey(withDiff?.key ?? null)
      await new Promise((resolve) => setTimeout(resolve, 600))
      document.querySelector<HTMLButtonElement>('button[aria-label="View diff"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 900))
      // Expand first: above five files the overlay opens collapsed, so a
      // measurement taken as-is reports six headers that fit comfortably and
      // says nothing about whether the thing scrolls.
      const expand = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Expand all'
      )
      expand?.click()
      await new Promise((resolve) => setTimeout(resolve, 400))
      // Reports which element actually scrolls. A panel whose body does not
      // overflow looks identical in a screenshot to one whose scroll container
      // is broken, and the fixture's diff used to be too small to tell them
      // apart at all.
      const report = (sel: string): string => {
        const el = document.querySelector(sel)
        if (!el) return `${sel}: missing`
        return `${sel}: ${el.scrollHeight}/${el.clientHeight}`
      }
      // The longest file's own patch too: it is capped and scrolls inside, so
      // there are two scroll containers here and either one can break alone.
      const patches = Array.from(document.querySelectorAll('.diff-file-patch'))
      const longest = patches.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
      pushToast(
        [
          report('.diff-overlay-body'),
          longest ? `longest patch: ${longest.scrollHeight}/${longest.clientHeight}` : 'no patches'
        ].join('  ')
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    registerShotScreen('session-detail-context-window', async () => {
      setView('sessions')
      setPaletteOpen(false)
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list[0]?.key ?? null)
      await new Promise((resolve) => setTimeout(resolve, 600))
      const button = document.querySelector<HTMLButtonElement>('.session-detail-context-button')
      button?.click()
    })
    // Verification shots for the Modal-conversion milestone (delete/add-rule/
    // new-skill/keyboard-help dialogs) — none of these four had a shot entry
    // before, so there was no way to look at them in the real app.
    registerShotScreen('delete-session-dialog', async () => {
      setView('sessions')
      setPaletteOpen(false)
      const list = sessions.length > 0 ? sessions : await listSessions()
      setOpenSessionKey(list[0]?.key ?? null)
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      document.querySelector<HTMLButtonElement>('.session-detail-menu-destructive')?.click()
    })
    registerShotScreen('add-rule-dialog', async () => {
      await landOnProjectDetail('rules')
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.rules-tab-add-button')?.click()
    })
    registerShotScreen('new-skill-dialog', async () => {
      await landOnProjectDetail('skills')
      await new Promise((resolve) => setTimeout(resolve, 300))
      document.querySelector<HTMLButtonElement>('.skills-tab-new-button')?.click()
    })
    registerShotScreen('keyboard-help', () => {
      setView('sessions')
      setOpenSessionKey(null)
      setPaletteOpen(false)
      setKeyboardHelpOpen(true)
    })
    registerShotScreen('grid', () => {
      setView('sessions')
      setOpenSessionKey(null)
      setGridView(true)
      setPaletteOpen(false)
    })
    registerShotScreen('gallery', () => {
      setView('gallery')
      setPaletteOpen(false)
    })
    registerShotScreen('settings', () => {
      setView('settings')
      setPaletteOpen(false)
    })
    registerShotScreen('command-palette', () => {
      setView('sessions')
      setOpenSessionKey(null)
      setPaletteOpen(true)
    })
    // Route through the theme controller (not a raw DOM attribute write) so
    // it doesn't race with ThemeProvider's own settings-driven effect.
    initShotListener((themeId) => theme.setTheme(themeId))
  }, [
    sessions,
    theme,
    projects,
    pushToast,
    refreshSessions,
    refreshProjects,
    setOpenTabs,
    openSessionByKey
  ])

  // Accepts an optional target session — the sessions list's own per-row
  // overflow menu acts on the row it's attached to, not whichever session
  // happens to be "current" (open or last-opened); every other call site
  // (palette, keyboard shortcut) omits it and keeps acting on currentSession.
  const handleOpenInIde = useCallback(
    async (target?: LiveSession) => {
      const session = target ?? currentSession
      if (!session?.record) {
        pushToast('No session selected to open in IDE.')
        return
      }
      const result = await openSessionInIde(session.record.id)
      if (!result.ok) pushToast(result.error ?? 'Could not open in Cursor.')
    },
    [currentSession, pushToast]
  )

  const handleFocusTerminal = useCallback(
    async (target?: LiveSession) => {
      const session = target ?? currentSession
      if (!session?.record) {
        pushToast('No session selected to focus.')
        return
      }
      const result = await focusSessionTerminal(session.record.id)
      if (!result.ok) {
        pushToast(
          result.noClients
            ? `No terminal is attached to tmux. Run: tmux attach -t ${result.tmuxSessionName}`
            : (result.error ?? 'Failed to focus terminal.')
        )
      }
    },
    [currentSession, pushToast]
  )

  const handleInstallHooks = useCallback(async () => {
    const result = await installHooks()
    pushToast(result.ok ? 'Hooks installed.' : (result.error ?? 'Failed to install hooks.'))
  }, [pushToast])

  const handleOpenDataFolder = useCallback(async () => {
    const error = await openDataFolder()
    if (error) pushToast(error)
  }, [pushToast])

  // The first click on Sessions returns you to the session you were in; a
  // second, while you're in it, goes up to the list — the same for a
  // project page under Projects. A click on where you already are should
  // still do something, and "up a level" is the only thing it can mean.
  const handleSelectView = useCallback(
    (next: MainView) => {
      if (next === view) {
        if (next === 'sessions') setOpenSessionKey(null)
        if (next === 'projects') setOpenProjectId(null)
        return
      }
      setView(next)
    },
    [view]
  )

  const handleSelectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId)
    setView('projects')
  }, [])

  // The Sessions view's own left rail (ProjectRail, not the Projects tab
  // above) — selecting a project there means "show that project's sessions,"
  // everywhere else in the app. Setting the filter alone used to leave a
  // stale SessionDetail or GridView on screen (openSessionKey/gridView both
  // sit ahead of the plain filtered list in the view switch below), so the
  // click looked like it did nothing. Clearing both here — for "All", a
  // named project, or the project you're already filtered to — always drops
  // back onto the filtered SessionsScreen.
  // The bell: every unread session, whatever filter or project you had on.
  const handleShowUnread = useCallback(() => {
    setUnreadOnly(true)
    setStatusFilter(null)
    setSelectedProjectId(null)
    setOpenSessionKey(null)
    setGridView(false)
    setView('sessions')
  }, [setUnreadOnly, setStatusFilter])

  const handleSelectRailProject = useCallback((projectId: string | null) => {
    // Picking a project is an explicit "show me this instead", so it clears the
    // attention filter rather than silently intersecting with it.
    setSelectedProjectId(projectId)
    setOpenSessionKey(null)
    setGridView(false)
  }, [])

  // J / K: move keyboard focus through the sessions on screen, in the order
  // you see them — list rows, grid cards, Home's cards — and Enter opens the
  // focused one (every session item already opens on Enter). This used to
  // move an invisible index into the unsorted session array, so the "next"
  // session was whichever came next in memory, and nothing showed which.
  const moveSessionFocus = useCallback(
    (delta: number) => {
      if (paletteOpen || keyboardHelpOpen || showNewSessionForm) return
      const items = [
        ...document.querySelectorAll<HTMLElement>('[data-session-item], [data-nav-item]')
      ].filter((el) => el.offsetParent !== null && !el.closest('[aria-hidden="true"]'))
      if (items.length === 0) return
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next =
        current === -1
          ? delta > 0
            ? 0
            : items.length - 1
          : Math.min(Math.max(current + delta, 0), items.length - 1)
      items[next].focus()
      items[next].scrollIntoView({ block: 'nearest' })
      // Say so directly too: focus events wait while the window is in the
      // background, and a list's open panel follows this (Backlog's peek).
      items[next].dispatchEvent(new CustomEvent('cr:nav-focus', { bubbles: true }))
    },
    [paletteOpen, keyboardHelpOpen, showNewSessionForm]
  )

  useKeyboardMap({
    palette: () => setPaletteOpen(true),
    projects: () => setView('projects'),
    sessions: () => setView('sessions'),
    'new-session': () => setShowNewSessionForm(true),
    'open-ide': handleOpenInIde,
    'focus-terminal': handleFocusTerminal,
    grid: () => {
      setView('sessions')
      setOpenSessionKey(null)
      setGridView((v) => !v)
    },
    back: () => travelTo(-1),
    forward: () => travelTo(1),
    'next-tab': () => stepTab(1),
    'prev-tab': () => stepTab(-1),
    // ⌘9 is the last tab however many there are, as in a browser.
    'jump-tab': (index) => {
      const target = index === 8 ? tabSessions[tabSessions.length - 1] : tabSessions[index]
      if (target) openSessionByKey(target.key)
    },
    // The composer; the session it starts opens as a tab of its own, next to
    // the one you were on (see the tab effect).
    'new-tab': () => setShowNewSessionForm(true),
    'home-tab': goToSessionsList,
    'toggle-sidebar': () => {
      // No rail on this view, so nothing to toggle — flipping the flag here
      // would just surprise the user the next time they opened Sessions.
      if (view !== 'sessions' && view !== 'backlog') return
      toggleSidebar()
    },
    help: () => setKeyboardHelpOpen((v) => !v),
    settings: () => setView('settings'),
    'move-down': () => moveSessionFocus(1),
    'move-up': () => moveSessionFocus(-1)
  })

  return (
    <div className="app-root" data-shell-size={shellSize} ref={appRootRef}>
      <AppShell
        view={view}
        onSelectView={handleSelectView}
        sessions={sessions}
        size={shellSize}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setView('settings')}
        onInstallHooks={handleInstallHooks}
        onOpenDataFolder={handleOpenDataFolder}
        onNewSession={() => setShowNewSessionForm(true)}
        onToggleHistory={() => setPaletteOpen(true)}
        onShowUnread={handleShowUnread}
        onToggleSidebar={toggleSidebar}
        sidebarHidden={sidebarHidden}
        sidebarAvailable={view === 'sessions' || view === 'backlog'}
        onViewSessions={() => {
          setView('sessions')
          setOpenProjectId(null)
          setSelectedProjectId(null)
        }}
        onToggleGridView={() => {
          setView('sessions')
          setOpenSessionKey(null)
          setGridView((v) => !v)
        }}
        gridViewActive={gridView}
        onOpenKeyboardHelp={() => setKeyboardHelpOpen(true)}
      />

      <div className="app-layout">
        {view === 'sessions' && !sidebarHidden && (
          <div className="sidebar-column" style={{ flexBasis: `${sidebarWidth}px` }}>
            <ProjectRail
              projects={projects}
              sessions={sessions}
              selectedProjectId={selectedProjectId}
              onSelectProject={handleSelectRailProject}
              onProjectsChanged={refreshProjects}
              onNewSession={() => setShowNewSessionForm(true)}
              onOpenSession={openSessionFrom}
              openSessionKey={openSessionKey}
            />
            <div
              className="sidebar-resize-handle"
              onPointerDown={startSidebarResize}
              onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
            />
          </div>
        )}

        {/* Names the screen actually on show. The shot harness reports this
            back to main, so a capture of the wrong screen is visible in the
            run output rather than only in the image. */}
        <div className="main-pane" data-screen={view}>
          {view === 'home' ? (
            <HomeScreen
              onSessionCreated={(record) => {
                refreshSessions()
                // `LiveSession.key` comes from sessionIdentityCandidates()
                // (engine/status.ts), which puts `record:<id>` first whenever a
                // record exists — and a session we just created always has one.
                // Building the key any other way here matched nothing, so Start
                // silently dropped you back on the Sessions list.
                openSessionByKey(`record:${record.id}`)
              }}
              onViewAllProjects={() => setView('projects')}
              sessions={sessions}
              onOpenSession={openSessionFrom}
              onViewAllSessions={() => setView('sessions')}
              onSessionsChanged={refreshSessions}
              pushToast={pushToast}
            />
          ) : view === 'backlog' ? (
            <BacklogScreen
              sidebarHidden={sidebarHidden}
              sidebarWidth={sidebarWidth}
              onSidebarResizeStart={startSidebarResize}
              onSidebarResizeReset={() => setSidebarWidth(SIDEBAR_DEFAULT)}
              sessions={sessions}
              pushToast={pushToast}
              onOpenSession={openSessionByKey}
              openTicket={openTicket}
              onTicketOpened={clearOpenTicket}
              onStartSession={(seed) => {
                setComposerSeed(seed)
                setShowNewSessionForm(true)
              }}
            />
          ) : view === 'settings' ? (
            <SettingsScreen theme={theme} />
          ) : view === 'gallery' ? (
            <PrimitivesGallery />
          ) : view === 'projects' ? (
            openProjectId && projects.find((p) => p.id === openProjectId) ? (
              <ProjectDetail
                project={projects.find((p) => p.id === openProjectId)!}
                sessions={sessions}
                onBack={() => setOpenProjectId(null)}
                onSessionsChanged={refreshSessions}
                onProjectsChanged={refreshProjects}
                onOpenSession={openSessionFrom}
                pushToast={pushToast}
                initialTab={shotProjectTab}
                initialHistoryTab={shotHistoryTab}
              />
            ) : (
              <ProjectsListScreen
                projects={projects}
                sessions={sessions}
                onProjectsChanged={refreshProjects}
                onOpenProject={setOpenProjectId}
                pushToast={pushToast}
              />
            )
          ) : (
            // Sessions: one strip of tabs, the list pinned first under a house.
            // The list stays mounted beneath an open session (hidden, not
            // removed), so its filters, sort and scroll are where you left
            // them when you come back — switching tabs, not reloading a page.
            <div className="cr-session-screen">
              <SessionTabs
                tabs={tabSessions}
                activeKey={openSession?.key ?? null}
                homeUnread={sessions.filter((s) => s.unread).length}
                onHome={goToSessionsList}
                onSelect={openSessionByKey}
                onClose={closeTab}
                onCloseOthers={closeOtherTabs}
                onCloseToRight={closeTabsToRight}
                onReorder={reorderTabs}
                onChanged={refreshSessions}
                onReopenClosed={reopenableKey ? reopenClosedTab : undefined}
                pushToast={pushToast}
              />
              <div className="cr-session-body">
                <div
                  className={
                    openSession ? 'cr-sessions-home cr-sessions-home--behind' : 'cr-sessions-home'
                  }
                  aria-hidden={openSession ? true : undefined}
                >
                  {gridView ? (
                    // Grid tiles poll their panes; no point while hidden.
                    !openSession && (
                      <GridView
                        sessions={sessions}
                        projects={projects}
                        onOpenSession={openSessionFrom}
                        onExitGrid={() => setGridView(false)}
                      />
                    )
                  ) : (
                    <SessionsScreen
                      sessions={sessions}
                      projects={projects}
                      selectedProjectId={selectedProjectId}
                      pushToast={pushToast}
                      unreadOnly={unreadOnly}
                      onUnreadOnlyChange={setUnreadOnly}
                      statusFilter={statusFilter}
                      onStatusFilterChange={setStatusFilter}
                      onAdopted={refreshSessions}
                      onOpenSession={openSessionFrom}
                      onClearFilter={() => {
                        setSelectedProjectId(null)
                      }}
                      onNewSession={(projectId) => {
                        setNewSessionProjectId(projectId ?? null)
                        setShowNewSessionForm(true)
                      }}
                      onProjectsChanged={refreshProjects}
                      onOpenInIde={handleOpenInIde}
                      onFocusTerminal={handleFocusTerminal}
                    />
                  )}
                </div>
                {openSession && (
                  <SessionDetail
                    // A fresh detail per tab, so nothing — a half-typed rename,
                    // an open menu, the terminal — carries over from the last.
                    key={openSession.key}
                    session={openSession}
                    projectName={
                      projects.find((p) => p.id === openSession.record?.projectId)?.name ??
                      projects.find(
                        (p) =>
                          openSession.cwd === p.repoPath ||
                          openSession.cwd.startsWith(`${p.worktreeRoot}/`)
                      )?.name ??
                      null
                    }
                    // Deleted or ended from inside: its tab goes with it.
                    onClose={() => closeTab(openSession.key)}
                    onDeleted={refreshSessions}
                    onSessionUpdated={refreshSessions}
                    pushToast={pushToast}
                    // Opens over the session, so you stay in it; the panel's
                    // "Open on Backlog" carries on there.
                    onOpenTicket={setPeekTicket}
                  />
                )}
                {openSession && peekTicket && (
                  <BacklogScreen
                    panelOnly
                    sessions={sessions}
                    pushToast={pushToast}
                    onOpenSession={openSessionByKey}
                    openTicket={peekTicket}
                    onPanelClose={() => setPeekTicket(null)}
                    onExpand={(key) => {
                      setPeekTicket(null)
                      setOpenTicket(key)
                      setOpenSessionKey(null)
                      setGridView(false)
                      setView('backlog')
                    }}
                    onStartSession={(seed) => {
                      setPeekTicket(null)
                      setComposerSeed(seed)
                      setShowNewSessionForm(true)
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {(() => {
        const card = sessions.find((s) => s.key === externalCardKey)
        if (!card) return null
        const title = card.record?.title ?? card.agentName ?? card.cwd
        const attach = card.backgroundAgentId ? `claude attach ${card.backgroundAgentId}` : null
        return (
          <Modal title={title} icon="Terminal" width={520} onClose={() => setExternalCardKey(null)}>
            <div className="cr-external-card">
              <Badge status={card.status} variant="bare" />
              <p className="cr-external-card-path">{card.cwd}</p>
              <p>
                {card.backgroundAgentId
                  ? 'A background agent, with no terminal of its own. Attach to it from any terminal to pick it up.'
                  : 'Running in a terminal Control Room didn’t start, so there’s no terminal to show here. Switch to that terminal to use it.'}
              </p>
              {attach && <code className="cr-external-card-command">{attach}</code>}
              <div className="cr-external-card-actions">
                {attach && (
                  <Button
                    variant="outlined"
                    onClick={() => {
                      void navigator.clipboard.writeText(attach)
                      pushToast('Attach command copied.')
                    }}
                  >
                    Copy command
                  </Button>
                )}
                <Button variant="filled" onClick={() => setExternalCardKey(null)}>
                  Done
                </Button>
              </div>
            </div>
          </Modal>
        )
      })()}

      {showNewSessionForm && (
        <Modal
          title={composerSeed ? composerSeed.title : 'New session'}
          icon="Plus"
          // 720, not 680: the chip row underneath carries a project name, the
          // run-location switch and the branch field, and at 680 it had to
          // wrap even with a short project name.
          width={720}
          onClose={() => {
            setShowNewSessionForm(false)
            setNewSessionProjectId(null)
            setComposerSeed(null)
            setPaletteBranchSeed(null)
          }}
        >
          <HomeScreen
            variant="sheet"
            initialProjectId={
              composerSeed
                ? (repoForJiraProject[composerSeed.jiraProject] ?? newSessionProjectId)
                : (paletteBranchSeed?.projectId ?? newSessionProjectId)
            }
            initialPrompt={composerSeed?.prompt}
            initialBranch={composerSeed?.branch}
            initialRunBranch={paletteBranchSeed?.branch}
            initialTitle={composerSeed?.title}
            onSessionCreated={(record) => {
              // Next time, an issue from this Jira project starts in this repo.
              if (composerSeed) {
                setRepoForJiraProject({
                  ...repoForJiraProject,
                  [composerSeed.jiraProject]: record.projectId
                })
              }
              setComposerSeed(null)
              setPaletteBranchSeed(null)
              setShowNewSessionForm(false)
              setNewSessionProjectId(null)
              refreshSessions()
              openSessionByKey(`record:${record.id}`)
              // The sheet closing and a screen changing underneath is not, on its
              // own, confirmation that anything happened. Say so.
              pushToast(`Session created: ${record.title}. The agent is starting.`)
            }}
          />
        </Modal>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
        projects={projects}
        onSelectSession={openSessionByKey}
        openTabKeys={tabSessions.map((s) => s.key)}
        onReopenClosedTab={reopenableKey ? reopenClosedTab : undefined}
        onSelectProject={handleSelectProject}
        currentThemeId={theme.themeId}
        onSelectTheme={theme.setTheme}
        onNewSession={() => setShowNewSessionForm(true)}
        onOpenInIde={handleOpenInIde}
        onFocusTerminal={handleFocusTerminal}
        onInstallHooks={handleInstallHooks}
        onOpenSettings={() => setView('settings')}
        onOpenDataFolder={handleOpenDataFolder}
        onOpenKeyboardHelp={() => setKeyboardHelpOpen(true)}
        onSelectTicket={(key) => {
          // Same path as a session header's ticket pill (onOpenTicket below).
          setOpenTicket(key)
          setOpenSessionKey(null)
          setGridView(false)
          setView('backlog')
        }}
        onSelectBranch={(projectId, branch) => {
          setPaletteBranchSeed({ projectId, branch })
          setShowNewSessionForm(true)
        }}
      />

      {keyboardHelpOpen && <KeyboardHelp onClose={() => setKeyboardHelpOpen(false)} />}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <div className="toast-body">
              <span className="toast-message">{toast.message}</span>
              {toast.action && (
                <button type="button" className="toast-action" onClick={toast.action.onClick}>
                  {toast.action.label}
                </button>
              )}
            </div>
            <IconButton
              icon="X"
              label="Dismiss"
              size={28}
              variant="ghost"
              onClick={() => dismissToast(toast.id)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
