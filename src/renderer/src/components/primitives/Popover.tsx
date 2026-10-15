import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDismissible } from '../../keyboard'
import './primitives.css'

/** Distance between the trigger and the panel. */
const GAP = 4
/** How close the panel may come to the window edge. */
const EDGE_MARGIN = 8
/** Below this a scrolling panel is useless, so flip rather than squeeze. */
const MIN_USABLE_HEIGHT = 120

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export interface PopoverProps {
  /** Whether the panel is showing. The trigger owns this state. */
  open: boolean
  /** Called on Escape, on an outside click, and when the window scrolls away. */
  onClose: () => void
  /**
   * The element the panel hangs off. Clicks inside it never count as outside,
   * so a trigger that toggles `open` keeps working.
   */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Preferred corner. Flips to the opposite side when there is no room. */
  placement?: PopoverPlacement
  /** Distance from the trigger, in px. */
  gap?: number
  /** Extra classes on the panel, for per-menu width and item styling. */
  className?: string
  /** `menu` for a list of actions; `dialog` for anything richer. */
  role?: 'menu' | 'dialog' | 'listbox'
  'aria-label'?: string
  children: React.ReactNode
}

/**
 * A floating panel anchored to a trigger.
 *
 * Rendered in a portal on `document.body`, so no ancestor's `overflow` can
 * clip it — the trap that hid the New session project picker, where the
 * pill sat at the bottom of a modal whose `overflow-y: auto` swallowed
 * everything below its edge. Position comes from the trigger's own rect,
 * measured at open and again on scroll and resize.
 *
 * It flips to the other side when the preferred one has no room, clamps
 * itself inside the window, and caps its height to what is actually
 * available so a long list scrolls instead of running off-screen.
 *
 * Closing is handled here too: Escape, and any pointer press outside both
 * the panel and the trigger.
 */
export default function Popover({
  open,
  onClose,
  anchorRef,
  placement = 'bottom-start',
  gap = GAP,
  className = '',
  role = 'menu',
  'aria-label': ariaLabel,
  children
}: PopoverProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  // Where focus was when the menu opened, so Escape or a pick can hand it
  // back. Without this, closing leaves focus on <body> and the next Tab
  // starts from the top of the window.
  const returnFocusTo = useRef<HTMLElement | null>(null)
  // The panel's natural height at the last placement, so a resize only
  // re-places it when the content really changed (see the observer below).
  const naturalHeight = useRef(0)

  /**
   * The items you can arrow between: every enabled control in the panel, in
   * DOM order. Read fresh on each keystroke rather than cached, because a
   * menu's items can change while it is open — the composer's model menu
   * swaps its whole list when you drill into thinking levels.
   */
  const items = useCallback(
    (): HTMLElement[] =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ),
    []
  )

  const place = useCallback((): void => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return

    // Measure the panel at its natural size — a max-height left over from the
    // last placement would otherwise make it look like it fits.
    panel.style.maxHeight = ''
    const { width, height } = panel.getBoundingClientRect()
    naturalHeight.current = height
    const r = anchor.getBoundingClientRect()

    const roomBelow = window.innerHeight - r.bottom - gap - EDGE_MARGIN
    const roomAbove = r.top - gap - EDGE_MARGIN
    const wantsBottom = placement.startsWith('bottom')
    const preferred = wantsBottom ? roomBelow : roomAbove
    const other = wantsBottom ? roomAbove : roomBelow
    // Only flip if the other side is genuinely better — flipping into an
    // equally cramped space just moves the problem.
    const onBottom = height <= preferred || other <= preferred ? wantsBottom : !wantsBottom

    const room = onBottom ? roomBelow : roomAbove
    const maxHeight = Math.max(room, MIN_USABLE_HEIGHT)
    const shown = Math.min(height, maxHeight)

    const left = placement.endsWith('end') ? r.right - width : r.left
    const maxLeft = window.innerWidth - width - EDGE_MARGIN

    setPos({
      top: onBottom ? r.bottom + gap : r.top - gap - shown,
      left: maxLeft > EDGE_MARGIN ? Math.min(Math.max(left, EDGE_MARGIN), maxLeft) : EDGE_MARGIN,
      maxHeight
    })
  }, [anchorRef, gap, placement])

  // Place before paint, so the panel never shows in the wrong spot first. The
  // last position is left behind on close rather than cleared — the component
  // renders nothing while closed, and this effect re-measures on reopen before
  // the browser paints, so a stale value is never on screen.
  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useDismissible(open, 'popover', onClose)

  // Move focus into the menu on open and give it back on close.
  //
  // Waits for the first measurement: until `pos` lands the panel is rendered
  // `visibility: hidden`, and a hidden element cannot take focus — calling
  // .focus() there silently did nothing and left the menu unnavigable.
  const placed = pos !== null
  // Content that arrives after opening (a list still loading) changes the
  // panel's height; measured only at open, a panel placed while empty grew
  // straight off the bottom of the window. Re-place whenever it resizes.
  useEffect(() => {
    if (!open || !panelRef.current || typeof ResizeObserver === 'undefined') return
    // Placing clears and re-sets the max-height, which is itself a resize:
    // re-placing on every one looped forever and froze the page. Only a
    // change in the content's own height counts.
    const observer = new ResizeObserver(() => {
      const panel = panelRef.current
      if (panel && Math.abs(panel.scrollHeight - naturalHeight.current) > 1) place()
    })
    observer.observe(panelRef.current)
    return () => observer.disconnect()
  }, [open, placed, place])

  useLayoutEffect(() => {
    if (!open || !placed) return
    returnFocusTo.current = document.activeElement as HTMLElement | null
    items()[0]?.focus()
    return () => {
      // Only take focus back if it is still inside the panel we are tearing
      // down — clicking straight onto something else should not be undone.
      if (document.activeElement === document.body || document.activeElement === null) {
        returnFocusTo.current?.focus()
      }
      returnFocusTo.current = null
    }
  }, [open, placed, items])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      // Escape is not handled here — useDismissible owns it, so a menu inside
      // a modal closes before the modal does rather than racing it.
      // Arrow keys only mean "move through this menu" while focus is in it.
      // Otherwise they belong to whatever the user is actually typing in.
      if (!panelRef.current?.contains(document.activeElement)) return

      const list = items()
      if (list.length === 0) return
      const at = list.indexOf(document.activeElement as HTMLElement)

      // Tab out of an open menu closes it rather than walking behind it into
      // the page, which is what a menu means by "done here".
      if (e.key === 'Tab') {
        onClose()
        return
      }

      const next = {
        ArrowDown: at < 0 ? 0 : (at + 1) % list.length,
        ArrowUp: at <= 0 ? list.length - 1 : at - 1,
        Home: 0,
        End: list.length - 1
      }[e.key]

      if (next === undefined) return
      e.preventDefault()
      e.stopPropagation()
      list[next].focus()
    }
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    // Capture, so a scroll in any container repositions rather than leaving
    // the panel floating over unrelated content.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, place, onClose, anchorRef, items])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      className={className ? `cr-popover ${className}` : 'cr-popover'}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        maxHeight: pos?.maxHeight,
        // Hidden for the single frame before the first measurement lands.
        visibility: pos ? 'visible' : 'hidden'
      }}
    >
      {children}
    </div>,
    document.body
  )
}
