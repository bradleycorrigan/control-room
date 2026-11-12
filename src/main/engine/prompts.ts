import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { findSessionTranscriptPath } from '../exec/transcripts'

/**
 * Claude's open prompts, answerable from the app: a permission to run a tool,
 * a plan to approve, a multiple-choice question. Claude Code sends each one
 * to the PermissionRequest hook, and the hook's request is held open here
 * until you answer. The terminal shows its own dialog the whole time and
 * stays usable; whichever answers first wins.
 *
 * Claude Code does not cancel the hook when you answer in the terminal, so a
 * prompt also clears itself once its transcript records the tool's result.
 */

export type PromptKind = 'permission' | 'plan' | 'question'

export interface PromptQuestion {
  question: string
  header: string | null
  multiSelect: boolean
  options: { label: string; description: string | null }[]
}

export interface PendingPrompt {
  id: string
  claudeSessionId: string | null
  cwd: string | null
  kind: PromptKind
  toolName: string
  /** One line for a permission: the command, the file, the tool. */
  summary: string
  /** The plan, in markdown, for kind 'plan'. */
  plan: string | null
  questions: PromptQuestion[]
  /** Whether "always allow" has a rule to add (Claude Code's own suggestion). */
  canAlwaysAllow: boolean
  at: number
}

export type PromptAnswer =
  | { kind: 'allow' }
  | { kind: 'allowAlways' }
  | { kind: 'deny'; message?: string }
  | { kind: 'answers'; answers: Record<string, string> }
  | { kind: 'approvePlan'; mode: 'acceptEdits' | 'default' }

interface Held {
  prompt: PendingPrompt
  toolInput: Record<string, unknown>
  suggestions: unknown[]
  respond: (body: string) => void
  transcriptPath: string | null
  transcriptSize: number
}

const held = new Map<string, Held>()
let onChange: (() => void) | null = null
let seq = 0

export function setPromptsListener(fn: () => void): void {
  onChange = fn
}

export function listPrompts(): PendingPrompt[] {
  return [...held.values()].map((h) => h.prompt)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  const pick =
    str(input.command) ??
    str(input.file_path) ??
    str(input.path) ??
    str(input.url) ??
    str(input.pattern) ??
    str(input.description)
  return pick ? pick.slice(0, 500) : toolName
}

function parseQuestions(input: Record<string, unknown>): PromptQuestion[] {
  if (!Array.isArray(input.questions)) return []
  return input.questions.flatMap((q): PromptQuestion[] => {
    const r = (q ?? {}) as Record<string, unknown>
    const question = str(r.question)
    if (!question || !Array.isArray(r.options)) return []
    return [
      {
        question,
        header: str(r.header),
        multiSelect: r.multiSelect === true,
        options: r.options.flatMap((o) => {
          const label = str((o as Record<string, unknown>)?.label)
          return label
            ? [{ label, description: str((o as Record<string, unknown>).description) }]
            : []
        })
      }
    ]
  })
}

function fileSize(path: string | null): number {
  if (!path) return 0
  try {
    const fd = openSync(path, 'r')
    try {
      return fstatSync(fd).size
    } finally {
      closeSync(fd)
    }
  } catch {
    return 0
  }
}

/**
 * Takes a PermissionRequest hook's body and holds the request. `respond`
 * sends the HTTP reply; it is called exactly once, with a decision or with
 * `{}` (no decision: Claude Code carries on with its own dialog).
 */
export function holdPrompt(raw: unknown, respond: (body: string) => void): string {
  const r = (raw ?? {}) as Record<string, unknown>
  const toolName = str(r.tool_name) ?? 'Tool'
  const toolInput = (
    r.tool_input && typeof r.tool_input === 'object' ? r.tool_input : {}
  ) as Record<string, unknown>
  const suggestions = Array.isArray(r.permission_suggestions) ? r.permission_suggestions : []
  const claudeSessionId = str(r.session_id)
  const kind: PromptKind =
    toolName === 'ExitPlanMode'
      ? 'plan'
      : toolName === 'AskUserQuestion'
        ? 'question'
        : 'permission'
  const id = `p${Date.now().toString(36)}${(seq++).toString(36)}`
  const transcriptPath =
    str(r.transcript_path) ?? (claudeSessionId ? findSessionTranscriptPath(claudeSessionId) : null)
  held.set(id, {
    prompt: {
      id,
      claudeSessionId,
      cwd: str(r.cwd),
      kind,
      toolName,
      summary: kind === 'permission' ? summarize(toolName, toolInput) : toolName,
      plan: kind === 'plan' ? (str(toolInput.plan) ?? '') : null,
      questions: kind === 'question' ? parseQuestions(toolInput) : [],
      canAlwaysAllow: suggestions.some((s) => (s as Record<string, unknown>)?.type === 'addRules'),
      at: Date.now()
    },
    toolInput,
    suggestions,
    respond,
    transcriptPath,
    transcriptSize: fileSize(transcriptPath)
  })
  onChange?.()
  return id
}

