import { existsSync, readFileSync } from 'node:fs'
import {
  readSessionFiles,
  listAgents,
  getTerminalStatus,
  listSubagentsForSession,
  TMUX_LOST_REASON,
  type LiveClaudeSessionFile
} from '../exec/claude'
import { listPanes, type TmuxPane } from '../exec/tmux'
import { run } from '../exec/run'
import { getState, mutate } from '../store/store'
import {
  computeInteractiveStatus,
  computeBackgroundStatus,
  sessionIdentityCandidates,
  migrateAcknowledgement
} from './status'
import { getHookState, type NormalizedEvent } from './hooks-server'
import { isUnread, lastActivityAt, migrateSeen } from './seen'
import { getTranscriptTitle } from '../exec/transcripts'
import type { LiveSession, SessionRecord } from '../store/types'

const TMUX_FIELD_RE = /^(.+):(@\d+)\.(%\d+)$/
// A pane whose foreground process is one of these is sitting at a prompt,
// so it's safe to type a command into and worth showing after Claude exits.
export const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', '-zsh', '-bash', 'login'])

interface JoinedTmux {
  sessionName: string
  windowId: string
  windowIndex: number
  windowName: string
  paneId: string
  // true when this poll's own `listPanes()` snapshot actually contained the
  // pane (a real, live confirmation); false when it was only reconstructed
  // from the session file's `tmux` field after the pane was NOT found in
  // that snapshot — i.e. a "stale" match that still needs a real tmux probe
  // (`getTerminalStatus`) before anything trusts it as reachable.
  verified: boolean
}

function toJoined(pane: TmuxPane): JoinedTmux {
  return {
    sessionName: pane.sessionName,
    windowId: pane.windowId,
    windowIndex: pane.windowIndex,
    windowName: pane.windowName,
    paneId: pane.paneId,
    verified: true
  }
}

/**
 * `pane_pid` is the pane's shell, never Claude — matching it to a session pid
 * never works. Join on the session file's own `tmux` field first; only fall
 * back to `pgrep -P <pane_pid>` (checking Claude is a *child* of the shell)
 * and finally a cwd match.
 */
/**
 * Every process's parent, read in one `ps`.
 *
 * This replaced a `pgrep -P <panePid>` spawned once per pane per session,
 * inside a serial loop: five sessions across five panes meant twenty-five
 * subprocesses one after another, and a real machine with fourteen sessions
 * and twenty-four windows meant well over three hundred — per poll, every two
 * seconds. It was the whole cost of discovery, 5.5s of a 5.6s pass.
 */
/**
 * Every ancestor of `pid`, from the same `ps` snapshot. Empty when `pid`
 * isn't in it, so the caller can tell "not in tmux" from "don't know".
 */
function ancestorsOf(pid: number, childPidsByParent: Map<number, number[]>): Set<number> {
  const parentOf = new Map<number, number>()
  for (const [parent, children] of childPidsByParent) {
    for (const child of children) parentOf.set(child, parent)
  }
  const ancestors = new Set<number>()
  let current = parentOf.get(pid)
  while (current !== undefined && current > 0 && !ancestors.has(current)) {
    ancestors.add(current)
    current = parentOf.get(current)
  }
  return ancestors
}

async function readChildPids(): Promise<Map<number, number[]>> {
  const byParent = new Map<number, number[]>()
  const ps = await run('ps', ['-eo', 'pid=,ppid='])
  if (ps.code !== 0) return byParent
  for (const line of ps.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    const siblings = byParent.get(ppid)
    if (siblings) siblings.push(pid)
    else byParent.set(ppid, [pid])
  }
  return byParent
}

/**
 * The tmux session of the project this path most specifically belongs to.
 *
 * Longest matching root wins, because projects nest: General's repo path is
 * the home directory, so it contains every other project's worktrees. Taking
 * every project that merely contains the path made the answer ambiguous for
 * all of them, which is the same as having no answer.
 */
