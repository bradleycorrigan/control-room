import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './primitives/primitives.css'

// Same timing and look as <Tooltip>, so the two can't be told apart.
const OPEN_DELAY_MS = 400
const GAP = 8
const EDGE_MARGIN = 8

/**
 * Hover text for every control that has none of its own.
 *
 * <Tooltip> covers the controls wrapped in it. Everything else (a button
 * with only an icon, or anything carrying a `title`) used to show nothing:
 * Electron's native title tooltip doesn't reliably appear. This watches the
 * whole page and shows the same tooltip for those, from the `title` or, on
 * a button with no words of its own, its aria-label. Mounted once, at the
 * root.
 */
export default function HoverHelp(): React.JSX.Element | null {
  const [tip, setTip] = useState<{
    text: string
    top: number
    left: number
    placed: 'top' | 'bottom'
  } | null>(null)
  const tipRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let current: HTMLElement | null = null

    /** What to say for this element, or null when it has its own tooltip or needs none. */
    const helpFor = (el: HTMLElement): string | null => {
      if (el.closest('.cr-tooltip-trigger')) return null
      const title = el.getAttribute('title') ?? el.dataset.crTitle
      if (title) return title
      const isControl = el.matches('button, [role="button"], a[href]')
      const words = (el.textContent ?? '').trim()
      return isControl && !words ? el.getAttribute('aria-label') : null
    }

    const hide = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (current?.dataset.crTitle !== undefined) {
        // Give the title back, now that ours is gone.
        current.setAttribute('title', current.dataset.crTitle)
        delete current.dataset.crTitle
      }
      current = null
      setTip(null)
    }

    const onOver = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      const el = target?.closest<HTMLElement>('[title], button, [role="button"], a[href]') ?? null
      if (el === current) return
      hide()
      if (!el) return
      const text = helpFor(el)
      if (!text) return
      current = el
      // Hold the title aside while hovering, so the native one never doubles ours.
      const title = el.getAttribute('title')
      if (title) {
        el.dataset.crTitle = title
        el.removeAttribute('title')
      }
      timer = setTimeout(() => {
        if (current !== el || !el.isConnected) return
        const r = el.getBoundingClientRect()
        const placed = r.top > 40 ? 'top' : 'bottom'
        setTip({
          text,
          top: placed === 'top' ? r.top - GAP : r.bottom + GAP,
          left: r.left + r.width / 2,
          placed
        })
      }, OPEN_DELAY_MS)
    }

    const onOut = (e: MouseEvent): void => {
      const to = e.relatedTarget as Node | null
      if (current && (!to || !current.contains(to))) hide()
    }

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    window.addEventListener('mousedown', hide, true)
    window.addEventListener('keydown', hide, true)
    window.addEventListener('scroll', hide, true)
    return () => {
      hide()
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      window.removeEventListener('mousedown', hide, true)
      window.removeEventListener('keydown', hide, true)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])

  // Keep it on screen near either edge, as <Tooltip> does.
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!tip || !el) return
    const half = el.offsetWidth / 2
    const minLeft = half + EDGE_MARGIN
    const maxLeft = window.innerWidth - half - EDGE_MARGIN
    if (maxLeft > minLeft) el.style.left = `${Math.min(Math.max(tip.left, minLeft), maxLeft)}px`
  }, [tip])

  if (!tip) return null
  return createPortal(
    <span
      ref={tipRef}
      role="tooltip"
      className={`cr-tooltip cr-tooltip--${tip.placed}`}
      data-hover-help
      style={{ top: tip.top, left: tip.left }}
    >
      {tip.text}
    </span>,
    document.body
  )
}
