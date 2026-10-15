import { useCallback, useEffect, useState } from 'react'
import type { LiveSession, Project } from '../../../main/store/types'
import { listSessions, onSessionsChanged } from '../api'

// A session belongs to exactly one project — this is the one rule for
// deciding which, used everywhere a session is attributed to a project
// (the rail, the projects list, the sessions list). Previously the rail
// matched by projectId OR cwd-prefix while the list matched by projectId
// alone; two projects can share a worktreeRoot (the fixture's
// data-infrastructure/fixture-project pair), and the OR let a session
// double-count into both. record.projectId is authoritative whenever a
// session has a record; cwd-prefix is only a fallback for a session seen
// live with no record at all, and even then it returns the first matching
// project rather than every project whose root happens to contain the cwd.
export function resolveSessionProjectId(session: LiveSession, projects: Project[]): string | null {
  if (session.record) return session.record.projectId
  const byPath = projects.find(
    (p) => session.cwd === p.repoPath || session.cwd.startsWith(`${p.worktreeRoot}/`)
  )
  return byPath?.id ?? null
}

export function useSessions(): {
  sessions: LiveSession[]
  refresh: () => Promise<void>
  error: string | null
} {
  const [sessions, setSessions] = useState<LiveSession[]>([])

  const [error, setError] = useState<string | null>(null)

  // Returns the promise rather than firing and forgetting: callers that need
  // the data before carrying on — the shot harness, which was photographing
  // an empty list because `await refresh()` awaited undefined — have no way
  // to wait otherwise.
  const refresh = useCallback(() => {
    return (
      listSessions()
        .then((next) => {
          setSessions(next)
          setError(null)
        })
        // Without this the list just stayed empty and said "No sessions yet",
        // which reads as "you have none" rather than "this failed".
        .catch((err: unknown) => setError(String(err)))
    )
  }, [])

  useEffect(() => {
    refresh()
    return onSessionsChanged((next) => setSessions(next))
  }, [refresh])

  return { sessions, refresh, error }
}
