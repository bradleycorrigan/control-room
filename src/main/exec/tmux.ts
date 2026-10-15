import { runTmux } from './run'

// Field delimiter for `-F` format strings. Never `|` — window/branch names can contain it.
const FS = '\x1f'

export interface TmuxPane {
  sessionName: string
  windowId: string
  windowIndex: number
  windowName: string
  paneId: string
  panePid: number
  panePath: string
  paneCommand: string
}

function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split(FS)
  if (parts.length < 8) return null
  const [sessionName, windowId, windowIndex, windowName, paneId, panePid, panePath, paneCommand] =
    parts
  return {
    sessionName,
    windowId,
    windowIndex: Number(windowIndex),
    windowName,
    paneId,
    panePid: Number(panePid),
    panePath,
    paneCommand
  }
}

/** "No tmux server" degrades to an empty result — it is a first-class UI state, not an error. */
export async function listPanes(): Promise<TmuxPane[]> {
  const format = [
    '#{session_name}',
    '#{window_id}',
    '#{window_index}',
    '#{window_name}',
    '#{pane_id}',
    '#{pane_pid}',
    '#{pane_current_path}',
    '#{pane_current_command}'
  ].join(FS)
  const res = await runTmux(['list-panes', '-a', '-F', format])
  if (res.code !== 0) return []
  return (
    res.stdout
      .split('\n')
      .filter(Boolean)
      .map(parsePaneLine)
      .filter((p): p is TmuxPane => p !== null)
      // A grouped session (tmux-pty.ts's `cr-view-<name>`) shares its target's windows,
      // so `list-panes -a` lists the same pane twice: once under the real session name,
      // once under our own transport's `cr-view-*` name. If discovery picks up the
      // `cr-view-*` copy and that name gets fed back into a terminal-attach call, the PTY
      // transport wraps it again (`cr-view-cr-view-...`), spawning a new grouped tmux
      // session every poll — this happened for real and created 20+ nested sessions.
      // Our own transport sessions are never a real join target, so exclude them here.
      .filter((p) => !p.sessionName.startsWith('cr-view-'))
  )
}

/** exit 0 = the named session exists. stderr "no server running" = no tmux server at all. */
export async function hasSession(
  sessionName: string
): Promise<{ exists: boolean; serverRunning: boolean }> {
  const res = await runTmux(['has-session', '-t', `=${sessionName}`])
  if (res.code === 0) return { exists: true, serverRunning: true }
  return { exists: false, serverRunning: !/no server running/i.test(res.stderr) }
}

export interface TmuxCreated {
  windowId: string
  paneId: string
}

export async function newSession(
  sessionName: string,
  windowName: string,
  dir: string
): Promise<TmuxCreated | null> {
  const res = await runTmux([
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-n',
    windowName,
    '-c',
    dir,
    '-P',
    '-F',
    `#{window_id}${FS}#{pane_id}`
  ])
  if (res.code !== 0) return null
  const [windowId, paneId] = res.stdout.trim().split(FS)
  return { windowId, paneId }
}

export async function newWindow(
  sessionName: string,
  windowName: string,
  dir: string
): Promise<TmuxCreated | null> {
  const res = await runTmux([
    'new-window',
    '-d',
    '-t',
    `=${sessionName}`,
    '-n',
    windowName,
    '-c',
    dir,
    '-P',
    '-F',
    `#{window_id}${FS}#{pane_id}`
  ])
  if (res.code !== 0) return null
  const [windowId, paneId] = res.stdout.trim().split(FS)
  return { windowId, paneId }
}

/** `-l` (literal) is mandatory — without it, text containing "Enter" or "C-" is read as keys. */
/**
 * Types `text` into a pane and presses Enter. `-l` (literal) is mandatory —
 * without it, text containing "Enter" or "C-" is read as key names.
 *
 * Returns tmux's own stderr on failure. Swallowing it cost us a day: a launch
 * step that only ever said "failed to launch the agent" is not a diagnosis,
 * and the user sees that string, not the log.
 */
export async function sendKeysResult(
  paneId: string,
  text: string
): Promise<{ ok: boolean; error: string | null }> {
  const literal = await runTmux(['send-keys', '-l', '-t', paneId, '--', text])
  if (literal.code !== 0) {
    return { ok: false, error: literal.stderr.trim() || `tmux send-keys -l exited ${literal.code}` }
  }
  const enter = await runTmux(['send-keys', '-t', paneId, 'C-m'])
  if (enter.code !== 0) {
    return { ok: false, error: enter.stderr.trim() || `tmux send-keys C-m exited ${enter.code}` }
  }
  return { ok: true, error: null }
}

export async function sendKeys(paneId: string, text: string): Promise<boolean> {
  return (await sendKeysResult(paneId, text)).ok
}

export async function capturePane(paneId: string, scrollbackLines = 2000): Promise<string> {
  const res = await runTmux([
    'capture-pane',
    '-p',
    '-e',
    '-J',
    '-t',
    paneId,
    '-S',
    String(-Math.abs(scrollbackLines))
  ])
  return res.code === 0 ? res.stdout : ''
}

