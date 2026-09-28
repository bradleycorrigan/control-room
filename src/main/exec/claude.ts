import {
  existsSync,
  readdirSync,
  readFileSync,
  openSync,
  closeSync,
  readSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { run, runTmux } from './run'
import { newWindow, sendKeys } from './tmux'
import { log } from '../log'
import type { SessionStartKind, LiveSubagentSummary } from '../store/types'
import { findSessionTranscriptPath } from './transcripts'

let cachedBinaryPath: string | null | undefined

export async function resolveClaudeBinary(): Promise<string | null> {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath

  const defaultPath = join(homedir(), '.local', 'bin', 'claude')
  if (existsSync(defaultPath)) {
    cachedBinaryPath = defaultPath
    return cachedBinaryPath
  }

  const which = await run('which', ['claude'])
  cachedBinaryPath = which.code === 0 && which.stdout.trim() ? which.stdout.trim() : null
  return cachedBinaryPath
}

// `agents --json` and the session-file shape are undocumented and Claude Code's own
// internals — every field is optional so a schema change degrades gracefully instead
// of breaking the whole list.
export interface ClaudeAgentEntry {
  id?: string // background agents
  state?: string // background: 'running' | 'blocked' | ...
  pid?: number // interactive agents
  status?: string // interactive: 'idle' | 'busy' | 'waiting' | 'blocked' | 'shell'
  cwd?: string
  kind?: 'background' | 'interactive' | string
  startedAt?: number
  sessionId?: string
  name?: string
}

export async function listAgents(): Promise<ClaudeAgentEntry[]> {
  // Fixture mode (CR_SESSIONS_DIR set): never shell out to the real `claude`
  // binary. Background agents come from `claude agents --json` against this
  // machine's real state, not from the sessions fixture — leaving this
  // ungated let real background agents (and their real titles/branches)
  // bleed into fixture screenshots alongside the synthetic sessions.
  if (process.env.CR_SESSIONS_DIR) return []

  const bin = await resolveClaudeBinary()
  if (!bin) return []

  const res = await run(bin, ['agents', '--json'], { cwd: homedir(), timeoutMs: 10_000 })
  if (res.code !== 0) return []

  try {
    const parsed = JSON.parse(res.stdout)
    return Array.isArray(parsed) ? (parsed as ClaudeAgentEntry[]) : []
  } catch (err) {
    log.error('claude: failed to parse agents --json', { error: String(err) })
    return []
  }
}

/**
 * A background agent (claude agents --json, kind "background") has no pid
 * we can kill(2) and no tmux pane — `claude stop <id>` is the documented,
 * safe way to end one. Its conversation is kept, resumable later with
 * `claude attach <id>`, so this is closer to Archive than a hard kill.
 */
export async function stopBackgroundAgent(id: string): Promise<boolean> {
  const bin = await resolveClaudeBinary()
  if (!bin) return false
  const res = await run(bin, ['stop', id], { cwd: homedir(), timeoutMs: 15_000 })
  return res.code === 0
}

/**
 * The last resort: a session found live via a session file (not `agents
 * --json`), no SessionRecord, and its terminal confirmed gone — there is no
 * window to close and no `claude stop` for this one, only the pid itself.
 * SIGTERM, not SIGKILL — same courtesy Claude Code's own process gets when
 * closed normally, letting it clean up before it exits. ESRCH (already
 * gone) counts as success — that's the outcome the caller wanted anyway.
 */
export function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

// =============================================================================
// Sub-agents (Job 2) — the Agent/Task tool spawns a child that never becomes
// its own OS process and never appears in `claude agents --json` or its own
// `~/.claude/sessions/*.json` file. Confirmed empirically on a live machine:
// a currently-running spawned agent's only visible OS footprint on its
// parent pid was an unrelated `caffeinate` child (Claude Code's own
// sleep-prevention helper) — the agent itself runs inside the parent
// process. The one place a spawned agent leaves any external trace is a
// sibling directory Claude Code writes next to the parent's own transcript:
//
//   ~/.claude/projects/<cwd-slug>/<parentSessionId>/subagents/
//     agent-<agentId>.meta.json   -- ~200 bytes, written once at spawn time:
//                                    { agentType, description, toolUseId, ... }
//     agent-<agentId>.jsonl       -- the child's own transcript, appended to
//                                    while it works — same message shape as
//                                    any other Claude Code transcript
//
// This is undocumented and unversioned, same caveat as everything else in
// this file — every field is optional-chained, and a missing/unreadable
// directory, file or line degrades to "no sub-agents" (an empty array),
// never a thrown error.
export interface SubagentSummary {
  agentId: string
  description: string | null
  agentType: string | null
  // Best-effort liveness: its transcript was touched inside
  // SUBAGENT_RECENT_WINDOW_MS AND ends on an assistant turn whose last
  // content block is an unresolved tool_use (stop_reason 'tool_use') — the
  // shape every genuinely in-progress transcript showed in testing, versus
  // stop_reason 'end_turn' for every finished one. false covers both
  // "finished" and "can't tell" — there is no separate unknown state here.
  active: boolean
}

const SUBAGENT_META_RE = /^agent-(.+)\.meta\.json$/
// Bounds how much of a (potentially many-MB) subagent transcript gets read
// to find its last complete JSON line — same head/tail trick as
// transcripts.ts, sized generously enough to clear one very long line (a
// big tool_result or thinking block).
const SUBAGENT_TAIL_BYTES = 256 * 1024
// A subagent whose transcript hasn't been touched in this long is dropped
// from the list entirely rather than shown as stale history — this feature
// is about "what's happening in my session right now", not an archive of
// every agent ever spawned. Chosen to comfortably outlast a slow tool call
// without keeping days-old history around; not derived from measurement —
// worth tuning against real usage.
const SUBAGENT_RECENT_WINDOW_MS = 60 * 60 * 1000
// Defensive cap so a session that has spawned an unusual number of agents
// within the recency window never hands the renderer an unbounded array.
const MAX_SUBAGENTS_RETURNED = 20

/** Reads the last syntactically-valid JSON line of a file, within a bounded tail window. Never throws. */
function readLastJsonLine(path: string, fileSize: number): Record<string, unknown> | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const readSize = Math.min(SUBAGENT_TAIL_BYTES, fileSize)
    if (readSize <= 0) return null
    const buf = Buffer.alloc(readSize)
    readSync(fd, buf, 0, readSize, fileSize - readSize)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim()
      if (!trimmed) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
      } catch {
        continue // a partial line at the start of the read window, or corrupt — try the one before it
      }
    }
    return null
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // already closed or gone — nothing more to do
    }
  }
}

