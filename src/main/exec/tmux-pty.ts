import { EventEmitter } from 'node:events'
import * as pty from 'node-pty'
import { ENV, runTmux } from './run'

// Plan 4, Part 10: a real PTY per visible terminal, replacing tmux control
// mode (`tmux -C`) as the pixel transport. Control mode gives no real client
// geometry, and tmux clamps every window to the smallest attached client —
// exactly the wrap-at-120-columns bug this replaces. A real PTY running
// `tmux attach` gives tmux a genuine client with a genuine size; resize is
// `pty.resize()` -> SIGWINCH -> tmux repaints itself. No manual geometry.
//
// We attach to a *grouped* session (`tmux new-session -t <target> -s
// cr-view-<name>`) rather than the target session directly. A grouped
// session shares the target's windows/panes but keeps its own client list,
// so another real client (e.g. Ghostty) attached to the target session
// cannot clamp our width, and we cannot clamp theirs. This is the actual
// fix for the clamping bug, not just the PTY swap.
//
// Plan 7 audit fix: the map below is keyed by **pane id**, not by tmux
// session name. Every project defaults its `tmuxSessionName` to 'wt', so two
// sessions (two windows/panes) in the same project used to collide on one
// shared PTY entry the moment both were open: the second `startPty` call hit
// the "already running" short-circuit below, its window pin never ran, and
// the first pane's grouped session — and its output — got silently handed
// to the second pane. A pane id is unique across the whole tmux server
// (CLAUDE.md), so it is also a safe, collision-free grouped-session name on
// its own; there is no need to fold the target session name into it too.

function sanitizePaneId(paneId: string): string {
  return paneId.replace(/[^A-Za-z0-9_-]/g, '_')
}

function groupedSessionName(paneId: string): string {
  return `cr-view-${sanitizePaneId(paneId)}`
}

// Safety: this app attaches clients to the user's own tmux server, where their
// real sessions live. It may only ever kill a session it created itself, and
// only by exact name (`=` prefix) — tmux targets are prefix-matched by default,
// so `kill-session -t wt` would also match `wt-anything`. Two tmux servers have
// already been lost on this machine while this transport was being built; the
// cause was never proven, so the rule is mechanical rather than a judgement.
function killOurSession(name: string): Promise<unknown> | undefined {
  if (!name.startsWith('cr-view-')) return undefined
  return runTmux(['kill-session', '-t', `=${name}`])
}

/**
 * Resolves `paneId`'s current window and pins `groupedName`'s "current
 * window" to it. A grouped session's current window starts independent of
 * the target's — it does NOT follow whichever window the target session (or
 * another grouped session in the same group, e.g. another control-room
 * view) has selected. Without this, every view lands on the group's
 * lowest-index window regardless of which pane it actually maps to (real
 * usage: one "wt" session, one window per worktree).
 *
 * Must run on *every* attach to an already-running pane, not just its
 * first — skipping it on the "already running" path is exactly how one
 * pane's terminal used to end up pointed at a different pane's window.
 */
async function pinWindow(groupedName: string, paneId: string): Promise<void> {
  const windowId = await runTmux(['display-message', '-p', '-t', paneId, '#{window_id}'])
  const id = windowId.stdout.trim()
  if (windowId.code === 0 && id) {
    await runTmux(['select-window', '-t', `${groupedName}:${id}`])
  }
}

interface PtyEntry {
  proc: pty.IPty
  groupedName: string
  // Refcounted rather than a plain boolean: `startPty` is idempotent by
  // design (e.g. a remount re-attaching the same pane must not spawn a
  // second PTY), but `stopPty` must not tear a pane down while another
  // caller is still relying on it — only a matching number of `stopPty`
  // calls does that.
  refCount: number
}

const ptyByPane = new Map<string, PtyEntry>()
const emitter = new EventEmitter()

export interface StartResult {
  ok: boolean
  reason?: string
}

/**
 * One real PTY per **pane**, never per tmux session name — see the header
 * comment for why that distinction is load-bearing. Idempotent per pane: a
 * second caller for a pane that already has a running PTY increments its
 * refcount and re-pins the grouped session's window, rather than spawning a
 * second PTY or silently doing nothing.
 */