function projectTmuxSessionOwning(cwd: string): string | null {
  let bestRoot = ''
  let bestSession: string | null = null
  for (const project of getState().projects) {
    for (const root of [project.repoPath, project.worktreeRoot]) {
      if (!root) continue
      if (cwd !== root && !cwd.startsWith(`${root}/`)) continue
      if (root.length > bestRoot.length) {
        bestRoot = root
        bestSession = project.tmuxSession
      }
    }
  }
  return bestSession
}

async function findPaneForSession(
  session: LiveClaudeSessionFile,
  panesByPaneId: Map<string, TmuxPane>,
  panes: TmuxPane[],
  knownTmuxSessions: Set<string>,
  childPidsByParent: Map<number, number[]>
): Promise<JoinedTmux | null> {
  if (session.tmux) {
    const match = TMUX_FIELD_RE.exec(session.tmux)
    if (match) {
      const [, , windowId, paneId] = match
      const pane = panesByPaneId.get(paneId)
      if (pane) return toJoined(pane)
      // tmux field present but the pane wasn't in this poll's live listing —
      // report the parsed ids, unverified. The caller must run these through
      // `getTerminalStatus` before trusting them; it must never treat this
      // as proof the pane is still there.
      return {
        sessionName: match[1],
        windowId,
        windowIndex: -1,
        windowName: '',
        paneId,
        verified: false
      }
    }
  }

  // Below this point neither fallback has a globally-unique key (a pid can
  // be a child of any shell on the machine; a cwd can be shared by any two
  // panes) — so, unlike the tmux-field lookup above (keyed by a paneId
  // that's unique across the whole tmux server), both must be scoped to
  // tmux sessions this app actually manages. Without this, a stray window
  // left open in some other tmux session (e.g. the user's own "wt" — never
  // to be read from OR written to by this app) sitting at the same cwd as a
  // truly-dead fixture/worktree pane silently "reconnects" the record to
  // someone else's terminal.
  // Narrow to the tmux session belonging to the project this cwd lives in,
  // when exactly one project claims it. Scoping to every project's tmux
  // session at once means two projects with a pane at the same path make the
  // cwd match ambiguous, and the session joins neither — which is precisely
  // what happened here: a stale window left in one project's tmux session,
  // sitting at another project's worktree path, silently cost that session
  // its terminal. A session belongs to one project, so its pane does too.
  const owner = session.cwd ? projectTmuxSessionOwning(session.cwd) : null
  const scope = owner ? new Set([owner]) : knownTmuxSessions
  const scopedPanes = panes.filter((p) => scope.has(p.sessionName))

  if (typeof session.pid === 'number') {
    // Up the whole parent chain, not just one step: a wrapper script or a
    // login shell puts claude a generation or two below the pane's shell.
    const ancestors = ancestorsOf(session.pid, childPidsByParent)
    for (const pane of scopedPanes) {
      if (ancestors.has(pane.panePid)) return toJoined(pane)
    }
    // Its ancestry is known and no tmux pane is in it, in any session: it
    // runs in a plain terminal (Ghostty, Terminal). Guessing by folder here
    // joined a Ghostty `claude` in the home folder to a brand-new General
    // session's pane, and the record kept the wrong session id for good.
    if (ancestors.size > 0 && !panes.some((p) => ancestors.has(p.panePid))) return null
  }

  if (session.cwd) {
    // Multiple tmux windows commonly share a cwd — every General/investigate
    // session sits at homedir(), and any plain `claude` run in a repo root
    // shares that repo's path — so, like the cwd fallback in findRecordMatch
    // below, this only trusts the match when it is unambiguous. Guessing the
    // first scoped pane at that path used to join unrelated sessions to the
    // same pane id, which then made findRecordMatch's tmuxPaneId branch
    // collapse them all onto one SessionRecord (the six-identical-rows bug —
    // confirmed live: 3+ session files with no `tmux` field of their own, all
    // at cwd `/Users/bradleycorrigan`, all resolving to whichever pane came
    // first in tmux's listing at that path).
    const atPath = scopedPanes.filter((p) => p.panePath === session.cwd)
    if (atPath.length === 1) return toJoined(atPath[0])
  }

  return null
}

