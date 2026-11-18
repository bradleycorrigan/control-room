// Forking from one of Claude's replies: the copy of the conversation ends at
// that reply, under a new id, next to the original, which is left alone.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
  if (!ok) failed++
}

async function main(): Promise<void> {
  const { cutTranscript, removeCut } = await import('../src/main/exec/forkTranscript')
  const dir = mkdtempSync(join(tmpdir(), 'cr-fork-transcript-'))
  const sid = 'aaaaaaaa-0000-4000-8000-000000000000'
  const u = (n: number): string => `bbbbbbbb-0000-4000-8000-00000000000${n}`
  const lines = [
    { type: 'session-owner', sessionId: sid },
    { type: 'user', uuid: u(1), parentUuid: null, sessionId: sid, message: { content: 'APPLE?' } },
    {
      type: 'assistant',
      uuid: u(2),
      parentUuid: u(1),
      sessionId: sid,
      message: { content: [{ type: 'text', text: 'APPLE' }] }
    },
    { type: 'last-prompt', sessionId: sid },
    { type: 'user', uuid: u(3), parentUuid: u(2), sessionId: sid, message: { content: 'BANANA?' } },
    {
      type: 'assistant',
      uuid: u(4),
      parentUuid: u(3),
      sessionId: sid,
      message: { content: [{ type: 'text', text: 'BANANA' }] }
    }
  ]
  const source = join(dir, `${sid}.jsonl`)
  const original = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  writeFileSync(source, original)

  const cut = cutTranscript(source, u(2))
  check('cuts at a reply', cut.ok, cut.ok ? '' : cut.error)
  if (cut.ok) {
    const kept = readFileSync(cut.path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    check('next to the original', dirname(cut.path) === dir, cut.path)
    check('named by its new id', cut.path.endsWith(`${cut.claudeSessionId}.jsonl`), cut.path)
    check('a new id', cut.claudeSessionId !== sid)
    check('ends at that reply', kept[kept.length - 1].uuid === u(2), JSON.stringify(kept.at(-1)))
    check('nothing after it', !kept.some((l) => l.uuid === u(3) || l.uuid === u(4)))
    check(
      'every line carries the new id',
      kept.every((l) => l.sessionId === cut.claudeSessionId)
    )
    removeCut(cut.path)
    check('removed', !existsSync(cut.path))
  }
  check('original untouched', readFileSync(source, 'utf8') === original)

  const missing = cutTranscript(source, 'cccccccc-0000-4000-8000-000000000000')
  check('refuses a message not in it', !missing.ok)

  rmSync(dir, { recursive: true, force: true })
  if (failed) process.exit(1)
}

void main()
