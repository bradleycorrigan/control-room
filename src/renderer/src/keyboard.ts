import { useEffect, useRef } from 'react'

// The global keyboard map (plan section 2.0, "Keyboard map" table). One
// source of truth for the key combos themselves — the command palette and
// the keyboard-help overlay both render from KEYBOARD_MAP rather than
// hard-coding the combo strings again.
export type KeyboardActionId =
  | 'palette'
  | 'projects'
  | 'sessions'
  | 'new-session'
  | 'open-ide'
  | 'focus-terminal'
  | 'grid'
  | 'toggle-sidebar'
  | 'help'
  | 'settings'
  | 'move-down'
  | 'move-up'
  | 'open-selected'
  | 'back'
  | 'forward'
  | 'next-tab'
  | 'prev-tab'
  | 'close-tab'
  | 'jump-tab'
  | 'new-tab'
  | 'home-tab'

export interface KeyboardMapEntry {
  id: KeyboardActionId
  combo: string
  description: string
}

export const KEYBOARD_MAP: KeyboardMapEntry[] = [
  { id: 'palette', combo: '⌘K', description: 'Command palette' },
  { id: 'projects', combo: '⌘⇧1', description: 'Projects' },
  { id: 'sessions', combo: '⌘⇧2', description: 'Sessions' },
  { id: 'new-session', combo: '⌘N', description: 'New session' },
  { id: 'open-ide', combo: '⌘⇧O', description: 'Open current session in Cursor' },
  { id: 'focus-terminal', combo: '⌘⇧E', description: 'Focus the tmux window' },
  { id: 'grid', combo: '⌘G', description: 'Grid view toggle' },
  { id: 'toggle-sidebar', combo: '⌘B', description: 'Show or hide the sidebar' },
  { id: 'help', combo: '⌘/', description: 'Keyboard help' },
  { id: 'settings', combo: '⌘,', description: 'Settings' },
  { id: 'move-down', combo: 'J', description: 'Move down the list' },
  { id: 'move-up', combo: 'K', description: 'Move up the list' },
  { id: 'open-selected', combo: 'Enter', description: 'Open the selected session' },
  { id: 'back', combo: '⌘[', description: 'Back' },
  { id: 'forward', combo: '⌘]', description: 'Forward' },
  { id: 'next-tab', combo: '⌘⇧]', description: 'Next session tab' },
  { id: 'prev-tab', combo: '⌘⇧[', description: 'Previous session tab' },
  { id: 'home-tab', combo: '⌘0', description: 'All sessions (the pinned tab)' },
  { id: 'jump-tab', combo: '⌘1–9', description: 'Jump to a session tab (⌘9: the last one)' },
  { id: 'new-tab', combo: '⌘T', description: 'New session, in a new tab' },
  { id: 'close-tab', combo: '⌘W', description: 'Close the session tab, or the window' }
]

// `jump-tab` takes the tab's position; everything else takes nothing.
// `close-tab` isn't here: ⌘W belongs to the app menu, so main catches it and
// sends it over (see App.tsx's onCloseTabShortcut).
export type KeyboardActions = Partial<
  Record<Exclude<KeyboardActionId, 'jump-tab' | 'close-tab'>, () => void>
> & { 'jump-tab'?: (index: number) => void }

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Wires every shortcut in KEYBOARD_MAP to a `document`-level keydown
 * listener. `actions` is looked up fresh on every keydown via a ref-free
 * closure swap (the effect re-runs when the actions object identity
 * changes), so callers can pass inline handlers without worrying about
 * stale closures.
 *
 * ⌘-prefixed combos fire regardless of focus (a command palette should open
 * even while a text field is focused). The bare list-navigation keys
 * (J / K / Enter) are suppressed while the user is typing into an input,
 * textarea, select or a contenteditable element.
 */
