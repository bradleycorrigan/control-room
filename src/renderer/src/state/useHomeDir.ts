import { useEffect, useState } from 'react'
import { getAppInfo } from '../api-projects'

/**
 * The renderer's home directory, for display only (swapping it for "~" in
 * long paths). Fetched once and cached for the life of the window — it
 * cannot change without a restart.
 */
let cached: string | null = null
let inflight: Promise<string | null> | null = null

export function useHomeDir(): string | null {
  const [homeDir, setHomeDir] = useState<string | null>(cached)

  useEffect(() => {
    if (cached !== null) return
    if (!inflight) {
      inflight = getAppInfo()
        .then((info) => {
          cached = info.homeDir
          return cached
        })
        .catch(() => null)
    }
    inflight.then((value) => {
      if (value !== null) setHomeDir(value)
    })
  }, [])

  return homeDir
}