export async function startPty(
  tmuxSessionName: string,
  cols: number,
  rows: number,
  paneId: string
): Promise<StartResult> {
  if (!paneId) {
    return {
      ok: false,
      reason: 'startPty requires a paneId: one PTY per pane, never per session'
    }
  }

  // Defense in depth: a `cr-view-*` name is one of our own grouped sessions, never a
  // real target. Wrapping it again is how 20+ nested `cr-view-cr-view-...` sessions
  // got created for real (a stale pane listing fed one back in). listPanes() now
  // filters these out at the source, but refuse here too rather than trust every caller.
  if (tmuxSessionName.startsWith('cr-view-')) {
    return {
      ok: false,
      reason: `refusing to attach to our own grouped session: ${tmuxSessionName}`
    }
  }

  const existing = ptyByPane.get(paneId)
  if (existing) {
    existing.refCount += 1
    await pinWindow(existing.groupedName, paneId)
    return { ok: true }
  }

  const grouped = groupedSessionName(paneId)
  const create = await runTmux(['new-session', '-d', '-t', tmuxSessionName, '-s', grouped])
  if (create.code !== 0 && !/duplicate session/i.test(create.stderr)) {
    return { ok: false, reason: create.stderr.trim() || 'failed to create grouped tmux session' }
  }

  // OSC 8 hyperlinks (Xirp does this too) — harmless if already set.
  await runTmux(['set-option', '-sa', 'terminal-features', 'xterm*:hyperlinks'])

  // Hide tmux's own status bar in our grouped view session only — the target
  // session (and any other real client attached to it) is untouched, since
  // this option is set with `-t` on the grouped session name, not `-g`. The
  // trailing `:` matters: tmux's exact-match `=name` session target only
  // resolves when it is followed by `:` (i.e. `=name:`) — a bare `=name`
  // returns "no such session" even though the session exists, verified by
  // hand against a live tmux server while wiring this up.
  await runTmux(['set-option', '-t', `=${grouped}:`, 'status', 'off'])

  await pinWindow(grouped, paneId)

  let proc: pty.IPty
  try {
    proc = pty.spawn('tmux', ['-u', 'attach', '-t', grouped], {
      name: 'xterm-256color',
      cols: Math.max(1, cols || 80),
      rows: Math.max(1, rows || 24),
      env: {
        ...ENV,
        TERM: 'xterm-256color',
        FORCE_COLOR: '3',
        COLORTERM: 'truecolor'
      } as { [key: string]: string }
    })
  } catch (err) {
    await killOurSession(grouped)
    return { ok: false, reason: String(err) }
  }

  const entry: PtyEntry = { proc, groupedName: grouped, refCount: 1 }
  ptyByPane.set(paneId, entry)

  proc.onData((data) => emitter.emit('output', paneId, data))
  proc.onExit(() => {
    ptyByPane.delete(paneId)
    emitter.emit('exit', paneId)
  })

  return { ok: true }
}

export function writePty(paneId: string, data: string): boolean {
  const entry = ptyByPane.get(paneId)
  if (!entry) return false
  try {
    entry.proc.write(data)
    return true
  } catch {
    return false
  }
}

/** The one resize path — every trigger (window resize, sidebar collapse, expand/shrink,
 * first paint) in the renderer funnels through this same IPC call. */
export function resizePty(paneId: string, cols: number, rows: number): boolean {
  const entry = ptyByPane.get(paneId)
  if (!entry) return false
  const c = Math.max(1, cols)
  const r = Math.max(1, rows)
  // Same size: nothing to do. Layout changes that leave the terminal's size
  // alone still fire the renderer's ResizeObserver, and passing each one on
  // made tmux clear and repaint the whole client for nothing.
  if (entry.proc.cols === c && entry.proc.rows === r) return true
  try {
    entry.proc.resize(c, r)
    return true
  } catch {
    return false
  }
}

/**
 * Tears down only this pane's PTY. Refcounted against `startPty`'s own
 * increment — a pane that has been attached to twice needs two `stopPty`
 * calls before its grouped session and process actually go away, so one
 * caller detaching never kills the PTY a second caller is still using.
 */
export async function stopPty(paneId: string): Promise<void> {
  const entry = ptyByPane.get(paneId)
  if (!entry) return
  entry.refCount -= 1
  if (entry.refCount > 0) return
  ptyByPane.delete(paneId)
  try {
    entry.proc.kill()
  } catch {
    // already gone
  }
  await killOurSession(entry.groupedName)
}

/** App-quit teardown: every pane's PTY goes away regardless of refcount —
 * nothing outlives the app itself. */
export function stopAllPtys(): void {
  for (const [paneId, entry] of [...ptyByPane.entries()]) {
    ptyByPane.delete(paneId)
    try {
      entry.proc.kill()
    } catch {
      // already gone
    }
    void killOurSession(entry.groupedName)
  }
}

export function onPtyOutput(fn: (paneId: string, data: string) => void): () => void {
  emitter.on('output', fn)
  return () => emitter.off('output', fn)
}

export function onPtyExit(fn: (paneId: string) => void): () => void {
  emitter.on('exit', fn)
  return () => emitter.off('exit', fn)
}
