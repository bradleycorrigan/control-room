import {
  openSync,
  closeSync,
  readSync,
  fstatSync,
  readdirSync,
  existsSync,
  readFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Part 4 (control-room-design-revision.md) — CLI history read from
// `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`. These files can
// be tens of MB, so only the head and tail are ever read (never the whole
// file) — the useful bookkeeping lines (`last-prompt`, `ai-title`, `cwd`,
// `gitBranch`) are written near the start or appended at the tail. The slug
// is a lossy, undocumented transform of the cwd (CLAUDE.md: "session
// discovery reads undocumented internals") — never reverse it; `cwd` is
// read back out of the file itself.

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024
// Overridable so the fixture (npm run fixture) can point this at a seeded
// directory instead of the real ~/.claude/projects — never used outside
// tests/fixtures.
const CLAUDE_PROJECTS_DIR =
  process.env.CR_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const CLAUDE_HISTORY_PATH = join(homedir(), '.claude', 'history.jsonl')

/** Reads up to the first and last N bytes of a file, on whole-line boundaries, without loading it all. */
function readHeadAndTail(filePath: string, headBytes: number, tailBytes: number): string[] {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return []
  }
  try {
    const size = fstatSync(fd).size
    const lines: string[] = []

    const head = Buffer.alloc(Math.min(headBytes, size))
    readSync(fd, head, 0, head.length, 0)
    lines.push(...head.toString('utf8').split('\n'))

    if (size > headBytes) {
      const tailStart = Math.max(headBytes, size - tailBytes)
      const tail = Buffer.alloc(size - tailStart)
      readSync(fd, tail, 0, tail.length, tailStart)
      lines.push(...tail.toString('utf8').split('\n'))
    }

    return lines
  } catch {
    return []
  } finally {
    closeSync(fd)
  }
}

interface ParsedLine {
  type?: string
  cwd?: string
  gitBranch?: string
  timestamp?: string
  lastPrompt?: string
  aiTitle?: string
  sessionId?: string
  message?: unknown
}

function parseLines(raw: string[]): ParsedLine[] {
  const out: ParsedLine[] = []
  for (const line of raw) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as ParsedLine)
    } catch {
      // partial line at a head/tail boundary, or a corrupt one — skip it
    }
  }
  return out
}

export interface CliHistoryEntry {
  sessionId: string
  cwd: string
  label: string
  lastPrompt: string | null
  aiTitle: string | null
  messageCount: number
  gitBranch: string | null
  updatedAt: number | null
  jsonlPath: string
}

function readOneTranscript(projectDir: string, fileName: string): CliHistoryEntry | null {
  if (!fileName.endsWith('.jsonl')) return null
  const jsonlPath = join(projectDir, fileName)
  const sessionId = fileName.slice(0, -'.jsonl'.length)
  const parsed = parseLines(readHeadAndTail(jsonlPath, HEAD_BYTES, TAIL_BYTES))
  if (parsed.length === 0) return null

  let cwd: string | null = null
  let gitBranch: string | null = null
  let lastPrompt: string | null = null
  let aiTitle: string | null = null
  let messageCount = 0
  let updatedAt: number | null = null

  for (const line of parsed) {
    if (line.cwd) cwd = line.cwd
    if (line.gitBranch) gitBranch = line.gitBranch
    if (line.type === 'last-prompt' && typeof line.lastPrompt === 'string')
      lastPrompt = line.lastPrompt
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string') aiTitle = line.aiTitle
    if (line.type === 'assistant' || line.type === 'user') messageCount++
    if (line.timestamp) {
      const t = Date.parse(line.timestamp)
      if (!Number.isNaN(t)) updatedAt = updatedAt === null ? t : Math.max(updatedAt, t)
    }
  }

  if (!cwd) return null // no usable line found in either window — degrade by omission, not a crash

  const label = aiTitle ?? lastPrompt ?? sessionId
  return {
    sessionId,
    cwd,
    label: label.length > 200 ? `${label.slice(0, 200)}…` : label,
    lastPrompt,
    aiTitle,
    messageCount,
    gitBranch,
    updatedAt,
    jsonlPath
  }
}

/**
 * Every Claude Code CLI transcript on disk, newest first. `matchRoots`, when
 * given, filters to transcripts whose `cwd` is one of (or inside) those
 * absolute paths — "filter to the current project by matching each
 * transcript's cwd against the project's repo path or worktree root" (Part 4).
 * Never trusts the directory-name slug to reverse into a path.
 */
export function listCliHistory(matchRoots?: string[]): CliHistoryEntry[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return []

  let projectDirs: string[]
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  const entries: CliHistoryEntry[] = []
  for (const dirName of projectDirs) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, dirName)
    let files: string[]
    try {
      files = readdirSync(projectDir)
    } catch {
      continue
    }
    for (const file of files) {
      const entry = readOneTranscript(projectDir, file)
      if (!entry) continue
      if (
        matchRoots &&
        !matchRoots.some((root) => entry.cwd === root || entry.cwd.startsWith(`${root}/`))
      ) {
        continue
      }
      entries.push(entry)
    }
  }

  return entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export interface HistoryPromptEntry {
  display: string
  project: string | null
  sessionId: string | null
  timestamp: number | null
}

