import { getHookState } from './hooks-server'
import type { SessionStatus } from '../store/types'

const DONE_DECAY_MS = 30 * 60 * 1000

// sessionKey -> when M7's session detail (or the 30-minute decay) last cleared 'done'.
const doneAcknowledgedAt = new Map<string, number>()

/** M7 calls this when the user opens a session's detail view. */
export function acknowledgeSession(sessionKey: string): void {
  doneAcknowledgedAt.set(sessionKey, Date.now())
}

export interface SessionIdentityInput {
  recordId: string | null
  claudeSessionId: string | null
  tmuxPaneId: string | null
  cwd: string | null
}

/**
 * P1 fix — the status flake. A session's identity gets more specific over
 * time (a SessionRecord gets matched, a `claudeSessionId` gets backfilled
 * onto the live session file, a tmux pane gets joined), and discovery.ts used
 * to key `doneAcknowledgedAt` by whichever of those happened to be known on
 * a given tick. The moment more specific information showed up, the key
 * changed string, orphaning any acknowledgement made under the old one and
 * resurrecting 'done'.
 *
 * Ordered most-to-least stable: a SessionRecord's `id` never changes for the
 * life of the record, so it always wins when one exists. `claudeSessionId`
 * is next (stable once Claude Code assigns it, but may be briefly absent).
 * A tmux pane id and finally the cwd path are the least stable fallbacks,
 * used only when nothing else is known yet.
 */
export function sessionIdentityCandidates(input: SessionIdentityInput): string[] {
  const candidates: string[] = []
  if (input.recordId) candidates.push(`record:${input.recordId}`)
  if (input.claudeSessionId) candidates.push(`session:${input.claudeSessionId}`)
  if (input.tmuxPaneId) candidates.push(`pane:${input.tmuxPaneId}`)
  candidates.push(`path:${input.cwd ?? 'unknown'}`)
  return candidates
}

/**
 * Call every tick with `sessionIdentityCandidates(...)` (most stable first)
 * before computing status: if an earlier tick acknowledged 'done' under any
 * of the less-stable candidates, carries that acknowledgement forward to the
 * canonical (most stable) one instead of letting it orphan. Idempotent and
 * cheap — safe to call unconditionally on every session, every tick.
 */
export function migrateAcknowledgement(candidatesMostStableFirst: string[]): void {
  const [canonical, ...fallbacks] = candidatesMostStableFirst
  if (!canonical) return

  let latest = doneAcknowledgedAt.get(canonical) ?? 0
  let found = latest > 0
  for (const key of fallbacks) {
    if (key === canonical) continue
    const at = doneAcknowledgedAt.get(key)
    if (at === undefined) continue
    found = true
    if (at > latest) latest = at
    doneAcknowledgedAt.delete(key)
  }
  if (found) doneAcknowledgedAt.set(canonical, latest)
}

export interface InteractiveStatusInput {
  sessionKey: string
  alive: boolean
  rawStatus: string | null // idle | busy | waiting | blocked | shell
  waitingFor: string | null
  claudeSessionId: string | null
  cwd: string
  statusUpdatedAt: number | null // proxy for "last user interaction"
}

export interface StatusResult {
  status: SessionStatus
  reason: string
}

/** Highest precedence first — see the plan's Milestone 5 table. */
export function computeInteractiveStatus(input: InteractiveStatusInput): StatusResult {
  const hookState = getHookState(input.claudeSessionId, input.cwd)
  const now = Date.now()

  // 1. StopFailure hook newer than the session's own status update, and not
  // yet seen. It used to lapse after 5 minutes on its own, so a failure you
  // weren't looking at quietly turned back into "your turn". Now it holds
  // until you open the session, or the session does something newer.
  const failureSeenAt = doneAcknowledgedAt.get(input.sessionKey) ?? 0
  if (
    hookState?.lastStopFailure &&
    hookState.lastStopFailure.at > failureSeenAt &&
    (input.statusUpdatedAt === null || hookState.lastStopFailure.at > input.statusUpdatedAt)
  ) {
    return {
      status: 'errored',
      reason: hookState.lastStopFailure.message ?? 'agent stopped with an error'
    }
  }

  // 2. Not alive.
  if (!input.alive) {
    return { status: 'stopped', reason: '' }
  }

  // 3. Blocked, or waitingFor set.
  if (input.rawStatus === 'blocked' || input.waitingFor) {
    return {
      status: 'needs_attention',
      reason: input.waitingFor ? `waiting: ${input.waitingFor}` : 'blocked'
    }
  }

  // 4. Waiting at the prompt with nothing pending — it finished and it is your
  // turn. Distinct from rule 3 above, which is a session that cannot proceed
  // until you answer something. Both want you eventually; only one is urgent,
  // and calling them the same thing left every finished session sitting in
  // attention orange with no way out of it.
  if (input.rawStatus === 'waiting') {
    return { status: 'ready', reason: 'finished its turn' }
  }

  // 5. Unacknowledged Notification hook, newer than the session's own status update —
  // this is what makes hooks faster than the poll.
  //
  // `idle_prompt` is excluded: Claude Code sends it after a session has sat at
  // its prompt for a minute, whether or not it asked anything. Counting it
  // turned every finished session into "needs an answer" a minute later.
  if (
    hookState?.lastNotification &&
    hookState.lastNotification.notificationType !== 'idle_prompt' &&
    (input.statusUpdatedAt === null || hookState.lastNotification.at > input.statusUpdatedAt)
  ) {
    return {
      status: 'needs_attention',
      reason: hookState.lastNotification.message ?? 'needs attention'
    }
  }

  // 6. Busy.
  if (input.rawStatus === 'busy') {
    return { status: 'working', reason: '' }
  }

  // 7. Stop hook newer than the last interaction, still idle -> done (decays after 30 min
  // or once acknowledged by opening the session detail).
  if (
    input.rawStatus === 'idle' &&
    hookState?.lastStop &&
    (input.statusUpdatedAt === null || hookState.lastStop.at > input.statusUpdatedAt)
  ) {
    const ackAt = doneAcknowledgedAt.get(input.sessionKey) ?? 0
    const decayed = now - hookState.lastStop.at > DONE_DECAY_MS || ackAt > hookState.lastStop.at
    if (!decayed) {
      return { status: 'done', reason: hookState.lastStop.message ?? 'finished' }
    }
  }

  // 8. Shell.
  if (input.rawStatus === 'shell') {
    return { status: 'shell', reason: '' }
  }

  // 9. Idle — the prompt is yours.
  //
  // Rule 4 above is close to dead against real Claude Code: across a real
  // ~/.claude/sessions directory, every finished session reports 'idle' and
  // 'waiting' shows up only with a `waitingFor`, which rule 3 has already
  // claimed. So this is the rule that actually describes "it finished and it
  // is your move", and the badge says so. It deliberately does not count
  // towards the attention bell (see wantsYou) — the bell means "something
  // happened since you last looked", and a session you finished with hours
  // ago has not.
  if (input.rawStatus === 'idle') {
    return { status: 'idle', reason: '' }
  }

  return { status: 'unknown', reason: input.rawStatus ?? '' }
}

export function computeBackgroundStatus(state: string | null): StatusResult {
  if (state === 'blocked') return { status: 'needs_attention', reason: 'blocked' }
  if (state === 'running') return { status: 'working', reason: '' }
  return { status: 'unknown', reason: state ?? '' }
}
