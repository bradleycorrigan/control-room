import { useEffect, useRef, useState } from 'react'
import { suggestSessionTitle } from '../api-sessions'

/**
 * "Suggest a name" for a rename field. Haiku starts as soon as the field
 * opens, so by the time someone reaches for the button the answer is usually
 * there; pressing it early just waits for it. `apply` gets the title.
 */
export function useTitleSuggestion(
  recordId: string | null,
  apply: (title: string) => void
): {
  suggest: () => void
  state: 'idle' | 'waiting' | 'error'
  error: string | null
} {
  const pending = useRef<ReturnType<typeof suggestSessionTitle> | null>(null)
  const [state, setState] = useState<'idle' | 'waiting' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  const applyRef = useRef(apply)
  useEffect(() => {
    applyRef.current = apply
  })

  useEffect(() => {
    live.current = true
    if (recordId) pending.current = suggestSessionTitle(recordId)
    return () => {
      live.current = false
    }
  }, [recordId])

  const suggest = (): void => {
    if (!recordId || state === 'waiting') return
    // A second press after one was used asks again, for a different one.
    const ask = pending.current ?? suggestSessionTitle(recordId)
    pending.current = null
    setState('waiting')
    setError(null)
    void ask
      .catch((e: unknown) => ({ ok: false as const, error: String(e) }))
      .then((r) => {
        if (!live.current) return
        if (r.ok) {
          setState('idle')
          applyRef.current(r.value)
        } else {
          setState('error')
          setError(r.error)
        }
      })
  }

  return { suggest, state, error }
}
