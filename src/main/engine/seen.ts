import { readSeenFile, writeSeenFile } from '../store/store'
import { getHookState } from './hooks-server'

/**
 * Read / unread, per session.
 *
 * A session is unread when something happened in it after you last opened it:
 * it finished a turn, stopped to ask you something, or failed. "Opened" is the
 * session detail screen (session:acknowledge). "Mark as unread" sets a flag
 * that holds until the next open, whatever the timestamps say.
 *
 * Persisted to seen.json so a restart does not mark everything read or unread.
 * Keyed by the session's identity key (record id first), the same key the
 * `done` acknowledgement uses.
 */
interface SeenEntry {
  seenAt: number
  markedUnread?: boolean
}

let cache: Record<string, SeenEntry> | null = null

function entries(): Record<string, SeenEntry> {
  if (!cache) {
    const raw = readSeenFile()
    cache = raw && typeof raw === 'object' ? (raw as Record<string, SeenEntry>) : {}
  }
  return cache
}

function save(): void {
  writeSeenFile(entries())
}

/**
 * When this session last did something worth reading, or null if we can't
 * tell. `statusUpdatedAt` moves on every status change, so it only counts once
 * the session has stopped working — otherwise you sending a message would
 * mark your own session unread. `idle_prompt` is Claude Code's "still at the
 * prompt" nudge a minute after a turn ends: nothing new to read.
 */
export function lastActivityAt(input: {
  claudeSessionId: string | null
  cwd: string | null
  rawStatus: string | null
  statusUpdatedAt: number | null
}): number | null {
  const times: number[] = []
  if (input.rawStatus !== 'busy' && input.statusUpdatedAt) times.push(input.statusUpdatedAt)
  const hook = getHookState(input.claudeSessionId, input.cwd)
  if (hook?.lastStop) times.push(hook.lastStop.at)
  if (hook?.lastStopFailure) times.push(hook.lastStopFailure.at)
  if (hook?.lastNotification && hook.lastNotification.notificationType !== 'idle_prompt') {
    times.push(hook.lastNotification.at)
  }
  return times.length > 0 ? Math.max(...times) : null
}

/** Same idea as migrateAcknowledgement: keep read state when a session's key gets more specific. */
export function migrateSeen(candidatesMostStableFirst: string[]): void {
  const [canonical, ...fallbacks] = candidatesMostStableFirst
  if (!canonical) return
  const all = entries()
  let changed = false
  for (const key of fallbacks) {
    const entry = all[key]
    if (!entry || key === canonical) continue
    const current = all[canonical]
    if (!current || entry.seenAt > current.seenAt) all[canonical] = entry
    delete all[key]
    changed = true
  }
  if (changed) save()
}

export function isUnread(sessionKey: string, activityAt: number | null): boolean {
  const all = entries()
  const entry = all[sessionKey]
  if (!entry) {
    // First time we see this session: start it read. Otherwise the first
    // launch would light up every session you have ever run.
    all[sessionKey] = { seenAt: activityAt ?? Date.now() }
    save()
    return false
  }
  if (entry.markedUnread) return true
  return activityAt !== null && activityAt > entry.seenAt
}

export function markSeen(sessionKey: string): void {
  entries()[sessionKey] = { seenAt: Date.now() }
  save()
}

export function markUnread(sessionKey: string): void {
  const all = entries()
  all[sessionKey] = { seenAt: all[sessionKey]?.seenAt ?? 0, markedUnread: true }
  save()
}
