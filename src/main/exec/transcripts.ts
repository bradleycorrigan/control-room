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
// Where each session's transcript was found. Every Sessions poll asks for
// every session's, and the chat view twice a second, and each ask used to
// list every project folder and test each one. A remembered path is checked
// still to exist; a session not found is looked for again at most every 10s.
const transcriptPaths = new Map<string, string>()
const notFoundAt = new Map<string, number>()

export function findSessionTranscriptPath(sessionId: string): string | null {
  const known = transcriptPaths.get(sessionId)
  if (known && existsSync(known)) return known
  if (known) transcriptPaths.delete(sessionId)
  const missedAt = notFoundAt.get(sessionId)
  if (missedAt !== undefined && Date.now() - missedAt < 10_000) return null
  const found = scanForTranscript(sessionId)
  if (found) {
    transcriptPaths.set(sessionId, found)
    notFoundAt.delete(sessionId)
  } else notFoundAt.set(sessionId, Date.now())
  return found
}

function scanForTranscript(sessionId: string): string | null {
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

/** Markdown down to the words: no heading marks, emphasis, code ticks or link targets. */
export function plainOneLine(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, ' ')
      // A heading becomes a sentence, so it doesn't run into the next one.
      .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, (_m, h: string) => (/[.:!?]$/.test(h) ? h : `${h}.`))
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/(\*\*|__|\*|_|`)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** A pull request the session opened, from the `pr-link` line Claude Code writes for each one. */
export interface TranscriptPrLink {
  number: number
  url: string
  /** `owner/name` — not always the session's own repo: an agent can open one anywhere. */
  repository: string
}

// Per transcript: how far it has been scanned and what was found, so a
// many-MB file is read once and only its new tail after that.
const prLinkScans = new Map<string, { offset: number; links: Map<string, TranscriptPrLink> }>()
const PR_LINK_MARKER = Buffer.from('"type":"pr-link"')
// A PR opened some other way than `gh pr create` (Omni's git sync opens its
// own): Claude Code writes no pr-link line, but the command's output names
// it, as "pr_url": "https://github.com/…/pull/30".
const PR_URL_MARKER = Buffer.from('pull/')
const PR_URL_IN_OUTPUT =
  /\\?"?pr_?url\\?"?\s*[:=]\s*\\?"?(https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+))/i

/** The PR a command's output says it opened, if any. */
export function prOpenedInOutput(output: string): TranscriptPrLink | null {
  const m = PR_URL_IN_OUTPUT.exec(output)
  return m ? { url: m[1], repository: m[2], number: Number(m[3]) } : null
}

/**
 * Every pull request a session's transcript says it opened, oldest first.
 * `pr-link` lines can sit anywhere in the file, so unlike the head-and-tail
 * readers above this scans it all — once, then incrementally.
 */
export function listTranscriptPrLinks(sessionId: string): TranscriptPrLink[] {
  const jsonlPath = findSessionTranscriptPath(sessionId)
  if (!jsonlPath) return []
  let scan = prLinkScans.get(jsonlPath)
  if (!scan) {
    scan = { offset: 0, links: new Map() }
    prLinkScans.set(jsonlPath, scan)
  }
  let fd: number
  try {
    fd = openSync(jsonlPath, 'r')
  } catch {
    return [...scan.links.values()]
  }
  try {
    const size = fstatSync(fd).size
    if (size < scan.offset) {
      // Rewritten from scratch: start over.
      scan.offset = 0
      scan.links.clear()
    }
    if (size > scan.offset) {
      const buf = Buffer.alloc(size - scan.offset)
      readSync(fd, buf, 0, buf.length, scan.offset)
      // Only whole lines; a half-written last line waits for the next scan.
      const end = buf.lastIndexOf(0x0a) + 1
      let start = 0
      while (start < end) {
        const nl = buf.indexOf(0x0a, start)
        const line = buf.subarray(start, nl)
        start = nl + 1
        if (line.indexOf(PR_LINK_MARKER) === -1) {
          // Only tool results can say a PR was opened; cheap check first.
          if (line.indexOf(PR_URL_MARKER) === -1) continue
          try {
            const parsed = JSON.parse(line.toString('utf8')) as {
              type?: string
              message?: { content?: unknown }
            }
            const blocks = parsed.message?.content
            if (parsed.type !== 'user' || !Array.isArray(blocks)) continue
            for (const b of blocks as Record<string, unknown>[]) {
              if (b?.type !== 'tool_result' || b.is_error === true) continue
              const link = prOpenedInOutput(JSON.stringify(b.content ?? ''))
              if (link && !scan.links.has(link.url)) scan.links.set(link.url, link)
            }
          } catch {
            // A malformed line is skipped, never fatal.
          }
          continue
        }
        try {
          const parsed = JSON.parse(line.toString('utf8')) as {
            prNumber?: unknown
            prUrl?: unknown
            prRepository?: unknown
          }
          if (
            typeof parsed.prNumber === 'number' &&
            typeof parsed.prUrl === 'string' &&
            parsed.prUrl.startsWith('https://')
          ) {
            scan.links.set(parsed.prUrl, {
              number: parsed.prNumber,
              url: parsed.prUrl,
              repository: typeof parsed.prRepository === 'string' ? parsed.prRepository : ''
            })
          }
        } catch {
          // A malformed line is skipped, never fatal.
        }
      }
      scan.offset += end
    }
  } catch {
    // Unreadable right now: report what was found so far.
  } finally {
    closeSync(fd)
  }
  return [...scan.links.values()]
}

/** A page the session published with Claude's Artifact tool. */
export interface TranscriptArtifact {
  url: string
  title: string
}

// The same incremental scan as the PR links: per transcript, how far it has
// been read, what was found, and Artifact calls still waiting on their result.
const artifactScans = new Map<
  string,
  {
    offset: number
    found: Map<string, TranscriptArtifact>
    pending: Map<string, { title: string; typeUrl: string; updates: string }>
  }
>()
const ARTIFACT_MARKER = Buffer.from('rtifact')
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{8,}/

/** The page's own <title>, else the file's name: what the artifact is called. */
function artifactTitle(input: Record<string, unknown>): string {
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  if (path) {
    try {
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(8192)
        const n = readSync(fd, buf, 0, buf.length, 0)
        const m = /<title>([^<]{1,120})<\/title>/i.exec(buf.subarray(0, n).toString('utf8'))
        if (m) return m[1].trim()
      } finally {
        closeSync(fd)
      }
    } catch {
      // Gone or unreadable: the name will do.
    }
  }
  if (typeof input.title === 'string' && input.title.trim()) return input.title.trim()
  const base = path
    .split('/')
    .pop()
    ?.replace(/\.[a-z]+$/i, '')
  return base || 'Artifact'
}

/**
 * Every page a session published with the Artifact tool, oldest first, by its
 * claude.ai link. Only publishes of a page: asset uploads, reads and lists
 * are left out. Republishing the same page keeps one entry.
 *
 * An artifact made from a type (a sheet, a deck, a doc) counts too: its first
 * publish names the type (`type_url`) and the result gives the new artifact's
 * link before the type's. Its rows or slides then often arrive through its
 * data store, not more publishes, so that first call is the only sign of it.
 */
export function listTranscriptArtifacts(sessionId: string): TranscriptArtifact[] {
  const jsonlPath = findSessionTranscriptPath(sessionId)
  if (!jsonlPath) return []
  let scan = artifactScans.get(jsonlPath)
  if (!scan) {
    scan = { offset: 0, found: new Map(), pending: new Map() }
    artifactScans.set(jsonlPath, scan)
  }
  let fd: number
  try {
    fd = openSync(jsonlPath, 'r')
  } catch {
    return [...scan.found.values()]
  }
  try {
    const size = fstatSync(fd).size
    if (size < scan.offset) {
      scan.offset = 0
      scan.found.clear()
      scan.pending.clear()
    }
    if (size > scan.offset) {
      const buf = Buffer.alloc(size - scan.offset)
      readSync(fd, buf, 0, buf.length, scan.offset)
      const end = buf.lastIndexOf(0x0a) + 1
      let start = 0
      while (start < end) {
        const nl = buf.indexOf(0x0a, start)
        const line = buf.subarray(start, nl)
        start = nl + 1
        if (line.indexOf(ARTIFACT_MARKER) === -1) continue
        try {
          const parsed = JSON.parse(line.toString('utf8')) as {
            message?: { content?: unknown }
          }
          const blocks = parsed.message?.content
          if (!Array.isArray(blocks)) continue
          for (const b of blocks as Record<string, unknown>[]) {
            if (b?.type === 'tool_use' && b.name === 'Artifact' && typeof b.id === 'string') {
              const input = (b.input ?? {}) as Record<string, unknown>
              const action = input.action ?? 'publish'
              if (action === 'publish' && input.asset !== true) {
                const typeUrl = typeof input.type_url === 'string' ? input.type_url : ''
                scan.pending.set(b.id, {
                  // A data file published into an artifact already listed
                  // keeps that artifact's name, not the file's.
                  title: typeUrl
                    ? typeof input.title === 'string' && input.title.trim()
                      ? input.title.trim()
                      : 'Artifact'
                    : artifactTitle(input),
                  typeUrl,
                  updates: typeof input.url === 'string' ? input.url : ''
                })
              }
            } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              const pending = scan.pending.get(b.tool_use_id)
              if (pending === undefined) continue
              scan.pending.delete(b.tool_use_id)
              if (b.is_error === true) continue
              // The first artifact link that isn't the type's own.
              const text = JSON.stringify(b.content ?? '')
              const links = text.match(new RegExp(ARTIFACT_URL.source, 'g')) ?? []
              const url = links.find((l) => !pending.typeUrl.startsWith(l))
              if (!url) continue
              const known = scan.found.get(url)
              const title = known && pending.updates ? known.title : pending.title
              scan.found.delete(url)
              scan.found.set(url, { url, title })
            }
          }
        } catch {
          // A malformed line is skipped, never fatal.
        }
      }
      scan.offset += end
    }
  } catch {
    // Unreadable right now: report what was found so far.
  } finally {
    closeSync(fd)
  }
  return [...scan.found.values()]
}

/**
 * What the user typed to the session, oldest first: the text of each user
 * turn, without tool results, slash-command echoes or system reminders. Read
 * from the head and tail only, so a long session gives its first asks and its
 * latest ones. For drafting a ticket from the session.
 */
export function listUserPrompts(sessionId: string): string[] {
  const jsonlPath = findSessionTranscriptPath(sessionId)
  if (!jsonlPath) return []
  const out: string[] = []
  for (const line of parseLines(readHeadAndTail(jsonlPath, HEAD_BYTES, TAIL_BYTES))) {
    if (line.type !== 'user') continue
    const message = line.message as { role?: string; content?: unknown } | undefined
    if (message?.role !== 'user') continue
    const content = message.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (b): b is { type: 'text'; text: string } =>
                  (b as { type?: string })?.type === 'text' &&
                  typeof (b as { text?: unknown }).text === 'string'
              )
              .map((b) => b.text)
              .join('\n')
          : ''
    const trimmed = text.trim()
    // Claude Code's own wrappers (<command-name>, <system-reminder>,
    // <local-command-stdout>…) aren't anything the user asked for.
    if (!trimmed || trimmed.startsWith('<')) continue
    if (out[out.length - 1] !== trimmed) out.push(trimmed)
  }
  return out
}