function isSubagentActive(jsonlPath: string, mtimeMs: number): boolean {
  if (Date.now() - mtimeMs > SUBAGENT_RECENT_WINDOW_MS) return false
  let size: number
  try {
    size = statSync(jsonlPath).size
  } catch {
    return false
  }
  const last = readLastJsonLine(jsonlPath, size)
  const message = last?.message as { role?: unknown; stop_reason?: unknown } | undefined
  return message?.role === 'assistant' && message?.stop_reason === 'tool_use'
}

/**
 * Every sub-agent this session has spawned recently, newest first. Empty
 * when the session has no locatable transcript, has never spawned one, the
 * `subagents/` directory can't be read, or every entry falls outside
 * SUBAGENT_RECENT_WINDOW_MS — always an empty array in that case, never an
 * error, so a caller can render "no sub-agents" unconditionally.
 */
export function listSubagentsForSession(sessionId: string): SubagentSummary[] {
  const transcriptPath = findSessionTranscriptPath(sessionId)
  if (!transcriptPath) return []

  const dir = join(dirname(transcriptPath), sessionId, 'subagents')
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const results: Array<LiveSubagentSummary & { mtimeMs: number }> = []
  for (const entry of entries) {
    const match = SUBAGENT_META_RE.exec(entry)
    if (!match) continue
    const agentId = match[1]
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`)

    let mtimeMs: number
    try {
      mtimeMs = statSync(jsonlPath).mtimeMs
    } catch {
      continue // meta.json with no matching transcript yet — nothing to report
    }
    if (Date.now() - mtimeMs > SUBAGENT_RECENT_WINDOW_MS) continue

    let meta: { description?: unknown; agentType?: unknown } | null = null
    try {
      meta = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
    } catch {
      meta = null
    }

    results.push({
      agentId,
      description: typeof meta?.description === 'string' ? meta.description : null,
      agentType: typeof meta?.agentType === 'string' ? meta.agentType : null,
      active: isSubagentActive(jsonlPath, mtimeMs),
      mtimeMs
    })
  }

  return results
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SUBAGENTS_RETURNED)
    .map(({ agentId, description, agentType, active }) => ({
      agentId,
      description,
      agentType,
      active
    }))
}

export interface ClaudeSessionFile {
  pid?: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  procStart?: string
  version?: string
  kind?: string
  tmux?: string // "<session>:@<window-id>.%<pane-id>" — the authoritative link to tmux
  messagingSocketPath?: string
  name?: string
  status?: string // idle | busy | waiting | blocked | shell
  statusUpdatedAt?: number
  waitingFor?: string // "input needed" | "dialog open" | "goal proposal" | "sandbox request"
}

export interface LiveClaudeSessionFile extends ClaudeSessionFile {
  alive: boolean
}

// EPERM means the pid belongs to another user but is still alive — Part 2's
// Risks section is explicit that this must count as alive, never as gone.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What `ps` can tell us about a pid: when it started, and what it is. */
interface ProcessIdentity {
  startedAtMs: number | null
  comm: string
}

/**
 * `ps -o lstart=,comm=` for one pid. Returns null when the process is gone or
 * `ps` gives us nothing usable — an inconclusive answer, never a negative one.
 *
 * Fixture mode skips the shell-out by default: synthetic pids have no real
 * process behind them, and a synthetic pid that happens to collide with a live
 * one would otherwise be judged reused and vanish from the fixture. Set
 * `CR_PID_CROSSCHECK=1` to exercise this path against a real pid in a test.
 */
async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.env.CR_SESSIONS_DIR && process.env.CR_PID_CROSSCHECK !== '1') return null
  const res = await run('ps', ['-o', 'lstart=,comm=', '-p', String(pid)])
  if (res.code !== 0) return null
  const out = res.stdout.trim()
  if (!out) return null

  // "Fri 18 Sep 13:29:14 2026     /Users/me/.local/bin/claude"
  const match = /^(\S{3}\s+\d{1,2}\s+\S{3}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(out)
  if (!match) return { startedAtMs: null, comm: out }

  const parsed = Date.parse(match[1])
  return { startedAtMs: Number.isNaN(parsed) ? null : parsed, comm: match[2].trim() }
}

/** How far apart the session file and `ps` may be before we call it a different process. */
const PROC_START_TOLERANCE_MS = 5_000

/**
 * A pid can be alive and still not be the process the session file thinks it
 * is — pids get reused, and a session file Claude Code never cleaned up can
 * point at someone else's process by the time we poll again.
 *
 * This asks for POSITIVE evidence of reuse and nothing less, because a false
 * positive here costs the user every live session at once. It returns true only
 * when `ps` names a command that is not Claude, or when both sides give us a
 * start time and those times genuinely disagree.
 *
 * Do NOT compare `procStart` to `ps -o lstart=` as strings. They are the same
 * instant in two different renderings — `procStart` is ctime order in UTC
 * ("Thu Sep 17 17:18:24 2026"), `ps` is day-first in local time
 * ("Thu 17 Sep 18:18:24 2026") — so the comparison never matched and the app
 * discarded every running agent it had. `startedAt` is epoch milliseconds with
 * no format and no timezone to get wrong; use that.
 */
async function pidLooksReused(session: ClaudeSessionFile): Promise<boolean> {
  if (typeof session.pid !== 'number') return false

  const identity = await processIdentity(session.pid)
  if (identity === null) return false // couldn't cross-check — don't punish it for that

  // The command is the strongest signal, and is immune to formats and timezones.
  const command = identity.comm.split('/').pop() ?? identity.comm
  if (command.length > 0 && !command.toLowerCase().includes('claude')) return true

  if (typeof session.startedAt !== 'number' || identity.startedAtMs === null) return false
  return Math.abs(identity.startedAtMs - session.startedAt) > PROC_START_TOLERANCE_MS
}

/**
 * Reads `~/.claude/sessions/*.json` only — never `*.key`, never logged, never
 * read. `CR_SESSIONS_DIR` overrides the directory for dev/test fixtures (see
 * `scripts/fixtures/sessions`) so the shot harness and future verifiers have
 * a synthetic, documented dataset instead of whatever real sessions happen
 * to be sitting in the real `~/.claude/sessions`.
 *
 * Stale-file hygiene (plan 4 Part 2): Claude Code never deletes these files
 * when a session ends, so every pid is liveness-checked on every call —
 * `kill(pid, 0)` plus a `ps` cross-check on the command name and start time
 * to catch a reused pid. A session that fails either
 * check comes back with `alive: false`; callers (`discoverLiveSessions`)
 * already drop those from the live list, so a gone session disappears after
 * one poll without any file being deleted from disk.
 */
/** Where Claude Code keeps one small status file per running session. */
export function sessionsDir(): string {
  return process.env.CR_SESSIONS_DIR || join(homedir(), '.claude', 'sessions')
}

// The ps cross-check's verdict per session file and pid. A reused pid stays
// reused, so that verdict is kept for good; a live one is re-checked after a
// minute. Without this, two stale files cost a `ps` launch (and a warning)
// on every discovery pass — ~224 a minute in the log, each launch inspected
// by the Mac's security agent.
const reuseVerdicts = new Map<string, { reused: boolean; at: number }>()

export async function readSessionFiles(): Promise<LiveClaudeSessionFile[]> {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err) {
    log.error('claude: failed to read sessions dir', { error: String(err) })
    return []
  }

  const results: LiveClaudeSessionFile[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue // skips *.key
    const path = join(dir, entry)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ClaudeSessionFile
      let alive = typeof parsed.pid === 'number' ? isAlive(parsed.pid) : false
      if (alive) {
        const key = `${path}:${parsed.pid}:${parsed.startedAt ?? ''}`
        const seen = reuseVerdicts.get(key)
        let reused: boolean
        if (seen && (seen.reused || Date.now() - seen.at < 60_000)) {
          reused = seen.reused
        } else {
          reused = await pidLooksReused(parsed)
          if (reused && !seen?.reused) {
            log.warn('claude: pid looks reused — ps cross-check failed, treating session as gone', {
              path,
              pid: parsed.pid
            })
          }
          reuseVerdicts.set(key, { reused, at: Date.now() })
        }
        if (reused) alive = false
      }
      results.push({ ...parsed, alive })
    } catch (err) {
      log.error('claude: failed to parse session file', { path, error: String(err) })
    }
  }

  return results
}

