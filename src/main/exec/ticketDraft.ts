/**
 * Drafting a Jira ticket from a session: what goes to Claude (Haiku, headless)
 * and how its answer is checked. Pure, so verify-ticket-draft.ts can run it;
 * the spawn itself is in ipc-sessions.ts, through run().
 */

/** What the session did, gathered from disk in the main process. */
export interface TicketDraftContext {
  title: string
  projectName: string | null
  branch: string | null
  /** What the user typed, oldest first. */
  prompts: string[]
  /** The agent's last reply: usually what it did and what's left. */
  lastReply: string | null
  pullRequests: { url: string; title: string | null }[]
  commits: string[]
}

/** The values the board allows; the draft may only pick from these. */
export interface TicketDraftChoices {
  epics: { key: string; summary: string }[]
  labels: string[]
  priorities: string[]
}

export interface TicketDraft {
  summary: string
  description: string
  priority: string | null
  epicKey: string | null
  labels: string[]
  /** One of ESTIMATES, or null when the record gives nothing to go on. */
  estimate: string | null
}

/** The estimates offered wherever one is picked, in Jira's shorthand. */
export const ESTIMATES = ['30m', '1h', '2h', '4h', '1d', '2d', '3d', '1w'] as const

export type TicketDraftResult = { ok: true; value: TicketDraft } | { ok: false; error: string }

const MAX_PROMPT_CHARS = 1_500
const MAX_PROMPTS_CHARS = 12_000
const MAX_REPLY_CHARS = 6_000

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Keeps the first asks and the latest ones when there are too many to send. */
function promptsWithin(prompts: string[]): string[] {
  const clipped = prompts.map((p) => clip(p, MAX_PROMPT_CHARS))
  const total = (xs: string[]): number => xs.reduce((n, x) => n + x.length, 0)
  if (total(clipped) <= MAX_PROMPTS_CHARS) return clipped
  const head = clipped.slice(0, 3)
  const tail: string[] = []
  for (let i = clipped.length - 1; i >= 3; i--) {
    if (total(head) + total(tail) + clipped[i].length > MAX_PROMPTS_CHARS) break
    tail.unshift(clipped[i])
  }
  return [...head, '(…earlier messages left out…)', ...tail]
}

export const TICKET_DRAFT_SYSTEM_PROMPT = `You write Jira tickets from the record of a coding-agent session.
Write for a teammate who never saw the session. Be specific: name the tables, models, dashboards, people and numbers the session names. Plain British English, short sentences, no filler, no marketing words.
Never invent facts the record doesn't support. Reply only through the structured output.`

export function buildTicketDraftPrompt(
  ctx: TicketDraftContext,
  choices: TicketDraftChoices
): string {
  const lines: string[] = []
  lines.push(`Session title: ${ctx.title}`)
  if (ctx.projectName) lines.push(`Repository: ${ctx.projectName}`)
  if (ctx.branch) lines.push(`Branch: ${ctx.branch}`)
  lines.push('', 'What the user asked, oldest first:')
  const prompts = promptsWithin(ctx.prompts)
  if (prompts.length === 0) lines.push('(nothing recorded)')
  prompts.forEach((p, i) => lines.push(`--- message ${i + 1} ---`, p))
  if (ctx.lastReply)
    lines.push('', "The agent's latest reply:", clip(ctx.lastReply, MAX_REPLY_CHARS))
  if (ctx.commits.length > 0)
    lines.push('', 'Commits:', ...ctx.commits.slice(0, 30).map((c) => `- ${c}`))
  if (ctx.pullRequests.length > 0)
    lines.push(
      '',
      'Pull requests:',
      ...ctx.pullRequests.map((p) => `- ${p.url}${p.title ? ` (${p.title})` : ''}`)
    )
  lines.push(
    '',
    'Write the ticket:',
    '- summary: what needs doing (or what was done), imperative, under 80 characters, no ticket key.',
    '- description: Jira wiki markup. "h4. Context" (why this matters, who asked), then "h4. What was done" or "h4. What needs doing" as "* " bullets, then "h4. Links" with each pull request as [title|url]. Under 200 words.',
    `- priority: one of ${choices.priorities.join(', ')}. The middle one unless the record shows urgency or that it can wait.`,
    '- epicKey: the key of the epic it clearly belongs to, or "" when none clearly fits:',
    ...(choices.epics.length > 0
      ? choices.epics.map((e) => `  ${e.key}: ${e.summary}`)
      : ['  (no epics)']),
    `- labels: up to 3, only from: ${choices.labels.join(', ') || '(none, so leave it empty)'}.`,
    `- estimate: how long the whole job takes one person, done or not, as one of ${ESTIMATES.join(', ')}. Judge from the size of the asks, commits and changes. "" only when the record gives nothing to go on.`
  )
  return lines.join('\n')
}

/** The --json-schema for the answer. Enums keep Haiku to the board's own values. */
export function ticketDraftSchema(choices: TicketDraftChoices): string {
  return JSON.stringify({
    type: 'object',
    properties: {
      summary: { type: 'string' },
      description: { type: 'string' },
      priority: choices.priorities.length > 0 ? { enum: choices.priorities } : { type: 'string' },
      epicKey: { enum: ['', ...choices.epics.map((e) => e.key)] },
      labels: {
        type: 'array',
        items: choices.labels.length > 0 ? { enum: choices.labels } : { type: 'string' },
        maxItems: 3
      },
      estimate: { enum: ['', ...ESTIMATES] }
    },
    required: ['summary', 'description', 'priority', 'epicKey', 'labels', 'estimate']
  })
}

