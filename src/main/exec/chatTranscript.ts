import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { findSessionTranscriptPath } from './transcripts'

/**
 * A session's conversation for the chat view, read from Claude Code's own
 * transcript: what you said, what Claude said, and each tool call as one
 * line. Read-only, and every field is untrusted text the renderer escapes.
 */

export type ChatEntry =
  | {
      kind: 'user'
      id: string
      text: string
      at: string | null
      /** Keys of images you pasted, fetched one by one with readChatImage. */
      images: string[]
    }
  | { kind: 'assistant'; id: string; text: string; at: string | null }
  | {
      kind: 'tool'
      id: string
      name: string
      label: string
      /** What it did, in a few words: a command's own description where it gave one. */
      detail: string
      /** The whole command or path, shown when the row is opened. Empty when detail says it all. */
      full: string
      at: string | null
      added: number | null
      removed: number | null
      failed: boolean
    }

const MAX_BYTES = 3_000_000
const MAX_ENTRIES = 400

interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
  source?: { type?: string; media_type?: string; data?: string }
}

interface Line {
  type?: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: { role?: string; content?: string | Block[] }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function lineCount(s: string): number {
  return s ? s.split('\n').length : 0
}

/**
 * A command without the `cd <folder> &&` it starts with: agents put one on
 * nearly every command, so every row began with the same long path and the
 * part that differed was cut off.
 */
export function withoutCd(command: string): string {
  let c = command.trim()
  const lead = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/
  while (lead.test(c)) c = c.replace(lead, '')
  return c
}

/** "Edit", "src/main/poller.ts", +12 −3: the words a tool row shows. */
export function describeTool(
  name: string,
  input: Record<string, unknown>
): { label: string; detail: string; full: string; added: number | null; removed: number | null } {
  const shown = describe(name, input)
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path)
  const full = name === 'Bash' ? str(input.command).trim() : file
  return { ...shown, full: full && full !== shown.detail ? full : '' }
}

function describe(
  name: string,
  input: Record<string, unknown>
): { label: string; detail: string; added: number | null; removed: number | null } {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path)
  const short = file ? file.split('/').slice(-3).join('/') : ''
  switch (name) {
    case 'Bash': {
      // Claude Code asks for a plain description of every command ("List
      // the worktrees"); it reads as a sentence on its own, so no "Ran".
      const said = str(input.description).trim()
      return said
        ? { label: '', detail: said, added: null, removed: null }
        : { label: 'Ran', detail: withoutCd(str(input.command)), added: null, removed: null }
    }
    case 'Read':
      return { label: 'Read', detail: short, added: null, removed: null }
    case 'Write':
      return {
        label: 'Wrote',
        detail: short,
        added: lineCount(str(input.content)),
        removed: null
      }
    case 'Edit':
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits)
        ? (input.edits as Record<string, unknown>[])
        : [input]
      let added = 0
      let removed = 0
      for (const e of edits) {
        added += lineCount(str(e.new_string))
        removed += lineCount(str(e.old_string))
      }
      return { label: 'Edited', detail: short, added, removed }
    }
    case 'Grep':
    case 'Glob':
      return { label: 'Searched', detail: str(input.pattern), added: null, removed: null }
    case 'WebFetch':
      return { label: 'Fetched', detail: str(input.url), added: null, removed: null }
    case 'WebSearch':
      return { label: 'Searched the web', detail: str(input.query), added: null, removed: null }
    case 'Task':
    case 'Agent':
      return { label: 'Agent', detail: str(input.description), added: null, removed: null }
    case 'TodoWrite':
      return { label: 'Updated the to-do list', detail: '', added: null, removed: null }
    case 'AskUserQuestion':
      return { label: 'Asked you', detail: '', added: null, removed: null }
    case 'ExitPlanMode':
      return { label: 'Presented a plan', detail: '', added: null, removed: null }
    default:
      return {
        label: name.replace(/^mcp__/, '').replace(/__/g, ' · '),
        detail: short || str(input.description),
        added: null,
        removed: null
      }
  }
}

/** A typed slash command arrives as tags; show it as you typed it. Other tagged text is Claude Code's own. */
function userText(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/)
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim()
    return `${cmd[1].trim()}${args ? ` ${args}` : ''}`
  }
  if (t.startsWith('<')) return null
  return t
}

/**
 * Reads a transcript a piece at a time: feed it text as the file grows and it
 * keeps what it has already made, so a session that's working (and so
 * writing every second) costs only its new lines, never the whole file again.
 */
export class ChatParser {
  private out: ChatEntry[] = []
  private tools = new Map<string, Extract<ChatEntry, { kind: 'tool' }>>()
  private n = 0
  /** A line cut off at the end of the last piece, finished by the next. */
  private partial = ''
  /** Pasted images, by key: a data: URL each. */
  readonly images = new Map<string, string>()

  push(text: string): void {
    const lines = (this.partial + text).split('\n')
    this.partial = lines.pop() ?? ''
    for (const raw of lines) this.line(raw)
  }

  /** Everything so far, including a last line with no newline after it yet. */
  entries(): ChatEntry[] {
    if (this.partial.trim()) {
      const before = this.out.length
      const saved = this.partial
      this.line(saved)
      // A complete line just lacking its newline: keep it, and don't parse it twice.
      if (this.out.length !== before) this.partial = ''
    }
    return this.out.slice(-MAX_ENTRIES)
  }

