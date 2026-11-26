import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LiveSession, SessionStatus } from '../../../main/store/types'
import { statusWord } from '../lib/statusWords'
import { Count, Icon, Popover, StatusDot, Tooltip } from './primitives'
import { MenuItems, type MenuItem } from './MenuItems'
import ColourSwatches from './ColourSwatches'
import type { TabLayoutActions } from '../state/useTabLayout'
import { groupLabel, hiddenTabs, tabColour, type TabGroup } from '../lib/tabLayout'
import { readAction } from './useSessionActions'
import { renameSession } from '../api'
import HandoffNoteDialog from './HandoffNoteDialog'
import './session-tabs.css'
import type { PushToast } from '../state/useToasts'

export interface SessionTabsProps {
  tabs: LiveSession[]
  /** null: the pinned list tab is the one showing. */
  activeKey: string | null
  /** Unread sessions anywhere — the pinned tab's badge. */
  homeUnread: number
  onHome: () => void
  /** The badge: Sessions filtered to the unread ones, so you can see which. */
  onShowUnread?: () => void
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onCloseOthers: (key: string) => void
  onCloseToRight: (key: string) => void
  /** Moves the tab at `from` to sit where the tab at `to` is. */
  onReorder: (from: number, to: number) => void
  /** Pins, colours and groups. */
  tabLayout: TabLayoutActions
  /** Closes every tab in a group. */
  onCloseGroup: (groupId: string) => void
  /** Closes several tabs at once: the ones shift-clicked together. */
  onCloseTabs: (keys: string[]) => void
  /** After Mark as unread / read, so the strip picks the change up. */
  onChanged: () => void
  /** Present only when a closed tab can come back. */
  onReopenClosed?: () => void
  pushToast?: PushToast
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
// What a folded group's label says about the tabs it hides: the status that
// most wants you, first. Statuses below these aren't worth a dot.
const LOUDEST: SessionStatus[] = ['needs_attention', 'errored', 'ready', 'idle', 'working']

function loudestStatus(sessions: LiveSession[]): SessionStatus | null {
  for (const status of LOUDEST) if (sessions.some((s) => s.status === status)) return status
  return null
}

/** "1 needs an answer, 1 working": each status word once, with how many. */
function statusSummary(sessions: LiveSession[]): string {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const word = statusWord(s.status)
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts].map(([word, n]) => `${n} ${word}`).join(', ')
}

