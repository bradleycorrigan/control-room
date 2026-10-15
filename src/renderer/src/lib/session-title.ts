import type { LiveSession } from '../../../main/store/types'

/** What a session is called on screen: its name, else its agent's, else its folder. */
export function sessionTitle(session: LiveSession): string {
  return session.record?.title ?? session.agentName ?? session.cwd
}