export async function selectWindow(sessionName: string, windowId: string): Promise<boolean> {
  const res = await runTmux(['select-window', '-t', `=${sessionName}:${windowId}`])
  return res.code === 0
}

export async function listClients(sessionName: string): Promise<string[]> {
  const res = await runTmux(['list-clients', '-t', `=${sessionName}`, '-F', '#{client_tty}'])
  if (res.code !== 0) return []
  return res.stdout.split('\n').filter(Boolean)
}

export async function killWindow(windowId: string): Promise<boolean> {
  const res = await runTmux(['kill-window', '-t', windowId])
  return res.code === 0
}

// ---------------------------------------------------------------------------
// A second pane in a session's window (plan 7 — "a button to add a new tmux
// window", implemented as a split of the existing one rather than a real
// second window: same window travels with the session as a single unit, so
// killWindow already tears both panes down on session delete with no extra
// code, and the existing PTY already attached to this window (tmux-pty.ts,
// one grouped session per pane, pinned to "its" window) keeps rendering it
// with zero changes there — a window's content is shared by every client
// viewing it, split or not.
//
// That sharing is exactly why the two panes are presented as tabs, not a
// permanent side-by-side split: a genuine tmux split is visible to *every*
// client on that window, including one attached to the agent's own pane id,
// so leaving it split would double-render both halves into both clients and
// reintroduce the very clamping bug grouped-per-pane sessions exist to avoid
// (tmux clamps a window to its smallest attached client). Zooming instead —
// resize-pane -Z — keeps exactly one pane filling the window's actual
// content at a time, so the one already-attached client just shows whichever
// pane is "current", full size, no second PTY needed.

export interface TmuxWindowPane {
  paneId: string
  active: boolean
}

/**
 * Every pane in the window that contains `paneId`, resolved from the pane
 * id alone — no caller ever needs to track a window id separately. Used to
 * tell whether a split already exists before adding another, and to find
 * the other pane when tearing one down or restoring tab state after a
 * remount. Empty on any failure, including a `paneId` that no longer
 * exists — verified by hand that `list-panes -t <bogus pane>` fails loudly
 * (exit 1, "can't find pane"), unlike `display-message`'s more forgiving
 * `-t` (see focusPane below), so this can trust a non-zero exit here.
 */
export async function listWindowPanes(paneId: string): Promise<TmuxWindowPane[]> {
  const res = await runTmux(['list-panes', '-t', paneId, '-F', `#{pane_id}${FS}#{pane_active}`])
  if (res.code !== 0) return []
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, active] = line.split(FS)
      return { paneId: id, active: active === '1' }
    })
}

export interface SplitResult {
  ok: boolean
  windowId?: string
  paneId?: string
  error?: string
}

/**
 * Splits the window containing `paneId`, adding a second, plain-shell pane
 * beside it. `-d` keeps the existing pane focused/active so nothing about
 * its view changes for any other attached client (matches newWindow's own
 * use of `-d`); `-h` places the new pane side by side. `-c` is required:
 * without it tmux starts the shell in the directory the tmux session was
 * created in (usually ~), not the split pane's. And it has to be a real
 * path: `-c '#{pane_current_path}'` expands against the session's active
 * pane, not `-t` (tmux 3.7), so every split landed in whichever worktree
 * was last focused. We read the target pane's path from tmux itself — the
 * renderer still only ever sends a pane id. Mirrors newWindow's `-P -F`
 * shape for the new pane id, and — unlike newWindow/newSession — keeps
 * tmux's stderr on failure (sendKeysResult's lesson: a swallowed tmux error
 * is not a diagnosis).
 */
export async function splitWindow(paneId: string): Promise<SplitResult> {
  const where = await runTmux(['display-message', '-p', '-t', paneId, '#{pane_current_path}'])
  const cwd = where.code === 0 ? where.stdout.trim() : ''
  const res = await runTmux([
    'split-window',
    '-d',
    '-h',
    '-t',
    paneId,
    ...(cwd ? ['-c', cwd] : []),
    '-P',
    '-F',
    `#{window_id}${FS}#{pane_id}`
  ])
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || `tmux split-window exited ${res.code}` }
  }
  const [windowId, newPaneId] = res.stdout.trim().split(FS)
  if (!newPaneId) return { ok: false, error: 'tmux split-window produced no pane id' }
  return { ok: true, windowId, paneId: newPaneId }
}

/**
 * Makes `paneId` the one visible pane of its window by selecting it and, if
 * needed, zooming it (`resize-pane -Z`) — see the header comment for why
 * zoom, not a permanent split. Idempotent: if `paneId` is already the
 * active, zoomed pane this is a deliberate no-op, because blindly toggling
 * zoom on a pane that's already focused would zoom it back *out* instead
 * (`-Z` toggles). Also re-zooms after selecting rather than assuming the
 * toggle lands the right way, because switching the active pane while
 * zoomed auto-unzooms the window. Both behaviours were verified by hand
 * against a real tmux server (3.7c) while building this, not assumed from
 * the man page.
 *
 * `display-message -t <target>`'s own `-t` is more forgiving than every
 * other command used here: given a pane id that no longer exists, it exits
 * 0 with an empty format result instead of erroring (verified by hand),
 * where `list-panes`/`select-pane`/`kill-pane`/`split-window` all fail
 * loudly. The empty-field check below treats that the same as a real
 * failure rather than trusting the exit code alone.
 */
