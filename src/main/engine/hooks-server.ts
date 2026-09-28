import { createServer, type Server } from 'node:http'
import { getState, updateSettings, appendEvent } from '../store/store'
import { mergeHooksIntoSettings, CLAUDE_SETTINGS_PATH } from './hooks-settings'
import { log } from '../log'

export interface NormalizedEvent {
  type: string // Notification | Stop | StopFailure
  sessionId: string | null
  cwd: string | null
  message: string | null
  notificationType: string | null
  at: number
  raw: unknown
}

export interface SessionHookState {
  lastNotification: NormalizedEvent | null
  lastStop: NormalizedEvent | null
  lastStopFailure: NormalizedEvent | null
}

const stateBySessionId = new Map<string, SessionHookState>()
const stateByCwd = new Map<string, SessionHookState>()

function emptyState(): SessionHookState {
  return { lastNotification: null, lastStop: null, lastStopFailure: null }
}

function getOrCreateState(sessionId: string | null, cwd: string | null): SessionHookState {
  if (sessionId) {
    let s = stateBySessionId.get(sessionId)
    if (!s) {
      s = emptyState()
      stateBySessionId.set(sessionId, s)
    }
    return s
  }
  if (cwd) {
    let s = stateByCwd.get(cwd)
    if (!s) {
      s = emptyState()
      stateByCwd.set(cwd, s)
    }
    return s
  }
  return emptyState() // orphaned event, not correlatable — not stored
}

/** Correlates by session_id → claudeSessionId first, falling back to cwd. */
export function getHookState(
  sessionId: string | null,
  cwd: string | null
): SessionHookState | null {
  if (sessionId) {
    const bySession = stateBySessionId.get(sessionId)
    if (bySession) return bySession
  }
  if (cwd) {
    const byCwd = stateByCwd.get(cwd)
    if (byCwd) return byCwd
  }
  return null
}

function truncate(msg: unknown): string | null {
  if (typeof msg !== 'string' || msg.length === 0) return null
  return msg.length > 200 ? msg.slice(0, 200) : msg
}

function normalize(raw: unknown): NormalizedEvent {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    type: typeof r.hook_event_name === 'string' ? r.hook_event_name : 'Unknown',
    sessionId: typeof r.session_id === 'string' ? r.session_id : null,
    cwd: typeof r.cwd === 'string' ? r.cwd : null,
    message: truncate(r.notification_message ?? r.last_assistant_message ?? r.error_message),
    notificationType: typeof r.notification_type === 'string' ? r.notification_type : null,
    at: Date.now(),
    raw
  }
}

let onEvent: ((event: NormalizedEvent) => void) | null = null
export function setHookEventListener(fn: (event: NormalizedEvent) => void): void {
  onEvent = fn
}

/**
 * Dev/test fixture only. `done` and `errored` are derived from hook events
 * (Stop / StopFailure) that only ever arrive over the loopback HTTP server in
 * real use, so a session-file fixture alone can't produce them. This seeds
 * the same in-memory maps `handleEvent` would, without going through the
 * server or touching `~/.claude/settings.json`. Called once at startup, only
 * when `CR_SESSIONS_DIR` is set — see `scripts/fixtures/sessions`.
 */
export function seedFixtureHookEvents(events: Partial<NormalizedEvent>[]): void {
  for (const partial of events) {
    const event: NormalizedEvent = {
      type: partial.type ?? 'Unknown',
      sessionId: partial.sessionId ?? null,
      cwd: partial.cwd ?? null,
      message: partial.message ?? null,
      notificationType: partial.notificationType ?? null,
      at: partial.at ?? Date.now(),
      raw: partial.raw ?? partial
    }
    const state = getOrCreateState(event.sessionId, event.cwd)
    if (event.type === 'Notification') state.lastNotification = event
    else if (event.type === 'Stop') state.lastStop = event
    else if (event.type === 'StopFailure') state.lastStopFailure = event
    if (event.sessionId) stateBySessionId.set(event.sessionId, state)
    if (event.cwd) stateByCwd.set(event.cwd, state)
  }
}

function handleEvent(raw: unknown): void {
  const event = normalize(raw)
  const state = getOrCreateState(event.sessionId, event.cwd)

  if (event.type === 'Notification') state.lastNotification = event
  else if (event.type === 'Stop') state.lastStop = event
  else if (event.type === 'StopFailure') state.lastStopFailure = event

  if (event.sessionId) stateBySessionId.set(event.sessionId, state)
  if (event.cwd) stateByCwd.set(event.cwd, state)

  appendEvent(event)
  onEvent?.(event)
}

/** Binds one port. Never rejects — resolves null on failure so the caller can try the next one. */
function startHookServer(port: number): Promise<{ server: Server; port: number } | null> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/hook')) {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 1_000_000) req.destroy()
      })
      req.on('end', () => {
        // Claude Code blocks on this response — answer before processing, always.
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        try {
          handleEvent(JSON.parse(body))
        } catch (err) {
          log.error('hooks-server: failed to parse event body', { error: String(err) })
        }
      })
    })

    server.once('error', (err) => {
      log.warn('hooks-server: failed to bind port', { port, error: String(err) })
      resolve(null)
    })

    // Loopback only — never 0.0.0.0.
    server.listen(port, '127.0.0.1', () => resolve({ server, port }))
  })
}

let activeServer: Server | null = null
let activePort: number | null = null

export function getBoundHookPort(): number | null {
  return activePort
}

/**
 * Starts the hook server, scanning ports if the default is busy. If hooks were
 * previously installed and the bound port differs from what's in
 * settings.json, re-runs the merge so the two stay consistent. Polling is
 * never disabled just because hooks failed to bind.
 */
export async function startHooksEngine(): Promise<number | null> {
  const settings = getState().settings

  for (let port = settings.hookPort; port <= settings.hookPort + 9; port++) {
    const bound = await startHookServer(port)
    if (bound) {
      activeServer = bound.server
      activePort = bound.port
      log.info('hooks-server: listening', { port: bound.port })
      break
    }
  }

  if (!activePort) {
    log.warn('hooks-server: failed to bind any port in range — degraded to polling-only')
    return null
  }

  const ourUrl = `http://127.0.0.1:${activePort}/hook`
  if (settings.hooksInstalled && settings.hooksInstalledUrl !== ourUrl) {
    const result = mergeHooksIntoSettings(CLAUDE_SETTINGS_PATH, ourUrl)
    if (result.ok) {
      updateSettings({ hooksInstalledUrl: ourUrl })
      log.info('hooks-server: re-merged settings.json after port change', { port: activePort })
    } else {
      log.error('hooks-server: failed to re-merge settings.json after port change', {
        error: result.error
      })
    }
  }

  return activePort
}

export function stopHooksServer(): void {
  activeServer?.close()
  activeServer = null
  activePort = null
}
