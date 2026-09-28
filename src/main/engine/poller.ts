import { app, BrowserWindow } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { discoverLiveSessions } from './discovery'
import { sessionsDir } from '../exec/claude'
import { getState } from '../store/store'
import { seedNotificationState, notifyOnTransitions } from './notify'
import { log } from '../log'
import type { LiveSession } from '../store/types'

// Told, not asking. Status changes arrive as they happen: Claude Code
// rewrites a session's status file (watched below) and sends hook events
// (hooks-server → triggerImmediateTick). The timer is only a safety net for
// what nobody announces — a tmux window killed by hand, a crashed process,
// background agents, a `done` decaying. Checking every 2s used to redraw the
// whole app every 2s and run `claude agents` nearly as often.
const SAFETY_TICK_MS = 30_000
// A turn ending touches the status file several times in a burst; one check
// for the burst is enough.
const WATCH_DEBOUNCE_MS = 120

let timer: NodeJS.Timeout | null = null
let watcher: FSWatcher | null = null
let debounce: NodeJS.Timeout | null = null
let lastSerialized: string | null = null
let previousSessions: LiveSession[] | null = null
let ticking = false
// Asked for while a check was running. Dropping it (as this used to) was
// harmless when another check came 2s later; with checks on events, it would
// lose the very change that asked.
let tickAgain = false

// `updatedAt` is stamped with now on every check, so leaving it in made every
// check look like a change and pushed an identical list to the screen.
function comparable(sessions: LiveSession[]): string {
  return JSON.stringify(sessions, (key, value) => (key === 'updatedAt' ? undefined : value))
}

async function tick(): Promise<void> {
  if (ticking) {
    tickAgain = true // never overlap; run once more when this one finishes
    return
  }
  ticking = true
  try {
    const sessions = await discoverLiveSessions()
    const serialized = comparable(sessions)

    if (previousSessions === null) {
      // First tick after launch — seed the dedupe map without notifying, or
      // every already-waiting agent would fire a banner on every startup.
      seedNotificationState(sessions)
    } else if (serialized !== lastSerialized) {
      notifyOnTransitions(previousSessions, sessions)
    }
    previousSessions = sessions

    if (serialized === lastSerialized) return
    lastSerialized = serialized

    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sessions:changed', sessions)
    }
    // The unread count on the Dock icon — the same number as the house tab
    // and the bell — so something new shows without switching to the app.
    app.setBadgeCount(sessions.filter((s) => s.unread).length)
  } catch (err) {
    log.error('poller: discovery tick failed', { error: String(err) })
  } finally {
    ticking = false
    if (tickAgain) {
      tickAgain = false
      void tick()
    }
  }
}

function watchSessionsDir(): void {
  const dir = sessionsDir()
  if (!existsSync(dir)) return
  try {
    watcher = watch(dir, () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void tick(), WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', (err) => {
      // The safety tick still runs; statuses just arrive up to 30s late.
      log.error('poller: sessions watcher failed', { error: String(err) })
      watcher?.close()
      watcher = null
    })
  } catch (err) {
    log.error('poller: could not watch sessions dir', { dir, error: String(err) })
  }
}

export function startPoller(): void {
  if (timer) return
  void tick() // immediate first tick so the UI isn't empty for a full interval
  watchSessionsDir()
  // pollIntervalMs (2s by default) predates the watcher. It can stretch the
  // safety net out, but never tighten it back to checking every 2s.
  const intervalMs = Math.max(getState().settings.pollIntervalMs, SAFETY_TICK_MS)
  timer = setInterval(() => void tick(), intervalMs)
}

export function stopPoller(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  watcher?.close()
  watcher = null
  if (debounce) clearTimeout(debounce)
}

/** A hook event should reach the UI faster than the poll interval would. */
export function triggerImmediateTick(): void {
  void tick()
}