function findRecordMatch(
  records: SessionRecord[],
  claudeSessionId: string | null,
  tmuxPaneId: string | null,
  cwd: string | null,
  claimedRecordIds: Set<string>
): SessionRecord | null {
  // A record already matched to a live session earlier in this same poll can
  // never be matched again. Two live processes can legitimately share one
  // identity — `claude --resume <id>` run more than once (a crash-relaunch, a
  // second terminal) keeps the same claudeSessionId unless `--fork-session`
  // is passed — and a stale tmux pane id can end up on a record too (see
  // findPaneForSession's cwd fallback above). Without this, every such
  // session resolved to the same SessionRecord and rendered as an identical
  // row (confirmed live: two session files with sessionId
  // 4cbec087-e7a8-4d52-909c-22a12e787d9b both matching record d1248220
  // "Tmux optimization with wta wts wtrm"). discoverLiveSessions processes
  // session files newest-`startedAt`-first, so the most recently
  // started/resumed process wins the record and any older duplicate falls
  // back to unmatched (shown live, no record) rather than duplicating it.
  const unclaimed = records.filter((r) => !claimedRecordIds.has(r.id))
  if (claudeSessionId) {
    const byId = unclaimed.find((r) => r.claudeSessionId === claudeSessionId)
    if (byId) return byId
  }
  if (tmuxPaneId) {
    const byPane = unclaimed.find((r) => r.tmuxPaneId === tmuxPaneId)
    if (byPane) return byPane
  }
  if (cwd) {
    // An Investigate/Home record's worktreePath is the project's repoPath or
    // homedir() — every other Investigate/Home record in that project shares
    // it, and so does any unrelated `claude` run started by hand in that
    // directory. A cwd match is only trustworthy when it is unambiguous:
    // never match an `investigation` record this way (it always risks
    // sharing its path with another one), and never match when more than one
    // record — investigation or not — shares the path. Real worktree
    // sessions have their own unique directory, so this only ever narrows
    // the genuinely ambiguous cases; the id/pane matches above stay the
    // primary path for everything else.
    const atPath = unclaimed.filter((r) => r.worktreePath === cwd)
    if (atPath.length === 1 && !atPath[0].investigation) return atPath[0]
  }
  return null
}

/**
 * U5 per-session accent (plan 1.5): pull `workbench.colorTheme` out of the
 * session's `.code-workspace` file so the app can tint the session to match
 * the Cursor window for that worktree. This must never throw and break
 * discovery — no workspace file, unreadable file, invalid JSON, or a
 * `workbench.colorTheme` that isn't a string all collapse to `null`, which
 * the renderer treats as "fall back to the deterministic branch-name hash".
 */
function readCursorTheme(workspaceFile: string | null): string | null {
  if (!workspaceFile) return null
  try {
    const raw = readFileSync(workspaceFile, 'utf8')
    const parsed = JSON.parse(raw) as { settings?: Record<string, unknown> }
    const theme = parsed.settings?.['workbench.colorTheme']
    return typeof theme === 'string' && theme.length > 0 ? theme : null
  } catch {
    return null
  }
}

function latestHookEvent(
  claudeSessionId: string | null,
  cwd: string | null
): NormalizedEvent | null {
  const state = getHookState(claudeSessionId, cwd)
  if (!state) return null
  const candidates = [state.lastNotification, state.lastStop, state.lastStopFailure].filter(
    (e): e is NormalizedEvent => e !== null
  )
  if (candidates.length === 0) return null
  return candidates.reduce((latest, e) => (e.at > latest.at ? e : latest))
}

function backfillRecord(
  record: SessionRecord,
  sessionId: string | null,
  tmuxJoin: JoinedTmux | null
): void {
  const patch: Partial<SessionRecord> = {}
  if (sessionId && record.claudeSessionId !== sessionId) patch.claudeSessionId = sessionId
  if (tmuxJoin && record.tmuxPaneId !== tmuxJoin.paneId) {
    patch.tmuxPaneId = tmuxJoin.paneId
    patch.tmuxWindowId = tmuxJoin.windowId
  }
  if (Object.keys(patch).length === 0) return

  mutate((draft) => {
    const target = draft.sessions.find((s) => s.id === record.id)
    if (target) Object.assign(target, patch)
  })
  Object.assign(record, patch)
}

