import { useRef, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import { Badge, Icon, IconButton, Popover } from './primitives'
import './session-card.css'

export interface SessionCardAction {
  label: string
  onClick: () => void
  danger?: boolean
}

export interface SessionCardProps {
  session: LiveSession
  /** `background`: ⌘- or middle-click — open it in a tab without switching. */
  onOpen: (background?: boolean) => void
  /** Shown in a menu over the card's top-right corner. Omitted, no menu. */
  actions?: SessionCardAction[]
  /** The project's name, for surfaces that mix projects together. */
  projectName?: string
}

/**
 * One session, as a card.
 *
 * Extracted from the project page's Active board so Home can use the same
 * thing rather than a second, smaller list of its own — one shape for "a
 * session you might go back to", wherever you meet it.
 */
export default function SessionCard({
  session,
  onOpen,
  actions,
  projectName
}: SessionCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const title = session.record?.title ?? session.agentName ?? session.cwd
  // An investigate session runs in the repo itself; its recorded branch is
  // whatever the repo had checked out, or "(unknown)". Say what it is.
  const branch = session.record?.investigation ? 'no worktree' : session.record?.branch

  return (
    <div className="cr-session-card-wrap" data-session-key={session.key}>
      <button
        type="button"
        className={session.unread ? 'cr-session-card cr-session-card--unread' : 'cr-session-card'}
        data-session-item
        onClick={(e) => onOpen(e.metaKey || e.ctrlKey)}
        onAuxClick={(e) => {
          if (e.button === 1) onOpen(true)
        }}
      >
        <div className="cr-session-card-top">
          <Badge status={session.status} />
          {/* Quiet — the badge is the thing that has to be seen first. */}
          {session.record?.pinned && (
            <span className="cr-session-card-pinned" aria-label="Pinned">
              <Icon name="Pin" size={12} />
            </span>
          )}
        </div>
        <div className="cr-session-card-title">{title}</div>
        {(branch || projectName) && (
          <div className="cr-session-card-branch">
            {branch && <span className="cr-session-card-branch-name">{branch}</span>}
            {projectName && <span className="cr-project-pill">{projectName}</span>}
          </div>
        )}
      </button>
      {/* The card is itself a button, so the menu cannot be nested inside it —
          it sits over the corner and stops the click reaching the card. */}
      {actions && actions.length > 0 && (
        <div className="cr-session-card-menu" ref={anchor} onClick={(e) => e.stopPropagation()}>
          <IconButton
            icon="MoreHorizontal"
            label={`Actions for ${title}`}
            size={28}
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
          />
          <Popover
            open={open}
            onClose={() => setOpen(false)}
            anchorRef={anchor}
            placement="bottom-end"
            className="cr-session-card-menu-list"
            aria-label="Session actions"
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                className={
                  action.danger ? 'cr-popover-item cr-popover-item--danger' : 'cr-popover-item'
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
      )}
    </div>
  )
}
