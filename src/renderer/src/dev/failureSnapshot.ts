// Dev-only: one short line saying what the app was showing, appended to a
// failing check's FAIL line so nobody has to re-run to guess why it failed.
// Reads the DOM only, never throws, and keeps the line free of quotes and
// backslashes so the gate's log parser needs no unescaping to read it.

const CAP = 400

let pointer: { x: number; y: number } | null = null
let pointerTracked = false

/** Records the last pointer position. Safe to call many times; installs once. */
export function trackPointer(): void {
  if (pointerTracked) return
  pointerTracked = true
  window.addEventListener(
    'mousemove',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY }
    },
    { capture: true, passive: true }
  )
}

/** A tag plus its first class, or its aria-label when it has one. */
function describe(el: Element): string {
  const label = el.getAttribute('aria-label')
  if (label) return `${el.tagName.toLowerCase()}[${label}]`
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0]
  return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase()
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function safe(part: () => string | null): string | null {
  try {
    return part()
  } catch {
    return null
  }
}

function screenPart(): string | null {
  const screen = document.querySelector('.main-pane')?.getAttribute('data-screen')
  return `screen: ${screen ?? 'unknown'}`
}

function overlayPart(): string | null {
  const seen = new Set<Element>()
  const shown: string[] = []
  for (const el of document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], .backlog-drawer'
  )) {
    if (seen.has(el)) continue
    seen.add(el)
    const name = el.getAttribute('aria-label') || text(el.querySelector('.cr-modal-title'))
    shown.push(name || describe(el))
  }
  return shown.length ? `overlay: ${shown.slice(0, 3).join(', ')}` : null
}

function toastPart(): string | null {
  const toasts = [...document.querySelectorAll('.toast-message')].map(text).filter(Boolean)
  return toasts.length ? `toast: ${toasts.slice(0, 3).join(' / ')}` : null
}

function tooltipPart(): string | null {
  const tip = text(document.querySelector('.cr-tooltip'))
  return tip ? `tooltip: ${tip}` : null
}

function focusPart(): string {
  const active = document.activeElement
  const what = active ? describe(active) : 'none'
  return `focus: ${what} (window focused: ${document.hasFocus() ? 'yes' : 'no'})`
}

function scrolledPart(): string | null {
  const scrolled: string[] = []
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollTop > 0) {
      scrolled.push(`${describe(el)}=${Math.round(el.scrollTop)}`)
      if (scrolled.length === 3) break
    }
  }
  return scrolled.length ? `scrolled: ${scrolled.join(', ')}` : null
}

function pointerPart(): string | null {
  if (!pointer) return 'pointer: not seen'
  const under = document.elementFromPoint(pointer.x, pointer.y)
  const at = under ? describe(under) : 'nothing'
  return `pointer: ${Math.round(pointer.x)},${Math.round(pointer.y)} over ${at}`
}

/** Makes text safe inside the log line: no quotes, backslashes or line breaks. */
function clean(line: string): string {
  return line.replace(/["\\]/g, "'").replace(/[\r\n\t]+/g, ' ')
}

/**
 * One compact line of what is on screen right now, for a failing check.
 * Every part is read on its own, so one that fails leaves the rest intact.
 */
export function failureSnapshot(): string {
  const parts = [
    safe(screenPart),
    safe(overlayPart),
    safe(toastPart),
    safe(tooltipPart),
    safe(focusPart),
    safe(scrolledPart),
    safe(pointerPart)
  ].filter((p): p is string => Boolean(p))
  const line = clean(parts.join(' | '))
  return line.length > CAP ? `${line.slice(0, CAP - 3)}...` : line
}
