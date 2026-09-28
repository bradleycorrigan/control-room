import { useEffect, useRef, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import { Icon, Popover, StatusDot, Tooltip } from './primitives'
import { readAction } from './useSessionActions'
import { renameSession } from '../api'
import HandoffNoteDialog from './HandoffNoteDialog'
import './session-tabs.css'

export interface SessionTabsProps {
  tabs: LiveSession[]
  /** null: the pinned list tab is the one showing. */
  activeKey: string | null
  /** Unread sessions anywhere — the pinned tab's badge. */
  homeUnread: number
  onHome: () => void
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onCloseOthers: (key: string) => void
  onCloseToRight: (key: string) => void
  /** Moves the tab at `from` to sit where the tab at `to` is. */
  onReorder: (from: number, to: number) => void
  /** After Mark as unread / read, so the strip picks the change up. */
  onChanged: () => void
  /** Present only when a closed tab can come back. */
  onReopenClosed?: () => void
  pushToast?: (message: string) => void
}

function tabTitle(session: LiveSession): string {
  return session.record?.title ?? session.agentName ?? session.cwd.split('/').pop() ?? session.cwd
}

/**
 * The sessions you have open, as tabs over the session screen.
 *
 * Only sessions — Home, Projects and Sessions already have the top bar, and
 * two ways to move between the same screens would compete. Each tab carries
 * the same status dot as everywhere else, and a tab with something new in it
 * says so, so you can see a background session finish without leaving the
 * one you're in. Only the active tab has a live terminal; tmux keeps the
 * others running, so switching costs a reattach and nothing else.
 */
export default function SessionTabs({
  tabs,
  activeKey,
  homeUnread,
  onHome,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onReorder,
  onChanged,
  onReopenClosed,
  pushToast
}: SessionTabsProps): React.JSX.Element {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  // Right-click menu: which tab it's for, anchored to that tab.
  const [menuKey, setMenuKey] = useState<string | null>(null)
  // Hand-off note dialog, opened from the same menu — kept as the record
  // rather than just a flag, so it still has something to show once the
  // menu itself (and menuSession) has closed.
  const [handoffFor, setHandoffFor] = useState<LiveSession | null>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  // Double-click a tab to rename its session in place, as a list row can.
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const submitRename = async (session: LiveSession): Promise<void> => {
    const next = renameValue.trim()
    setRenamingKey(null)
    if (!session.record || !next || next === tabTitle(session)) return
    const result = await renameSession(session.record.id, next)
    if (result.ok) onChanged()
  }

  // Which sides have more tabs scrolled out of view — drives the edge fades.
  const [more, setMore] = useState({ left: false, right: false })
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const measure = (): void => {
      const left = strip.scrollLeft > 1
      const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
    }
    measure()
    strip.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(strip)
    return () => {
      strip.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [tabs.length])

  // Keep the tab you're on in view when the strip overflows — switching with
  // ⌘9 to a tab scrolled off the end should show you where you landed.
  useEffect(() => {
    stripRef.current
      ?.querySelector('.cr-tab--active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey, tabs.length])

  const menuSession = tabs.find((s) => s.key === menuKey) ?? null
  const menuIndex = menuSession ? tabs.indexOf(menuSession) : -1
  const menuItems = menuSession
    ? [
        { label: 'Close tab', onClick: () => onClose(menuSession.key) },
        ...(tabs.length > 1
          ? [{ label: 'Close other tabs', onClick: () => onCloseOthers(menuSession.key) }]
          : []),
        ...(menuIndex < tabs.length - 1
          ? [{ label: 'Close tabs to the right', onClick: () => onCloseToRight(menuSession.key) }]
          : []),
        readAction(menuSession, onChanged),
        ...(menuSession.record
          ? [{ label: 'Write hand-off note…', onClick: () => setHandoffFor(menuSession) }]
          : []),
        ...(onReopenClosed ? [{ label: 'Reopen closed tab', onClick: onReopenClosed }] : [])
      ]
    : []

  return (
    <div
      className={['cr-tabs', more.left && 'cr-tabs--more-left', more.right && 'cr-tabs--more-right']
        .filter(Boolean)
        .join(' ')}
      role="tablist"
      aria-label="Open sessions"
      ref={stripRef}
    >
      {/* Pinned: the full Sessions list, with every filter and sort. It can't
          be closed or moved — it's where tabs come from. */}
      <Tooltip label="All sessions · ⌘0">
        <div
          role="tab"
          aria-selected={activeKey === null}
          aria-label={homeUnread > 0 ? `All sessions, ${homeUnread} unread` : 'All sessions'}
          tabIndex={activeKey === null ? 0 : -1}
          className={
            activeKey === null ? 'cr-tab cr-tab--home cr-tab--active' : 'cr-tab cr-tab--home'
          }
          onClick={onHome}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onHome()
            }
          }}
        >
          <Icon name="House" size={16} />
          {homeUnread > 0 && <span className="cr-tab-home-badge">{homeUnread}</span>}
        </div>
      </Tooltip>
      {tabs.map((session, index) => {
        const active = session.key === activeKey
        const title = tabTitle(session)
        const unread = session.unread && !active
        const className = [
          'cr-tab',
          active && 'cr-tab--active',
          unread && 'cr-tab--unread',
          dragOver === index && dragFrom !== index && 'cr-tab--drop'
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <Tooltip
            key={session.key}
            label={
              index === tabs.length - 1
                ? `${title} · ⌘9`
                : index < 8
                  ? `${title} · ⌘${index + 1}`
                  : title
            }
          >
            <div
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={className}
              draggable={renamingKey !== session.key}
              onClick={() => onSelect(session.key)}
              onContextMenu={(e) => {
                e.preventDefault()
                menuAnchor.current = e.currentTarget
                setMenuKey(session.key)
              }}
              // Middle-click closes, as it does in every browser.
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(session.key)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(session.key)
                }
              }}
              onDragStart={(e) => {
                setDragFrom(index)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return
                e.preventDefault()
                setDragOver(index)
              }}
              onDragLeave={() => setDragOver((v) => (v === index ? null : v))}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom !== null && dragFrom !== index) onReorder(dragFrom, index)
                setDragFrom(null)
                setDragOver(null)
              }}
              onDragEnd={() => {
                setDragFrom(null)
                setDragOver(null)
              }}
            >
              <StatusDot status={session.status} size={8} />
              {renamingKey === session.key ? (
                <input
                  className="cr-tab-rename"
                  autoFocus
                  aria-label="Session name"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') void submitRename(session)
                    else if (e.key === 'Escape') setRenamingKey(null)
                  }}
                  onBlur={() => void submitRename(session)}
                />
              ) : (
                <span
                  className="cr-tab-title"
                  onDoubleClick={(e) => {
                    // Only a session with a record has a name to change.
                    if (!session.record) return
                    e.stopPropagation()
                    setRenameValue(title)
                    setRenamingKey(session.key)
                  }}
                >
                  {title}
                </span>
              )}
              {unread && <span className="cr-tab-unread" aria-label="unread" />}
              <button
                type="button"
                className="cr-tab-close"
                aria-label={`Close ${title}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(session.key)
                }}
              >
                <Icon name="X" size={12} />
              </button>
            </div>
          </Tooltip>
        )
      })}
      <Popover
        open={menuSession !== null}
        onClose={() => setMenuKey(null)}
        anchorRef={menuAnchor}
        placement="bottom-start"
        className="cr-tab-menu"
        aria-label="Tab actions"
      >
        {menuItems.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="cr-popover-item"
            onClick={() => {
              setMenuKey(null)
              item.onClick()
            }}
          >
            {item.label}
          </button>
        ))}
      </Popover>
      {handoffFor?.record && (
        <HandoffNoteDialog
          record={handoffFor.record}
          onClose={() => setHandoffFor(null)}
          pushToast={pushToast}
        />
      )}
    </div>
  )
}