/** `~/.claude/history.jsonl` — cheap global list of typed prompts, for labelling without opening transcripts. */
export function listTypedPromptHistory(limit = 500): HistoryPromptEntry[] {
  if (!existsSync(CLAUDE_HISTORY_PATH)) return []
  const parsed = parseLines(readHeadAndTail(CLAUDE_HISTORY_PATH, 0, TAIL_BYTES))
  const out: HistoryPromptEntry[] = []
  for (const line of parsed.slice(-limit)) {
    const raw = line as Record<string, unknown>
    const display = typeof raw.display === 'string' ? raw.display : null
    if (!display) continue
    out.push({
      display,
      project: typeof raw.project === 'string' ? raw.project : null,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : null
    })
  }
  return out.reverse()
}

// =====================================================================
// Part 7.4 (control-room-truthful-state.md) — the context-window panel.
// Cost per session used to live here too, estimated against a hand-maintained
// price table. On team pricing that estimate answers a question nobody is
// asking, and a stale table answers it wrongly, so both are gone.
//
// Assistant lines in the same jsonl carry `usage` (input_tokens,
// output_tokens, cache_creation_input_tokens, cache_read_input_tokens) plus
// the model id. Unlike listCliHistory above, this needs every assistant line,
// not just the head/tail window, so it reads the whole file — Claude Code
// session transcripts are not the multi-GB case that trick exists for.
//
// Only fresh input and output are reported. Cache reads are a property of how
// a turn was served rather than of the work done, and they run to millions of
// tokens on an ordinary session, so every figure built on them read as a
// fault: a "in context now" line summing input + cache read + cache write
// showed 5.1M for a window that holds at most 1M.

interface AssistantUsageLine {
  type?: string
  timestamp?: string
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

export interface TranscriptUsagePoint {
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  timestamp: number | null
}

/** Every assistant `usage` line in a transcript, in file (append) order. Never partial — reads the whole file. */
function readAssistantUsageLines(jsonlPath: string): TranscriptUsagePoint[] {
  let raw: string
  try {
    raw = readFileSync(jsonlPath, 'utf8')
  } catch {
    return []
  }

  const points: TranscriptUsagePoint[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: AssistantUsageLine
    try {
      parsed = JSON.parse(trimmed) as AssistantUsageLine
    } catch {
      continue // partial line at EOF, or a corrupt one — skip it
    }
    if (parsed.type !== 'assistant') continue
    const usage = parsed.message?.usage
    if (!usage) continue

    const t = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN
    points.push({
      model: parsed.message?.model ?? null,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      timestamp: Number.isNaN(t) ? null : t
    })
  }
  return points
}

// There is no context-window size in here on purpose. Claude Code does not
// record one and the model id does not carry it — a 1M session writes itself
// as plain "claude-opus-5". Every way of deducing it was a guess dressed as a
// number: assuming 200k reported a 1M session at five times its real usage,
// and watching for a turn above 200k only corrected it after the fact, if
// ever. The token counts below are read straight from each turn's own
// `usage`, so they are exactly what the API reported. A percentage needs a
// denominator nobody writes down, so this no longer offers one.

export interface ContextWindowUsage {
  sessionId: string
  jsonlPath: string
  /** The model id on the latest (most recent) assistant usage line. */
  model: string | null
  /** Cumulative fresh (uncached) input tokens, summed across every assistant line. */
  cumulativeInputFresh: number
  /** Cumulative output tokens. */
  cumulativeOutput: number
}

/**
 * Reads every assistant usage line in one transcript and computes the
 * context-window panel's numbers. Returns null when the transcript has no
 * assistant usage lines at all (nothing to show, not an error).
 */
export function getContextWindowUsage(
  jsonlPath: string,
  sessionId: string
): ContextWindowUsage | null {
  const points = readAssistantUsageLines(jsonlPath)
  if (points.length === 0) return null

  // Transcripts are append-only, so the last line in file order is the
  // latest turn — never picked by taking a max over cumulative usage. Only
  // its model is used now: the "in context now" figure that lived here was
  // the turn's input + cache read + cache write, and cache read dominates it,
  // so it reported 5.1M for a window that holds at most 1M.
  const latest = points[points.length - 1]

  let cumulativeInputFresh = 0
  let cumulativeOutput = 0

  for (const point of points) {
    cumulativeInputFresh += point.inputTokens
    cumulativeOutput += point.outputTokens
  }

  return {
    sessionId,
    jsonlPath,
    model: latest.model,
    cumulativeInputFresh,
    cumulativeOutput
  }
}

/** Locates a session's transcript by id, searching every project dir under `~/.claude/projects` (or the fixture override). Never reverses the directory-name slug. */
export function findSessionTranscriptPath(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null

  let projectDirs: string[]
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return null
  }

  for (const dirName of projectDirs) {
    const candidate = join(CLAUDE_PROJECTS_DIR, dirName, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Convenience wrapper: cost-per-session and context-window data for a session, by id alone. The function ipc.ts's stub(s) should call. */
export function getContextWindowUsageForSession(sessionId: string): ContextWindowUsage | null {
  const jsonlPath = findSessionTranscriptPath(sessionId)
  if (!jsonlPath) return null
  return getContextWindowUsage(jsonlPath, sessionId)
}

/**
 * Part 7.3 — the transcript's own auto-generated title (`ai-title` line),
 * read straight from the session's jsonl by id. Returns null when there is
 * no transcript yet or no `ai-title` line has been written — discovery.ts
 * treats null as "nothing to sync", never as "clear the title".
 */
export function getTranscriptTitle(sessionId: string): string | null {
  const jsonlPath = findSessionTranscriptPath(sessionId)
  if (!jsonlPath) return null
  const parsed = parseLines(readHeadAndTail(jsonlPath, HEAD_BYTES, TAIL_BYTES))
  let aiTitle: string | null = null
  for (const line of parsed) {
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string') aiTitle = line.aiTitle
  }
  return aiTitle
}
