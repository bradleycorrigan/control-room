import { useCallback, useEffect, useRef, useState } from 'react'
import { onToast } from '../api'

export interface ToastAction {
  label: string
  onClick: () => void
}

/** What a toast is reporting: drives its glyph and colour, never its words. */
export type ToastTone = 'info' | 'success' | 'error'

export interface ToastOptions {
  /** Left out, it's read from the message (see `toneOf`). */
  tone?: ToastTone
  /** A short bold line above the message, for a toast that asks something. */
  title?: string
  action?: ToastAction
  /** A quieter second choice beside the action, like "Not now". */
  secondary?: ToastAction
  /** Stays until dismissed. */
  sticky?: boolean
}

export interface Toast {
  id: number
  message: string
  title?: string
  tone: ToastTone
  action?: ToastAction
  secondary?: ToastAction
  /** How many times this same message arrived while it was showing. */
  count: number
  /** ms it stays for, or null when it waits for the dismiss button. */
  lifetime: number | null
  /** Playing its exit; removed once that's done. */
  leaving: boolean
  /** Bumped when a repeat restarts its countdown, so the bar restarts too. */
  round: number
}

const TOAST_LIFETIME_MS = 5000
// A toast that offers something needs long enough to read and reach for.
const ACTION_LIFETIME_MS = 8000
// A flat 5s timer cuts off anything longer than a short confirmation before
// it can be read — a "Finished:" toast carrying the first line of an
// assistant turn, or a git error with a path in it, both run well past this.
// Past this many characters a toast no longer auto-dismisses at all; it
// waits for the dismiss button instead.
const TOAST_AUTO_DISMISS_CHAR_LIMIT = 80
// Matches the exit animation in styles.css.
const LEAVE_MS = 160
// More than this and the oldest go: a burst shouldn't wall off the corner.
const MAX_SHOWN = 4

const ERROR_WORDS =
  /^(could not|couldn[’']t|can[’']t|cannot|failed|error|unable|refusing)\b|\b(could not|couldn[’']t|failed to)\b/i
const SUCCESS_WORDS =
  /\b(copied|saved|created|deleted|removed|installed|updated|added|marked done|wrapped up|merged|pinned|unpinned|renamed|restored|sent|posted|moved|forked|archived|done)\b/i

/** Reads a tone from the message, so the 70-odd existing callers get one free. */
export function toneOf(message: string): ToastTone {
  if (ERROR_WORDS.test(message)) return 'error'
  if (SUCCESS_WORDS.test(message)) return 'success'
  return 'info'
}

export type PushToast = (message: string, options?: ToastAction | ToastOptions) => void

export interface ToastsController {
  toasts: Toast[]
  push: PushToast
  dismiss: (id: number) => void
  /** Hovering holds a toast: its countdown stops until the pointer leaves. */
  pause: (id: number) => void
  resume: (id: number) => void
}

let nextId = 1

interface Timer {
  handle: ReturnType<typeof setTimeout> | null
  remaining: number
  startedAt: number
}

export function useToasts(): ToastsController {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<number, Timer>())
  // The list as last set, so push can read it without doing its work inside
  // a state updater (which React may run twice).
  const current = useRef<Toast[]>([])
  const commit = useCallback((next: Toast[]) => {
    current.current = next
    setToasts(next)
  }, [])

  const remove = useCallback(
    (id: number) => {
      const timer = timers.current.get(id)
      if (timer?.handle) clearTimeout(timer.handle)
      timers.current.delete(id)
      commit(current.current.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
      setTimeout(() => commit(current.current.filter((t) => t.id !== id)), LEAVE_MS)
    },
    [commit]
  )

  const start = useCallback(
    (id: number, ms: number) => {
      const old = timers.current.get(id)
      if (old?.handle) clearTimeout(old.handle)
      timers.current.set(id, {
        handle: setTimeout(() => remove(id), ms),
        remaining: ms,
        startedAt: Date.now()
      })
    },
    [remove]
  )

  const pause = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (!timer?.handle) return
    clearTimeout(timer.handle)
    timer.handle = null
    timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt))
  }, [])

  const resume = useCallback(
    (id: number) => {
      const timer = timers.current.get(id)
      if (!timer || timer.handle) return
      timer.startedAt = Date.now()
      timer.handle = setTimeout(() => remove(id), timer.remaining)
    },
    [remove]
  )

  const push = useCallback(
    (message: string, options?: ToastAction | ToastOptions) => {
      const opts: ToastOptions =
        options && 'onClick' in options ? { action: options } : (options ?? {})
      const lifetime =
        opts.sticky || message.length > TOAST_AUTO_DISMISS_CHAR_LIMIT
          ? null
          : opts.action
            ? ACTION_LIFETIME_MS
            : TOAST_LIFETIME_MS
      const prev = current.current
      // The same words again while they're still up: count it, restart the
      // clock, and don't stack a twin.
      const twin = opts.action
        ? undefined
        : prev.find((t) => !t.leaving && t.message === message && !t.action)
      if (twin) {
        if (twin.lifetime !== null) start(twin.id, twin.lifetime)
        commit(
          prev.map((t) => (t.id === twin.id ? { ...t, count: t.count + 1, round: t.round + 1 } : t))
        )
        return
      }
      const toast: Toast = {
        id: nextId++,
        message,
        title: opts.title,
        tone: opts.tone ?? toneOf(message),
        action: opts.action,
        secondary: opts.secondary,
        count: 1,
        lifetime,
        leaving: false,
        round: 0
      }
      if (lifetime !== null) start(toast.id, lifetime)
      const next = [...prev, toast]
      const shown = next.filter((t) => !t.leaving)
      const over = shown.length - MAX_SHOWN
      const drop = new Set(over > 0 ? shown.slice(0, over).map((t) => t.id) : [])
      for (const id of drop) {
        const timer = timers.current.get(id)
        if (timer?.handle) clearTimeout(timer.handle)
        timers.current.delete(id)
      }
      commit(next.filter((t) => !drop.has(t.id)))
    },
    [start, commit]
  )

  // Toasts also arrive from the main process (hook events, binary checks) —
  // route those through the same queue as locally-triggered ones (e.g. a
  // keyboard shortcut or palette command that has nothing to act on yet).
  useEffect(() => {
    return onToast((message) => push(message))
  }, [push])

  useEffect(() => {
    const all = timers.current
    return () => {
      for (const t of all.values()) if (t.handle) clearTimeout(t.handle)
    }
  }, [])

  return { toasts, push, dismiss: remove, pause, resume }
}