// =============================================================================
// Terminal (plan 4 Part 2) — can we reach this session's tmux pane at all?
// Computed fresh every time, never trusted from a stored record.

export type TerminalStatus = 'yes' | 'no' | 'unknown'

// tmux's own wording for "that target does not exist" — matched loosely so a
// wording change in a future tmux version degrades to `unknown` rather than
// a false `no`. Covers a missing session, window or pane, and a dead server.
const TMUX_TARGET_GONE_RE = /can't find (?:session|window|pane)|no such session|no server running/i

/**
 * Xirp's three-way probe, copied exactly: exit 0 is reachable, exit 1 with
 * tmux's own "no such session"-style wording is genuinely gone, and anything
 * else — tmux not on PATH, permission denied, a timeout — is `unknown`.
 * `unknown` must never collapse to `no`: that would report a healthy session
 * as dead because *we* couldn't reach tmux, not because the session died.
 */
async function probeTmuxTarget(target: string): Promise<TerminalStatus> {
  const res = await runTmux(['has-session', '-t', target], { timeoutMs: 5_000 })
  if (res.code === 0) return 'yes'
  if (res.code === 1 && TMUX_TARGET_GONE_RE.test(res.stderr)) return 'no'
  return 'unknown'
}

/**
 * Terminal reachability for one session record. Two things have to hold:
 * the tmux *session* named `tmuxSessionName` must still be up (the
 * whole-server-died case the plan opens with), and the specific *window*
 * this record points at must still exist within it — `tmux kill-window`
 * only kills one pane, not the shared session every worktree's window lives
 * in, so checking only the former would miss exactly the case the W1 verify
 * step exercises.
 *
 * `unknown` from the session-level probe short-circuits (we can't say
 * anything about the window either); `unknown` from the window-level probe
 * still returns `unknown`, never `no` — same rule as above.
 */
