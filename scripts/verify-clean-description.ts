// Checks cleanDescription (src/renderer/src/screens/backlog/ticketSessions.ts):
// the cleaner that keeps encoded blobs out of a session prompt seeded from a
// Jira ticket.
//
// Run: npm run verify:clean-description

import { cleanDescription } from '../src/renderer/src/screens/backlog/ticketSessions'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` ${detail}`}`)
}

const blob = Buffer.from('x'.repeat(4000)).toString('base64')

let out = cleanDescription(`Fix the card.\n\n${blob}\n\nThen redeploy.`)
check('base64 blob dropped', !out.includes(blob.slice(0, 50)), out.slice(0, 80))
check('prose around blob kept', out === 'Fix the card.\n\nThen redeploy.', JSON.stringify(out))

out = cleanDescription(`See ![chart](data:image/png;base64,${blob.slice(0, 300)}) here`)
check(
  'data: URI dropped',
  !out.includes('data:') && out.includes('See') && out.includes('here'),
  out
)

out = cleanDescription('Look at !screenshot.png|width=300! and [^report.pdf] now')
check('wiki image and attachment dropped', !out.includes('!') && !out.includes('[^'), out)

const url =
  'https://example.atlassian.net/browse/ABC-123?focusedCommentId=1234567890&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel'
out = cleanDescription(`Context: ${url}`)
check('normal URL kept', out.includes(url), out)

const code = 'const x = fetch("/api/v1/items")\nif (x) {\n  return x.json()\n}'
out = cleanDescription(`Try:\n\n${code}\n\nDone.`)
check('code kept', out.includes(code), out)

const para = 'This is a normal paragraph about the wallet ledger. '.repeat(10).trim()
const long = Array.from({ length: 40 }, () => para).join('\n\n')
out = cleanDescription(long)
check('long description capped', out.length < 4200 && out.length > 3000, String(out.length))
check('cap note appended', out.endsWith('(Description shortened: read the ticket for the rest.)'))
check(
  'cut at paragraph',
  out
    .split('\n\n')
    .slice(0, -1)
    .every((p) => p === para)
)
check('short description untouched', cleanDescription('Short.\n\nText.') === 'Short.\n\nText.')

const prose = 'Post this on social media\nUpdate the media\n\n[mediaSingle]\n\nDone.'
out = cleanDescription(prose)
check(
  'prose ending in media kept, placeholder line dropped',
  out === 'Post this on social media\nUpdate the media\n\nDone.',
  JSON.stringify(out)
)

if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All checks passed')
