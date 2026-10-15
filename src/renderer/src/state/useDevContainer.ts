import { useEffect, useState } from 'react'
import {
  getDevContainerAvailability,
  onSettingsChanged,
  type DevContainerAvailability
} from '../api'

const NONE: DevContainerAvailability = { available: false, byDefault: false }

/**
 * Whether a new session in `projectId` can start in a dev container, and
 * whether that's the default. Asked again when the project or any setting
 * changes, so turning the default on in Settings shows straight away. While
 * the answer is on its way, the option stays hidden: it never shows a choice
 * that might not work.
 */
export function useDevContainer(projectId: string | null): DevContainerAvailability {
  const [state, setState] = useState<{ id: string | null; value: DevContainerAvailability }>({
    id: null,
    value: NONE
  })

  useEffect(() => {
    if (!projectId) return
    let live = true
    const ask = (): void => {
      getDevContainerAvailability(projectId)
        .then((value) => {
          if (live) setState({ id: projectId, value })
        })
        .catch(() => {
          if (live) setState({ id: projectId, value: NONE })
        })
    }
    ask()
    const off = onSettingsChanged(ask)
    return () => {
      live = false
      off()
    }
  }, [projectId])

  return state.id === projectId ? state.value : NONE
}