/**
 * `claude -p --output-format json` output to a draft, keeping only values the
 * board allows: an epic or label that isn't there is dropped, not created.
 */
export function parseTicketDraft(stdout: string, choices: TicketDraftChoices): TicketDraftResult {
  let outer: { is_error?: boolean; result?: string; structured_output?: unknown }
  try {
    outer = JSON.parse(stdout.trim())
  } catch {
    return { ok: false, error: 'Claude gave an answer that could not be read.' }
  }
  if (outer.is_error)
    return { ok: false, error: clip(String(outer.result ?? 'Claude failed.'), 200) }
  const raw = outer.structured_output as Partial<Record<keyof TicketDraft, unknown>> | undefined
  if (!raw || typeof raw.summary !== 'string' || !raw.summary.trim())
    return { ok: false, error: 'Claude gave no summary.' }
  const priority =
    typeof raw.priority === 'string' && choices.priorities.includes(raw.priority)
      ? raw.priority
      : null
  const epicKey =
    typeof raw.epicKey === 'string' && choices.epics.some((e) => e.key === raw.epicKey)
      ? raw.epicKey
      : null
  const labels = Array.isArray(raw.labels)
    ? [...new Set(raw.labels.filter((l): l is string => typeof l === 'string'))]
        .filter((l) => choices.labels.includes(l))
        .slice(0, 3)
    : []
  return {
    ok: true,
    value: {
      summary: clip(raw.summary.trim().replace(/\s+/g, ' '), 200),
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      priority,
      epicKey,
      labels,
      estimate:
        typeof raw.estimate === 'string' && (ESTIMATES as readonly string[]).includes(raw.estimate)
          ? raw.estimate
          : null
    }
  }
}

/** Board values from the renderer, checked and capped before they reach a prompt. */
export function sanitiseChoices(input: unknown): TicketDraftChoices {
  const o = (input ?? {}) as Record<string, unknown>
  const strings = (x: unknown, n: number): string[] =>
    Array.isArray(x)
      ? x.filter((s): s is string => typeof s === 'string' && s.length <= 200).slice(0, n)
      : []
  const epics = Array.isArray(o.epics)
    ? o.epics
        .filter(
          (e): e is { key: string; summary: string } =>
            typeof e?.key === 'string' &&
            /^[A-Z][A-Z0-9_]*-\d+$/.test(e.key) &&
            typeof e?.summary === 'string'
        )
        .slice(0, 100)
        .map((e) => ({ key: e.key, summary: e.summary.slice(0, 200) }))
    : []
  return { epics, labels: strings(o.labels, 200), priorities: strings(o.priorities, 20) }
}

/**
 * argv for a headless Haiku run: no tools, no MCP, no hooks or settings,
 * nothing saved. Low effort: these are short writing jobs, and thinking was
 * a third of the wait.
 */
export function headlessHaikuArgs(prompt: string, systemPrompt: string, schema?: string): string[] {
  return [
    '-p',
    prompt,
    '--model',
    'haiku',
    '--effort',
    'low',
    '--system-prompt',
    systemPrompt,
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--output-format',
    'json',
    ...(schema ? ['--json-schema', schema] : [])
  ]
}

export function ticketDraftArgs(prompt: string, choices: TicketDraftChoices): string[] {
  return headlessHaikuArgs(prompt, TICKET_DRAFT_SYSTEM_PROMPT, ticketDraftSchema(choices))
}

// --- Session titles ---------------------------------------------------------

export const SESSION_TITLE_SYSTEM_PROMPT = `You name coding-agent sessions so they're easy to find in a list.
Reply with the title only: 3 to 6 words, sentence case, no quotes, no full stop.
Name what the session is about overall, as it stands now, not just the first message. Keep specific names (tables, models, PR numbers, people, products).`

export function buildSessionTitlePrompt(
  ctx: Pick<TicketDraftContext, 'title' | 'projectName' | 'prompts' | 'lastReply'>
): string {
  const lines = [`Current title: ${ctx.title}`]
  if (ctx.projectName) lines.push(`Repository: ${ctx.projectName}`)
  lines.push('', 'What the user asked, oldest first:')
  const prompts = promptsWithin(ctx.prompts)
  if (prompts.length === 0) lines.push('(nothing recorded)')
  prompts.forEach((p, i) => lines.push(`--- message ${i + 1} ---`, p))
  if (ctx.lastReply)
    lines.push('', "The agent's latest reply:", clip(ctx.lastReply, MAX_REPLY_CHARS))
  lines.push('', 'A better title for this session:')
  return lines.join('\n')
}

export function sessionTitleArgs(prompt: string): string[] {
  return headlessHaikuArgs(prompt, SESSION_TITLE_SYSTEM_PROMPT)
}

export type SessionTitleResult = { ok: true; value: string } | { ok: false; error: string }

/** Plain-text answer to one clean line: no quotes, prefix or full stop. */
export function parseSessionTitle(stdout: string): SessionTitleResult {
  let outer: { is_error?: boolean; result?: string }
  try {
    outer = JSON.parse(stdout.trim())
  } catch {
    return { ok: false, error: 'Claude gave an answer that could not be read.' }
  }
  if (outer.is_error)
    return { ok: false, error: clip(String(outer.result ?? 'Claude failed.'), 200) }
  const line =
    String(outer.result ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const title = line
    .replace(/^(title|suggested title)\s*:\s*/i, '')
    .replace(/^["'“‘*]+|["'”’*]+$/g, '')
    .replace(/\.$/, '')
    .trim()
  if (!title) return { ok: false, error: 'Claude gave no title.' }
  return { ok: true, value: clip(title, 80) }
}
