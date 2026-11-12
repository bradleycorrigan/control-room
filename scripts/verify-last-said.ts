// What a Sessions row or card shows as "what Claude last said": the text of
// its latest reply, read from the transcript's tail, flattened to one line.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
  if (!ok) failed++
}

const root = mkdtempSync(join(tmpdir(), 'cr-last-said-'))
mkdirSync(join(root, '-some-project'))
const write = (id: string, lines: object[]): void =>
  writeFileSync(
    join(root, '-some-project', `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
const said = (...content: object[]): object => ({
  type: 'assistant',
  message: { role: 'assistant', content }
})
const text = (t: string): object => ({ type: 'text', text: t })
const tool = { type: 'tool_use', id: 't1', name: 'Bash', input: {} }

async function main(): Promise<void> {
  // Read once at import, so it has to be set first.
  process.env.CR_CLAUDE_PROJECTS_DIR = root
  const { plainOneLine } = await import('../src/main/exec/transcripts')
  const { lastAssistantLine: lastAssistantText } = await import('../src/main/exec/handoffNote')

  check(
    'markdown comes down to its words, headings as sentences',
    plainOneLine('## Done\n\nThe **tests** pass. See [the PR](https://x.y) and `a.ts`.\n- one') ===
      'Done. The tests pass. See the PR and a.ts. one',
    plainOneLine('## Done\n\nThe **tests** pass. See [the PR](https://x.y) and `a.ts`.\n- one')
  )

  write('a', [said(text('First answer.')), { type: 'user' }, said(text('Latest answer.'))])
  check(
    'the latest reply wins',
    lastAssistantText('a') === 'Latest answer.',
    `${lastAssistantText('a')}`
  )

  write('b', [said(text('What it told you.')), said(tool)])
  check(
    'a reply that is only a tool call is skipped',
    lastAssistantText('b') === 'What it told you.',
    `${lastAssistantText('b')}`
  )

  write('c', [said(text('x'.repeat(400)))])
  const long = lastAssistantText('c') ?? ''
  check(
    'a long reply is cut with an ellipsis',
    long.length === 280 && long.endsWith('…'),
    `${long.length}`
  )

  check('no transcript, nothing said', lastAssistantText('missing') === null)

  // The cache must notice a new reply.
  write('a', [said(text('Latest answer.')), said(text('A newer one, longer than before.'))])
  check(
    'a new reply replaces the cached one',
    lastAssistantText('a') === 'A newer one, longer than before.',
    `${lastAssistantText('a')}`
  )
}

main()
  .catch((e) => {
    console.log(`FAIL  last-said check crashed (${e})`)
    failed++
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true })
    if (failed > 0) process.exit(1)
  })
