import { useCallback, useEffect, useRef, useState } from 'react'
import Terminal, { type TerminalHandle } from './Terminal'
import PaneOutput from './PaneOutput'
import { IconButton, SegmentedControl, type SegmentedOption } from './primitives'
import {
  splitTerminalPane,
  focusTerminalPane,
  closeTerminalPane,
  listTerminalWindowPanes
} from '../api'
import './terminal-frame.css'

// Plan 7, Stage B5 — terminal fills the session detail pane edge to edge,
// with focus hint moved below. The raw xterm surface lives in Terminal.tsx;
// this file only handles layout (maximize/shrink). tmux's own status bar is
// hidden in the grouped view session by src/main/exec/tmux-pty.ts, once, when
// that session is created — there is nothing to do here per-render.
//
// Plan 7 — "add a second tmux window" (a plain shell beside the agent, same
// worktree). It's a split of the session's *own* window (exec/tmux.ts owns
// why), not a real second window, and that one extra pane is presented as a
// second tab rather than a permanent side-by-side split: this component's
// single Terminal/xterm surface is already attached to the whole window, so
// a real split would render both panes inside it at once, and a second
// xterm for the new pane would render the exact same merged content again
// (see exec/tmux.ts's header comment) — doubled, and fighting the first
// over the window's size. Switching tabs instead sends `select-pane` +
// `resize-pane -Z` (exec/tmux.ts's focusPane) so the one attached surface
// always shows exactly one pane, full size, and typed input already lands
// on whichever pane tmux considers active — select-pane is what makes that
// true, so no separate input path is needed for the second pane either.

interface Props {
  tmuxSessionName: string
  paneId: string
  maximized: boolean
  onToggleMaximize: () => void
  onFocusChange?: (focused: boolean) => void
}

type PaneTab = 'agent' | 'shell'

// How long a failed split/switch/close note stays up before clearing itself.
const PANE_ACTION_ERROR_MS = 4000
// Catches the extra pane closing outside the app (tmux directly, or `exit`
// typed into the shell) and a split that already existed from a previous
// visit to this session — see the effect below.
const PANE_POLL_MS = 5000

const PANE_TAB_OPTIONS: SegmentedOption<PaneTab>[] = [
  { value: 'agent', label: 'Agent' },
  { value: 'shell', label: 'Shell' }
]