/** The hook's reply for an answer. Exported for scripts/verify-prompts.ts. */
export function buildDecision(
  kind: PromptKind,
  toolInput: Record<string, unknown>,
  suggestions: unknown[],
  answer: PromptAnswer
): Record<string, unknown> | null {
  const wrap = (decision: Record<string, unknown>): Record<string, unknown> => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision }
  })
  switch (answer.kind) {
    case 'deny':
      return wrap({
        behavior: 'deny',
        ...(answer.message ? { message: answer.message } : {})
      })
    case 'allow':
      return kind === 'permission' ? wrap({ behavior: 'allow' }) : null
    case 'allowAlways': {
      if (kind !== 'permission') return null
      const rules = suggestions.filter((s) => (s as Record<string, unknown>)?.type === 'addRules')
      return wrap({ behavior: 'allow', ...(rules.length ? { updatedPermissions: rules } : {}) })
    }
    case 'answers': {
      if (kind !== 'question') return null
      const asked = new Set(parseQuestions(toolInput).map((q) => q.question))
      const answers: Record<string, string> = {}
      for (const [q, a] of Object.entries(answer.answers ?? {})) {
        if (asked.has(q) && typeof a === 'string' && a.trim()) answers[q] = a.trim()
      }
      if (Object.keys(answers).length === 0) return null
      return wrap({ behavior: 'allow', updatedInput: { ...toolInput, answers } })
    }
    case 'approvePlan':
      if (kind !== 'plan') return null
      return wrap({
        behavior: 'allow',
        updatedInput: toolInput,
        updatedPermissions: [
          {
            type: 'setMode',
            mode: answer.mode === 'acceptEdits' ? 'acceptEdits' : 'default',
            destination: 'session'
          }
        ]
      })
    default:
      return null
  }
}

function release(id: string, body: string): void {
  const h = held.get(id)
  if (!h) return
  held.delete(id)
  try {
    h.respond(body)
  } catch {
    // the hook already went away — nothing to tell it
  }
  onChange?.()
}

export function answerPrompt(
  id: string,
  answer: PromptAnswer
): { ok: boolean; error: string | null } {
  const h = held.get(id)
  if (!h) return { ok: false, error: 'That prompt was already answered.' }
  const decision = buildDecision(h.prompt.kind, h.toolInput, h.suggestions, answer)
  if (!decision) return { ok: false, error: 'That answer doesn’t fit this prompt.' }
  release(id, JSON.stringify(decision))
  return { ok: true, error: null }
}

/** The hook's connection closed (Claude Code timed out or quit): forget it. */
export function dropPrompt(id: string): void {
  if (!held.has(id)) return
  held.delete(id)
  onChange?.()
}

/** Dev/check only: a prompt with no hook behind it; its reply is kept for the check to read. */
let lastReply: string | null = null
export function seedPrompt(raw: unknown): string {
  return holdPrompt(raw, (body) => {
    lastReply = body
  })
}
export function lastSeededReply(): string | null {
  return lastReply
}

function readRange(path: string, from: number, to: number): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const start = Math.max(0, from)
      const len = Math.min(to - start, 4_000_000)
      if (len <= 0) return ''
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, start)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** The id of the tool call this prompt is about: the last tool_use with its name and input. */
function findToolUseId(
  text: string,
  toolName: string,
  input: Record<string, unknown>
): string | null {
  const want = JSON.stringify(input)
  let found: string | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"') || !line.includes(toolName)) continue
    try {
      const parsed = JSON.parse(line) as { message?: { content?: unknown } }
      const content = parsed.message?.content
      if (!Array.isArray(content)) continue
      for (const b of content as Record<string, unknown>[]) {
        if (b?.type === 'tool_use' && b.name === toolName && JSON.stringify(b.input) === want) {
          found = typeof b.id === 'string' ? b.id : found
        }
      }
    } catch {
      // a partial line at the edge of the window
    }
  }
  return found
}

/**
 * Clears prompts answered somewhere else. The result of this prompt's own
 * tool call in the transcript, written after the prompt opened, means the
 * terminal answered it. When the call can't be found (Claude Code adds
 * fields to some inputs), any tool result after the prompt does. Reads only
 * the bytes added since, so this is cheap to run every second.
 */
export function sweepAnsweredPrompts(): void {
  for (const [id, h] of held) {
    if (!h.transcriptPath) continue
    const size = fileSize(h.transcriptPath)
    if (size <= h.transcriptSize) continue
    const added = readRange(h.transcriptPath, h.transcriptSize, size)
    if (!added.includes('"tool_result"')) continue
    const before = readRange(h.transcriptPath, h.transcriptSize - 400_000, h.transcriptSize)
    const useId = findToolUseId(before + added, h.prompt.toolName, h.toolInput)
    if (!useId || added.includes(`"tool_use_id":"${useId}"`)) release(id, '{}')
  }
}
