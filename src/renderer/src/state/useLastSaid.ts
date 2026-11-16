import { useEffect, useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import { getLastSaid } from '../api-sessions'

/** What Claude last said in a session, as one line; read again whenever it moves on. */
export function useLastSaid(session: LiveSession): string | null {
  const [said, setSaid] = useState<string | null>(null)
  const id = session.claudeSessionId
  useEffect(() => {
    if (!id) return
    let live = true
    void getLastSaid(id).then((t) => live && setSaid(t))
    return () => {
      live = false
    }
  }, [id, session.activityAt, session.status])
  return id ? said : null
}
