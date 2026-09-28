import { Notification, BrowserWindow } from 'electron'
import { getState } from '../store/store'
import { log } from '../log'
import type { LiveSession, SessionStatus } from '../store/types'

const BODY_MAX_CHARS = 140

/**
 * `statusReason` for 'done' is the agent's own Stop-hook message verbatim —
 * whatever it wrote, unbounded length, often markdown. A notification body
 * is not a place to read the whole thing: strip the markdown emphasis
 * markers a plain-text OS banner would otherwise show literally, then cut
 * to one line and a sane length regardless of where (or whether) the
 * original had its own line breaks.
 */
function toPlainSummary(text: string, maxChars = BODY_MAX_CHARS): string {
  const oneLine = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine
}

const DEDUPE_PRUNE_MS = 60 * 60 * 1000
const NOTIFIABLE_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'needs_attention',
  'ready',
  'done',
  'errored'
])

// key -> when we notified (or seeded) it, so we never notify twice for the same transition.
const notifiedKeys = new Map<string, number>()
let seeded = false

function dedupeKey(session: LiveSession): string {
  const idPart = session.claudeSessionId ?? session.key
  const eventAt = session.lastEvent?.at ?? session.updatedAt
  return `${idPart}:${session.status}:${eventAt}`
}

function pruneOldEntries(): void {
  const cutoff = Date.now() - DEDUPE_PRUNE_MS
  for (const [key, at] of notifiedKeys) {
    if (at < cutoff) notifiedKeys.delete(key)
  }
}

// The title is the one thing a banner shows before you decide whether to
// read it — name the project too, not just the session, since an
// auto-generated session title alone ("bradleycorrigan-3d") often isn't
// enough to place which one it is at a glance.
function titleFor(session: LiveSession): string {
  const sessionTitle = session.record?.title ?? session.agentName ?? session.cwd
  const project = session.record
    ? getState().projects.find((p) => p.id === session.record?.projectId)
    : null
  return project ? `${project.name} - ${sessionTitle}` : sessionTitle
}

function bodyFor(session: LiveSession): string {
  switch (session.status) {
    case 'needs_attention':
      return toPlainSummary(session.waitingFor ?? session.statusReason ?? 'input needed')
    case 'ready':
      return toPlainSummary('Ready for you')
    case 'done':
      return toPlainSummary(
        `Finished: ${session.statusReason || session.lastEvent?.message || 'agent finished'}`
      )
    case 'errored':
      return toPlainSummary(`Error: ${session.statusReason || 'agent stopped with an error'}`)
    default:
      return toPlainSummary(session.statusReason)
  }
}

/**
 * On the very first poll, record every session's current status without
 * notifying — otherwise launching the app fires a banner for every
 * already-waiting agent.
 */
export function seedNotificationState(sessions: LiveSession[]): void {
  if (seeded) return
  seeded = true
  for (const session of sessions) {
    if (NOTIFIABLE_STATUSES.has(session.status)) {
      notifiedKeys.set(dedupeKey(session), Date.now())
    }
  }
}

/**
 * Notifies only on transitions INTO needs_attention/done/errored, filtered by
 * settings.notifyOn. `previous` and `current` are consecutive poll results.
 *
 * "Already showing that session" (skip condition from the plan) can't yet be
 * checked per-session — session detail lands in M7. Until then this treats
 * "window focused" as "already showing", since the sessions list is the
 * whole app today.
 */
export function notifyOnTransitions(previous: LiveSession[], current: LiveSession[]): void {
  pruneOldEntries()
  const settings = getState().settings
  const previousByKey = new Map(previous.map((s) => [s.key, s]))

  for (const session of current) {
    if (!NOTIFIABLE_STATUSES.has(session.status)) continue
    if (!settings.notifyOn.includes(session.status as 'needs_attention' | 'done' | 'errored'))
      continue

    const prev = previousByKey.get(session.key)
    const enteredNow = !prev || prev.status !== session.status
    if (!enteredNow) continue

    const key = dedupeKey(session)
    if (notifiedKeys.has(key)) continue
    notifiedKeys.set(key, Date.now())

    const win = BrowserWindow.getAllWindows()[0]
    if (win?.isFocused()) continue // already showing — see note above

    const notification = new Notification({ title: titleFor(session), body: bodyFor(session) })
    notification.on('click', () => {
      log.info('notify: banner clicked', { key })
      // Re-fetch rather than close over `win` from creation time — a
      // banner can sit around long enough for that window to have closed
      // and a new one opened since, and win?.show() on a destroyed
      // BrowserWindow is a silent no-op, which is how "clicking it does
      // nothing" happens.
      const target = BrowserWindow.getAllWindows()[0]
      target?.show()
      target?.focus()
      target?.webContents.send('navigate', {
        sessionId: session.record?.id ?? null,
        liveKey: session.key
      })
    })
    notification.show()
    log.info('notify: banner shown', { key, title: titleFor(session), body: bodyFor(session) })
  }
}
