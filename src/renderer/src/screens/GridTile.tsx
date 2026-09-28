import { useEffect, useRef, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import { Badge } from '../components/primitives'
import { getSessionPane } from '../api'

// How often an on-screen, actively-polled tile refreshes its preview. Kept
// well above SessionDetail's PaneOutput cadence (1.5s, src/renderer/src/
// components/PaneOutput.tsx) — a grid can show many tiles at once, and plan
// 2.5 asks this screen to stay near-idle between polls, not match the
// single-session detail view's responsiveness.
const TILE_POLL_MS = 2500
// Only the tail of the pane is useful in a small tile — asking for the full
// 2000-line scrollback PaneOutput uses would waste an IPC round trip per
// active tile, every poll.
const TILE_PANE_LINES = 40

// Strips ANSI SGR/cursor/OSC escape sequences so the preview can render as
// plain text in a <pre> — no dangerouslySetInnerHTML in this file. Colour
// rendering of pane output is out of scope for a small tile preview;
// PaneOutput (U5) is where the full ANSI-to-HTML conversion lives, with its
// own escapeXML: true. Pane content is untrusted either way.
// Matching literal ESC (0x1b) and BEL (0x07) bytes is the point here — these
// are ANSI escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, '')
}

interface Props {
  session: LiveSession
  projectName: string | null
  active: boolean
  /** Something happened since you last opened it. */
  unread: boolean
  onVisibilityChange: (key: string, visible: boolean) => void
  onFocus: () => void
  /** `background`: ⌘- or middle-click — open it in a tab without switching. */
  onOpen: (background?: boolean) => void
}

export default function GridTile({
  session,
  projectName,
  active,
  unread,
  onVisibilityChange,
  onFocus,
  onOpen
}: Props): React.JSX.Element {
  const [preview, setPreview] = useState('')
  const elRef = useRef<HTMLButtonElement>(null)
  const paneId = session.tmux?.paneId ?? null
  const title = session.record?.title ?? session.agentName ?? session.cwd
  const branch = session.record?.branch ?? null
  // The alarm ring is for a session that cannot proceed, not one that
  // finished. Using wantsYou here put a `ready` tile in attention amber,
  // which undoes the whole point of telling those two states apart.
  const attention = session.status === 'needs_attention'
  const [previewError, setPreviewError] = useState(false)

  // Reports this tile's own on-screen visibility up to GridView, which caps
  // how many tiles poll at once (plan 2.5) — a tile scrolled out of view
  // stops asking for pane content the moment it leaves the viewport.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => onVisibilityChange(session.key, entry.isIntersecting),
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      onVisibilityChange(session.key, false)
    }
  }, [session.key, onVisibilityChange])

  useEffect(() => {
    if (!active || !paneId) return
    let cancelled = false

    const poll = (): void => {
      getSessionPane(paneId, TILE_PANE_LINES)
        .then((raw) => {
          if (!cancelled) {
            setPreview(stripAnsi(raw))
            setPreviewError(false)
          }
        })
        // A session can die (worktree removed, tmux window killed) between
        // polls — getSessionPane rejecting just leaves the last-known
        // preview on screen rather than clearing the tile or throwing.
        .catch(() => {
          if (!cancelled) setPreviewError(true)
        })
    }

    poll()
    const timer = setInterval(poll, TILE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, paneId])

  const handleClick = (e: React.MouseEvent): void => {
    onFocus()
    onOpen(e.metaKey || e.ctrlKey)
  }

  return (
    <button
      ref={elRef}
      type="button"
      data-session-item
      className={[
        'cr-grid-tile',
        attention && 'cr-grid-tile-attention',
        unread && 'cr-grid-tile-unread'
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={handleClick}
      onAuxClick={(e) => {
        if (e.button === 1) onOpen(true)
      }}
    >
      <div className="cr-grid-tile-header">
        <div className="cr-grid-tile-heading">
          <span className="cr-grid-tile-title">{title}</span>
          <div className="cr-grid-tile-meta">
            {branch && <span className="cr-grid-tile-branch">{branch}</span>}
            {projectName && <span className="cr-grid-tile-project">{projectName}</span>}
          </div>
        </div>
        <div className="cr-grid-tile-header-right">
          <Badge status={session.status} variant="bare" />
        </div>
      </div>
      <div className="cr-grid-tile-preview">
        {paneId ? (
          previewError ? (
            <span className="cr-grid-tile-no-pane">Preview unavailable.</span>
          ) : (
            <pre>{preview}</pre>
          )
        ) : (
          <span className="cr-grid-tile-no-pane">No live pane.</span>
        )}
      </div>
    </button>
  )
}
