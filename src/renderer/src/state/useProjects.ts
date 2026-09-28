import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../../../main/store/types'
import { listProjects } from '../api'

export function useProjects(): { projects: Project[]; refresh: () => Promise<void> } {
  const [projects, setProjects] = useState<Project[]>([])

  // Awaitable for the same reason useSessions' is — see there.
  const refresh = useCallback(() => {
    return listProjects().then(setProjects)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { projects, refresh }
}
