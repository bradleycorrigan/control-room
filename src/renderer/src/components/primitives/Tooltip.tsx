import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './primitives.css'

const OPEN_DELAY_MS = 400
const GAP = 8
/** Keep in step with `--cr-tooltip-max-width` behaviour in primitives.css. */
const MAX_WIDTH = 280
const EDGE_MARGIN = 8

export interface TooltipProps {
  /** What the control does. Kept short — this is a label, not documentation. */
  label: string
  children: React.ReactNode
  /** Preferred side; flips automatically when there is no room. */
  side?: 'top' | 'bottom'
}

/**
 * Hover/focus tooltip for controls that show only an icon.
 *
 * Rendered in a portal so it is never clipped by a scroll container or by a
 * parent's overflow, and positioned from the trigger's own rect rather than
 * CSS anchoring, which Electron's Chromium does not yet support everywhere.
 * Opens on hover after a delay and on keyboard focus immediately; Escape
 * dismisses it. Purely descriptive — never put an action in here.
 */
export default function Tooltip({
  label,
  children,
  side = 'top'
}: TooltipProps): React.JSX.Element {
  const id = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; placed: 'top' | 'bottom' } | null>(
    null
  )

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const place = useCallback((): void => {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // Flip to the other side when the preferred one would go off-screen.
    const wantsTop = side === 'top'
    const fitsTop = r.top > 40
    const placed: 'top' | 'bottom' = wantsTop ? (fitsTop ? 'top' : 'bottom') : 'bottom'
    // The tooltip is centred on its trigger, so a control near either edge of
    // the window would otherwise have half its tooltip off-screen. Clamping the
    // centre keeps it fully visible; it only takes effect within half a
    // tooltip's width of an edge, where being slightly off-centre is much
    // better than being cut off.
    const half = MAX_WIDTH / 2
    const centre = r.left + r.width / 2
    const minLeft = half + EDGE_MARGIN
    const maxLeft = window.innerWidth - half - EDGE_MARGIN
    setPos({
      top: placed === 'top' ? r.top - GAP : r.bottom + GAP,
      left: maxLeft > minLeft ? Math.min(Math.max(centre, minLeft), maxLeft) : centre,
      placed
    })
  }, [side])

  const open = useCallback(
    (immediate: boolean): void => {
      clear()
      if (immediate) place()
      else timer.current = setTimeout(place, OPEN_DELAY_MS)
    },
    [clear, place]
  )

  const close = useCallback((): void => {
    clear()
    setPos(null)
  }, [clear])

  useEffect(() => clear, [clear])

  useEffect(() => {
    if (!pos) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [pos, close])

  return (
    <span
      ref={wrapRef}
      className="cr-tooltip-trigger"
      onMouseEnter={() => open(false)}
      onMouseLeave={close}
      onFocusCapture={() => open(true)}
      onBlurCapture={close}
      aria-describedby={pos ? id : undefined}
    >
      {children}
      {pos &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className={`cr-tooltip cr-tooltip--${pos.placed}`}
            style={{ top: pos.top, left: pos.left }}
          >
            {label}
          </span>,
          document.body
        )}
    </span>
  )
}
