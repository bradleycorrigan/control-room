import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnStream } from './run'

// Part 3 (control-room-design-revision.md): one long-lived
// `tmux -C attach -t <session>` control-mode process per tmux *session*
// (control mode multiplexes every pane in that session over one
// connection), owned here. Parses the `%output %<pane-id> <data>` line
// protocol and forwards it as events; the renderer never talks to tmux
// itself (CLAUDE.md: "the renderer has no OS access").
//
// Fallback is load-bearing, not an afterthought: if `tmux -C attach` fails
// to start or exits immediately (old tmux, no server, session gone), this
// degrades to `failed` and the caller (ipc.ts) falls back to the existing
// capture-pane polling path, read-only, with a visible note. Never let the
// screen break — see Part 6 risk #1.

/** Un-escapes tmux control-mode's `\ooo` octal escaping of non-printable bytes. */
function unescapeControlOutput(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && /[0-7]{3}/.test(raw.slice(i + 1, i + 4))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      out += ch
    }
  }
  return out
}

export interface TmuxControlEvents {
  output: [paneId: string, data: string]
  layout: [line: string] // %window-add / %window-close / %layout-change, raw
  exit: []
  fail: [reason: string]
}

export class TmuxControlSession extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  private stderrBuf = ''
  private startPromise: Promise<boolean> | null = null
  ready = false
  failed = false

  constructor(readonly tmuxSessionName: string) {
    super()
  }

  /**
   * Starts the control-mode process. Resolves once it has either attached or
   * failed. A second concurrent caller (e.g. two grid tiles mounting the same
   * tmux session at once) gets the *same* in-flight promise rather than a
   * snapshot of `ready` taken before the first attach has settled — that
   * snapshot is always `false` and would wrongly report the second caller
   * into fallback even though the session goes on to attach fine.
   */
  start(): Promise<boolean> {
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise((resolve) => {
      let settled = false
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      let proc: ChildProcessWithoutNullStreams
      try {
        proc = spawnStream('tmux', ['-C', 'attach', '-t', this.tmuxSessionName])
      } catch (err) {
        this.failed = true
        this.emit('fail', String(err))
        settle(false)
        return
      }
      this.proc = proc

      // `spawn` only confirms fork/exec succeeded — tmux itself can still
      // fail fast right after (e.g. "can't find session", server gone) and
      // exit with a nonzero code. Resolving readiness on `spawn` alone races
      // that failure and can report `ready` for a session that never
      // attached, silently defeating the fallback. Give tmux a short grace
      // window after spawn to prove it stayed up before calling it ready.
      let graceTimer: ReturnType<typeof setTimeout> | null = null

      proc.once('error', (err) => {
        if (graceTimer) clearTimeout(graceTimer)
        this.failed = true
        this.ready = false
        this.emit('fail', String(err))
        settle(false)
      })

      proc.once('spawn', () => {
        graceTimer = setTimeout(() => {
          if (settled) return
          // Still alive after the grace window with no exit/error — control
          // mode prints a `%begin`/`%end` banner immediately on a real
          // attach, but a session with no output yet has nothing to wait on,
          // so "didn't die" is the ready signal.
          this.ready = true
          settle(true)
        }, 250)
      })

      proc.on('exit', (code) => {
        if (graceTimer) clearTimeout(graceTimer)
        this.ready = false
        if (!settled) {
          this.failed = true
          this.emit('fail', `tmux -C attach exited immediately (code ${code})`)
          settle(false)
        }
        this.emit('exit')
      })

      proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')))
      proc.stderr.on('data', (chunk: Buffer) => {
        this.stderrBuf += chunk.toString('utf8')
      })
    })
    return this.startPromise
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    const lines = this.stdoutBuf.split('\n')
    this.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) this.parseLine(line.replace(/\r$/, ''))
  }

  private parseLine(line: string): void {
    if (line.startsWith('%output ')) {
      const rest = line.slice('%output '.length)
      const spaceIdx = rest.indexOf(' ')
      if (spaceIdx === -1) return
      const paneId = rest.slice(0, spaceIdx)
      const data = unescapeControlOutput(rest.slice(spaceIdx + 1))
      this.emit('output', paneId, data)
      return
    }
    if (
      line.startsWith('%window-add') ||
      line.startsWith('%window-close') ||
      line.startsWith('%layout-change') ||
      line.startsWith('%unlinked-window-add')
    ) {
      this.emit('layout', line)
      return
    }
    if (line.startsWith('%exit')) {
      this.emit('exit')
    }
    // %begin/%end/%error frame command replies — no reply-driven command is
    // issued on this connection yet, so they are intentionally ignored.
  }

  lastStderr(): string {
    return this.stderrBuf.slice(-2000)
  }

  /** `send-keys -H` (hex bytes) — exact fidelity, never a raw interpolated string. */
  sendKeysHex(paneId: string, text: string): boolean {
    if (!this.proc || !this.ready) return false
    const bytes = Buffer.from(text, 'utf8')
    const hex = Array.from(bytes)
      .map((b) => `0x${b.toString(16).padStart(2, '0')}`)
      .join(' ')
    return this.writeCommand(
      hex.length ? `send-keys -H -t ${paneId} ${hex}` : `send-keys -t ${paneId}`
    )
  }

  /** `refresh-client -C <cols>x<rows>` so the agent's own rendering matches the pane. */
  resize(cols: number, rows: number): boolean {
    return this.writeCommand(`refresh-client -C ${Math.max(1, cols)}x${Math.max(1, rows)}`)
  }

  private writeCommand(cmd: string): boolean {
    if (!this.proc || !this.proc.stdin.writable) return false
    try {
      this.proc.stdin.write(`${cmd}\n`)
      return true
    } catch {
      return false
    }
  }

  stop(): void {
    if (!this.proc) return
    try {
      this.proc.stdin.end()
      this.proc.kill()
    } catch {
      // already gone
    }
    this.proc = null
    this.ready = false
  }
}