export async function focusPane(paneId: string): Promise<boolean> {
  const before = await runTmux([
    'display-message',
    '-p',
    '-t',
    paneId,
    `#{pane_active}${FS}#{window_zoomed_flag}`
  ])
  const [activeStr, zoomedStr] = before.stdout.trim().split(FS)
  if (before.code !== 0 || !activeStr || zoomedStr === undefined) return false
  if (activeStr === '1' && zoomedStr === '1') return true // already the visible pane

  const select = await runTmux(['select-pane', '-t', paneId])
  if (select.code !== 0) return false // most likely: paneId is gone

  const after = await runTmux(['display-message', '-p', '-t', paneId, '#{window_zoomed_flag}'])
  if (after.code === 0 && after.stdout.trim() === '1') return true // e.g. a single-pane window

  const zoom = await runTmux(['resize-pane', '-Z', '-t', paneId])
  return zoom.code === 0
}

/**
 * Removes just the split pane splitWindow created — the session's own
 * primary pane, and the rest of the window, are untouched. Only ever
 * called with a pane id the renderer got back from splitWindow itself,
 * never one it constructed or a user typed.
 */
export async function killPane(paneId: string): Promise<boolean> {
  const res = await runTmux(['kill-pane', '-t', paneId])
  return res.code === 0
}

// ---------------------------------------------------------------------------
// Handing a new session its first prompt.
//
// Typed as literal keys and followed straight away by Enter, the prompt often
// just sat in Claude Code's input box: a fast burst of keys reads as a paste,
// and an Enter that lands inside the burst is taken as part of it — a
// newline, not "send". So the prompt goes in as a real (bracketed) paste,
// Enter follows once the paste has settled, and if the input box still holds
// the prompt a moment later, Enter is pressed again.

// Zero-width space/joiners, word joiner, BOM, soft hyphen — built from code
// points so the source holds no invisible characters itself.
const INVISIBLE = new RegExp(
  `[${[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad].map((c) => String.fromCharCode(c)).join('')}]`,
  'g'
)

/** Invisible and control characters out, line endings normalised. */
export function cleanPrompt(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // zero-width spaces/joiners, word joiner, BOM, soft hyphen
      .replace(INVISIBLE, '')
      // C0/C1 controls except tab and newline (escape sequences included)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
      .trim()
  )
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The bottom of the pane still showing the prompt in the input box — i.e. unsent. */
async function promptStillWaiting(paneId: string, text: string): Promise<boolean> {
  const res = await runTmux(['capture-pane', '-p', '-J', '-t', paneId, '-S', '-12'])
  if (res.code !== 0) return false
  const lines = res.stdout.split('\n').filter((l) => l.trim())
  // The input box is the last "> " line on screen; the transcript's own copy
  // of a sent prompt sits above the box, never at the bottom.
  const inputLine = [...lines.slice(-8)].reverse().find((l) => /^[\s│|]*>\s/.test(l))
  if (!inputLine) return false
  const typed = inputLine
    .replace(/^[\s│|]*>\s?/, '')
    .replace(/[│|]\s*$/, '')
    .trim()
  if (!typed) return false
  const firstLine = text.split('\n')[0].trim().slice(0, 24)
  return /\[Pasted text/.test(typed) || (firstLine.length > 0 && typed.startsWith(firstLine))
}

export async function deliverPrompt(
  paneId: string,
  prompt: string
): Promise<{ ok: boolean; error: string | null }> {
  const text = cleanPrompt(prompt)
  if (!text) return { ok: true, error: null }
  const buffer = `cr-prompt-${Date.now()}`
  const set = await runTmux(['set-buffer', '-b', buffer, '--', text])
  if (set.code !== 0) {
    // No buffer to paste from: fall back to typing it.
    return sendKeysResult(paneId, text)
  }
  const paste = await runTmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', paneId])
  if (paste.code !== 0) {
    return { ok: false, error: paste.stderr.trim() || `tmux paste-buffer exited ${paste.code}` }
  }
  await sleep(350)
  for (let attempt = 0; attempt < 3; attempt++) {
    const enter = await runTmux(['send-keys', '-t', paneId, 'C-m'])
    if (enter.code !== 0) {
      return { ok: false, error: enter.stderr.trim() || `tmux send-keys C-m exited ${enter.code}` }
    }
    await sleep(700)
    if (!(await promptStillWaiting(paneId, text))) return { ok: true, error: null }
  }
  return {
    ok: false,
    error: 'the prompt was pasted but Claude didn’t take it - press Enter in the terminal'
  }
}
