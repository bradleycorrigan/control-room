import { useCallback, useState } from 'react'

/**
 * A per-viewer preference that survives a restart — a filter, a sort. Never
 * load-bearing: a private window or blocked storage just means the default.
 */
export function useStoredState<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  // Stable, so it can sit in an effect's dependencies like a useState setter.
  const set = useCallback(
    (next: T): void => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Private window or blocked site data — it just won't be remembered.
      }
    },
    [key]
  )
  return [value, set]
}
