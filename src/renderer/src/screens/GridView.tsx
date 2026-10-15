import { useCallback, useMemo, useState } from 'react'
import { attentionRank, type LiveSession, type Project } from '../../../main/store/types'
import GridTile from './GridTile'

// At most this many tiles poll their pane preview at once (plan 2.5); the
// rest sit idle until they scroll into view and a slot frees up.
const MAX_ACTIVE_PREVIEWS = 8

interface Props {
  sessions: LiveSession[]
  projects: Project[]
  onFocusSession?: (liveKey: string) => void
  onOpenSession: (liveKey: string, background?: boolean) => void
  onExitGrid: () => void
}

function projectNameFor(session: LiveSession, projects: Project[]): string | null {
  if (!session.record) return null
  return projects.find((p) => p.id === session.record!.projectId)?.name ?? null
}

export default function GridView({
  sessions,
  projects,
  onFocusSession,
  onOpenSession,
  onExitGrid
}: Props): React.JSX.Element {
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())

  const handleVisibilityChange = useCallback((key: string, visible: boolean): void => {
    setVisibleKeys((prev) => {
      if (prev.has(key) === visible) return prev
      const next = new Set(prev)
      if (visible) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  // needs_attention sorts to the front; everything else keeps the order it
  // arrived in.
  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const aAttn = attentionRank(a.status)
      const bAttn = attentionRank(b.status)
      return aAttn - bAttn
    })
  }, [sessions])

  // Cap live polling at MAX_ACTIVE_PREVIEWS, preferring tiles earlier in the
  // (attention-first) order among those currently on screen.
  const activeKeys = useMemo(() => {
    const active = new Set<string>()
    for (const session of sorted) {
      if (active.size >= MAX_ACTIVE_PREVIEWS) break
      if (visibleKeys.has(session.key)) active.add(session.key)
    }
    return active
  }, [sorted, visibleKeys])

  // Fetch/refresh context window usage for whichever tiles are currently
  // active (same cap as pane polling), once per USAGE_POLL_MS rather than on
  // every render — a grid re-renders far more often than usage changes.

  if (sessions.length === 0) {
    return <p className="empty-state">No sessions running.</p>
  }

  return (
    <div className="cr-grid-view">
      <style>{GRID_CSS}</style>
      <div className="cr-grid-topbar">
        <span className="cr-grid-topbar-count">
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </span>
        <button type="button" className="cr-grid-topbar-exit" onClick={onExitGrid}>
          Exit grid
        </button>
      </div>
      <div className="cr-grid">
        {sorted.map((session) => (
          <GridTile
            key={session.key}
            session={session}
            projectName={projectNameFor(session, projects)}
            active={activeKeys.has(session.key)}
            unread={session.unread}
            onVisibilityChange={handleVisibilityChange}
            onFocus={() => onFocusSession?.(session.key)}
            onOpen={(background) => onOpenSession(session.key, background)}
          />
        ))}
      </div>
    </div>
  )
}

// Scoped to this screen's own classnames (cr-grid-*) so it never depends on,
// or collides with, the shared stylesheet other milestones may be editing
// concurrently. Every colour still comes from a theme token — none of these
// are hex literals. No animation here beyond the status dot pulse already
// defined (and reduced-motion-guarded) in sessions-list.css.
const GRID_CSS = `
.cr-grid-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.cr-grid-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-12) var(--space-16);
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.cr-grid-topbar-count {
  font-size: var(--text-caption-size);
  line-height: var(--text-caption-line);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.cr-grid-topbar-exit {
  font-size: var(--text-caption-size);
  line-height: var(--text-caption-line);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.cr-grid-topbar-exit:hover {
  background: var(--surface-raised);
}

.cr-grid-topbar-exit:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.cr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--space-16);
  padding: var(--space-16);
  overflow-y: auto;
  min-height: 0;
}

.cr-grid-tile {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 220px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-ui);
  color: inherit;
  padding: 0;
}

.cr-grid-tile:hover {
  background: var(--surface-raised);
}

.cr-grid-tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.cr-grid-tile-attention {
  border-color: var(--status-attention);
  box-shadow: 0 0 0 1px var(--status-attention);
}


.cr-grid-tile-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-8);
  padding: var(--space-12);
  border-bottom: 1px solid var(--border);
}

.cr-grid-tile-header-right {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  flex-shrink: 0;
}

.cr-grid-tile-usage {
  font-size: var(--text-meta-size);
  line-height: var(--text-meta-line);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
}

.cr-grid-tile-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cr-grid-tile-title {
  font-size: var(--text-label-size);
  line-height: var(--text-label-line);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cr-grid-tile-meta {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-width: 0;
}

.cr-grid-tile-branch {
  font-family: var(--font-mono);
  font-size: var(--text-meta-size);
  line-height: var(--text-meta-line);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cr-grid-tile-project {
  font-size: var(--text-meta-size);
  line-height: var(--text-meta-line);
  color: var(--text-muted);
  white-space: nowrap;
}

.cr-grid-tile-preview {
  flex: 1;
  min-height: 0;
  background: var(--term-bg);
  padding: var(--space-8) var(--space-12);
  overflow: hidden;
}

.cr-grid-tile-preview pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-meta-size);
  line-height: 1.5;
  color: var(--term-fg);
  white-space: pre-wrap;
  word-break: break-word;
}

.cr-grid-tile-no-pane {
  font-size: var(--text-caption-size);
  line-height: var(--text-caption-line);
  color: var(--text-faint);
}
`
