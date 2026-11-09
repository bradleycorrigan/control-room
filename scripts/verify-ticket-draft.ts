// Checks the ticket-draft helpers (src/main/exec/ticketDraft.ts): the prompt
// carries the session, the answer keeps only the board's own values, and the
// headless run stays quiet (no tools, hooks or saved session).
//
// Run: npx tsx scripts/verify-ticket-draft.ts

import {
  buildTicketDraftPrompt,
  parseTicketDraft,
  sanitiseChoices,
  ticketDraftArgs,
  type TicketDraftChoices
} from '../src/main/exec/ticketDraft'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` ${detail}`}`)
}

const choices: TicketDraftChoices = {
  epics: [{ key: 'TEAM-60', summary: 'Partner dashboards' }],
  labels: ['data-ask', 'bug'],
  priorities: ['High', 'Medium', 'Low']
}

const prompt = buildTicketDraftPrompt(
  {
    title: 'Fix UTM attribution',
    projectName: 'example-repo',
    branch: 'fix/utms',
    prompts: [
      'first ask',
      ...Array.from({ length: 40 }, (_, i) => `later ask ${i} ${'x'.repeat(800)}`)
    ],
    lastReply: 'Opened PR #7.',
    pullRequests: [{ url: 'https://github.com/o/r/pull/7', title: 'Fix UTMs' }],
    commits: ['fix: read utms off track events']
  },
  choices
)
check(
  'the prompt carries the title, asks, reply, PR, commit and epics',
  [
    'Session title: Fix UTM attribution',
    'first ask',
    'later ask 39',
    'Opened PR #7.',
    'https://github.com/o/r/pull/7 (Fix UTMs)',
    'fix: read utms off track events',
    'TEAM-60: Partner dashboards'
  ].every((s) => prompt.includes(s))
)
check(
  'a long session keeps its first and latest asks, and drops the middle',
  prompt.includes('earlier messages left out') &&
    !prompt.includes('later ask 3 ') &&
    prompt.length < 20_000,
  `${prompt.length} chars`
)

const answer = (o: object): string =>
  JSON.stringify({ type: 'result', is_error: false, structured_output: o })
const parsed = parseTicketDraft(
  answer({
    summary: '  Fix   UTMs ',
    description: 'h4. Context',
    priority: 'Urgent',
    epicKey: 'NOPE-1',
    labels: ['data-ask', 'invented', 'data-ask']
  }),
  choices
)
check(
  "the answer keeps only the board's values: unknown priority, epic and label dropped",
  parsed.ok &&
    parsed.value.summary === 'Fix UTMs' &&
    parsed.value.priority === null &&
    parsed.value.epicKey === null &&
    parsed.value.labels.join() === 'data-ask',
  JSON.stringify(parsed)
)
const good = parseTicketDraft(
  answer({ summary: 'A', description: '', priority: 'High', epicKey: 'TEAM-60', labels: [] }),
  choices
)
check(
  'a valid priority and epic come through',
  good.ok && good.value.priority === 'High' && good.value.epicKey === 'TEAM-60',
  JSON.stringify(good)
)
check(
  'an error or unreadable answer is a failure, not a blank ticket',
  !parseTicketDraft('not json', choices).ok &&
    !parseTicketDraft(JSON.stringify({ is_error: true, result: 'Not logged in' }), choices).ok &&
    !parseTicketDraft(answer({ summary: '' }), choices).ok
)
check(
  'board values from the renderer are checked: a bad epic key is dropped',
  sanitiseChoices({ epics: [{ key: 'rm -rf', summary: 'x' }, choices.epics[0]], labels: [1, 'a'] })
    .epics.length === 1 && sanitiseChoices({ labels: [1, 'a'] }).labels.join() === 'a'
)
const args = ticketDraftArgs('p', choices)
const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1]
check(
  'the run is Haiku with no tools, MCP, settings (hooks) or saved session',
  after('--model') === 'haiku' &&
    after('--tools') === '' &&
    after('--setting-sources') === '' &&
    args.includes('--strict-mcp-config') &&
    args.includes('--no-session-persistence'),
  args.join(' ')
)

if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