export function useKeyboardMap(actions: KeyboardActions): void {
  // A ref so callers can pass a fresh inline object every render without
  // tearing down and re-attaching the listener each time.
  const actionsRef = useRef(actions)
  useEffect(() => {
    actionsRef.current = actions
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const actions = actionsRef.current
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      if (mod && !e.shiftKey && key === 'k') {
        e.preventDefault()
        actions.palette?.()
        return
      }
      // ⌘1–9 are the session tabs, as in a browser, so the two screens they
      // used to open moved up a shift. `code`, because shift turns the digit
      // into a symbol in `key`.
      if (mod && e.shiftKey && e.code === 'Digit1') {
        e.preventDefault()
        actions.projects?.()
        return
      }
      if (mod && e.shiftKey && e.code === 'Digit2') {
        e.preventDefault()
        actions.sessions?.()
        return
      }
      if (mod && !e.shiftKey && !e.altKey && e.code === 'Digit0') {
        e.preventDefault()
        actions['home-tab']?.()
        return
      }
      if (mod && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault()
        actions['jump-tab']?.(Number(e.code.slice(5)) - 1)
        return
      }
      if (mod && !e.shiftKey && key === 't') {
        e.preventDefault()
        actions['new-tab']?.()
        return
      }
      if (mod && !e.shiftKey && key === 'n') {
        e.preventDefault()
        actions['new-session']?.()
        return
      }
      if (mod && e.shiftKey && key === 'o') {
        e.preventDefault()
        actions['open-ide']?.()
        return
      }
      if (mod && e.shiftKey && key === 'e') {
        e.preventDefault()
        actions['focus-terminal']?.()
        return
      }
      if (mod && !e.shiftKey && key === 'b') {
        e.preventDefault()
        actions['toggle-sidebar']?.()
        return
      }
      if (mod && !e.shiftKey && key === 'g') {
        e.preventDefault()
        actions.grid?.()
        return
      }
      if (mod && key === '/') {
        e.preventDefault()
        actions.help?.()
        return
      }
      if (mod && key === ',') {
        e.preventDefault()
        actions.settings?.()
        return
      }
      // Session tabs. Before back/forward below, which would otherwise take
      // ⌘⇧[ as ⌘[ — `code` is the bracket key whatever shift makes of it.
      // ⌃Tab too, the other thing hands already know for tabs.
      if (
        (mod && e.shiftKey && e.code === 'BracketRight') ||
        (e.ctrlKey && !e.shiftKey && key === 'tab')
      ) {
        e.preventDefault()
        actions['next-tab']?.()
        return
      }
      if (
        (mod && e.shiftKey && e.code === 'BracketLeft') ||
        (e.ctrlKey && e.shiftKey && key === 'tab')
      ) {
        e.preventDefault()
        actions['prev-tab']?.()
        return
      }

      // Browser back/forward, because that is what everyone's hands already
      // know. `key` is the bracket itself on a US layout; `code` covers the
      // layouts where it is not.
      if (mod && (key === '[' || e.code === 'BracketLeft')) {
        e.preventDefault()
        actions.back?.()
        return
      }
      if (mod && (key === ']' || e.code === 'BracketRight')) {
        e.preventDefault()
        actions.forward?.()
        return
      }

      // Bare, unmodified keys — only when not typing somewhere.
      if (!mod && !e.altKey && !isTypingTarget(e.target)) {
        if (key === 'j') {
          e.preventDefault()
          actions['move-down']?.()
          return
        }
        if (key === 'k') {
          e.preventDefault()
          actions['move-up']?.()
          return
        }
        if (key === 'enter') {
          actions['open-selected']?.()
          return
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

// ---------------------------------------------------------------------------
// Escape precedence
// ---------------------------------------------------------------------------

/**
 * Which layer a dismissible thing sits on. Mirrors the stacking order in
 * theme/tokens.css, because "what Escape closes" and "what is drawn on top"
 * are the same question asked twice.
 */
export type DismissLayer = 'overlay' | 'modal' | 'popover'

const LAYER_RANK: Record<DismissLayer, number> = { overlay: 1, modal: 2, popover: 3 }

interface Dismissible {
  rank: number
  /** Breaks ties between two things on the same layer — newest wins. */
  seq: number
  dismiss: () => boolean | void
}

const stack: Dismissible[] = []
let seqCounter = 0
let listening = false

function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || stack.length === 0) return
  // Topmost first: highest layer, and within a layer the one opened last. A
  // menu inside a modal closes before the modal; the modal closes before the
  // maximized terminal behind it. Walk down until something takes the press.
  // An entry returning false is registered but not interested right now — the
  // maximized terminal declines while the terminal has keyboard focus, so
  // Escape reaches the agent. If nobody takes it, the event goes on untouched.
  for (const entry of [...stack].sort((a, b) => b.rank - a.rank || b.seq - a.seq)) {
    if (entry.dismiss() === false) continue
    e.preventDefault()
    e.stopPropagation()
    return
  }
}

/**
 * Closes this thing when Escape is pressed and nothing is stacked above it.
 *
 * Every overlay used to listen for Escape on its own, in whatever phase it
 * happened to pick, so which one closed came down to listener order — an
 * accident that happened to look right. One stack makes it a decision.
 *
 * Tooltips stay out of this deliberately: a tooltip is showing because you
 * are pointing at something, not because you opened it, so Escape should
 * dismiss it *and* whatever is underneath, in one press.
 */
export function useDismissible(
  active: boolean,
  layer: DismissLayer,
  /** Return false to decline this press and let the layer below try. */
  onDismiss: () => boolean | void
): void {
  // Kept in a ref so a caller passing an inline arrow — which is all of them —
  // does not re-register the entry on every render and jump its own seq to the
  // top of its layer.
  const latest = useRef(onDismiss)
  useEffect(() => {
    latest.current = onDismiss
  })

  useEffect(() => {
    if (!active) return
    const entry: Dismissible = {
      rank: LAYER_RANK[layer],
      seq: ++seqCounter,
      dismiss: () => latest.current()
    }
    stack.push(entry)
    if (!listening) {
      // Capture, so this resolves before any component's own bubble-phase
      // handler gets a chance to act on the same press.
      window.addEventListener('keydown', onEscape, true)
      listening = true
    }
    return () => {
      stack.splice(stack.indexOf(entry), 1)
      if (stack.length === 0 && listening) {
        window.removeEventListener('keydown', onEscape, true)
        listening = false
      }
    }
  }, [active, layer])
}