export async function getTerminalStatus(
  tmuxSessionName: string,
  tmuxWindowId: string | null
): Promise<TerminalStatus> {
  const serverStatus = await probeTmuxTarget(`=${tmuxSessionName}`)
  if (serverStatus !== 'yes') return serverStatus
  if (!tmuxWindowId) return 'no' // never had a window recorded — nothing to reach
  return probeTmuxTarget(`=${tmuxSessionName}:${tmuxWindowId}`)
}

/**
 * Part 2's copy rule (Part 7.7): what happened, then what to do, naming the
 * action exactly as its button is labelled — never milestone/IPC/scope
 * language. This is the string a caller stores as the record's
 * `waitingReason` once `getTerminalStatus` comes back `no`.
 */
export const TMUX_LOST_REASON =
  'The tmux window hosting this session was lost. Resume to relaunch it and continue where it stopped.'

// =============================================================================
// Resume (plan 4 Part 3) — a new pane, not a revived one. A dead pane cannot
// be reattached; this relaunches `claude --resume <id>` in a fresh tmux
// window and waits for Claude Code to pick the conversation back up.

// In-memory attach lock: session id -> currently resuming. A single Electron
// main process is the only writer, so a Set is enough to stop two Resume
// clicks on the same session from creating two windows against one worktree.
const resumingSessionIds = new Set<string>()

