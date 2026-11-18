import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type CutResult =
  { ok: true; claudeSessionId: string; path: string } | { ok: false; error: string }

/**
 * A copy of a conversation that ends at one of Claude's messages, to fork
 * from that point. Claude Code has a flag for this (`--resume-session-at`),
 * but it only works with `--print`: an interactive resume ignores it and
 * keeps the whole conversation. So the copy is written by hand, next to the
 * original, under a new id; `--fork-session` then reads it like any other
 * conversation. Everything after `atUuid` is left out. The copy is only a
 * stepping stone: delete it (removeCut) once the fork has started.
 */
export function cutTranscript(sourcePath: string, atUuid: string): CutResult {
  let text: string
  try {
    text = readFileSync(sourcePath, 'utf8')
  } catch (err) {
    return { ok: false, error: `could not read the conversation: ${String(err)}` }
  }
  const id = randomUUID()
  const kept: string[] = []
  let found = false
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry.sessionId === 'string') entry.sessionId = id
    kept.push(JSON.stringify(entry))
    if (entry.uuid === atUuid) {
      found = true
      break
    }
  }
  if (!found) return { ok: false, error: 'that message is no longer in the conversation' }
  const path = join(dirname(sourcePath), `${id}.jsonl`)
  try {
    writeFileSync(path, kept.join('\n') + '\n')
  } catch (err) {
    return { ok: false, error: `could not write the copy: ${String(err)}` }
  }
  return { ok: true, claudeSessionId: id, path }
}

export function removeCut(path: string): void {
  rmSync(path, { force: true })
}