  private line(raw: string): void {
    if (!raw.trim()) return
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      return // a partial line at the start of the window
    }
    if (line.isSidechain || line.isMeta) return
    const content = line.message?.content
    const id = line.uuid ?? `l${this.n++}`
    const at = typeof line.timestamp === 'string' ? line.timestamp : null
    if (line.type === 'user') {
      if (typeof content === 'string') {
        const t = userText(content)
        if (t) this.out.push({ kind: 'user', id, text: t, at, images: [] })
        return
      }
      if (!Array.isArray(content)) return
      const words = content
        .filter((b) => b.type === 'text')
        .map((b) => userText(str(b.text)))
        .filter((t): t is string => !!t)
        .join('\n\n')
      const images: string[] = []
      content.forEach((b, i) => {
        const src = b.source
        if (
          b.type === 'image' &&
          src?.type === 'base64' &&
          typeof src.data === 'string' &&
          /^image\/(png|jpeg|gif|webp)$/.test(src.media_type ?? '')
        ) {
          const key = `${id}:${i}`
          this.images.set(key, `data:${src.media_type};base64,${src.data}`)
          images.push(key)
        }
      })
      if (words || images.length) this.out.push({ kind: 'user', id, text: words, at, images })
      for (const b of content) {
        if (b.type === 'tool_result' && b.is_error && b.tool_use_id) {
          const tool = this.tools.get(b.tool_use_id)
          if (tool) tool.failed = true
        }
      }
    } else if (line.type === 'assistant') {
      if (typeof content === 'string') {
        if (content.trim()) this.out.push({ kind: 'assistant', id, text: content.trim(), at })
        return
      }
      if (!Array.isArray(content)) return
      content.forEach((b, i) => {
        if (b.type === 'text' && str(b.text).trim()) {
          this.out.push({ kind: 'assistant', id: `${id}:${i}`, text: str(b.text).trim(), at })
        } else if (b.type === 'tool_use' && b.name) {
          const entry = {
            kind: 'tool' as const,
            id: b.id ?? `${id}:${i}`,
            name: b.name,
            ...describeTool(b.name, b.input ?? {}),
            at,
            failed: false
          }
          this.tools.set(entry.id, entry)
          this.out.push(entry)
        }
      })
    }
  }
}

export function parseChat(text: string): ChatEntry[] {
  const p = new ChatParser()
  p.push(text)
  return p.entries()
}

interface Cached {
  size: number
  mtimeMs: number
  /** Bytes of the file already handed to the parser. */
  offset: number
  parser: ChatParser
  entries: ChatEntry[]
}
const cache = new Map<string, Cached>()

function readFrom(fd: number, start: number, end: number): string {
  const len = end - start
  if (len <= 0) return ''
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, start)
  return buf.toString('utf8')
}

export interface ChatRead {
  /** Changes whenever the transcript does; send it back to hear "unchanged". */
  version: string
  entries?: ChatEntry[]
}

/**
 * The conversation, read incrementally: a file seen before is read only from
 * where the last read stopped (transcripts only ever grow). When `known` is
 * the current version, no entries are sent at all.
 */
export function readChat(claudeSessionId: string | null, known?: string): ChatRead | null {
  if (!claudeSessionId) return null
  const path = findSessionTranscriptPath(claudeSessionId)
  if (!path) return null
  try {
    const fd = openSync(path, 'r')
    try {
      const st = fstatSync(fd)
      const version = `${st.size}:${st.mtimeMs}`
      let hit = cache.get(path)
      if (!hit || st.size < hit.offset) {
        // First read, or the file was replaced: start over from the window.
        const start = Math.max(0, st.size - MAX_BYTES)
        const parser = new ChatParser()
        parser.push(readFrom(fd, start, st.size))
        hit = {
          size: st.size,
          mtimeMs: st.mtimeMs,
          offset: st.size,
          parser,
          entries: parser.entries()
        }
        cache.set(path, hit)
      } else if (hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
        hit.parser.push(readFrom(fd, hit.offset, st.size))
        hit.offset = st.size
        hit.size = st.size
        hit.mtimeMs = st.mtimeMs
        hit.entries = hit.parser.entries()
      }
      return known === version ? { version } : { version, entries: hit.entries }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** One pasted image from a transcript already read, as a data: URL. */
export function readChatImage(claudeSessionId: string | null, key: string): string | null {
  if (!claudeSessionId) return null
  const path = findSessionTranscriptPath(claudeSessionId)
  return (path && cache.get(path)?.parser.images.get(key)) ?? null
}

/**
 * Claude Code's own "working" line from the bottom of its pane, as it shows
 * it: "✻ Blanching… (1m 22s · ↓ 3.1k tokens · esc to interrupt)" becomes
 * { verb: 'Blanching…', elapsed: '1m 22s' }. Null when no such line is on
 * screen (Claude is idle, or the pane shows something else).
 */
export function parseActivity(screen: string): { verb: string; elapsed: string | null } | null {
  // Colour codes out first: the pane is captured with them.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')
  const lines = screen.replace(ansi, '').split('\n').slice(-30)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*\S\s+([A-Z][A-Za-z'-]{1,40}(?:…|\.\.\.))\s*(?:\(([^)]*)\))?/)
    if (!m) continue
    const first = (m[2] ?? '').split('·')[0].trim()
    const elapsed = /^\d+[hms](\s+\d+[ms])*$/.test(first) ? first : null
    return { verb: m[1].replace(/\.\.\.$/, '…'), elapsed }
  }
  return null
}
