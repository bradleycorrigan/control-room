import { useCallback, useEffect, useState } from 'react'
import { onToast } from '../api'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: number
  message: string
  action?: ToastAction
}

let nextId = 1
const TOAST_LIFETIME_MS = 5000
// A flat 5s timer cuts off anything longer than a short confirmation before
// it can be read — a "Finished:" toast carrying the first line of an
// assistant turn, or a git error with a path in it, both run well past this.
// Past this many characters a toast no longer auto-dismisses at all; it
// waits for the dismiss button instead. Short toasts (the common case — "Hooks
// installed.", "Skill created (project).") keep the existing 5s timing.
const TOAST_AUTO_DISMISS_CHAR_LIMIT = 80

export interface ToastsController {
  toasts: Toast[]
  push: (message: string, action?: ToastAction) => void
  dismiss: (id: number) => void
}

export function useToasts(): ToastsController {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((message: string, action?: ToastAction) => {
    const toast: Toast = { id: nextId++, message, action }
    setToasts((prev) => [...prev, toast])
    if (message.length <= TOAST_AUTO_DISMISS_CHAR_LIMIT) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id))
      }, TOAST_LIFETIME_MS)
    }
  }, [])

  // Toasts also arrive from the main process (hook events, binary checks) —
  // route those through the same queue as locally-triggered ones (e.g. a
  // keyboard shortcut or palette command that has nothing to act on yet).
  useEffect(() => {
    return onToast((message) => push(message))
  }, [push])

  return { toasts, push, dismiss }
}