/**
 * Part 7.3 — auto-name from the transcript's own title, but never fight the
 * user for it. Mirrors Xirp: generation is gated on `isCustomName`, and a
 * rename (ipc.ts sessions:rename) sets that flag permanently. Only writes
 * when the transcript actually has a title and it differs from what's
 * already stored, so this is a no-op most polls.
 */
function syncTitleFromTranscript(record: SessionRecord, sessionId: string | null): void {
  if (record.isCustomName) return
  if (!sessionId) return

  const transcriptTitle = getTranscriptTitle(sessionId)
  if (!transcriptTitle) return
  if (transcriptTitle === record.title) return

  mutate((draft) => {
    const target = draft.sessions.find((s) => s.id === record.id)
    if (target && !target.isCustomName) target.title = transcriptTitle
  })
  record.title = transcriptTitle
}

function clearWaitingReason(record: SessionRecord): void {
  if (record.waitingReason === null) return
  mutate((draft) => {
    const target = draft.sessions.find((s) => s.id === record.id)
    if (target) target.waitingReason = null
  })
  record.waitingReason = null
}

/**
 * Plan 4 Part 2's real fix: a pane this poll's `listPanes()` snapshot didn't
 * see — whether `findPaneForSession` came back empty-handed or only with an
 * unverified parse of a stale `tmux` field — is NOT proof the terminal is
 * gone, and is NOT proof it's still there either. Only `getTerminalStatus`'s
 * live tmux probe gets to decide that, per record:
 *
 * - 'no'      -> the pane really is gone. Null the record's tmux pointers,
 *                set `waitingReason` to `TMUX_LOST_REASON` (SessionRow /
 *                SessionDetail both key their "unreachable" affordances off
 *                exactly that + a null `LiveSession.tmux`), and report no
 *                join for this poll.
 * - 'unknown' -> tmux itself couldn't be reached (missing binary, perms, a
 *                timeout) — leave the record and the join exactly as they
 *                were; never claim the terminal is gone on our own account.
 * - 'yes'     -> genuinely reachable. Clear any stale `waitingReason` left
 *                over from an earlier 'no' (a killed window can come back
 *                under the same id if the pane is recreated) and report the
 *                join unchanged.
 *
 * A join this poll's snapshot already confirmed (`verified: true`) skips the
 * probe entirely — it's already live proof, and re-probing would just be an
 * extra `tmux has-session` call for no new information — but a stale
 * `waitingReason` is still cleared, since a probe from an earlier poll may
 * have set one before the pane came back.
 */
async function reconcileTerminalReachability(
  record: SessionRecord | null,
  tmuxJoin: JoinedTmux | null
): Promise<JoinedTmux | null> {
  // A record-less session (found live in a terminal, never adopted) gets
  // exactly the same scrutiny as a recorded one — skipping this for "no
  // record" is how a session with a real pid but a long-dead window kept
  // reporting session.tmux as non-null: findPaneForSession's stale-field
  // fallback returns a parsed-but-unverified join, nothing ever cross-
  // checked it against a live tmux probe, and Delete then tried to close a
  // window that no longer existed ("failed to close the terminal window").
  // There's just no SessionRecord to write waitingReason onto.
  if (tmuxJoin && tmuxJoin.verified) {
    if (record) clearWaitingReason(record)
    return tmuxJoin
  }

  const sessionName = tmuxJoin?.sessionName ?? record?.tmuxSessionName
  const windowId = tmuxJoin?.windowId ?? record?.tmuxWindowId
  if (!sessionName || !windowId) return tmuxJoin
  const status = await getTerminalStatus(sessionName, windowId)

  if (status === 'no') {
    if (record) {
      mutate((draft) => {
        const target = draft.sessions.find((s) => s.id === record.id)
        if (target) {
          target.tmuxWindowId = null
          target.tmuxPaneId = null
          target.waitingReason = TMUX_LOST_REASON
        }
      })
      record.tmuxWindowId = null
      record.tmuxPaneId = null
      record.waitingReason = TMUX_LOST_REASON
    }
    return null
  }

  if (status === 'yes') {
    if (record) clearWaitingReason(record)
    return tmuxJoin
  }

  // 'unknown' — tmux itself couldn't be reached this poll. Don't touch
  // anything; report whatever join (possibly none) we already had.
  return tmuxJoin
}

