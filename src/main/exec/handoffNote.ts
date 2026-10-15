import { openSync, closeSync, readSync, fstatSync } from 'node:fs'
import { findSessionTranscriptPath } from './transcripts'
import type { HandoffGitSummary } from './sessionGit'

/**
 * A hand-off note, generated with no LLM call from what's already on disk:
 * commits + diffstat since the base branch, the open pull request (if any),
 * and the transcript's last assistant reply. Plain text, written so it reads
 * fine pasted into Jira's wiki markup (bold lines for headings, "- " bullets)
 * or anywhere else.
 */

// Only the tail needs reading — the last assistant reply is always near the
// end of an append-only transcript. Sized like claude.ts's own
// SUBAGENT_TAIL_BYTES: generous enough to clear one very long turn.
const TAIL_BYTES = 256 * 1024

interface TranscriptContentBlock {
  type?: string
  text?: string
}

interface TranscriptLine {
  type?: string
  message?: {
    role?: string
    content?: TranscriptContentBlock[] | string
  }
}

function readTail(path: string, maxBytes: number): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return ''
  }
  try {
    const size = fstatSync(fd).size
    const readSize = Math.min(maxBytes, size)
    if (readSize <= 0) return ''
    const buf = Buffer.alloc(readSize)
    readSync(fd, buf, 0, readSize, size - readSize)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    try {
      closeSync(fd)
    } catch {
      // already closed — nothing more to do
    }
  }
}

/**
 * The last assistant message with real text in it, read straight from the
 * session's own transcript (same file `claude.ts`'s subagent/context-window
 * readers use, found the same way: `findSessionTranscriptPath`). A turn that
 * ended in a tool call and nothing else is skipped, so this walks backward
 * until it finds one with a text block. Null when there's no transcript yet,
 * or nothing but tool calls — never a crash, never a guess.
 */
export function lastAssistantMessage(claudeSessionId: string | null): string | null {
  if (!claudeSessionId) return null
  const jsonlPath = findSessionTranscriptPath(claudeSessionId)
  if (!jsonlPath) return null

  const tail = readTail(jsonlPath, TAIL_BYTES)
  if (!tail) return null
  const lines = tail.split('\n')

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    let parsed: TranscriptLine
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine
    } catch {
      continue // a partial line at the start of the tail window — try the one before it
    }
    if (parsed.type !== 'assistant' || parsed.message?.role !== 'assistant') continue

    const content = parsed.message.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => (b.text as string).trim())
        .filter(Boolean)
        .join('\n\n')
      if (text) return text
    }
    // An assistant turn that was tool-use only (no text) isn't a hand-off
    // message — keep walking back for one that actually says something.
  }
  return null
}

export interface HandoffNoteInput {
  title: string
  branch: string
  git: HandoffGitSummary | null
  prUrl: string | null
  lastMessage: string | null
  /**
   * An investigate-mode session has no worktree or branch of its own to
   * commit to (`git` is always null for it, same as a session that simply
   * has no commits yet) — say so instead of "No commits yet on this branch."
   */
  investigation?: boolean
}

/** Jira wiki markup-friendly plain text: `*heading*` lines, `- ` bullets. */
export function buildHandoffNote(input: HandoffNoteInput): string {
  const lines: string[] = []
  lines.push(`*Hand-off: ${input.title}*`)
  lines.push(input.investigation ? 'Investigation: no branch' : `Branch: ${input.branch}`)
  lines.push('')

  if (input.investigation) {
    lines.push('*Investigation*')
    lines.push('- No branch or worktree: nothing to commit or diff.')
  } else {
    lines.push('*Commits*')
    if (!input.git || input.git.commits.length === 0) {
      lines.push('- No commits yet on this branch.')
    } else {
      for (const c of input.git.commits) lines.push(`- ${c.sha} ${c.subject}`)
      if (input.git.commitsCapped) {
        lines.push(
          `- …earlier commits omitted (showing the most recent ${input.git.commits.length})`
        )
      }
    }
    lines.push('')

    lines.push('*Changes*')
    if (input.git && input.git.filesChanged > 0) {
      const { filesChanged, added, removed } = input.git
      lines.push(
        `${filesChanged} file${filesChanged === 1 ? '' : 's'} changed, +${added} -${removed}`
      )
    } else {
      lines.push('No changes yet.')
    }
  }

  if (input.prUrl) {
    lines.push('')
    lines.push('*Pull request*')
    lines.push(input.prUrl)
  }

  if (input.lastMessage) {
    lines.push('')
    lines.push('*Last update from Claude*')
    lines.push(input.lastMessage)
  }

  return lines.join('\n')
}
