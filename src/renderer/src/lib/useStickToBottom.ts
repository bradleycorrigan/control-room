import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createStickToBottom, type StickToBottomState } from './vendor/stickToBottom'

/**
 * Keeps a growing log scrolled to its end while you're at the bottom, and
 * leaves you be once you scroll up to read: the chat view's follow. `unseen`
 * says something new arrived below while you were reading.
 */
export function useStickToBottom(ref: React.RefObject<HTMLElement | null>): StickToBottomState & {
  scrollToBottom: () => void
} {
  const log = useMemo(() => createStickToBottom({ threshold: 48 }), [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return log.connect(el)
  }, [log, ref])
  const state = useSyncExternalStore(log.subscribe, log.get)
  return { ...state, scrollToBottom: () => log.scrollToBottom({ behavior: 'smooth' }) }
}