// One control-mode connection per tmux session name, shared across every
// pane/window the renderer attaches to within it and across every terminal
// component watching that session — avoids N control-mode processes for N
// panes in the same tmux session.
const sessions = new Map<string, TmuxControlSession>()

export interface AttachResult {
  ok: boolean
  fallback: boolean
  reason?: string
}

export async function attachControlSession(tmuxSessionName: string): Promise<AttachResult> {
  let session = sessions.get(tmuxSessionName)
  if (session && (session.ready || !session.failed)) {
    if (session.ready) return { ok: true, fallback: false }
  }
  if (!session || session.failed) {
    session = new TmuxControlSession(tmuxSessionName)
    sessions.set(tmuxSessionName, session)
  }
  const ok = await session.start()
  if (!ok) {
    return {
      ok: false,
      fallback: true,
      reason: session.lastStderr() || 'tmux control mode failed to start'
    }
  }
  return { ok: true, fallback: false }
}

export function getControlSession(tmuxSessionName: string): TmuxControlSession | undefined {
  return sessions.get(tmuxSessionName)
}

export function stopControlSession(tmuxSessionName: string): void {
  const session = sessions.get(tmuxSessionName)
  if (!session) return
  session.stop()
  sessions.delete(tmuxSessionName)
}

export function stopAllControlSessions(): void {
  for (const name of [...sessions.keys()]) stopControlSession(name)
}

// Plan 4, Part 10: control mode no longer carries pixels (that's the PTY's
// job now, see tmux-pty.ts) — it stays alive only for the cheap
// session-list-liveness signals (`%window-add`/`%window-close`/`%exit`).
// Deliberately does NOT forward `output` events.
const wiredLayout = new Set<string>()

export function wireLayoutEvents(
  tmuxSessionName: string,
  onLayout: (line: string) => void,
  onExit: () => void
): void {
  if (wiredLayout.has(tmuxSessionName)) return
  const session = sessions.get(tmuxSessionName)
  if (!session) return
  wiredLayout.add(tmuxSessionName)
  session.on('layout', onLayout)
  session.on('exit', () => {
    wiredLayout.delete(tmuxSessionName)
    onExit()
  })
}