export default function SessionTabs({
  tabs,
  activeKey,
  homeUnread,
  onHome,
  onShowUnread,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onReorder,
  tabLayout,
  onCloseGroup,
  onCloseTabs,
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
  // Shift-click picks tabs to act on together: right-click one of them and
  // the menu colours, groups, pins or closes them all. A plain click or
  // Escape lets them go.
  const [picked, setPicked] = useState<string[]>([])
  useEffect(() => {
    if (picked.length === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPicked([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked.length])
  // A picked tab that closes drops out.
  const pickedOpen = picked.filter((k) => tabs.some((s) => s.key === k))
  // The group editor (name, colour, ungroup, close), hung off a group's label.
  // Opened by right-clicking the label, and straight after making a group.
  const [editGroupId, setEditGroupId] = useState<string | null>(null)
  const groupAnchor = useRef<HTMLElement | null>(null)
  // A group made from the tab menu: open its editor once its label is drawn.
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null)
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

  // The active tab joins the session header beneath it. Where it sits flush
  // with the header's left or right edge, that corner of the header goes
  // square, or its rounding shows as a notch beside the tab. Measured, since
  // scrolling and resizing move the tab.
  useEffect(() => {
    const strip = stripRef.current
    const screen = strip?.closest<HTMLElement>('.cr-session-screen')
    if (!strip || !screen) return
    const measure = (): void => {
      const tab = strip.querySelector<HTMLElement>('.cr-tab--active')
      const header = screen.querySelector<HTMLElement>('.session-detail-header')
      if (!tab || !header || header.offsetParent === null) {
        delete screen.dataset.tabFlushLeft
        delete screen.dataset.tabFlushRight
        return
      }
      const t = tab.getBoundingClientRect()
      const h = header.getBoundingClientRect()
      const radius = parseFloat(getComputedStyle(header).borderTopLeftRadius) || 0
      // The tab covers the corner when it starts or ends within the rounding.
      if (t.left <= h.left + radius) screen.dataset.tabFlushLeft = ''
      else delete screen.dataset.tabFlushLeft
      if (t.right >= h.right - radius) screen.dataset.tabFlushRight = ''
      else delete screen.dataset.tabFlushRight
    }
    // After layout: the header mounts with the session it belongs to.
    const frame = requestAnimationFrame(measure)
    strip.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(strip)
    return () => {
      cancelAnimationFrame(frame)
      strip.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [activeKey, tabs.length])

  const { layout } = tabLayout
  useEffect(() => {
    if (!pendingGroupId) return
    const label = stripRef.current?.querySelector<HTMLElement>(
      `[data-group-id="${pendingGroupId}"]`
    )
    if (!label) return
    groupAnchor.current = label
    setEditGroupId(pendingGroupId)
    setPendingGroupId(null)
  }, [pendingGroupId, layout])

  const menuSession = tabs.find((s) => s.key === menuKey) ?? null
  const menuIndex = menuSession ? tabs.indexOf(menuSession) : -1
  // The tabs the menu acts on: every picked tab when you right-click one of
  // them, else just the one under the pointer.
  const menuKeys = menuSession
    ? pickedOpen.length > 1 && pickedOpen.includes(menuSession.key)
      ? tabs.map((s) => s.key).filter((k) => pickedOpen.includes(k))
      : [menuSession.key]
    : []
  const multi = menuKeys.length > 1
  const count = multi ? `${menuKeys.length} tabs` : 'tab'
  const menuPinned = menuKeys.length > 0 && menuKeys.every((k) => layout.pinned.includes(k))
  const menuGroups = new Set(menuKeys.map((k) => layout.groupOf[k]).filter(Boolean))
  const menuGroupId =
    menuGroups.size === 1 && menuKeys.every((k) => layout.groupOf[k])
      ? [...menuGroups][0]
      : undefined
  // Done with the picked tabs once something has been done to them.
  const forPicked = (act: () => void) => () => {
    act()
    if (multi) setPicked([])
  }
  const menuItems: MenuItem[] = menuSession
    ? [
        {
          label: `${menuPinned ? 'Unpin' : 'Pin'} ${count}`,
          icon: menuPinned ? 'PinOff' : 'Pin',
          group: 'layout',
          onClick: forPicked(() => tabLayout.setPinned(menuKeys, !menuPinned))
        },
        ...(menuPinned
          ? []
          : [
              {
                label: multi ? `Group ${count}` : 'Add to new group',
                group: 'layout',
                onClick: forPicked(() => setPendingGroupId(tabLayout.newGroup(menuKeys)))
              },
              // Existing groups go in a submenu, so the menu stays the same
              // length however many groups there are.
              ...(layout.groups.some((g) => g.id !== menuGroupId)
                ? [
                    {
                      label: multi ? `Add ${count} to group` : 'Add to group',
                      group: 'layout',
                      onClick: () => {},
                      submenu: layout.groups
                        .filter((g) => g.id !== menuGroupId)
                        .map((g) => ({
                          label: groupLabel(g),
                          onClick: forPicked(() => tabLayout.moveToGroup(menuKeys, g.id))
                        }))
                    }
                  ]
                : []),
              ...(menuGroups.size > 0
                ? [
                    {
                      label: 'Remove from group',
                      group: 'layout',
                      onClick: forPicked(() => tabLayout.moveToGroup(menuKeys, null))
                    }
                  ]
                : [])
            ]),
        multi
          ? {
              label: `Close ${count}`,
              group: 'close',
              onClick: forPicked(() => onCloseTabs(menuKeys))
            }
          : { label: 'Close tab', group: 'close', onClick: () => onClose(menuSession.key) },
        ...(!multi && tabs.length > 1
          ? [
              {
                label: 'Close other tabs',
                group: 'close',
                onClick: () => onCloseOthers(menuSession.key)
              }
            ]
          : []),
        ...(!multi && menuIndex < tabs.length - 1
          ? [
              {
                label: 'Close tabs to the right',
                group: 'close',
                onClick: () => onCloseToRight(menuSession.key)
              }
            ]
          : []),
        ...(!multi && onReopenClosed
          ? [{ label: 'Reopen closed tab', group: 'close', onClick: onReopenClosed }]
          : []),
        ...(multi ? [] : [{ ...readAction(menuSession, onChanged), group: 'session' }]),
        ...(!multi && menuSession.record
          ? [
              {
                label: 'Write hand-off note…',
                group: 'session',
                onClick: () => setHandoffFor(menuSession)
              }
            ]
          : [])
      ]
    : []
  // Colour: for tabs outside a group (a grouped tab wears its group's colour).
  const colourKeys = menuKeys.filter((k) => !layout.groupOf[k])
  const colourValue = colourKeys.every((k) => layout.colour[k] === layout.colour[colourKeys[0]])
    ? (layout.colour[colourKeys[0]] ?? null)
    : null

  const editGroup = layout.groups.find((g) => g.id === editGroupId) ?? null
  const hidden = hiddenTabs(
    tabs.map((s) => s.key),
    layout,
    activeKey
  )
  const visibleKeys = tabs.map((s) => s.key).filter((k) => !hidden.has(k))

  // Tabs glide to where they now belong when the strip's arrangement changes
  // (grouped, ungrouped, pinned, dragged) rather than jumping there. Each
  // render notes where every tab and group label sits; when the order or the
  // grouping changed, each one starts from its old place and slides home.
  // Folding a group isn't an arrangement change: its tabs' widths animate in
  // CSS and the neighbours follow on their own.
  const arrangement = tabs
    .map(
      (s) => `${s.key}:${layout.pinned.includes(s.key) ? 'p' : ''}${layout.groupOf[s.key] ?? ''}`
    )
    .join('|')
  const lastArrangement = useRef(arrangement)
  const lastPlaces = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const items = [...strip.querySelectorAll<HTMLElement>('[data-tab-key], [data-group-id]')]
    const id = (el: HTMLElement): string => el.dataset.tabKey ?? `group:${el.dataset.groupId}`
    const placeOf = (el: HTMLElement): number => el.getBoundingClientRect().left + strip.scrollLeft
    const changed = lastArrangement.current !== arrangement
    lastArrangement.current = arrangement
    const motion = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : parseFloat(getComputedStyle(strip).getPropertyValue('--motion-medium')) || 0
    const places = new Map<string, number>()
    for (const el of items) {
      const now = placeOf(el)
      places.set(id(el), now)
      const before = lastPlaces.current.get(id(el))
      if (!changed || motion === 0) continue
      if (before === undefined) {
        // New to the strip (a group's label just made): fade in where it is.
        if (el.dataset.groupId)
          el.animate(
            [
              { opacity: 0, transform: 'scale(0.92)' },
              { opacity: 1, transform: 'none' }
            ],
            {
              duration: motion,
              easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
            }
          )
        continue
      }
      const dx = before - now
      if (Math.abs(dx) < 1) continue
      el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], {
        duration: motion * 1.4,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
      })
    }
    lastPlaces.current = places
  })

  const renderTab = (session: LiveSession, index: number, folded = false): React.JSX.Element => {
    const active = session.key === activeKey
    const title = tabTitle(session)
    const unread = session.unread && !active
    const pinned = layout.pinned.includes(session.key)
    const colour = tabColour(session.key, layout)
    const grouped = Boolean(layout.groupOf[session.key])
    const className = [
      'cr-tab',
      active && 'cr-tab--active',
      unread && 'cr-tab--unread',
      pinned && 'cr-tab--pinned',
      pickedOpen.includes(session.key) && 'cr-tab--picked',
      folded && 'cr-tab--folded',
      // A grouped tab shares its group's line; only a lone tab draws its own.
      colour && !grouped && 'cr-tab--coloured',
      dragOver === index && dragFrom !== index && 'cr-tab--drop'
    ]
      .filter(Boolean)
      .join(' ')
    const shortcut = visibleKeys.indexOf(session.key)
    return (
      <Tooltip
        key={session.key}
        label={
          shortcut === visibleKeys.length - 1
            ? `${title} · ⌘9`
            : shortcut >= 0 && shortcut < 8
              ? `${title} · ⌘${shortcut + 1}`
              : title
        }
      >
        <div
          role="tab"
          aria-selected={active}
          aria-label={pinned ? `${title}, pinned` : undefined}
          tabIndex={active ? 0 : -1}
          className={className}
          data-tab-key={session.key}
          // Folded away in a collapsed group: still drawn, so it can slide
          // shut and open again, but out of reach.
          aria-hidden={folded || undefined}
          inert={folded || undefined}
          data-tab-colour={colour ?? undefined}
          style={
            colour
              ? ({ '--tab-colour': `var(--label-${colour})` } as React.CSSProperties)
              : undefined
          }
          draggable={renamingKey !== session.key}
          aria-description={pickedOpen.includes(session.key) ? 'picked' : undefined}
          onClick={(e) => {
            if (e.shiftKey) {
              setPicked((p) =>
                p.includes(session.key) ? p.filter((k) => k !== session.key) : [...p, session.key]
              )
              return
            }
            setPicked([])
            onSelect(session.key)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            // Right-clicking a tab you didn't pick starts over with just it.
            if (!pickedOpen.includes(session.key)) setPicked([])
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
          {/* A pinned tab has no ×: it stays put until you unpin it, or close
              it from its menu, ⌘W or a middle-click. */}
          {pinned ? (
            <span className="cr-tab-pin" aria-hidden="true">
              <Icon name="Pin" size={12} />
            </span>
          ) : (
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
          )}
        </div>
      </Tooltip>
    )
  }

  // The strip, in runs: a group's label, then its tabs (bar any it hides
  // while collapsed); lone tabs on their own.
  const runs: { group: TabGroup | null; items: { session: LiveSession; index: number }[] }[] = []
  tabs.forEach((session, index) => {
    const group = layout.groups.find((g) => g.id === layout.groupOf[session.key]) ?? null
    const last = runs[runs.length - 1]
    if (group && last?.group?.id === group.id) last.items.push({ session, index })
    else runs.push({ group, items: [{ session, index }] })
  })

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
      <Tooltip
        label={
          homeUnread > 0
            ? `All sessions · ${homeUnread} finished since you last looked: click the number to see ${homeUnread === 1 ? 'it' : 'them'} · ⌘0`
            : 'All sessions · ⌘0'
        }
      >
        <div
          role="tab"
          aria-selected={activeKey === null}
          aria-label={
            homeUnread > 0
              ? `All sessions, ${homeUnread} finished since you last looked`
              : 'All sessions'
          }
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
          {homeUnread > 0 && (
            <span
              className="cr-tab-home-badge"
              data-home-unread
              onClick={(e) => {
                if (!onShowUnread) return
                e.stopPropagation()
                onShowUnread()
              }}
            >
              <Count value={homeUnread} />
            </span>
          )}
        </div>
      </Tooltip>
      {runs.map((run) => {
        const group = run.group
        if (!group)
          return (
            <Fragment key={run.items[0].session.key}>
              {renderTab(run.items[0].session, run.items[0].index)}
            </Fragment>
          )
        // Folded, the label speaks for the tabs it hides: the status that most
        // wants you as a dot, how many there are, and the unread dot if any
        // has something new. The words are in its tooltip and name.
        const folded = run.items.filter((i) => hidden.has(i.session.key)).map((i) => i.session)
        const hiddenCount = folded.length
        const loudest = loudestStatus(folded)
        const foldedUnread = folded.some((s) => s.unread)
        const summary = statusSummary(folded)
        const label = groupLabel(group)
        return (
          <div
            key={group.id}
            role="group"
            aria-label={label}
            className={group.collapsed ? 'cr-tab-group cr-tab-group--collapsed' : 'cr-tab-group'}
            style={{ '--tab-colour': `var(--label-${group.colour})` } as React.CSSProperties}
          >
            <Tooltip
              label={
                group.collapsed && hiddenCount > 0
                  ? `${label}: ${summary}${foldedUnread ? ', something new' : ''} · click to show · right-click to edit`
                  : `${label}: click to fold away · right-click to edit`
              }
            >
              <button
                type="button"
                className={
                  foldedUnread
                    ? 'cr-tab-group-label cr-tab-group-label--unread'
                    : 'cr-tab-group-label'
                }
                data-group-id={group.id}
                aria-expanded={!group.collapsed}
                aria-label={`${label}, ${run.items.length} ${run.items.length === 1 ? 'tab' : 'tabs'}${hiddenCount > 0 ? `, folded: ${summary}${foldedUnread ? ', something new' : ''}` : ''}`}
                onClick={() => tabLayout.updateGroup(group.id, { collapsed: !group.collapsed })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  groupAnchor.current = e.currentTarget
                  setEditGroupId(group.id)
                }}
              >
                <span className="cr-tab-group-swatch" aria-hidden="true" />
                {group.name.trim() && <span className="cr-tab-group-name">{group.name}</span>}
                {hiddenCount > 0 && (
                  <span className="cr-tab-group-folded">
                    {loudest && <StatusDot status={loudest} size={8} />}
                    <Count value={hiddenCount} />
                  </span>
                )}
                {foldedUnread && <span className="cr-tab-unread" aria-hidden="true" />}
              </button>
            </Tooltip>
            {run.items.map((i) => renderTab(i.session, i.index, hidden.has(i.session.key)))}
          </div>
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
        <MenuItems items={menuItems} onPicked={() => setMenuKey(null)} />
        {/* A grouped tab takes its group's colour; change it on the group. */}
        {menuSession && colourKeys.length > 0 && (
          <>
            <div role="separator" className="cr-popover-separator" />
            <ColourSwatches
              label={multi ? `Colour for ${colourKeys.length} tabs` : 'Tab colour'}
              value={colourValue}
              onPick={(colour) => {
                tabLayout.setColour(colourKeys, colour)
                if (multi) {
                  setPicked([])
                  setMenuKey(null)
                }
              }}
            />
          </>
        )}
      </Popover>
      <Popover
        open={editGroup !== null}
        onClose={() => setEditGroupId(null)}
        anchorRef={groupAnchor}
        placement="bottom-start"
        className="cr-tab-menu"
        role="dialog"
        aria-label="Edit group"
      >
        {editGroup && (
          <>
            <input
              className="cr-tab-group-input"
              autoFocus
              aria-label="Group name"
              placeholder="Name this group"
              value={editGroup.name}
              onChange={(e) => tabLayout.updateGroup(editGroup.id, { name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setEditGroupId(null)
              }}
            />
            <ColourSwatches
              label="Group colour"
              allowNone={false}
              value={editGroup.colour}
              onPick={(colour) => colour && tabLayout.updateGroup(editGroup.id, { colour })}
            />
            <div role="separator" className="cr-popover-separator" />
            <MenuItems
              onPicked={() => setEditGroupId(null)}
              items={[
                { label: 'Ungroup', onClick: () => tabLayout.ungroup(editGroup.id) },
                { label: 'Close group', onClick: () => onCloseGroup(editGroup.id) }
              ]}
            />
          </>
        )}
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
