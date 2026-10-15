import { useEffect, useRef, useState } from 'react'
import Convert from 'ansi-to-html'
import { getSessionPane } from '../api'

const PANE_POLL_MS = 1500
const PANE_SCROLLBACK_LINES = 2000
const SCROLLED_UP_THRESHOLD_PX = 40

// Fallbacks only for the instant before the DOM has computed styles to read
// (see readTermColors) — every real render sources fg/bg from the active
// theme's --term-fg/--term-bg tokens, never a literal.
const FALLBACK_TERM_FG = 'inherit'
const FALLBACK_TERM_BG = 'transparent'

// ansi-to-html's `fg` option is used whenever pane output emits an explicit
// "reset foreground" code (SGR 39) rather than a full reset — common in CLI
// tool output (git, npm, etc). A hardcoded fg here previously made pane text
// nearly illegible in light themes (dark theme's pale default happened to
// read fine, light theme's white-ish default on a light --term-bg did not).
// Reading the live token keeps it correct in every theme, including a
// runtime theme switch, and keeps this file's hex-literal grep clean.
function readTermColors(el: HTMLElement | null): { fg: string; bg: string } {
  const source = el ?? document.documentElement
  const styles = getComputedStyle(source)
  const fg = styles.getPropertyValue('--term-fg').trim()
  const bg = styles.getPropertyValue('--term-bg').trim()
  return { fg: fg || FALLBACK_TERM_FG, bg: bg || FALLBACK_TERM_BG }
}

interface Props {
  paneId: string | null
}

export default function PaneOutput({ paneId }: Props): React.JSX.Element {
  const [html, setHtml] = useState('')
  const [scrolledUp, setScrolledUp] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!paneId) return // render guard below shows the empty state; nothing to poll

    let cancelled = false

    const poll = (): void => {
      getSessionPane(paneId, PANE_SCROLLBACK_LINES).then((raw) => {
        if (cancelled) return
        // Re-read the tokens on every poll (cheap, ~1.5s) so a live theme
        // switch or the first paint (before the container has laid out)
        // both land on the right colours — escapeXML is mandatory, pane
        // content is untrusted.
        const { fg, bg } = readTermColors(containerRef.current)
        const convert = new Convert({ fg, bg, newline: false, escapeXML: true })
        setHtml(convert.toHtml(raw))
      })
    }

    poll()
    const timer = setInterval(poll, PANE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [paneId])

  // Plan 2.4 — "auto-scroll to the bottom unless the user has scrolled up".
  useEffect(() => {
    const el = containerRef.current
    if (!el || scrolledUp) return
    el.scrollTop = el.scrollHeight
  }, [html, scrolledUp])

  const handleScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setScrolledUp(distanceFromBottom > SCROLLED_UP_THRESHOLD_PX)
  }

  const jumpToLatest = (): void => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
    setScrolledUp(false)
  }

  if (!paneId) return <div className="pane-output empty-state">No live pane for this session.</div>

  return (
    <div className="pane-output-wrap">
      <div className="pane-output" ref={containerRef} onScroll={handleScroll}>
        {/* ansi-to-html output, constructed with escapeXML: true */}
        <pre dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {scrolledUp && (
        <button type="button" className="pane-output-jump" onClick={jumpToLatest}>
          Jump to latest ↓
        </button>
      )}
    </div>
  )
}
