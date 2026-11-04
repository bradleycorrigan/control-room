// A session whose Claude is running in its own pane but has not written a
// session file yet. Every start looks like this for a moment. It stays like
// this when Claude stops to ask something first: the trust prompt in a folder
// it has never opened, a login, a settings warning. Discovery used to hide the
// pane until the session file appeared, which left those sessions on
// "Starting up" for good, with a question nobody could see.
//
// Pure on purpose: scripts/verify-pre-start.ts checks it without the app.

import type { TmuxPane } from '../exec/tmux'
import type { SessionRecord } from '../store/types'

// Claude writes its session file a second or two after it starts. A pane that
// has run Claude this long without one is waiting on a question.
export const PRE_START_GRACE_MS = 8_000

export const PRE_START_REASON =
  'Claude is asking something before it starts, such as whether to trust this folder. Answer it in the terminal.'

/**
 * The record's own pane, when it is running something other than a shell.
 * It must still be the pane this record made (same window, same folder):
 * tmux reuses pane ids after a restart, so an old record's `%17` can name
 * someone else's pane today.
 */
export function preStartPaneFor(
  record: Pick<SessionRecord, 'tmuxPaneId' | 'tmuxWindowId' | 'worktreePath' | 'devContainer'>,
  panesByPaneId: ReadonlyMap<string, TmuxPane>,
  shellCommands: ReadonlySet<string>
): TmuxPane | null {
  if (record.devContainer || !record.tmuxPaneId) return null
  const pane = panesByPaneId.get(record.tmuxPaneId)
  if (!pane) return null
  if (shellCommands.has(pane.paneCommand)) return null
  if (pane.windowId !== record.tmuxWindowId) return null
  if (pane.panePath !== record.worktreePath) return null
  return pane
}

/** 'working' while it may just be booting, then 'needs_attention'. */
export function preStartStatus(
  firstSeenAt: number,
  now: number
): { status: 'working' | 'needs_attention'; reason: string; waitingFor: string | null } {
  return now - firstSeenAt >= PRE_START_GRACE_MS
    ? { status: 'needs_attention', reason: PRE_START_REASON, waitingFor: PRE_START_REASON }
    : { status: 'working', reason: 'Starting Claude', waitingFor: null }
}
