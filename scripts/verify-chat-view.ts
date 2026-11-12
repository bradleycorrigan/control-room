// The chat view's logic: the transcript as a conversation, the hook replies
// built from each kind of answer, and prompts clearing themselves when the
// terminal answers first.
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
  if (!ok) failed++
}

const root = mkdtempSync(join(tmpdir(), 'cr-chat-view-'))
mkdirSync(join(root, '-proj'))
const line = (o: object): string => JSON.stringify(o) + '\n'

async function main(): Promise<void> {
  process.env.CR_CLAUDE_PROJECTS_DIR = root
  const { parseChat } = await import('../src/main/exec/chatTranscript')
  const prompts = await import('../src/main/engine/prompts')

  // ---- The transcript as a conversation ----
  const chat = parseChat(
    [
      line({ type: 'user', message: { role: 'user', content: 'Fix the flicker.' } }),
      line({
        type: 'user',
        message: { role: 'user', content: '<command-name>/compact</command-name>' }
      }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: 'hidden' } }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } },
            {
              type: 'tool_use',
              id: 'b',
              name: 'Edit',
              input: { file_path: '/x/src/main/poller.ts', old_string: 'a', new_string: 'a\nb' }
            }
          ]
        }
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true },
            { type: 'tool_result', tool_use_id: 'b', content: 'ok' }
          ]
        }
      }),
      '{"type":"assistant", broken',
      line({ type: 'assistant', isSidechain: true, message: { content: 'subagent' } })
    ].join('')
  )
  const kinds = chat.map((e) => e.kind).join(',')
  check(
    'you, a slash command, Claude, two tools — meta and subagent lines left out',
    kinds === 'user,user,assistant,tool,tool',
    kinds
  )
  check(
    'a typed slash command shows as typed',
    chat[1]?.kind === 'user' && chat[1].text === '/compact',
    JSON.stringify(chat[1])
  )
  const bash = chat[3]
  const edit = chat[4]
  check(
    'a failed command is marked failed',
    bash?.kind === 'tool' && bash.label === 'Ran' && bash.detail === 'npm test' && bash.failed,
    JSON.stringify(bash)
  )
  check(
    'an edit shows its file and lines added and removed',
    edit?.kind === 'tool' &&
      edit.detail === 'src/main/poller.ts' &&
      edit.added === 2 &&
      edit.removed === 1 &&
      !edit.failed,
    JSON.stringify(edit)
  )

  // ---- Replies ----
  const ask = {
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        options: [{ label: 'Red' }, { label: 'Blue' }]
      }
    ]
  }
  const reply = (
    kind: 'permission' | 'plan' | 'question',
    input: object,
    answer: never,
    sugg: unknown[] = []
  ): string =>
    JSON.stringify(prompts.buildDecision(kind, input as Record<string, unknown>, sugg, answer))
  check(
    'Allow sends allow',
    reply('permission', {}, { kind: 'allow' } as never) ===
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  )
  const rule = {
    type: 'addRules',
    rules: [{ toolName: 'Bash' }],
    behavior: 'allow',
    destination: 'localSettings'
  }
  check(
    'Always allow adds Claude Code’s own suggested rule, and only that',
    reply('permission', {}, { kind: 'allowAlways' } as never, [
      rule,
      { type: 'setMode', mode: 'acceptEdits' }
    ]) ===
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedPermissions: [rule] }
        }
      })
  )
  check(
    'an answer goes back with the questions it answers',
    reply('question', ask, {
      kind: 'answers',
      answers: { 'Which colour?': 'Blue', 'Made up?': 'x' }
    } as never) ===
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: { ...ask, answers: { 'Which colour?': 'Blue' } }
          }
        }
      })
  )
  check(
    'approving a plan sends the plan back and switches the mode',
    reply('plan', { plan: '# P' }, { kind: 'approvePlan', mode: 'acceptEdits' } as never) ===
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: { plan: '# P' },
            updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
          }
        }
      })
  )
  check(
    'an answer that doesn’t fit the prompt sends nothing',
    prompts.buildDecision('permission', {}, [], { kind: 'answers', answers: { a: 'b' } }) ===
      null && prompts.buildDecision('question', ask, [], { kind: 'allow' }) === null
  )

  // ---- Held prompts ----
  const path = join(root, '-proj', 's1.jsonl')
  writeFileSync(
    path,
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'one', name: 'Bash', input: { command: 'touch a' } },
          { type: 'tool_use', id: 'two', name: 'Bash', input: { command: 'touch b' } }
        ]
      }
    })
  )
  const replies: Record<string, string> = {}
  const idA = prompts.holdPrompt(
    {
      session_id: 's1',
      transcript_path: path,
      tool_name: 'Bash',
      tool_input: { command: 'touch a' }
    },
    (b) => (replies.a = b)
  )
  const idB = prompts.holdPrompt(
    {
      session_id: 's1',
      transcript_path: path,
      tool_name: 'Bash',
      tool_input: { command: 'touch b' }
    },
    (b) => (replies.b = b)
  )
  check(
    'two prompts are held',
    prompts.listPrompts().length === 2,
    `${prompts.listPrompts().length}`
  )
  appendFileSync(
    path,
    line({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: '' }] }
    })
  )
  prompts.sweepAnsweredPrompts()
  check(
    'the terminal answering one prompt clears that one, not the other',
    replies.a === '{}' &&
      replies.b === undefined &&
      prompts
        .listPrompts()
        .map((p) => p.id)
        .join() === idB,
    JSON.stringify({ replies, left: prompts.listPrompts().map((p) => p.id), idA })
  )
  const r = prompts.answerPrompt(idB, { kind: 'deny', message: 'not that one' })
  check(
    'answering in the app replies once and clears it',
    r.ok &&
      JSON.parse(replies.b).hookSpecificOutput.decision.behavior === 'deny' &&
      prompts.listPrompts().length === 0,
    JSON.stringify({ r, replies })
  )
  check(
    'a second answer to the same prompt is refused',
    !prompts.answerPrompt(idB, { kind: 'allow' }).ok
  )

  rmSync(root, { recursive: true, force: true })
  if (failed) {
    console.log(`${failed} failed`)
    process.exit(1)
  }
}

void main()