// session id -> when it last started transitioning (create or resume), so a
// second resume fired moments after the first is refused rather than racing
// it — Part 3's "refuse while a transition is in flight".
const lastTransitionAt = new Map<string, number>()

const TRANSITION_GUARD_MS = 5_000
const RESUME_POLL_TIMEOUT_MS = 20_000
const RESUME_POLL_INTERVAL_MS = 500

export function isResuming(sessionId: string): boolean {
  return resumingSessionIds.has(sessionId)
}

/** Called by session creation too, so a resume can't race a just-created session. */
export function markSessionTransition(sessionId: string): void {
  lastTransitionAt.set(sessionId, Date.now())
}

export function isTransitionGuarded(sessionId: string): boolean {
  const at = lastTransitionAt.get(sessionId)
  return at !== undefined && Date.now() - at < TRANSITION_GUARD_MS
}

/**
 * The harness's resume arguments, kept in this one place per Part 3 so a
 * future non-Claude-Code harness can be added without touching the UI or
 * `ipc.ts`. Claude Code specifically: `claude --resume <claudeSessionId>`,
 * plus `--fork-session` to branch into a second, independent conversation
 * instead of continuing the same one.
 */
export function resumeArgs(claudeSessionId: string, fork = false): string[] {
  return fork ? ['--resume', claudeSessionId, '--fork-session'] : ['--resume', claudeSessionId]
}

export function resumeCommand(claudeSessionId: string, fork = false): string {
  return ['claude', ...resumeArgs(claudeSessionId, fork)].join(' ')
}

export interface ResumeSessionInput {
  sessionId: string // SessionRecord.id — what the attach lock and transition guard key on
  claudeSessionId: string
  tmuxSessionName: string
  windowName: string
  cwd: string
  fork?: boolean
}

export interface ResumeSessionResult {
  ok: boolean
  error?: string // set on refusal or failure; also set alongside ok:true on a poll timeout
  tmuxWindowId?: string
  tmuxPaneId?: string
  newClaudeSessionId?: string
  command?: string // the exact resume command — surfaced on any failure so it's never silent
}

/**
 * Poll `~/.claude/sessions/*.json` for the file the just-launched resume
 * should produce: same cwd, alive, carrying a `tmux` field (proof Claude
 * Code has joined the new window), and started no earlier than this poll
 * began — so a poll can't accidentally relink onto some other, older
 * session that happens to share the cwd.
 */
async function pollForResumedSession(
  cwd: string,
  pollStartedAt: number
): Promise<LiveClaudeSessionFile | null> {
  const deadline = Date.now() + RESUME_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const files = await readSessionFiles()
    const match = files.find(
      (f) =>
        f.alive &&
        f.cwd === cwd &&
        typeof f.tmux === 'string' &&
        f.tmux.length > 0 &&
        (typeof f.startedAt !== 'number' || f.startedAt >= pollStartedAt)
    )
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_INTERVAL_MS))
  }
  return null
}

/**
 * The full Part 3 flow: take the attach lock, refuse a racing transition,
 * open a new tmux window, run the harness's resume args in it, then poll
 * for the new session file so the caller can relink the record and clear
 * `waitingReason`. On a poll timeout the window is left open and `ok: true`
 * comes back with `command` set and an explanatory `error` — never a
 * silent failure, and never a claim of success we can't back up.
 */