export default function TerminalFrame({
  tmuxSessionName,
  paneId,
  maximized,
  onToggleMaximize,
  onFocusChange
}: Props): React.JSX.Element {
  const [fallback, setFallback] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [secondPaneId, setSecondPaneId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<PaneTab>('agent')
  const [paneBusy, setPaneBusy] = useState(false)
  const [paneError, setPaneError] = useState<string | null>(null)
  const termRef = useRef<TerminalHandle>(null)
  const paneBusyRef = useRef(false)

  const handleFallback = useCallback((reason: string) => setFallback(reason), [])
  const jumpToLatest = useCallback(() => termRef.current?.scrollToBottom(), [])
  const handleFocusChange = useCallback(
    (f: boolean) => {
      setFocused(f)
      onFocusChange?.(f)
    },
    [onFocusChange]
  )

  const flashPaneError = useCallback((message: string) => {
    setPaneError(message)
    setTimeout(
      () => setPaneError((current) => (current === message ? null : current)),
      PANE_ACTION_ERROR_MS
    )
  }, [])

  // Discovers a split that already exists (reopening a session that had one)
  // and notices one going away from outside the app — the only two ways
  // this component's own idea of "is there a second pane" can go stale,
  // since every action this file initiates already updates state from its
  // own result. Skipped while an action is in flight so a slow poll tick
  // can never stomp an optimistic update (paneBusyRef, not state, so the
  // interval closure always reads the current value), and skipped entirely
  // with no live window (fallback) — the controls are hidden either way, so
  // a stale secondPaneId sitting unused in state is harmless, and this
  // picks the real state up again within one tick once fallback clears.
  useEffect(() => {
    if (fallback) return
    let cancelled = false

    const sync = (): void => {
      if (paneBusyRef.current) return
      listTerminalWindowPanes(paneId).then((panes) => {
        if (cancelled || paneBusyRef.current) return
        const other = panes.find((p) => p.paneId !== paneId)
        if (!other) {
          setSecondPaneId(null)
          setActiveTab('agent')
          return
        }
        setSecondPaneId(other.paneId)
        setActiveTab(panes.find((p) => p.active)?.paneId === other.paneId ? 'shell' : 'agent')
      })
    }

    sync()
    const interval = setInterval(sync, PANE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [paneId, fallback])

  const handleAddPane = useCallback(async (): Promise<void> => {
    paneBusyRef.current = true
    setPaneBusy(true)
    try {
      const result = await splitTerminalPane(paneId)
      if (result.ok && result.paneId) {
        setSecondPaneId(result.paneId)
        setActiveTab('agent') // splitTerminalPane already restores the agent's full view
      } else {
        flashPaneError(result.error ?? "Couldn't add a terminal.")
      }
    } finally {
      paneBusyRef.current = false
      setPaneBusy(false)
    }
  }, [paneId, flashPaneError])

  const handleTabChange = useCallback(
    async (tab: PaneTab): Promise<void> => {
      if (tab === activeTab) return
      const target = tab === 'agent' ? paneId : secondPaneId
      if (!target) return
      paneBusyRef.current = true
      setPaneBusy(true)
      try {
        const ok = await focusTerminalPane(target)
        if (ok) setActiveTab(tab)
        else flashPaneError("Couldn't switch terminals.")
      } finally {
        paneBusyRef.current = false
        setPaneBusy(false)
      }
    },
    [activeTab, paneId, secondPaneId, flashPaneError]
  )

  const handleClosePane = useCallback(async (): Promise<void> => {
    if (!secondPaneId) return
    paneBusyRef.current = true
    setPaneBusy(true)
    try {
      const ok = await closeTerminalPane(secondPaneId)
      if (ok) {
        setSecondPaneId(null)
        setActiveTab('agent')
      } else {
        flashPaneError("Couldn't close that terminal.")
      }
    } finally {
      paneBusyRef.current = false
      setPaneBusy(false)
    }
  }, [secondPaneId, flashPaneError])

  const focusTargetLabel = activeTab === 'shell' ? 'the shell' : 'the agent'

  return (
    <div className={maximized ? 'terminal-frame terminal-frame-maximized' : 'terminal-frame'}>
      <div className="terminal-frame-body">
        {fallback ? (
          <>
            <div className="terminal-frame-fallback-note">
              Live terminal unavailable ({fallback}) - showing read-only output.
            </div>
            <PaneOutput paneId={paneId} />
          </>
        ) : (
          <Terminal
            ref={termRef}
            tmuxSessionName={tmuxSessionName}
            paneId={paneId}
            onFallback={handleFallback}
            onFocusChange={handleFocusChange}
            onAtBottomChange={setAtBottom}
          />
        )}
        {!fallback && !atBottom && (
          <button type="button" className="terminal-frame-jump" onClick={jumpToLatest}>
            Jump to latest ↓
          </button>
        )}
      </div>
      <div className="terminal-frame-footer">
        <span
          className={
            paneError
              ? 'terminal-frame-focus-hint terminal-frame-focus-hint-error'
              : 'terminal-frame-focus-hint'
          }
        >
          {paneError ??
            (fallback
              ? 'Read-only: live output unavailable'
              : focused
                ? 'Terminal focused: press Esc twice to release'
                : `Click to type into ${focusTargetLabel}`)}
        </span>
        <div className="terminal-frame-footer-right">
          {!fallback &&
            (secondPaneId ? (
              <>
                <SegmentedControl<PaneTab>
                  aria-label="Terminal pane"
                  options={PANE_TAB_OPTIONS}
                  value={activeTab}
                  onChange={(tab) => void handleTabChange(tab)}
                />
                <IconButton
                  icon="X"
                  label="Close second terminal"
                  size={28}
                  variant="ghost"
                  onClick={() => void handleClosePane()}
                  disabled={paneBusy}
                />
              </>
            ) : (
              <IconButton
                icon="SquareTerminal"
                label="Add terminal"
                tooltip="Add a second terminal in this session"
                size={28}
                variant="ghost"
                onClick={() => void handleAddPane()}
                disabled={paneBusy}
              />
            ))}
          <IconButton
            icon={maximized ? 'Minimize2' : 'Maximize2'}
            label={maximized ? 'Shrink' : 'Expand'}
            size={28}
            variant="ghost"
            onClick={onToggleMaximize}
            title={maximized ? 'Shrink (⌘⏎)' : 'Expand (⌘⏎)'}
          />
        </div>
      </div>
    </div>
  )
}
