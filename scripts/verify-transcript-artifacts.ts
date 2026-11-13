// The artifacts a session made, for its header: a page it published, and one
// made from a type (a sheet, a deck), whose create call names the type and
// whose result gives the new artifact's link before the type's.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
  if (!ok) failed++
}

const root = mkdtempSync(join(tmpdir(), 'cr-artifacts-'))
mkdirSync(join(root, '-proj'))
const call = (id: string, input: object): object => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'Artifact', input }] }
})
const result = (id: string, text: string): object => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
})
const TYPE = 'https://claude.ai/artifact/TypeSheetsAAAA'
const SHEET = 'https://claude.ai/artifact/SheetOneBBBBBB'
const PAGE = 'https://claude.ai/code/artifact/0f1e2d3c-page'

async function main(): Promise<void> {
  process.env.CR_CLAUDE_PROJECTS_DIR = root
  writeFileSync(
    join(root, '-proj', 's.jsonl'),
    [
      call('t1', { action: 'publish', type_url: TYPE, title: 'Customer Groups' }),
      result(
        't1',
        `Created a new Artifact at ${SHEET} (version 1) from the Artifact type ${TYPE}.`
      ),
      call('t2', { url: SHEET, file_path: '/nowhere/project/rows.json' }),
      result('t2', `Updated the Artifact at ${SHEET} (Version 2).`),
      call('t3', { file_path: '/nowhere/report.html', title: 'Funnel report' }),
      result('t3', `Published: ${PAGE}`),
      call('t4', { action: 'publish', url: SHEET, asset: true, file_path: '/nowhere/logo.png' }),
      result('t4', `Uploaded to ${SHEET}`)
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  )
  const { listTranscriptArtifacts } = await import('../src/main/exec/transcripts')
  const found = listTranscriptArtifacts('s')
  const got = JSON.stringify(found)
  check(
    'a sheet made from a type is listed, by its own link, not the type’s',
    found.some((a) => a.url === SHEET) && !found.some((a) => a.url === TYPE),
    got
  )
  check(
    'it keeps the name it was made with when its data is published into it',
    found.find((a) => a.url === SHEET)?.title === 'Customer Groups',
    got
  )
  check(
    'a page is listed as before, and an asset upload adds nothing',
    found.length === 2 && found.some((a) => a.url === PAGE && a.title === 'Funnel report'),
    got
  )
  rmSync(root, { recursive: true, force: true })
  if (failed) {
    console.log(`${failed} failed`)
    process.exit(1)
  }
}

void main()