export async function resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult> {
  const { sessionId, claudeSessionId, tmuxSessionName, windowName, cwd, fork } = input

  if (resumingSessionIds.has(sessionId)) {
    return { ok: false, error: 'this session is already resuming - one window per session' }
  }
  if (isTransitionGuarded(sessionId)) {
    return {
      ok: false,
      error: 'this session was just created or resumed - wait a few seconds and try again'
    }
  }

  resumingSessionIds.add(sessionId)
  markSessionTransition(sessionId)
  const pollStartedAt = Date.now()

  try {
    const created = await newWindow(tmuxSessionName, windowName, cwd)
    if (!created) {
      return { ok: false, error: `failed to create a tmux window in session '${tmuxSessionName}'` }
    }

    const command = resumeCommand(claudeSessionId, fork)
    const launched = await sendKeys(created.paneId, command)
    if (!launched) {
      return {
        ok: false,
        error: `the window opened but the resume command could not be typed - run it yourself: ${command}`,
        tmuxWindowId: created.windowId,
        tmuxPaneId: created.paneId,
        command
      }
    }

    const relinked = await pollForResumedSession(cwd, pollStartedAt)
    if (!relinked) {
      return {
        ok: true,
        tmuxWindowId: created.windowId,
        tmuxPaneId: created.paneId,
        command,
        error: `resumed, but could not confirm it within ${RESUME_POLL_TIMEOUT_MS / 1000}s - the window is open and running ${command}`
      }
    }

    return {
      ok: true,
      tmuxWindowId: created.windowId,
      tmuxPaneId: created.paneId,
      newClaudeSessionId: relinked.sessionId ?? claudeSessionId,
      command
    }
  } finally {
    resumingSessionIds.delete(sessionId)
  }
}

export interface RelaunchInput {
  sessionId: string // SessionRecord.id — same transition guard as resume
  tmuxSessionName: string
  windowName: string
  cwd: string
  /** The session's pane, when it's still open at a shell prompt: type here. */
  shellPaneId: string | null
  /** What to type: a fresh `claude …`, or `claude --resume <id>`. */
  command: string
  /** Told the new conversation's id when it checks in — possibly after this returns. */
  onRelinked?: (claudeSessionId: string | null) => void
}

// How long Start/Resume waits for the new Claude to check in before handing
// the button back. The full poll carries on behind it.
const RELAUNCH_WAIT_MS = 4000

/**
 * Starts Claude again in a session whose Claude has exited — Ctrl-C, /exit,
 * a crash — reusing what's still there. When the pane is still open at its
 * shell prompt, the command is typed into it, so it comes back in the same
 * window you were looking at; when the pane is gone too, a new window opens
 * in the same worktree. Resume's own path always made a new window, and a
 * fresh start wasn't offered at all, so an exited session was a dead end.
 */
export async function relaunchInSession(input: RelaunchInput): Promise<ResumeSessionResult> {
  const { sessionId, tmuxSessionName, windowName, cwd, shellPaneId, command, onRelinked } = input
  if (resumingSessionIds.has(sessionId) || isTransitionGuarded(sessionId)) {
    return {
      ok: false,
      error: 'this session was just started or resumed - wait a few seconds and try again'
    }
  }
  resumingSessionIds.add(sessionId)
  markSessionTransition(sessionId)
  const pollStartedAt = Date.now()
  try {
    let paneId = shellPaneId
    let windowId: string | undefined
    if (!paneId) {
      const created = await newWindow(tmuxSessionName, windowName, cwd)
      if (!created) {
        return {
          ok: false,
          error: `failed to create a tmux window in session '${tmuxSessionName}'`
        }
      }
      paneId = created.paneId
      windowId = created.windowId
    }
    const launched = await sendKeys(paneId, command)
    if (!launched) {
      return {
        ok: false,
        error: `could not type into the terminal - run it yourself: ${command}`,
        tmuxWindowId: windowId,
        tmuxPaneId: paneId,
        command
      }
    }
    // Waiting out the whole poll left the button on "Starting…" for as long
    // as Claude took to check in — which reads as frozen. Give it a few
    // seconds, then hand back and let the poll finish on its own.
    const poll = pollForResumedSession(cwd, pollStartedAt)
    void poll.then((found) => onRelinked?.(found?.sessionId ?? null))
    const relinked = await Promise.race([
      poll,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RELAUNCH_WAIT_MS))
    ])
    return {
      ok: true,
      tmuxWindowId: windowId,
      tmuxPaneId: paneId,
      newClaudeSessionId: relinked?.sessionId ?? undefined,
      error: relinked ? undefined : 'Started - waiting for Claude to check in.',
      command
    }
  } finally {
    resumingSessionIds.delete(sessionId)
  }
}

// Re-exported so callers that only need the type name don't have to import
// `../store/types` themselves just for this.
export type { SessionStartKind }
