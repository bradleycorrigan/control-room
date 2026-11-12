import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { findSessionTranscriptPath } from './transcripts'

/**
 * A session's conversation for the chat view, read from Claude Code's own
 * transcript: what you said, what Claude said, and each tool call as one
 * line. Read-only, and every field is untrusted text the renderer escapes.
 */

export type ChatEntry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      label: string
      detail: string
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
}

interface Line {
  type?: string
  uuid?: string
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

/** "Edit", "src/main/poller.ts", +12 −3: the words a tool row shows. */
export function describeTool(
  name: string,
  input: Record<string, unknown>
): { label: string; detail: string; added: number | null; removed: number | null } {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path)
  const short = file ? file.split('/').slice(-3).join('/') : ''
  switch (name) {
    case 'Bash':
      return { label: 'Ran', detail: str(input.command), added: null, removed: null }
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

export function parseChat(text: string): ChatEntry[] {
  const out: ChatEntry[] = []
  const tools = new Map<string, Extract<ChatEntry, { kind: 'tool' }>>()
  let n = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue // a partial line at the start of the window
    }
    if (line.isSidechain || line.isMeta) continue
    const content = line.message?.content
    const id = line.uuid ?? `l${n++}`
    if (line.type === 'user') {
      if (typeof content === 'string') {
        const t = userText(content)
        if (t) out.push({ kind: 'user', id, text: t })
        continue
      }
      if (!Array.isArray(content)) continue
      const words = content
        .filter((b) => b.type === 'text')
        .map((b) => userText(str(b.text)))
        .filter((t): t is string => !!t)
        .join('\n\n')
      if (words) out.push({ kind: 'user', id, text: words })
      for (const b of content) {
        if (b.type === 'tool_result' && b.is_error && b.tool_use_id) {
          const tool = tools.get(b.tool_use_id)
          if (tool) tool.failed = true
        }
      }
    } else if (line.type === 'assistant') {
      if (typeof content === 'string') {
        if (content.trim()) out.push({ kind: 'assistant', id, text: content.trim() })
        continue
      }
      if (!Array.isArray(content)) continue
      content.forEach((b, i) => {
        if (b.type === 'text' && str(b.text).trim()) {
          out.push({ kind: 'assistant', id: `${id}:${i}`, text: str(b.text).trim() })
        } else if (b.type === 'tool_use' && b.name) {
          const entry = {
            kind: 'tool' as const,
            id: b.id ?? `${id}:${i}`,
            name: b.name,
            ...describeTool(b.name, b.input ?? {}),
            failed: false
          }
          tools.set(entry.id, entry)
          out.push(entry)
        }
      })
    }
  }
  return out.slice(-MAX_ENTRIES)
}

const cache = new Map<string, { size: number; mtimeMs: number; entries: ChatEntry[] }>()

export function readChat(claudeSessionId: string | null): ChatEntry[] | null {
  if (!claudeSessionId) return null
  const path = findSessionTranscriptPath(claudeSessionId)
  if (!path) return null
  try {
    const fd = openSync(path, 'r')
    try {
      const st = fstatSync(fd)
      const hit = cache.get(path)
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.entries
      const len = Math.min(st.size, MAX_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, st.size - len)
      const entries = parseChat(buf.toString('utf8'))
      cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, entries })
      return entries
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}
