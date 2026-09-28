import { useRef, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import { SegmentedControl, IconButton, Icon, Popover, Tooltip } from './primitives'

export type MainView = 'home' | 'projects' | 'sessions' | 'backlog'
// 'gallery' is a dev-only route (the primitives gallery, plan 3 milestone
// V1) reached only via the shot harness — never a MainView, so it never
// appears in normal navigation.
export type AppView = MainView | 'settings' | 'gallery'

export type ShellSize = 'wide' | 'medium' | 'narrow'

interface Props {
  view: AppView
  onSelectView: (view: MainView) => void
  sessions: LiveSession[]
  // Which breakpoint (plan 3, 1.5) the shell currently sits in, computed by a
  // ResizeObserver on the shell in App.tsx — never a viewport media query.
  size: ShellSize
  onOpenPalette: () => void
  onOpenSettings: () => void
  onInstallHooks: () => void
  onOpenDataFolder: () => void
  onNewSession: () => void
  onToggleHistory: () => void
  onViewSessions: () => void
  /** Show only the sessions waiting on the user. */
  /** The bell: open the list with Unread only on. */
  onShowUnread: () => void
  onToggleSidebar: () => void
  sidebarHidden: boolean
  /** The rail only exists on the Sessions view, so the toggle only exists there. */
  sidebarAvailable: boolean
  onToggleGridView: () => void
  gridViewActive: boolean
  onOpenKeyboardHelp: () => void
}

export default function AppShell({
  view,
  onSelectView,
  sessions,
  size, // Kept for Props compatibility (B6 doesn't use responsive sizing)
  onOpenPalette,
  onOpenSettings,
  onInstallHooks,
  onOpenDataFolder,
  onNewSession,
  onToggleHistory,
  onViewSessions,
  onShowUnread,
  onToggleSidebar,
  sidebarHidden,
  sidebarAvailable,
  onToggleGridView,
  gridViewActive,
  onOpenKeyboardHelp
}: Props): React.JSX.Element {
  void size
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowAnchor = useRef<HTMLDivElement>(null)

  // Count active sessions (working status)
  const activeCount = sessions.filter((s) => s.status === 'working').length
  // Sessions waiting on the user. This is the one number that means "do
  // something", so it gets its own control, coloured like the status it counts,
  // and it takes the place in-app notifications used to occupy: the app stopped
  // shouting each event and shows the standing total instead.
  // Unread — the same count as the house tab's badge. The bell used to count
  // "needs you" while the house counted unread: two numbers that nearly agreed.
  const unreadCount = sessions.filter((s) => s.unread).length
  const historyCount = sessions.length // For now, use total session count as history

  return (
    <div className="app-titlebar">
      <div className="app-titlebar-left">
        {/* Only on Sessions, because that is the only view with a rail to
            toggle. A button that visibly does nothing on three of four screens
            is worse than no button — CLAUDE.md: a control exists only if it
            works. ⌘B is gated the same way in App.tsx.

            The slot is always here though, empty on the other views. It used
            to appear and disappear with the button, which shoved Home /
            Projects / Sessions sideways every time you opened or left a
            session — the one control on this bar you navigate by, moving
            under the cursor. */}
        <div className="app-titlebar-sidebar-slot">
          {sidebarAvailable && (
            <div className="app-titlebar-no-drag">
              {/* Hiding the rail is also ⌘B. The button exists because a state you
              can only get out of with a shortcut is a state people get stuck
              in — and it carries aria-pressed so it reads as a toggle. */}
              <IconButton
                icon={sidebarHidden ? 'PanelLeftOpen' : 'PanelLeftClose'}
                label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
                tooltip={`${sidebarHidden ? 'Show' : 'Hide'} sidebar (⌘B)`}
                size={36}
                variant="ghost"
                aria-pressed={!sidebarHidden}
                onClick={onToggleSidebar}
              />
            </div>
          )}
        </div>
        <div className="app-titlebar-no-drag">
          <SegmentedControl
            options={[
              { value: 'home' as MainView, label: 'Home' },
              { value: 'projects' as MainView, label: 'Projects' },
              { value: 'sessions' as MainView, label: 'Sessions' },
              { value: 'backlog' as MainView, label: 'Backlog' }
            ]}
            // Home is where the app starts, and until now nothing could get
            // back to it — the switcher offered only the other two, so the
            // composer screen was unreachable the moment you navigated away.
            // Nothing selected on Settings or the dev gallery, rather than
            // lighting up Sessions — the switcher was claiming you were
            // somewhere you were not.
            value={
              view === 'home' || view === 'projects' || view === 'sessions' || view === 'backlog'
                ? view
                : ('' as MainView)
            }
            onChange={onSelectView}
            aria-label="Primary view"
          />
        </div>
      </div>

      <div className="app-titlebar-center">
        <button
          type="button"
          className="app-titlebar-search-button app-titlebar-no-drag"
          onClick={onOpenPalette}
          title="Search sessions, projects, commands…"
          aria-label="Search sessions, projects, commands…"
        >
          <Icon name="Search" size={15} />
          <span className="app-titlebar-search-text">Search or jump to…</span>
          <kbd className="app-titlebar-search-kbd">⌘K</kbd>
        </button>
      </div>

      <div className="app-titlebar-right">
        <IconButton
          icon="Plus"
          label="New session"
          size={36}
          variant="filled"
          className="app-titlebar-no-drag"
          title="Create new session"
          onClick={onNewSession}
        />

        {historyCount > 0 && (
          <div className="app-titlebar-icon-group app-titlebar-no-drag">
            <IconButton
              icon="History"
              label="History"
              size={36}
              variant="ghost"
              tooltip={`${historyCount} total`}
              onClick={onToggleHistory}
            />
            <span className="app-titlebar-icon-count">{historyCount}</span>
          </div>
        )}

        {unreadCount > 0 && (
          <div className="app-titlebar-icon-group app-titlebar-no-drag app-titlebar-attention">
            <IconButton
              icon="BellRing"
              label="Unread sessions"
              size={36}
              variant="ghost"
              tooltip={`${unreadCount} unread session${unreadCount === 1 ? '' : 's'}`}
              onClick={onShowUnread}
            />
            <span className="app-titlebar-icon-count">{unreadCount}</span>
          </div>
        )}

        {activeCount > 0 && (
          <div className="app-titlebar-icon-group app-titlebar-no-drag">
            <IconButton
              icon="Boxes"
              label="Active"
              size={36}
              variant="ghost"
              tooltip={`${activeCount} active`}
              onClick={onViewSessions}
            />
            <span className="app-titlebar-icon-count">{activeCount}</span>
          </div>
        )}

        <IconButton
          icon="LayoutGrid"
          label="Grid view"
          size={36}
          variant="ghost"
          className="app-titlebar-no-drag"
          title="Grid view"
          onClick={onToggleGridView}
          style={{
            background: gridViewActive ? 'var(--surface-raised)' : 'transparent'
          }}
        />

        <IconButton
          icon="HelpCircle"
          label="Help"
          size={36}
          variant="ghost"
          className="app-titlebar-no-drag"
          title="Help"
          onClick={onOpenKeyboardHelp}
        />

        <div className="app-titlebar-menu app-titlebar-no-drag" ref={overflowAnchor}>
          <Tooltip label="More options">
            <button
              type="button"
              className="app-titlebar-menu-button"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((v) => !v)}
            >
              <Icon name="MoreHorizontal" size={16} />
            </button>
          </Tooltip>
          <Popover
            open={overflowOpen}
            onClose={() => setOverflowOpen(false)}
            anchorRef={overflowAnchor}
            placement="bottom-end"
            className="app-titlebar-menu-list"
            aria-label="More options"
          >
            <button
              type="button"
              role="menuitem"
              className="app-titlebar-menu-item"
              onClick={() => {
                setOverflowOpen(false)
                onOpenSettings()
              }}
            >
              Settings
            </button>
            <button
              type="button"
              role="menuitem"
              className="app-titlebar-menu-item"
              onClick={() => {
                setOverflowOpen(false)
                onInstallHooks()
              }}
            >
              Install hooks
            </button>
            <button
              type="button"
              role="menuitem"
              className="app-titlebar-menu-item"
              onClick={() => {
                setOverflowOpen(false)
                onOpenDataFolder()
              }}
            >
              Open data folder
            </button>
          </Popover>
        </div>
      </div>
    </div>
  )
}