// `claude agents --json` starts a whole Node program (~0.3 CPU-s a run), and
// it only tells us about background agents, which come and go rarely. Asked
// on every check, it was the single biggest cost of an idle app.
const AGENTS_TTL_MS = 30_000
let agentsCache: { at: number; value: Awaited<ReturnType<typeof listAgents>> } | null = null

async function listAgentsCached(): Promise<Awaited<ReturnType<typeof listAgents>>> {
  if (agentsCache && Date.now() - agentsCache.at < AGENTS_TTL_MS) return agentsCache.value
  const value = await listAgents()
  agentsCache = { at: Date.now(), value }
  return value
}

/** After stopping or hiding a background agent, so the next check asks again. */
export function invalidateAgentsCache(): void {
  agentsCache = null
}

export async function discoverLiveSessions(): Promise<LiveSession[]> {
  const state = getState()
  const now = Date.now()

  const [sessionFiles, agents, panes, childPidsByParent] = await Promise.all([
    Promise.resolve(readSessionFiles()),
    listAgentsCached(),
    listPanes(),
    readChildPids()
  ])

  const panesByPaneId = new Map(panes.map((p) => [p.paneId, p]))
  const knownTmuxSessions = new Set(state.projects.map((p) => p.tmuxSession))
  const agentsBySessionId = new Map(
    agents
      .filter((a): a is typeof a & { sessionId: string } => Boolean(a.sessionId))
      .map((a) => [a.sessionId, a])
  )

  // Newest-started first: when two live session files share one identity
  // (see findRecordMatch's claimedRecordIds below), whichever was started or
  // resumed most recently claims the record, and a stale duplicate left over
  // from an earlier resume or crash falls back to unmatched instead of
  // rendering the same row twice.
  const orderedSessionFiles = [...sessionFiles].sort(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)
  )

  const live: LiveSession[] = []
  const seenSessionIds = new Set<string>()
  // One SessionRecord can be claimed by at most one live session per poll —
  // see findRecordMatch. Without this, several distinct live sessions could
  // resolve to the same record (a shared claudeSessionId from a double
  // resume, or a mis-joined tmux pane) and render as identical rows.
  const claimedRecordIds = new Set<string>()

  for (const session of orderedSessionFiles) {
    if (!session.alive) continue // dead pids are dropped entirely, not shown as stale

    const agent = session.sessionId ? agentsBySessionId.get(session.sessionId) : undefined
    if (session.sessionId) seenSessionIds.add(session.sessionId)

    let tmuxJoin = await findPaneForSession(
      session,
      panesByPaneId,
      panes,
      knownTmuxSessions,
      childPidsByParent
    )

    const record = findRecordMatch(
      state.sessions,
      session.sessionId ?? null,
      tmuxJoin?.paneId ?? null,
      session.cwd ?? null,
      claimedRecordIds
    )
    if (record) claimedRecordIds.add(record.id)

    // A path match is how a session started with `wta` in the terminal becomes first-class.
    if (record && session.cwd === record.worktreePath) {
      backfillRecord(record, session.sessionId ?? null, tmuxJoin)
    }

    if (record) {
      syncTitleFromTranscript(record, session.sessionId ?? record.claudeSessionId ?? null)
    }

    // Outside every project's tmux session — a plain terminal, or someone
    // else's tmux (xirp, a hand-made session). Read from the join before the
    // reachability probe below, so a probe hiccup on one of our own panes
    // can't flip it to external.
    const external = !tmuxJoin || !knownTmuxSessions.has(tmuxJoin.sessionName)

    // Never trust an unverified join (or the lack of one) at face value —
    // confirm it against a real tmux probe so a killed pane can't keep
    // reporting as reachable (plan 4 Part 2).
    tmuxJoin = await reconcileTerminalReachability(record, tmuxJoin)

    const rawStatus = session.status ?? agent?.status ?? null
    // P1 fix: a record's id (when one is matched) is the most stable
    // identity a session can have across polls — prefer it over
    // claudeSessionId/pane/path, and carry any acknowledgement forward from
    // whichever less-stable candidate it may have been keyed under earlier.
    const identityCandidates = sessionIdentityCandidates({
      recordId: record?.id ?? null,
      claudeSessionId: session.sessionId ?? null,
      tmuxPaneId: tmuxJoin?.paneId ?? null,
      cwd: session.cwd ?? null
    })
    migrateAcknowledgement(identityCandidates)
    migrateSeen(identityCandidates)
    const sessionKey = identityCandidates[0]

    const computed = computeInteractiveStatus({
      sessionKey,
      alive: session.alive,
      rawStatus,
      waitingFor: session.waitingFor ?? null,
      claudeSessionId: session.sessionId ?? null,
      cwd: session.cwd ?? '',
      statusUpdatedAt: session.statusUpdatedAt ?? null
    })
    const lastEvent = latestHookEvent(session.sessionId ?? null, session.cwd ?? null)
    const finishedAt = lastActivityAt({
      claudeSessionId: session.sessionId ?? null,
      cwd: session.cwd ?? null,
      rawStatus,
      statusUpdatedAt: session.statusUpdatedAt ?? null
    })

    // "Mark as done" sets archivedAt, and the process usually keeps running
    // at its prompt — which read "your turn" as if you had never said so.
    // Done, until it does something newer than the moment you marked it:
    // working, asking, failing, or finishing a turn you gave it afterwards.
    const markedDone =
      record?.archivedAt != null &&
      (computed.status === 'ready' || computed.status === 'idle' || computed.status === 'done') &&
      (finishedAt ?? 0) <= record.archivedAt

    // An errored session still says so; anything else we can't vouch for.
    const { status, reason } = markedDone
      ? { status: 'done' as const, reason: 'marked done' }
      : external && computed.status !== 'errored'
        ? { status: 'external' as const, reason: 'running outside Control Room' }
        : computed
    const unread = isUnread(sessionKey, finishedAt)

    // Job 2 — a sub-agent (the Agent/Task tool) is never its own top-level
    // session: no pid, no tmux pane, no `~/.claude/sessions/*.json` file of
    // its own (see exec/claude.ts's listSubagentsForSession for how this was
    // confirmed). It only ever shows up nested here, under whichever live
    // session actually spawned it.
    const subagents = session.sessionId ? listSubagentsForSession(session.sessionId) : []

    live.push({
      record,
      key: sessionKey,
      status,
      statusReason: reason,
      claudePid: session.pid ?? null,
      claudeSessionId: session.sessionId ?? null,
      cwd: session.cwd ?? '',
      agentName: session.name ?? agent?.name ?? null,
      rawStatus,
      waitingFor: session.waitingFor ?? null,
      tmux: tmuxJoin,
      alive: session.alive,
      lastEvent: lastEvent
        ? { type: lastEvent.type, at: lastEvent.at, message: lastEvent.message }
        : null,
      cursorTheme: readCursorTheme(record?.workspaceFile ?? null),
      updatedAt: now,
      backgroundAgentId: null,
      subagents,
      unread,
      // While working: when it started, not now — "now" changed every check
      // and made an unchanged list look new. The screen says "active now".
      activityAt: rawStatus === 'busy' ? (session.statusUpdatedAt ?? finishedAt) : finishedAt
    })
  }

  // Background agents have no session file — surface them straight from `agents --json`.
  const dismissedBackgroundAgentIds = new Set(state.dismissedBackgroundAgentIds)
  for (const agent of agents) {
    if (agent.kind !== 'background') continue
    if (agent.id && dismissedBackgroundAgentIds.has(agent.id)) continue
    if (agent.sessionId && seenSessionIds.has(agent.sessionId)) continue

    const rawStatus = agent.state ?? null
    const { status, reason } = computeBackgroundStatus(rawStatus)

    live.push({
      record: null,
      key: agent.sessionId ?? `agent:${agent.id ?? 'unknown'}`,
      status,
      statusReason: reason,
      claudePid: null,
      claudeSessionId: agent.sessionId ?? null,
      cwd: agent.cwd ?? '',
      agentName: agent.name ?? null,
      rawStatus,
      waitingFor: null,
      tmux: null,
      alive: true,
      lastEvent: null,
      cursorTheme: null,
      updatedAt: now,
      backgroundAgentId: agent.id ?? null,
      // Background (`claude agents --json`, kind "background") agents are
      // independently-dispatched top-level sessions of their own — the
      // `--bg`/`--background` CLI flag, or a scheduled routine — never a
      // sub-agent nested under something else, so there is nothing to list
      // here. See exec/claude.ts's listSubagentsForSession doc comment.
      subagents: [],
      // No session file and no hooks to date its activity by.
      unread: false,
      activityAt: null
    })
  }

  // Registered records with no live session: 'stopped', or 'missing' if the worktree is gone
  // (this happens when `wtrm` runs behind the app's back).
  const liveRecordIds = new Set(live.map((l) => l.record?.id).filter(Boolean))
  for (const record of state.sessions) {
    if (record.archivedAt) continue
    if (liveRecordIds.has(record.id)) continue

    const worktreeExists = existsSync(record.worktreePath)
    // Same identity priority as the live-session loop above (record.id first)
    // — this is what lets an acknowledgement survive a session moving between
    // "live" and "record with no live match" across polls.
    const recordIdentityCandidates = sessionIdentityCandidates({
      recordId: record.id,
      claudeSessionId: record.claudeSessionId,
      tmuxPaneId: record.tmuxPaneId,
      cwd: record.worktreePath
    })
    migrateAcknowledgement(recordIdentityCandidates)
    migrateSeen(recordIdentityCandidates)
    const recordKey = recordIdentityCandidates[0]

    // 'missing' (the worktree directory is gone) takes final precedence over
    // whatever the status engine would say about a merely-dead process.
    const { status, reason } = worktreeExists
      ? computeInteractiveStatus({
          sessionKey: recordKey,
          alive: false,
          rawStatus: null,
          waitingFor: null,
          claudeSessionId: record.claudeSessionId,
          cwd: record.worktreePath,
          statusUpdatedAt: null
        })
      : { status: 'missing' as const, reason: 'worktree directory no longer exists' }

    // Claude exited but its pane is still open at a shell prompt (Ctrl-C,
    // /exit): keep showing the terminal, so the session isn't a dead end —
    // the screen offers to start Claude again right there.
    const shellPane =
      worktreeExists && record.tmuxPaneId ? panesByPaneId.get(record.tmuxPaneId) : undefined
    const openShell =
      shellPane && SHELL_COMMANDS.has(shellPane.paneCommand) ? toJoined(shellPane) : null

    const lastEvent = latestHookEvent(record.claudeSessionId, record.worktreePath)
    const recordActivityAt = lastActivityAt({
      claudeSessionId: record.claudeSessionId,
      cwd: record.worktreePath,
      rawStatus: null,
      statusUpdatedAt: null
    })

    live.push({
      record,
      key: recordKey,
      status,
      statusReason: openShell ? 'Claude exited - its terminal is still open' : reason,
      claudePid: null,
      claudeSessionId: record.claudeSessionId,
      cwd: record.worktreePath,
      agentName: record.title,
      rawStatus: null,
      waitingFor: null,
      tmux: openShell,
      alive: false,
      lastEvent: lastEvent
        ? { type: lastEvent.type, at: lastEvent.at, message: lastEvent.message }
        : null,
      cursorTheme: readCursorTheme(record.workspaceFile),
      updatedAt: now,
      backgroundAgentId: null,
      // Not live this poll, so nothing of its own could be actively
      // spawning sub-agents right now — kept scoped to the live loop above.
      subagents: [],
      unread: isUnread(recordKey, recordActivityAt),
      activityAt: recordActivityAt
    })
  }

  return live
}
