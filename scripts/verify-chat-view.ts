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

  // ---- How a command reads ----
  const { describeTool, withoutCd } = await import('../src/main/exec/chatTranscript')
  const described = describeTool('Bash', {
    command: 'cd /x && npm test',
    description: 'Run the tests'
  })
  check(
    'a command with a description shows just that, and keeps the command for opening',
    described.label === '' &&
      described.detail === 'Run the tests' &&
      described.full === 'cd /x && npm test',
    JSON.stringify(described)
  )
  const bare = describeTool('Bash', { command: "cd '/a b' && cd sub; git status" })
  check(
    'without one, the leading cd steps go, so the part that differs shows',
    bare.label === 'Ran' &&
      bare.detail === 'git status' &&
      withoutCd('git status') === 'git status',
    JSON.stringify(bare)
  )
  check(
    'a command with nothing to add has no second line',
    describeTool('Bash', { command: 'ls' }).full === '',
    JSON.stringify(describeTool('Bash', { command: 'ls' }))
  )

  // ---- Claude Code's working line ----
  const { parseActivity } = await import('../src/main/exec/chatTranscript')
  const act = parseActivity(
    'output\n\x1b[38;5;174m✻\x1b[0m Blanching… (1m 22s · ↓ 3.1k tokens · esc to interrupt)\n\n────\n> \n'
  )
  check(
    'Claude Code’s working line gives its word and time',
    act?.verb === 'Blanching…' && act.elapsed === '1m 22s',
    JSON.stringify(act)
  )
  check(
    'a screen without one gives nothing',
    parseActivity('$ ls\nREADME.md\n> hello\n') === null,
    JSON.stringify(parseActivity('$ ls\nREADME.md\n> hello\n'))
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

  // ---- Reading a growing transcript ----
  const { readChat, readChatImage } = await import('../src/main/exec/chatTranscript')
  const grow = join(root, '-proj', 'grow.jsonl')
  writeFileSync(
    grow,
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'First.' } })
  )
  const r1 = readChat('grow')
  check(
    'a transcript reads with a version',
    r1?.entries?.length === 1 && !!r1.version,
    JSON.stringify(r1)
  )
  const r2 = readChat('grow', r1?.version)
  check(
    'asked again unchanged, it sends no entries',
    r2?.version === r1?.version && r2?.entries === undefined,
    JSON.stringify(r2)
  )
  const png = 'iVBORw0KGgo='
  appendFileSync(
    grow,
    line({
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
        ]
      }
    }) + '{"type":"assistant","message":{"content":"half'
  )
  const r3 = readChat('grow', r1?.version)
  const u2 = r3?.entries?.[1]
  check(
    'new lines are added to what was read; a half-written line waits',
    r3?.entries?.length === 2 &&
      u2?.kind === 'user' &&
      u2.text === 'Look at this.' &&
      u2.images.length === 1,
    JSON.stringify(r3?.entries)
  )
  check(
    'a pasted image comes back by its key, as a data URL',
    u2?.kind === 'user' && readChatImage('grow', u2.images[0]) === `data:image/png;base64,${png}`
  )
  appendFileSync(grow, ' done"}}\n')
  const r4 = readChat('grow', r3?.version)
  check(
    'the rest of a half-written line completes it',
    r4?.entries?.length === 3 &&
      r4.entries[2].kind === 'assistant' &&
      (r4.entries[2] as { text: string }).text === 'half done',
    JSON.stringify(r4?.entries?.[2])
  )

  rmSync(root, { recursive: true, force: true })
  if (failed) {
    console.log(`${failed} failed`)
    process.exit(1)
  }
}

void main()
