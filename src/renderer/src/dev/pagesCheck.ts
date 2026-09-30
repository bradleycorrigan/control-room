// Dev-only page checks, run by `npm run gate` alongside the tab checks: each
// screen that has grown behaviour gets driven with real input and asserted
// on, one PASS/FAIL line per behaviour. Uses the fixture sessions and the
// CR_JIRA_FIXTURE sample issues. Only ever registered as a shot screen.

import { parseEstimateHours, workingDays } from '../screens/backlog/cyclePlan'

type Api = { invoke: <T>(channel: string, ...args: unknown[]) => Promise<T> }
const api = (window as unknown as { api: Api }).api

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (message: string): Promise<void> => api.invoke('dev:log', message)
const input = (event: Record<string, unknown>): Promise<void> => api.invoke('dev:input', event)
type Modifier = 'meta' | 'shift' | 'alt' | 'control'

async function click(el: Element | null | undefined, modifiers: Modifier[] = []): Promise<boolean> {
  if (!el) return false
  // Real input lands where the pointer is: bring the target on screen first
  // (a tall panel puts its lower controls below the fold).
  el.scrollIntoView({ block: 'center', inline: 'center' })
  await wait(100)
  const r = el.getBoundingClientRect()
  // Past the leading controls a wide row starts with (the pick check, then
  // priority), onto its key and title; the middle of anything narrower.
  const x = Math.round(r.left + Math.min(r.width / 2, 120))
  const y = Math.round(r.top + r.height / 2)
  await input({ type: 'mouseMove', x, y, modifiers })
  await input({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers })
  await input({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers })
  await wait(300)
  return true
}

/**
 * Buttons inside `root` whose label doesn't fit them: wider or taller than
 * their own box. Returns their labels, so a failure names them.
 */
function spills(root: Element | null): string[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>('button, .cr-button')]
    .filter((b) => b.offsetParent !== null)
    .filter((b) => b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1)
    .map((b) => (b.textContent ?? b.getAttribute('aria-label') ?? '').trim())
}

async function key(keyCode: string, modifiers: Modifier[] = []): Promise<void> {
  await input({ type: 'keyDown', keyCode, modifiers })
  await input({ type: 'keyUp', keyCode, modifiers })
  await wait(300)
}

async function typeText(text: string): Promise<void> {
  for (const ch of text) {
    await input({ type: 'keyDown', keyCode: ch })
    await input({ type: 'char', keyCode: ch })
    await input({ type: 'keyUp', keyCode: ch })
  }
  await wait(400)
}

/** Polls until `cond` holds (or the time runs out) — for UI that settles on its own clock. */
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await wait(100)
  }
  return cond()
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...document.querySelectorAll<T>(sel)
]
const byText = (sel: string, text: string): HTMLElement | undefined =>
  $$<HTMLElement>(sel).find((el) => el.textContent?.trim().startsWith(text))

export interface PagesCheckContext {
  goTo: (view: 'home' | 'sessions' | 'backlog' | 'settings') => Promise<void>
  openFirstSession: () => Promise<void>
  /** Reload the session list, as the app does after its own rename. */
  refreshSessions: () => Promise<void>
}

export async function runPagesCheck(ctx: PagesCheckContext): Promise<void> {
  let passed = 0
  let failed = 0
  const check = async (name: string, ok: boolean, detail = ''): Promise<void> => {
    if (ok) passed++
    else failed++
    await log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  // Focus and blur events only fire in the frontmost window; a run behind
  // another app used to "fail" whatever relied on them.
  await api.invoke('dev:window', 'restore')

  // Session ↔ ticket links persist on disk; a run cut short leaves its own
  // behind. Start clean.
  {
    const links = await api.invoke<Record<string, string>>('jira:links')
    for (const id of Object.keys(links)) await api.invoke('jira:link', id, null)
  }

  // ---- Backlog ------------------------------------------------------------
  // A session whose title carries a ticket key: DSD-102 should show it.
  await api.invoke(
    'sessions:rename',
    'fixture-rec-waiting',
    'DSD-102 Review the donations model tests'
  )
  await ctx.refreshSessions()
  await wait(600)
  await ctx.goTo('home')
  await wait(400)
  await click(byText('.app-titlebar-no-drag .cr-segmented__option', 'Backlog'))
  await wait(900)
  // Views and filters are remembered between runs: start from the list, unfiltered.
  await click($('[aria-label="List view"]'))
  await click(byText('.backlog-filter', 'Everyone'))
  // Hide done is the one filter that's remembered.
  if ($('[data-filter-chip="done"] button')) await click($('[data-filter-chip="done"] button'))
  const rows = (): HTMLElement[] => $$('.backlog-row')
  const row = (key: string): HTMLElement | undefined => rows().find((r) => r.dataset.issue === key)
  const setSelect = (el: HTMLSelectElement | null, value: string): void => {
    if (!el) return
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const setText = (el: HTMLTextAreaElement | HTMLInputElement | null, value: string): void => {
    if (!el) return
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  // Group: one menu, up to two picks in order.
  const groupBy = async (...want: string[]): Promise<void> => {
    await click($('.backlog-menu-button[aria-label^="Display"]'))
    const items = (): HTMLElement[] => $$('.backlog-display-menu [role="menuitemcheckbox"]')
    const name = (el: HTMLElement): string => (el.textContent ?? '').replace(/\d/g, '').trim()
    const item = (n: string): HTMLElement | undefined => items().find((el) => name(el) === n)
    const isOn = (n: string): boolean => item(n)?.getAttribute('aria-checked') === 'true'
    if (!isOn(want[0])) await click(item(want[0]))
    for (const el of items()) {
      if (name(el) !== want[0] && el.getAttribute('aria-checked') === 'true') await click(el)
    }
    if (want[1]) await click(item(want[1]))
    await key('Escape')
  }
  // Cycle lives in the Filter menu now.
  const cycleFilter = async (option: string): Promise<void> => {
    await click($('.backlog-menu-button[aria-label^="Filter"]'))
    await click(byText('.backlog-filter-menu [role="menuitemradio"]', option))
    await key('Escape')
  }

  await cycleFilter('All open')
  await groupBy('Status')
  await check('Backlog lists every ticket, not epics', rows().length === 5, `${rows().length} rows`)
  await click(byText('.backlog-filter', 'Mine'))
  await check('Mine shows only yours', rows().length === 3, `${rows().length}`)
  await click(byText('.backlog-filter', 'Unassigned'))
  await check('Unassigned shows only unassigned', rows().length === 1, `${rows().length}`)
  await click(byText('.backlog-filter', 'Everyone'))
  await check('Everyone shows them all again', rows().length === 5, `${rows().length}`)

  await cycleFilter('Current cycle (honey-buzzard)')
  await check('the cycle filter shows the current cycle', rows().length === 3, `${rows().length}`)
  await cycleFilter('Backlog only')
  // One of the other two is in the upcoming cycle, so it isn't backlog.
  await check('Backlog shows tickets in no cycle', rows().length === 1, `${rows().length}`)
  await cycleFilter('All open')
  // Status filter: leave a column out, and put it back
  await click($('.backlog-menu-button[aria-label^="Filter"]'))
  await click(byText('.backlog-filter-menu [role="menuitemcheckbox"]', 'Blocked'))
  await key('Escape')
  await check(
    'the status filter leaves a column out',
    rows().length === 4 &&
      !row('TEAMDATA-201') &&
      /1 active/.test(
        $('.backlog-menu-button[aria-label^="Filter"]')?.getAttribute('aria-label') ?? ''
      ),
    `${rows().length} rows`
  )
  await check(
    'and says so in a chip under the tabs',
    /not Blocked/.test($('[data-filter-chip="status"]')?.textContent ?? ''),
    $('.backlog-filter-bar')?.textContent ?? 'no filter bar'
  )
  await click($('.backlog-menu-button[aria-label^="Filter"]'))
  await click(byText('.backlog-filter-menu button', 'Hide done'))
  await check(
    'Hide done leaves out the done column too',
    $$(
      '.backlog-filter-menu [role="menuitemcheckbox"][aria-checked="false"]:not(.backlog-filter-people *)'
    ).length === 2
  )
  await click(byText('.backlog-filter-menu button', 'Clear filters'))
  await key('Escape')
  await check('Clear filters brings everything back', rows().length === 5, `${rows().length}`)
  await check('and the filter bar goes', !$('.backlog-filter-bar'))

  // A search that the tab hides says where the rest are.
  await click(byText('.backlog-filter', 'Mine'))
  await click($('input[aria-label="Search tickets"]'))
  await typeText('runbook')
  await check(
    'a search the tab hides offers to show what it hides',
    rows().length === 0 && Boolean(byText('button', 'Show 1 outside this tab'))
  )
  await click(byText('button', 'Show 1 outside this tab'))
  await check(
    'and showing it lands on Everyone with the ticket',
    Boolean(row('TEAMDATA-202')) &&
      $('.backlog-filter-tabs [aria-checked="true"]')?.textContent?.startsWith('Everyone') === true
  )
  await click($('input[aria-label="Search tickets"]'))
  await key('Escape')

  // Filters last while you're here; leave the Backlog and they're gone.
  await cycleFilter('Backlog only')
  await ctx.goTo('home')
  await wait(300)
  await click(byText('.app-titlebar-no-drag .cr-segmented__option', 'Backlog'))
  await wait(900)
  await check(
    'leaving the Backlog clears its filters',
    !$('.backlog-filter-bar') && rows().length === 5,
    `${rows().length} rows; ${$('.backlog-filter-bar')?.textContent ?? 'no bar'}`
  )
  await click($('.backlog-menu-button[aria-label^="Filter"]'))
  await click(
    $$('.backlog-filter-people [role="menuitemcheckbox"]').find((el) =>
      (el.textContent ?? '').includes('Someone Else')
    )
  )
  await key('Escape')
  await check(
    'Filter → Assignee narrows to the people picked',
    rows().length === 1 && Boolean(row('DSD-103')),
    `${rows().length} rows`
  )
  await click($('.backlog-menu-button[aria-label^="Filter"]'))
  await click(byText('.backlog-filter-menu button', 'Clear filters'))
  await key('Escape')

  await check(
    'values sit in pills: the epic, priority, estimate',
    Boolean(row('DSD-101')?.querySelector('.backlog-pill--accent')) &&
      Boolean(row('DSD-101')?.querySelector('[aria-label="High priority"]')) &&
      [...(row('DSD-101')?.querySelectorAll<HTMLElement>('.backlog-pill') ?? [])].some(
        (p) => p.textContent === '4h'
      ),
    [...(row('DSD-101')?.querySelectorAll<HTMLElement>('.backlog-pill') ?? [])]
      .map((p) => p.textContent)
      .join(' | ')
  )

  // Every value on a row edits in place.
  await click(row('DSD-101')?.querySelector('[aria-label^="Epic:"]'))
  await click(byText('.backlog-picker .cr-popover-item', 'Internal reporting'))
  await wait(300)
  await check(
    "clicking a row's epic changes it",
    /Internal reporting/.test(
      row('DSD-101')?.querySelector('[aria-label^="Epic:"]')?.textContent ?? ''
    )
  )
  await click(row('DSD-101')?.querySelector('[aria-label^="Epic:"]'))
  await click(byText('.backlog-picker .cr-popover-item', 'Partner dashboards'))
  await wait(300)
  await click(row('DSD-101')?.querySelector('[aria-label^="Estimate:"]'))
  await typeText('3h')
  await key('Enter')
  await wait(300)
  await check(
    'and its estimate takes a typed value',
    row('DSD-101')?.querySelector('[aria-label^="Estimate:"]')?.textContent === '3h',
    row('DSD-101')?.querySelector('[aria-label^="Estimate:"]')?.textContent ?? 'none'
  )
  await click(row('TEAMDATA-202')?.querySelector('[aria-label^="Assignee:"]'))
  await click(byText('.backlog-picker .cr-popover-item', 'Assign to me'))
  await wait(300)
  await check('and its assignee', !row('TEAMDATA-202')?.querySelector('[aria-label="Unassigned"]'))
  await click(row('TEAMDATA-202')?.querySelector('[aria-label^="Assignee:"]'))
  await click(byText('.backlog-picker .cr-popover-item', 'Unassign'))
  await wait(300)

  await groupBy('Epic')
  const epicTitles = $$('.backlog-group-title').map((g) => g.textContent ?? '')
  await check(
    'grouping by epic shows each epic, then No epic',
    epicTitles.some((t) => t.includes('Internal reporting')) &&
      /No epic/.test(epicTitles[epicTitles.length - 1] ?? ''),
    epicTitles.join(' / ')
  )
  await groupBy('Epic', 'Status')
  const sub = (epic: string, status: string): HTMLElement | null =>
    $(`.backlog-group[data-lane="${epic}"] .backlog-subgroup[data-lane="${status}"]`)
  await check(
    'epics can be sub-grouped by status',
    Boolean(sub('TEAMDATA-50', 'In Review')?.querySelector('[data-issue="DSD-102"]')) &&
      Boolean(
        sub('TEAMDATA-50', 'Backlog/Not started')?.querySelector('[data-issue="TEAMDATA-202"]')
      )
  )
  {
    const data = new DataTransfer()
    row('TEAMDATA-202')?.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data })
    )
    await wait(200)
    const target = sub('TEAMDATA-60', 'In Progress')
    target?.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    target?.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    row('TEAMDATA-202')?.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer: data })
    )
    await wait(500)
  }

  await check(
    'dropping into a sub-group sets both its epic and its status',
    Boolean(sub('TEAMDATA-60', 'In Progress')?.querySelector('[data-issue="TEAMDATA-202"]'))
  )
  await check(
    'after a drop, the empty drop-targets go away again',
    !byText('.backlog-empty-lane', 'Drop here'),
    `${$$('.backlog-empty-lane').length} drop targets still showing`
  )
  await groupBy('Status', 'Epic')
  await click($('.backlog-menu-button[aria-label^="Display"]'))
  await click($('.backlog-display-menu [aria-label^="Swap order"]'))
  await key('Escape')
  await check(
    'Swap order flips status-then-epic to epic-then-status',
    Boolean(sub('TEAMDATA-50', 'In Review')),
    $('.backlog-menu-button[aria-label^="Display"]')?.getAttribute('aria-label') ?? ''
  )
  await click($('[aria-label="Collapse Partner dashboards"]'))
  await check(
    'a group can be collapsed',
    !$('.backlog-group[data-lane="TEAMDATA-60"] [data-issue="DSD-101"]')
  )
  await click($('[aria-label="Expand Partner dashboards"]'))
  await click(
    sub('TEAMDATA-50', 'In Review')?.querySelector('[aria-label="Collapse In Review"]') ?? null
  )
  await check(
    'a status inside an epic can be collapsed on its own',
    !sub('TEAMDATA-50', 'In Review')?.querySelector('[data-issue="DSD-102"]') &&
      Boolean(sub('TEAMDATA-50', 'In Review')?.querySelector('.backlog-subgroup-title'))
  )
  await click(
    sub('TEAMDATA-50', 'In Review')?.querySelector('[aria-label="Expand In Review"]') ?? null
  )
  await groupBy('Status')

  await check(
    'a ticket with a Slack thread has Open in Slack',
    Boolean(row('DSD-101')?.querySelector('[aria-label="Open in Slack"]')) &&
      !row('DSD-103')?.querySelector('[aria-label="Open in Slack"]')
  )
  await check(
    "a ticket in a session says so, with that session's status",
    Boolean(row('DSD-102')?.classList.contains('backlog-row--in-session')) &&
      /needs an answer/.test(
        row('DSD-102')?.querySelector('.backlog-session-chip')?.textContent ?? ''
      ),
    row('DSD-102')?.querySelector('.backlog-session-chip')?.textContent ?? 'no chip'
  )
  await check(
    "a ticket's session shows its branch or pull request",
    await until(() =>
      Boolean(row('DSD-102')?.querySelector('[aria-label^="Branch"], [aria-label^="Pull request"]'))
    )
  )
  await check(
    'a pull request Jira knows about shows on the row',
    await until(() => Boolean(row('DSD-102')?.querySelector('[aria-label="Pull request (open)"]')))
  )
  await check(
    'tickets without a session offer Start session',
    Boolean(row('DSD-101')?.querySelector('[aria-label="Start session"]'))
  )

  await check(
    'rows show status as a glyph, and Slack as its own mono mark',
    Boolean(row('DSD-101')?.querySelector('svg[aria-label="In Progress"]')) &&
      Boolean(row('DSD-101')?.querySelector('[aria-label="Open in Slack"] svg path'))
  )

  // Search, and "/" to get there
  await click($('.backlog-title'))
  await key('/')
  await check(
    '"/" jumps to search',
    document.activeElement === $('input[aria-label="Search tickets"]')
  )
  await typeText('freshness')
  await check(
    'search narrows the list',
    rows().length === 1 && Boolean(row('DSD-103')),
    rows()
      .map((r) => r.dataset.issue)
      .join(', ')
  )
  await key('Escape')
  await check('Escape clears search', rows().length === 5, `${rows().length}`)

  // J / K walk the list; Enter opens; the panel follows J
  await click($('.backlog-title'))
  await key('j')
  const firstKey = (document.activeElement as HTMLElement | null)?.dataset?.issue
  await check(
    'J focuses the first ticket',
    firstKey === rows()[0]?.dataset.issue,
    firstKey ?? 'none'
  )
  await key('Enter')
  await until(() => Boolean($('.backlog-drawer')))
  await check(
    'Enter opens it',
    ($('.backlog-drawer')?.getAttribute('aria-label') ?? '').startsWith(firstKey ?? '?')
  )
  const secondKey = rows()[1]?.dataset.issue ?? '?'
  row(firstKey ?? '')?.focus()
  await wait(300)
  await key('j')
  await wait(500)
  row('DSD-102')?.focus()
  await wait(500)
  row(secondKey)?.focus()
  await check(
    'with the panel open, J moves it to the next ticket',
    await until(
      () => ($('.backlog-drawer')?.getAttribute('aria-label') ?? '').startsWith(secondKey),
      4000
    ),
    `panel ${$('.backlog-drawer')?.getAttribute('aria-label')?.slice(0, 12) ?? 'closed'}, focus ${(document.activeElement as HTMLElement | null)?.dataset?.issue ?? document.activeElement?.tagName}, wanted ${secondKey}`
  )
  await key('Escape')

  // Right-click menu
  const menuOn = async (keyName: string): Promise<void> => {
    const r = row(keyName)!.getBoundingClientRect()
    row(keyName)!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 200,
        clientY: r.top + 10
      })
    )
    await wait(300)
  }
  await menuOn('TEAMDATA-201')
  await check(
    'right-click opens the ticket menu',
    Boolean(byText('.backlog-context-menu .cr-popover-item', 'Copy branch name'))
  )
  await click(byText('.backlog-context-menu .cr-popover-item', 'In Review'))
  await wait(400)
  await check(
    'its Status items move the ticket',
    Boolean($('.backlog-group[data-lane="In Review"] [data-issue="TEAMDATA-201"]'))
  )
  await menuOn('TEAMDATA-201')
  await click(byText('.backlog-context-menu .cr-popover-item', 'Move to backlog'))
  await wait(400)
  await check(
    'and Move to backlog takes it out of the cycle',
    !row('TEAMDATA-201')?.textContent?.includes('honey-buzzard')
  )
  await check(
    'Disconnect lives in the ⋯ menu, not the header',
    !byText('.backlog-header-actions button', 'Disconnect')
  )

  // Start session → pre-filled composer
  await click(row('DSD-101')?.querySelector('[aria-label="Start session"]'))
  await wait(500)
  const composer = $('[role="dialog"]')
  const promptBox = composer?.querySelector<HTMLTextAreaElement>('textarea') ?? null
  await check(
    'Start session opens the composer, titled and pre-filled from the ticket',
    (composer?.getAttribute('aria-label') ?? '').startsWith('DSD-101') &&
      Boolean(
        promptBox?.value.includes('Re-run the model') && promptBox.value.includes('Jira: https://')
      )
  )
  await key('Escape')
  await check('Escape closes the composer', !$('[role="dialog"]'))

  // The ticket panel: every edit
  await click(row('DSD-103'))
  await wait(500)
  const drawer = (): HTMLElement | null => $('.backlog-drawer')
  await check(
    'clicking a ticket opens its panel',
    (drawer()?.getAttribute('aria-label') ?? '').startsWith('DSD-103')
  )
  await click($('.backlog-drawer-summary'))
  setText(
    $<HTMLInputElement>('.backlog-drawer-summary-form input'),
    'Add freshness checks to every run'
  )
  $('.backlog-drawer-summary-form')?.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true })
  )
  await wait(400)
  await check(
    'the summary can be edited',
    /every run/.test(row('DSD-103')?.textContent ?? ''),
    row('DSD-103')?.querySelector('.backlog-row-summary')?.textContent ?? ''
  )
  setSelect($<HTMLSelectElement>('.backlog-drawer select[aria-label="Status"]'), 'In Review')
  await wait(400)
  await check(
    'the status can be changed',
    $<HTMLSelectElement>('.backlog-drawer select[aria-label="Status"]')?.value === 'In Review'
  )
  await click(byText('.backlog-drawer button', 'Assign to me'))
  await wait(300)
  await check('Assign to me assigns it', /Unassign/.test(drawer()?.textContent ?? ''))
  setSelect($<HTMLSelectElement>('.backlog-drawer select[aria-label="Priority"]'), 'Highest')
  await wait(400)
  await check(
    'the priority can be changed',
    Boolean(row('DSD-103')?.querySelector('[aria-label="Highest priority"]'))
  )
  setText($<HTMLTextAreaElement>('.backlog-drawer textarea[aria-label="Add a comment"]'), 'half')
  $<HTMLTextAreaElement>('.backlog-drawer textarea[aria-label="Add a comment"]')?.focus()
  await key('Escape')
  await check(
    'Escape in a field leaves the field, not the panel',
    Boolean(drawer()) &&
      $<HTMLTextAreaElement>('.backlog-drawer textarea[aria-label="Add a comment"]')?.value ===
        'half'
  )
  setText($<HTMLTextAreaElement>('.backlog-drawer textarea[aria-label="Add a comment"]'), '')

  {
    type Result = { ok: boolean; error?: string }
    const bare = await api.invoke<Result>(
      'jira:slackLink',
      'TEAMDATA-201',
      'example.slack.com/archives/C01ABC123/p1789660839431909?thread_ts=1789483818.132249'
    )
    await check('a Slack link without https:// is accepted', bare.ok, bare.error ?? '')
  }
  // A Slack thread added by hand, for a ticket Zapier didn't link
  await click($('.backlog-drawer [aria-label="Add Slack link"]'))
  await until(() => Boolean($('input[aria-label="Slack message link"]')))
  setText(
    $<HTMLInputElement>('input[aria-label="Slack message link"]'),
    'https://example.slack.com/archives/C01ABC123/p1789660839431909'
  )
  await click(byText('.backlog-save-view button', 'Add link'))
  await check(
    'a Slack link can be added to a ticket without one',
    await until(
      () =>
        Boolean($('.backlog-drawer [aria-label="Open in Slack"]')) &&
        Boolean(row('DSD-103')?.querySelector('[aria-label="Open in Slack"]'))
    )
  )
  setSelect($<HTMLSelectElement>('.backlog-drawer select[aria-label="Cycle"]'), '1')
  await wait(400)
  await check(
    'it can be added to the current cycle',
    /honey-buzzard/.test(row('DSD-103')?.textContent ?? '')
  )
  setSelect($<HTMLSelectElement>('.backlog-drawer select[aria-label="Cycle"]'), '')
  await wait(400)
  await check(
    'and put back in the backlog',
    !/honey-buzzard/.test(row('DSD-103')?.textContent ?? '') &&
      $<HTMLSelectElement>('.backlog-drawer select[aria-label="Cycle"]')?.value === ''
  )
  setSelect($<HTMLSelectElement>('.backlog-drawer select[aria-label="Parent"]'), 'TEAMDATA-50')
  await wait(400)
  await check(
    'a parent epic can be set',
    /Internal reporting/.test(row('DSD-103')?.textContent ?? '')
  )
  await click(byText('.backlog-drawer button', 'Edit'))
  setText(
    $<HTMLTextAreaElement>('.backlog-drawer textarea[aria-label="Description"]'),
    'Nightly freshness, h2. checks'
  )
  await click(
    [...$$<HTMLElement>('.backlog-drawer .backlog-drawer-buttons button')].find(
      (b) => b.textContent === 'Save'
    )
  )
  await wait(400)
  await check(
    'the description can be edited',
    /Nightly freshness/.test($('.backlog-drawer .backlog-drawer-text')?.textContent ?? '')
  )
  setText(
    $<HTMLTextAreaElement>('.backlog-drawer textarea[aria-label="Add a comment"]'),
    'Picked this up.'
  )
  await click(byText('.backlog-drawer button', 'Comment'))
  await wait(400)
  await check(
    'a comment can be added',
    $$('.backlog-comment').some((c) => /Picked this up/.test(c.textContent ?? ''))
  )
  // Blocked by / Blocking: shown from both ends, and editable.
  const blockRow = (side: 'blockedBy' | 'blocking', key: string): HTMLElement | null =>
    $(`.backlog-drawer [data-blocks="${side}"] [data-block="${key}"]`)
  await check('a ticket shows what blocks it', Boolean(blockRow('blockedBy', 'TEAMDATA-201')))
  await click($('.backlog-drawer [aria-label="Add blocking"]'))
  await until(() => Boolean($('.backlog-picker')))
  setText($<HTMLInputElement>('.backlog-picker-input'), 'TEAMDATA-202')
  await wait(200)
  await key('Enter')
  await check(
    'a ticket it blocks can be added',
    await until(() => Boolean(blockRow('blocking', 'TEAMDATA-202')))
  )
  await click(blockRow('blocking', 'TEAMDATA-202')?.querySelector('.backlog-drawer-subtask'))
  await check(
    'the other ticket shows the same link, from its side',
    await until(
      () =>
        (drawer()?.getAttribute('aria-label') ?? '').startsWith('TEAMDATA-202') &&
        Boolean(blockRow('blockedBy', 'DSD-103'))
    ),
    drawer()?.getAttribute('aria-label')?.slice(0, 14) ?? 'closed'
  )
  await click(blockRow('blockedBy', 'DSD-103')?.querySelector('[aria-label^="Remove DSD-103"]'))
  await check('a link can be removed', await until(() => !blockRow('blockedBy', 'DSD-103')))
  await click(row('TEAMDATA-201'))
  await check(
    'a blocker on another board shows too, and opens in Jira',
    await until(
      () =>
        blockRow('blockedBy', 'PLAT-9')
          ?.querySelector('.backlog-drawer-subtask')
          ?.getAttribute('title') === 'Not on this board: opens in Jira' &&
        Boolean(blockRow('blocking', 'DSD-103'))
    )
  )
  await check(
    'nothing in the Blocked by and Blocking rows spills out',
    spills($('.backlog-drawer [data-blocks="blockedBy"]')).length === 0,
    spills($('.backlog-drawer [data-blocks="blockedBy"]')).join(', ')
  )

  await key('Escape')
  await check('Escape closes the panel', !drawer())

  // The panel shows what matters, and links a session that started elsewhere.
  await click(row('DSD-101'))
  await wait(500)
  const panelText = drawer()?.textContent ?? ''
  await check(
    'tagged people show by name in comments',
    await until(() => /@Joanna Fixture/.test($('.backlog-drawer')?.textContent ?? ''))
  )
  await check(
    'the panel shows reporter, labels, estimate and why it matters',
    /Reporter/.test(panelText) &&
      /data-ask/.test(panelText) &&
      /\d+[hdmw]\b/.test(panelText) &&
      /Why it matters/.test(panelText),
    panelText.slice(0, 160)
  )
  setSelect(
    $<HTMLSelectElement>('.backlog-drawer select[aria-label="Link a session"]'),
    'fixture-rec-working'
  )
  await wait(500)
  await check(
    'a session can be linked to a ticket',
    Boolean($('.backlog-drawer [aria-label="Unlink this session"]')) &&
      Boolean(row('DSD-101')?.querySelector('.backlog-session-chip')),
    row('DSD-101')?.querySelector('.backlog-session-chip')?.textContent ?? 'no chip'
  )
  await click($('.backlog-drawer [aria-label="Unlink this session"]'))
  await wait(500)
  await check(
    'and unlinked again',
    !row('DSD-101')?.querySelector('.backlog-session-chip') &&
      !$('.backlog-drawer [aria-label="Unlink this session"]')
  )
  await key('Escape')

  await click(row('DSD-102'))
  await wait(500)
  const wiki = $('.backlog-drawer .backlog-wiki')
  await check(
    'and the ticket panel lists it',
    await until(() => /fixture pull request/.test($('.backlog-ticket-prs')?.textContent ?? ''))
  )
  await check(
    'Jira formatting renders: headings, bold, lists, code',
    Boolean(wiki?.querySelector('.backlog-wiki-h')) &&
      /model tests/.test(wiki?.querySelector('strong')?.textContent ?? '') &&
      (wiki?.querySelectorAll('li').length ?? 0) === 2 &&
      Boolean(wiki?.querySelector('code')) &&
      !/h3\.|\*model/.test(wiki?.textContent ?? ''),
    (wiki?.textContent ?? 'no description').slice(0, 80)
  )
  await key('Escape')

  // Drops into groups: an epic becomes the parent, a cycle group sets the cycle.
  const drag = async (
    el: Element | null | undefined,
    onto: () => Element | null
  ): Promise<void> => {
    const data = new DataTransfer()
    el?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
    await wait(200)
    const target = onto()
    target?.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    target?.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    el?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
    await wait(500)
  }
  await groupBy('Epic')
  await drag(row('TEAMDATA-202'), () => $('.backlog-group[data-lane="TEAMDATA-60"]'))
  await check(
    'dropping a ticket on an epic makes it the parent',
    Boolean($('.backlog-group[data-lane="TEAMDATA-60"] [data-issue="TEAMDATA-202"]'))
  )
  await groupBy('Cycle')
  await drag(row('TEAMDATA-202'), () => $('.backlog-group[data-lane="current"]'))
  await check(
    'dropping a ticket on the current cycle adds it',
    Boolean($('.backlog-group[data-lane="current"] [data-issue="TEAMDATA-202"]'))
  )
  await drag(row('TEAMDATA-202'), () => $('.backlog-group[data-lane="backlog"]'))
  await check(
    'and on Backlog takes it out',
    Boolean($('.backlog-group[data-lane="backlog"] [data-issue="TEAMDATA-202"]'))
  )
  // Upcoming cycles are there to plan into, not just the active one.
  await drag(row('TEAMDATA-202'), () => $('.backlog-group[data-lane="sprint-2"]'))
  await check(
    'an upcoming cycle is its own group, and a drop adds the ticket to it',
    Boolean($('.backlog-group[data-lane="sprint-2"] [data-issue="TEAMDATA-202"]'))
  )
  await click($('[data-sidebar-cycle="sprint-2"]'))
  await check(
    'and the sidebar lists it, showing only its tickets',
    rows().length === 1 && Boolean(row('TEAMDATA-202')),
    `${rows().length} rows`
  )
  await cycleFilter('All open')
  await drag(row('TEAMDATA-202'), () => $('.backlog-group[data-lane="backlog"]'))
  await groupBy('Status')

  // The current cycle's progress sits under the title.
  await check(
    'the sidebar shows the cycle and how much of it is done',
    /honey-buzzard/.test($('[data-sidebar-cycle="current"]')?.textContent ?? '') &&
      /\d+ of \d+ done/.test($('[data-sidebar-cycle="current"]')?.textContent ?? ''),
    $('[data-sidebar-cycle="current"]')?.textContent ?? 'none'
  )

  // Sidebar: an epic filters, a drop onto one sets it, ⌘B hides it all.
  await click($('[data-sidebar-epic="TEAMDATA-60"]'))
  await check(
    'clicking an epic in the sidebar shows only its tickets',
    rows().length > 0 &&
      rows().every((r) => /Partner dashboards/.test(r.textContent ?? '')) &&
      Boolean($('.backlog-active-chip')),
    rows()
      .map((r) => r.dataset.issue)
      .join(', ')
  )
  await click($('[data-sidebar-epic="TEAMDATA-60"]'))
  {
    const data = new DataTransfer()
    row('TEAMDATA-201')?.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data })
    )
    const target = $('[data-sidebar-epic="TEAMDATA-50"]')
    target?.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    target?.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    row('TEAMDATA-201')?.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer: data })
    )
  }
  await check(
    'dropping a ticket on a sidebar epic sets its epic',
    await until(() =>
      /Internal reporting/.test(
        row('TEAMDATA-201')?.querySelector('[aria-label^="Epic:"]')?.textContent ?? ''
      )
    )
  )
  await key('b', ['meta'])
  await check('⌘B hides the sidebar', await until(() => !$('.backlog-sidebar')))
  await key('b', ['meta'])
  await until(() => Boolean($('.backlog-sidebar')))

  // Keyboard edits on the focused ticket: P priority, S status, A assign.
  await click(row('DSD-103'))
  await key('Escape')
  row('DSD-103')?.focus()
  await key('p')
  await check('P opens the priority picker', Boolean($('.backlog-picker')))
  await typeText('low')
  await key('Enter')
  await check(
    'and picking one sets it',
    Boolean(row('DSD-103')?.querySelector('[aria-label="Low priority"]'))
  )
  row('DSD-103')?.focus()
  await key('s')
  await typeText('review')
  await key('Enter')
  await check(
    'S changes the status the same way',
    Boolean($('.backlog-group[data-lane="In Review"] [data-issue="DSD-103"]'))
  )
  const assignedBefore = row('DSD-103')
    ?.querySelector('.backlog-avatar')
    ?.getAttribute('aria-label')
  row('DSD-103')?.focus()
  await key('a')
  await wait(300)
  const assignedAfter = row('DSD-103')?.querySelector('.backlog-avatar')?.getAttribute('aria-label')
  await check(
    'A assigns it to you, or takes you off it',
    assignedBefore !== assignedAfter,
    `${assignedBefore} → ${assignedAfter}`
  )

  // Several at once: the hover check picks (as on Sessions), the bar changes
  // them all. ⌘-click opens a ticket instead, as it does on Sessions.
  const pick = (k: string): Promise<boolean> => click(row(k)?.querySelector('.backlog-row-pick'))
  await click(row('DSD-103'), ['meta'])
  await check(
    '⌘-click opens a ticket rather than picking it',
    ($('.backlog-drawer')?.getAttribute('aria-label') ?? '').startsWith('DSD-103') &&
      !$('.backlog-bulk')
  )
  await key('Escape')
  await pick('TEAMDATA-202')
  await pick('DSD-101')
  await check(
    'the check picks tickets, and a bar offers to change them together',
    /2 selected/.test($('.backlog-bulk')?.textContent ?? '')
  )
  await check(
    'nothing in the selection bar spills out of its button',
    spills($('.backlog-bulk')).length === 0,
    spills($('.backlog-bulk')).join(', ')
  )
  await click(row('DSD-102'))
  await check(
    'once picking, a plain click adds to the pick',
    /3 selected/.test($('.backlog-bulk')?.textContent ?? '') && !$('.backlog-drawer'),
    $('.backlog-bulk')?.textContent ?? 'no bar'
  )
  await click(byText('.backlog-bulk button', 'Epic'))
  await click(byText('.backlog-picker .cr-popover-item', 'Partner dashboards'))
  await check(
    'the bar sets an epic on all of them at once',
    await until(() =>
      ['TEAMDATA-202', 'DSD-102'].every((k) =>
        /Partner dashboards/.test(row(k)?.querySelector('.backlog-pill--accent')?.textContent ?? '')
      )
    )
  )
  await click(byText('.backlog-bulk button', 'Priority'))
  await click(byText('.backlog-picker .cr-popover-item', 'Lowest'))
  await wait(400)
  await check(
    'a change from the bar lands on every picked ticket',
    Boolean(row('TEAMDATA-202')?.querySelector('[aria-label="Lowest priority"]')) &&
      Boolean(row('DSD-101')?.querySelector('[aria-label="Lowest priority"]'))
  )
  // The bar stays clear of an open panel.
  await key('Escape')
  await click(row('DSD-103'))
  await until(() => Boolean($('.backlog-drawer')))
  await pick('TEAMDATA-201')
  {
    const bar = $('.backlog-bulk')?.getBoundingClientRect()
    const panel = $('.backlog-drawer')?.getBoundingClientRect()
    await check(
      'with the panel open, the bar sits over the list, not under the panel',
      Boolean(bar && panel && bar.right <= panel.left),
      `bar right ${Math.round(bar?.right ?? 0)}, panel left ${Math.round(panel?.left ?? 0)}`
    )
    await check(
      'with the panel open, nothing in the bar spills out of its button',
      spills($('.backlog-bulk')).length === 0,
      spills($('.backlog-bulk')).join(', ')
    )
  }
  // Escape closes the panel first, then clears the pick.
  await key('Escape')
  await key('Escape')
  await check('Escape clears the selection', !$('.backlog-bulk'))

  // Saved views
  await click(byText('.backlog-filter', 'Mine'))
  const mineCount = rows().length
  await click(byText('.backlog-filter', 'Save view'))
  await typeText('My tickets')
  await key('Enter')
  await check(
    'the current filters can be saved as a view',
    Boolean($('.backlog-view-tab--selected')) &&
      /My tickets/.test($('.backlog-view-tab--selected')?.textContent ?? '')
  )
  await click(byText('.backlog-filter', 'Everyone'))
  await click(byText('.backlog-view-tab .backlog-filter', 'My tickets'))
  await check(
    'and applied again in one click',
    rows().length === mineCount && Boolean($('.backlog-view-tab--selected')),
    `${rows().length} vs ${mineCount}`
  )
  $<HTMLButtonElement>('[aria-label="Delete view My tickets"]')?.click()
  await wait(300)
  await check('a view can be deleted', !$('.backlog-view-tab'))
  await click(byText('.backlog-filter', 'Everyone'))

  // Panel: estimate, labels, and the pull request offer
  await click(row('DSD-101'))
  await wait(500)
  await until(() => Boolean($('.backlog-drawer [aria-label^="Estimate"]')))
  await click($('.backlog-drawer [aria-label^="Estimate"]'))
  await until(() => Boolean($('.backlog-drawer input[aria-label="Estimate"]')))
  setText($<HTMLInputElement>('.backlog-drawer input[aria-label="Estimate"]'), '1d')
  $<HTMLInputElement>('.backlog-drawer input[aria-label="Estimate"]')?.focus()
  await key('Enter')
  await check(
    'the estimate can be edited',
    await until(() =>
      [...(row('DSD-101')?.querySelectorAll('.backlog-pill') ?? [])].some(
        (p) => p.textContent === '1d'
      )
    ),
    `panel ${$('.backlog-drawer')?.getAttribute('aria-label')?.slice(0, 8) ?? 'closed'}, input ${Boolean($('.backlog-drawer input[aria-label="Estimate"]'))}, row pills ${[...(row('DSD-101')?.querySelectorAll('.backlog-pill') ?? [])].map((p) => p.textContent).join('|')}`
  )
  await click($('.backlog-drawer input[aria-label="Add a label"]'))
  await typeText('urgent')
  await key('Enter')
  await wait(300)
  await check(
    'a label can be added',
    Boolean($('.backlog-drawer [aria-label="Remove label urgent"]'))
  )
  await click($('.backlog-drawer [aria-label="Remove label urgent"]'))
  await wait(300)
  await check('and removed', !$('.backlog-drawer [aria-label="Remove label urgent"]'))
  setSelect(
    $<HTMLSelectElement>('.backlog-drawer select[aria-label="Link a session"]'),
    'fixture-rec-ready'
  )
  await wait(800)
  await check(
    'a linked session with an open PR offers to move the ticket on',
    /Pull request #42/.test($('.backlog-nudge')?.textContent ?? ''),
    $('.backlog-nudge')?.textContent ?? 'no offer'
  )
  await check(
    'and the row swaps the branch for the pull request',
    await until(() => Boolean(row('DSD-101')?.querySelector('[aria-label^="Pull request #42"]')))
  )
  await click(byText('.backlog-nudge button', 'Comment with link'))
  await wait(400)
  await check(
    'Comment with link puts the PR on the ticket',
    $$('.backlog-comment').some((c) => /#42/.test(c.textContent ?? ''))
  )
  await click(byText('.backlog-nudge button', 'Move to'))
  await wait(400)
  await check(
    'Move to In Review moves it',
    $<HTMLSelectElement>('.backlog-drawer select[aria-label="Status"]')?.value === 'In Review'
  )
  await click($('.backlog-drawer [aria-label="Unlink this session"]'))
  await key('Escape')

  // Columns: your own, from the ⋯ menu; Jira's board stays the default.
  await click($('.backlog-menu-button[aria-label^="Display"]'))
  await click(byText('.backlog-display-menu .cr-popover-item', 'Columns'))
  await wait(300)
  setText($<HTMLInputElement>('input[aria-label="Column 1 name"]'), 'Not started')
  {
    const data = new DataTransfer()
    $('[data-status-chip="In Review"]')?.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data })
    )
    const hiddenZone = $('[data-columns-target="hidden"]')
    hiddenZone?.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    hiddenZone?.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    await wait(200)
  }
  await check(
    'a status can be dragged into Hidden',
    Boolean($('[data-columns-target="hidden"] [data-status-chip="In Review"]'))
  )
  await click(byText('.cr-modal button', 'Save columns'))
  await wait(400)
  await click($('[aria-label="Board view"]'))
  const boardNames = $$('.backlog-column').map((c) => c.dataset.status ?? '')
  await check(
    'saved columns rename and hide columns, and that status’s tickets',
    boardNames.includes('Not started') &&
      !boardNames.includes('In Review') &&
      Boolean($('.backlog-hidden-note')),
    boardNames.join(' / ')
  )
  await click($('[aria-label="List view"]'))
  await click($('.backlog-hidden-note button'))
  await wait(300)
  await click(byText('.cr-modal button', 'Reset to Jira board'))
  await wait(400)
  await check(
    "and one click goes back to the Jira board's columns",
    $$('.backlog-group').some((g) => g.dataset.lane === 'In Review') && !$('.backlog-hidden-note')
  )

  // New ticket (C)
  await click($('.backlog-title'))
  await key('c')
  await check('C opens New ticket', Boolean($('.cr-modal .backlog-create')))
  await wait(300)
  await typeText('Write the refunds runbook')
  await click(byText('.cr-modal button', 'Create ticket'))
  await wait(600)
  const created = rows().find((r) => /Write the refunds runbook/.test(r.textContent ?? ''))
  await check(
    'creating a ticket adds it and opens it',
    Boolean(created) &&
      /Write the refunds runbook/.test($('.backlog-drawer')?.getAttribute('aria-label') ?? ''),
    created?.dataset.issue ?? 'not listed'
  )
  await key('Escape')

  // Board: columns, and a drag across them
  await click($('[aria-label="Board view"]'))
  await wait(500)
  const columns = $$('.backlog-column')
  const columnNames = columns.map((c) => c.dataset.status ?? '')
  await check(
    "the board uses the Jira board's own columns",
    columns.length === 5 && columnNames.includes('Backlog/Not started'),
    columnNames.join(' / ')
  )
  const card = $('.backlog-card[data-issue="TEAMDATA-202"]')
  const target = $('.backlog-column[data-status="In Progress"]')
  const dt = new DataTransfer()
  card?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  target?.dispatchEvent(
    new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
  )
  target?.dispatchEvent(
    new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
  )
  await wait(500)
  await check(
    'dragging a card to another column moves the ticket there',
    Boolean(
      $('.backlog-column[data-status="In Progress"] .backlog-card[data-issue="TEAMDATA-202"]')
    )
  )
  await check(
    'board cards show the session a ticket is in',
    Boolean($('.backlog-card[data-issue="DSD-102"] .backlog-session-chip'))
  )
  await groupBy('Epic')
  await click($('[aria-label="Collapse Internal reporting"]'))
  await check(
    'board swimlanes collapse too',
    Boolean($('.backlog-lane[data-lane="TEAMDATA-50"]')) &&
      !$('.backlog-lane[data-lane="TEAMDATA-50"] .backlog-card')
  )
  await click($('[aria-label="Expand Internal reporting"]'))
  await groupBy('Status')
  await click($('.backlog-menu-button[aria-label^="Filter"]'))
  await click(byText('.backlog-filter-menu button', 'Hide done'))
  await key('Escape')
  await check(
    'on the board, a filtered-out column stays as a drop target',
    Boolean($('.backlog-column--filtered[data-status="Done/Not doing"]'))
  )
  await click($('.backlog-menu-button[aria-label^="Filter"]'))
  await click(byText('.backlog-filter-menu button', 'Clear filters'))
  await key('Escape')
  await click($('[aria-label="List view"]'))
  await api.invoke('sessions:rename', 'fixture-rec-waiting', 'Waiting session')
  await ctx.refreshSessions()

  // ---- Dropping a fresh screenshot ----------------------------------------
  // macOS hands over a real file in a temp folder, then deletes it moments
  // later. The drop must keep a copy; referencing the original is the bug
  // that kept coming back.
  {
    type Kept = { ok: boolean; path?: string; error?: string }
    const fresh = await api.invoke<string>('dev:fresh-screenshot')
    const [kept] = await api.invoke<Kept[]>('attachments:addDropped', [fresh])
    await api.invoke('dev:delete-fresh-screenshot', fresh)
    const [still] = kept?.path
      ? await api.invoke<Kept[]>('attachments:addPaths', [kept.path])
      : [{ ok: false, error: 'no copy' }]
    await check(
      'a dropped fresh screenshot is copied before macOS deletes it',
      Boolean(kept?.ok && kept.path && kept.path !== fresh && still?.ok),
      `${kept?.path ?? kept?.error ?? 'nothing'} → ${still?.ok ? 'still there' : (still?.error ?? '?')}`
    )
    const [saved] = await api.invoke<Kept[]>('attachments:addDropped', ['/etc/hosts'])
    await check(
      'a file saved elsewhere is still referenced where it lives',
      saved?.path === '/private/etc/hosts' || saved?.path === '/etc/hosts',
      saved?.path ?? saved?.error ?? ''
    )
  }

  // ---- Home ---------------------------------------------------------------
  await ctx.goTo('home')
  await wait(600)
  const cards = $$('.cr-session-card:not(.cr-session-card--new)')
  await check('Home shows recent session cards', cards.length > 0, `${cards.length}`)
  const titleStyle = cards[0]?.querySelector('.cr-session-card-title')
  await check(
    'card titles wrap to two lines rather than cutting off at one',
    Boolean(titleStyle) && getComputedStyle(titleStyle!).webkitLineClamp === '2'
  )
  const recent = $('.home-recent')
  const homeComposer = $('.home-composer-card')
  await check(
    'recent sessions are wider than the composer',
    Boolean(recent && homeComposer) &&
      recent!.getBoundingClientRect().width > homeComposer!.getBoundingClientRect().width,
    `${Math.round(recent?.getBoundingClientRect().width ?? 0)} vs ${Math.round(homeComposer?.getBoundingClientRect().width ?? 0)}`
  )
  await check(
    'Home filters are there (Unread, Your turn)',
    Boolean(
      byText('.home-recent-filters .cr-pill', 'Unread') &&
      byText('.home-recent-filters .cr-pill', 'Your turn')
    )
  )

  // Starting a session on an existing branch
  {
    type Project = { id: string; name: string }
    type Branch = { name: string; where: string }
    const projects = await api.invoke<Project[]>('projects:list')
    const fixtureProject = projects.find((p) => p.id !== 'general')
    const listed = fixtureProject
      ? await api.invoke<Branch[]>('git:checkoutBranches', fixtureProject.id)
      : []
    await check(
      "a project's branches on GitHub are listed for a new session",
      listed.some((b) => b.name === 'feature/remote-only' && b.where === 'remote'),
      `${listed.length} branches: ${listed
        .slice(0, 4)
        .map((b) => b.name)
        .join(', ')}`
    )
    type Resolved = { ok: boolean; branch?: string; error?: string }
    if (fixtureProject) {
      const good = await api.invoke<Resolved>(
        'git:resolveBranch',
        fixtureProject.id,
        'feature/remote-only'
      )
      const bad = await api.invoke<Resolved>(
        'git:resolveBranch',
        fixtureProject.id,
        'no-such-branch'
      )
      await check(
        'a branch name is checked against GitHub: found, or said to be missing',
        good.ok && !bad.ok && /no branch/.test(bad.error ?? ''),
        `${good.ok ? good.branch : good.error} / ${bad.error ?? 'accepted'}`
      )
    }
    if (fixtureProject && !/fixture/.test($('.home-project-chip')?.textContent ?? '')) {
      await click($('.home-add-project-pill'))
      await until(() => Boolean(byText('.home-composer-popover-item', fixtureProject.name)))
      await click(byText('.home-composer-popover-item', fixtureProject.name))
    }
    await until(() => Boolean(byText('.home-composer .cr-segmented button', 'On a branch')))
    const branchOption = byText('.home-composer .cr-segmented button', 'On a branch')
    const wasWorktree = branchOption?.getAttribute('aria-selected') !== 'true'
    if (wasWorktree) await click(branchOption)
    const branchButton = (): HTMLElement | null => $('.home-branch-button')
    await check(
      'On a branch defaults to the repo’s main branch',
      await until(() => /main/.test(branchButton()?.textContent ?? '')),
      branchButton()?.textContent ?? 'no branch button'
    )
    await click(branchButton())
    await until(() => $$('.backlog-picker [role="option"]').length > 0, 8000)
    {
      const names = $$('.backlog-picker [role="option"]').map((o) => o.textContent ?? '')
      const list = $('.backlog-picker-list')
      await check(
        'the branch list shows open branches, not merged ones, and scrolls',
        names.some((n) => n.includes('feature/remote-only')) &&
          !names.some((n) => n.includes('feature/merged-old')) &&
          /more/.test($('.backlog-picker')?.textContent ?? '') &&
          Boolean(list && getComputedStyle(list).overflowY === 'auto'),
        names.join(', ')
      )
    }
    await typeText('merged')
    await check(
      'a merged branch still turns up in a search',
      await until(() => Boolean(byText('.backlog-picker [role="option"]', 'feature/merged-old')))
    )
    setText($<HTMLInputElement>('.backlog-picker input'), '')
    await typeText('no-such-branch')
    await key('Enter')
    await check(
      'a pasted branch that isn’t on GitHub is flagged, and says so',
      (await until(() => Boolean($('.home-branch-button--invalid')))) &&
        /no branch/.test($('.home-composer-error')?.textContent ?? ''),
      $('.home-composer-error')?.textContent ?? 'no message'
    )
    await click(branchButton())
    await until(
      () => Boolean(byText('.backlog-picker [role="option"]', 'feature/remote-only')),
      8000
    )
    await click(byText('.backlog-picker [role="option"]', 'feature/remote-only'))
    await check(
      'a branch that is on GitHub is accepted, and the button says where it’ll start',
      (await until(() => Boolean($('.home-branch-button--ok')))) &&
        /Start on feature\/remote-only/.test($('.home-composer')?.textContent ?? ''),
      branchButton()?.className ?? ''
    )
    if (wasWorktree) await click(byText('.home-composer .cr-segmented button', 'New worktree'))
  }

  // ---- Sessions list ------------------------------------------------------
  await ctx.goTo('sessions')
  await wait(600)
  const sessionRow = $('.sessions-row')
  await check(
    'session rows lead with the title; the status chip is on line two',
    Boolean(sessionRow?.querySelector('.sessions-row-line1 .sessions-row-title')) &&
      Boolean(sessionRow?.querySelector('.sessions-row-line2 .sessions-row-badge')) &&
      !sessionRow?.querySelector('.sessions-row-line1 .sessions-row-badge')
  )
  await check(
    'the list has its status tabs and sort menu',
    Boolean($('.sessions-filter-tab') && $('.sessions-sort-button'))
  )

  // ---- Settings -----------------------------------------------------------
  await ctx.goTo('settings')
  await wait(600)
  await check(
    'Settings → Hooks explains itself in plain words',
    Boolean($('.settings-hooks-state')?.textContent?.trim())
  )
  await check(
    'the raw hook config is behind a toggle, closed by default',
    Boolean($('.settings-hooks-details')) &&
      !($('.settings-hooks-details') as HTMLDetailsElement | null)?.open
  )

  // ---- Switching screens with a session open ------------------------------
  // Each switch mounts a fresh terminal; its GPU context has to be handed
  // back, or Chromium hits its cap and the terminal shows a sad face.
  {
    const warningsBefore = await api.invoke<number>('dev:webgl-warnings')
    for (let n = 0; n < 20; n++) {
      await ctx.openFirstSession()
      await wait(350)
      await ctx.goTo(n % 2 ? 'backlog' : 'home')
      await wait(150)
    }
    await ctx.openFirstSession()
    await wait(1500)
    const warnings = (await api.invoke<number>('dev:webgl-warnings')) - warningsBefore
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.terminal-surface canvas')]
    const lost = canvases.some((c) => c.getContext('webgl2')?.isContextLost())
    await check(
      'twenty screen switches leave no GPU contexts behind',
      warnings === 0 && !lost,
      `${warnings} WebGL warnings, ${canvases.length} canvases, lost=${lost}`
    )
  }

  // ---- Session: header, terminal find --------------------------------------
  await ctx.openFirstSession()
  await wait(2000)
  const header = $('.session-detail-header')
  await check(
    'the session header is rounded',
    Boolean(header) && parseFloat(getComputedStyle(header!).borderTopLeftRadius) > 0
  )
  await check('the header has Close tab (×)', Boolean($('[aria-label="Close tab (⌘W)"]')))
  {
    // A real double-click: the second press carries clickCount 2.
    const title = $('.session-detail-breadcrumb-title')
    const before = title?.textContent ?? ''
    if (title) {
      title.scrollIntoView({ block: 'center' })
      const r = title.getBoundingClientRect()
      const at = {
        x: Math.round(r.left + Math.min(r.width / 2, 40)),
        y: Math.round(r.top + r.height / 2)
      }
      await input({ type: 'mouseMove', ...at })
      for (const clickCount of [1, 2]) {
        await input({ type: 'mouseDown', ...at, button: 'left', clickCount })
        await input({ type: 'mouseUp', ...at, button: 'left', clickCount })
      }
      await wait(300)
    }
    const field = $<HTMLInputElement>('.session-detail-header input')
    await check(
      "double-clicking the session's title renames it in place",
      Boolean(field) && field!.value === before,
      field ? `field holds "${field.value}", title was "${before}"` : 'no rename field'
    )
    await key('Escape')
    await check(
      'Escape leaves the title as it was',
      !$('.session-detail-header input') &&
        $('.session-detail-breadcrumb-title')?.textContent === before
    )
  }
  await check(
    'the header folder opens the IDE and is a single tile',
    Boolean($('.session-detail-folder')) &&
      getComputedStyle($('.session-detail-folder')!).paddingLeft === '0px'
  )
  // A session with no ticket offers to make one, prefilled, and links it.
  {
    await until(() => Boolean($('.session-detail-ticket--create')), 4000)
    await click($('.session-detail-ticket--create'))
    await until(() => Boolean($('.backlog-picker')), 6000)
    await check(
      'the ticket button offers to create a ticket or link one',
      /Create a new ticket/.test($('.backlog-picker')?.textContent ?? '') &&
        /DSD-103/.test($('.backlog-picker')?.textContent ?? '')
    )
    await key('Enter')
    await until(() => Boolean($('.cr-modal .backlog-create')), 6000)
    const summary = $<HTMLInputElement>('.cr-modal input[aria-label="Summary"]')?.value ?? ''
    const headerTitle = $('.session-detail-breadcrumb-title')?.textContent ?? ''
    await check(
      'Create ticket from a session opens the form with its title',
      summary.length > 0 && summary === headerTitle,
      `${summary} vs ${headerTitle}`
    )
    await click(byText('.cr-modal button', 'Create ticket'))
    await check(
      'and links the new ticket to the session',
      await until(
        () =>
          /^[A-Z]+-\d+$/.test($('.session-detail-ticket')?.textContent?.trim() ?? '') &&
          !$('.session-detail-ticket--create'),
        6000
      ),
      $('.session-detail-ticket')?.textContent ?? 'no pill'
    )
  }
  {
    type Delivered = { ok: boolean; detail: string }
    const delivered = await api.invoke<Delivered>('dev:deliver-prompt')
    await check(
      'a first prompt is sent in one go, invisible characters stripped',
      delivered.ok,
      delivered.detail
    )
  }

  const fixtureRecords = [
    'fixture-rec-working',
    'fixture-rec-waiting',
    'fixture-rec-ready',
    'fixture-rec-done',
    'fixture-rec-errored',
    'fixture-rec-idle',
    'fixture-rec-stopped',
    'fixture-rec-resumable'
  ]
  // Several sessions from a branch that's already checked out: each gets a
  // detached worktree of its own, and Ship won't push the branch they started from.
  {
    type Created = {
      ok: boolean
      error?: string
      record?: { id: string; worktreePath: string; detached?: boolean; branch: string }
    }
    const start = (): Promise<Created> =>
      api.invoke<Created>('sessions:create', {
        creationId: crypto.randomUUID(),
        projectId: 'fixture-project',
        branch: 'fixture/working',
        basedOn: 'existing',
        title: 'detached check'
      })
    const a = await start()
    const b = await start()
    await check(
      'two sessions can start from a branch that is already checked out',
      Boolean(
        a.ok &&
        b.ok &&
        a.record?.detached &&
        b.record?.detached &&
        a.record.worktreePath !== b.record.worktreePath
      ),
      `${a.error ?? a.record?.worktreePath ?? ''} / ${b.error ?? b.record?.worktreePath ?? ''}`
    )
    if (a.record) {
      const shipped = await api.invoke<{ ok: boolean; error?: string }>(
        'sessions:ship',
        a.record.id,
        'title',
        'body',
        false
      )
      await check(
        "Ship refuses a detached session until it's on a branch of its own",
        !shipped.ok && /isn't on a branch of its own/.test(shipped.error ?? ''),
        shipped.error ?? 'shipped'
      )
    }
    for (const r of [a.record, b.record]) {
      if (r)
        await api.invoke('sessions:delete', r.id, { removeWorktree: true, discardChanges: true })
    }
  }

  // Link an existing ticket from the same button.
  for (const id of fixtureRecords) await api.invoke('jira:link', id, null)
  await ctx.goTo('home')
  await ctx.openFirstSession()
  await until(() => Boolean($('.session-detail-ticket--create')), 4000)
  await click($('.session-detail-ticket--create'))
  await until(() => Boolean($('.backlog-picker')), 6000)
  setText($<HTMLInputElement>('.backlog-picker-input'), 'DSD-103')
  await wait(200)
  await key('Enter')
  await check(
    'an existing ticket can be linked to a session',
    await until(() => $('.session-detail-ticket')?.textContent === 'DSD-103', 4000),
    $('.session-detail-ticket')?.textContent ?? 'no pill'
  )
  for (const id of fixtureRecords) await api.invoke('jira:link', id, 'DSD-101')
  await ctx.goTo('home')
  await ctx.openFirstSession()
  await wait(1500)
  await check(
    'a linked session shows its ticket in the header',
    $('.session-detail-ticket')?.textContent === 'DSD-101',
    $('.session-detail-ticket')?.textContent ?? 'no pill'
  )
  await click($('.session-detail-ticket'))
  await wait(900)
  await check(
    'and the pill opens that ticket on Backlog',
    ($('.backlog-drawer')?.getAttribute('aria-label') ?? '').startsWith('DSD-101')
  )
  await key('Escape')
  for (const id of fixtureRecords) await api.invoke('jira:link', id, null)
  await ctx.goTo('home')
  await ctx.openFirstSession()
  await wait(1500)

  const split = (await api.invoke('dev:split-check')) as {
    target: string | null
    got: string | null
  }
  await check(
    'a new terminal (+) starts in its session’s worktree',
    Boolean(split.target) && split.got === split.target,
    `${split.got ?? 'nothing'} (wanted ${split.target ?? 'no fixture pane'})`
  )

  await key('f', ['meta'])
  await check('⌘F opens find in the terminal', Boolean($('.terminal-search')))
  await typeText('feature')
  await until(() => /\d+ of \d+/.test($('.terminal-search-count')?.textContent ?? ''), 5000)
  const count = $('.terminal-search-count')?.textContent ?? ''
  await check(
    'find counts matches in the scrollback',
    /\d+ of \d+/.test(count),
    count || `empty (query ${$<HTMLInputElement>('.terminal-search-input')?.value ?? 'none'})`
  )
  await key('Escape')
  await check('Escape closes find', !$('.terminal-search'))

  // ==== checks: backlog round — add this team's checks directly below ====
  await ctx.goTo('backlog')
  await wait(900)
  await click($('[aria-label="List view"]'))
  await click(byText('.backlog-filter', 'Everyone'))
  if ($('[data-filter-chip="done"] button')) await click($('[data-filter-chip="done"] button'))

  // Bulk bar regression: the familiar M button (an active cycle exists) and
  // the Cycle picker (more than one cycle exists) should both show, not
  // just one or the other.
  await click(row('DSD-101'))
  await click(row('TEAMDATA-202')?.querySelector('.backlog-row-pick'))
  {
    const bar = $('.backlog-bulk')?.textContent ?? 'no bar'
    const moveBtn = byText('.backlog-bulk button', 'Move to')
    const cycleBtn = byText('.backlog-bulk button', 'Cycle')
    await check(
      'the bulk bar keeps the familiar Move-to-cycle button alongside the Cycle picker',
      Boolean(moveBtn) && Boolean(cycleBtn),
      `move=${Boolean(moveBtn)} cycle=${Boolean(cycleBtn)} bar="${bar}"`
    )
  }
  await key('Escape')
  await key('Escape')
  await check('Escape clears the selection', !$('.backlog-bulk'))

  // The top filter row: with the ticket panel open eating its width, it
  // should stay on one line rather than wrapping (the search box collapses
  // instead), and every tab must stay fully visible — none of them clipped
  // or pushed outside the row, whatever the search does.
  await click(row('DSD-102'))
  await until(() => Boolean($('.backlog-drawer')))
  await wait(400)
  {
    const filtersRect = $('.backlog-filters')?.getBoundingClientRect()
    // One line: the tabs and the menus group share a row (a wrap drops the
    // menus a full row below). The row's own height includes its 12px
    // bottom padding, so height alone can't tell one line from two.
    const tabsTop = $('.backlog-filter-tabs')?.getBoundingClientRect().top ?? NaN
    const menusRect = $('.backlog-filter-menus')?.getBoundingClientRect()
    await check(
      'the filter row stays on one line with the ticket panel open',
      Boolean(
        filtersRect &&
        menusRect &&
        filtersRect.height > 0 &&
        Math.abs(menusRect.top - tabsTop) < 8 &&
        filtersRect.height < 60
      ),
      `height ${Math.round(filtersRect?.height ?? 0)}, tabs top ${Math.round(tabsTop)}, menus top ${Math.round(menusRect?.top ?? 0)}`
    )
    const tabs = $$('.backlog-filter-tabs .backlog-filter')
    const outside = tabs.filter((t) => {
      const r = t.getBoundingClientRect()
      return (
        !filtersRect ||
        r.width === 0 ||
        r.left < filtersRect.left - 0.5 ||
        r.right > filtersRect.right + 0.5
      )
    })
    await check(
      'every tab button stays fully visible in the row, none clipped',
      tabs.length > 0 && outside.length === 0,
      `${outside.length} of ${tabs.length} clipped or out of bounds`
    )
  }
  await key('Escape')

  // O: on a ticket with a session already named after it, opens that
  // session; on one without, starts a new one seeded from it. The Backlog
  // round above renamed the waiting session back to "Waiting session" (later
  // checks find it by that title), so name it after DSD-102 again just for
  // this check.
  await api.invoke(
    'sessions:rename',
    'fixture-rec-waiting',
    'DSD-102 Review the donations model tests'
  )
  await ctx.refreshSessions()
  await ctx.goTo('home')
  await wait(200)
  await ctx.goTo('backlog')
  await wait(900)
  try {
    row('DSD-102')?.focus()
    await key('o')
    await check(
      'O opens the ticket’s existing session',
      await until(() => Boolean($('.session-detail-breadcrumb-title'))),
      $('.session-detail-breadcrumb-title')?.textContent ??
        $('.cr-modal-title')?.textContent ??
        'no session header'
    )
    // A composer opened by mistake would swallow the next check's O.
    if ($('.cr-modal')) await key('Escape')
  } finally {
    await api.invoke('sessions:rename', 'fixture-rec-waiting', 'Waiting session')
    await ctx.refreshSessions()
  }
  await ctx.goTo('backlog')
  await wait(900)
  row('TEAMDATA-202')?.focus()
  await key('o')
  await check(
    'O starts a session for a ticket with none, seeded with its title',
    await until(() => Boolean($('.cr-modal-title')?.textContent?.includes('TEAMDATA-202'))),
    $('.cr-modal-title')?.textContent ?? 'no composer'
  )
  await key('Escape')

  // Sub-tasks: DSD-101 has two in the fixture, hidden until unfolded, and
  // never counted as rows of their own.
  const topLevelCount = rows().length
  await check(
    'a ticket with sub-tasks shows a quiet count, not extra rows',
    Boolean(row('DSD-101')?.querySelector('.backlog-subtask-count')) && !row('DSD-104')
  )
  await click(row('DSD-101')?.querySelector('.backlog-subtask-count'))
  await check(
    'clicking it unfolds them indented underneath, with key and summary',
    $$('.backlog-subtask-row').length === 2 &&
      Boolean(byText('.backlog-subtask-row .backlog-row-key', 'DSD-104')) &&
      Boolean(byText('.backlog-subtask-row .backlog-row-key', 'DSD-105')),
    $$('.backlog-subtask-row')
      .map((r) => r.textContent)
      .join(' | ')
  )
  await check('rows() still only counts top-level tickets', rows().length === topLevelCount)
  await click($$('.backlog-subtask-row')[0])
  await check(
    'clicking a sub-task opens its own panel',
    await until(() =>
      ($('.backlog-drawer')?.getAttribute('aria-label') ?? '').startsWith('DSD-104')
    )
  )
  await check(
    'a sub-task shows a read-only Parent, not an Epic picker it can’t actually set',
    !$('.backlog-drawer select[aria-label="Parent"]') &&
      ($('.backlog-drawer .backlog-link')?.textContent ?? '').includes('DSD-101'),
    $('.backlog-drawer select[aria-label="Parent"]')
      ? 'still has the Epic select'
      : ($('.backlog-drawer .backlog-link')?.textContent ?? 'no parent link')
  )
  await check(
    'and no live Cycle select — a sub-task can’t be re-sprinted on its own',
    !$('.backlog-drawer select[aria-label="Cycle"]')
  )
  await key('Escape')

  // The ticket panel lists sub-tasks too, and can add one.
  await click(row('DSD-101'))
  await until(() => Boolean($('.backlog-drawer')))
  await check(
    'the panel lists both sub-tasks',
    await until(() => $$('.backlog-drawer-subtask').length === 2),
    `${$$('.backlog-drawer-subtask').length} listed`
  )
  await click(byText('.backlog-drawer button', 'Add sub-task'))
  setText(
    $<HTMLInputElement>('.backlog-drawer input[aria-label="Sub-task summary"]'),
    'Confirm the fix with the partner'
  )
  await click(byText('.backlog-drawer form button', 'Add'))
  await check(
    'adding one puts it straight in the list',
    await until(() =>
      $$('.backlog-drawer-subtask').some((el) =>
        (el.textContent ?? '').includes('Confirm the fix with the partner')
      )
    )
  )
  await check("a new sub-task doesn't become a top-level row", rows().length === topLevelCount)
  await key('Escape')

  // PR follow-up: an open PR on a ticket that isn't in review yet offers a
  // toast to move it there, once — with an Undo after. The "already offered"
  // list is a stored key, and the fixture's userData (.dev/fixture) survives
  // between separate gate runs, so start clean and remount to re-read it —
  // otherwise this never fires again after the first real run.
  try {
    localStorage.removeItem('backlog-pr-offered')
  } catch {
    // Private window / blocked storage: nothing to clear.
  }
  await ctx.goTo('sessions')
  await wait(200)
  await ctx.goTo('backlog')
  await wait(600)
  await click(row('TEAMDATA-202'))
  await until(() => Boolean($('.backlog-drawer')))
  // Earlier rounds move TEAMDATA-202 about; Undo should restore whatever it
  // was just before the toast's move, not a fixed status.
  const statusBeforePrMove =
    $<HTMLSelectElement>('.backlog-drawer select[aria-label="Status"]')?.value ?? ''
  setSelect(
    $<HTMLSelectElement>('.backlog-drawer select[aria-label="Link a session"]'),
    'fixture-rec-ready'
  )
  await check(
    'a linked session with an open PR offers a toast, not just the panel nudge',
    await until(
      () => /PR #42 is open for TEAMDATA-202/.test($('.toast-message')?.textContent ?? ''),
      4000
    ),
    $('.toast-message')?.textContent ?? 'no toast'
  )
  await click(byText('.toast-action', 'Move to '))
  await check(
    'its action moves the ticket',
    await until(
      () =>
        $<HTMLSelectElement>('.backlog-drawer select[aria-label="Status"]')?.value === 'In Review'
    )
  )
  await check(
    'and a follow-up toast offers Undo',
    await until(() => Boolean(byText('.toast-action', 'Undo')))
  )
  await click(byText('.toast-action', 'Undo'))
  await check(
    'Undo puts it back',
    await until(
      () =>
        $<HTMLSelectElement>('.backlog-drawer select[aria-label="Status"]')?.value ===
        statusBeforePrMove,
      4000
    ),
    `${$<HTMLSelectElement>('.backlog-drawer select[aria-label="Status"]')?.value ?? 'no select'} (wanted ${statusBeforePrMove})`
  )
  await click($('.backlog-drawer [aria-label="Unlink this session"]'))
  await key('Escape')

  // Cycle planning — pure helpers first (unit-testable without a rendered
  // screen: fabricated dates, not the fixture's real ones, since honey-buzzard's
  // dates are pinned by the CycleProgress "N days left" check above).
  await check(
    'parseEstimateHours reads Jira shorthand (1w=5d, 1d=8h)',
    parseEstimateHours('1d 4h') === 12 && parseEstimateHours('1w') === 40,
    `${parseEstimateHours('1d 4h')}h, ${parseEstimateHours('1w')}h`
  )
  await check(
    'workingDays counts weekdays only, and defaults to 10 with no dates',
    workingDays('2026-09-14T00:00:00.000Z', '2026-09-18T00:00:00.000Z') === 5 &&
      workingDays(undefined, undefined) === 10,
    `${workingDays('2026-09-14T00:00:00.000Z', '2026-09-18T00:00:00.000Z')}, ${workingDays(undefined, undefined)}`
  )

  // Cycle planning view: opened from the sidebar's hover action, drag a
  // ticket in, capacity updates.
  await ctx.goTo('backlog')
  await wait(600)
  await click($('[aria-label="Plan kestrel"]'))
  await check(
    'the hover action on a cycle row opens its planning view',
    await until(() => $('.cr-modal-title')?.textContent === 'Plan kestrel'),
    $('.cr-modal-title')?.textContent ?? 'no modal'
  )
  // DSD-103 starts assigned to "Someone Else", but the Backlog round's
  // "Assign to me" lands on it — so find its row by whoever it belongs to
  // now: it's the only ticket in kestrel, so the only capacity row.
  const capacityRow = (): HTMLElement | null => $('.cycle-plan-capacity-row')
  const capacityUsed = (): string =>
    capacityRow()?.querySelector('.cycle-plan-capacity-numbers')?.textContent ?? ''
  const capacityDays = (): string =>
    capacityRow()?.querySelector<HTMLInputElement>('.cycle-plan-capacity-input')?.value ?? ''
  const planDrag = async (el: Element | null | undefined, onto: Element | null): Promise<void> => {
    const data = new DataTransfer()
    el?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
    await wait(200)
    onto?.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    onto?.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
    )
    el?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
    await wait(500)
  }
  // The fixture puts DSD-103 in kestrel, but the Backlog round above moves
  // it to the current cycle and back out to the backlog. Put it back in
  // kestrel for the capacity check, and restore it after.
  const dsd103WasOut = Boolean($('[data-cycle-plan-column="backlog"] [data-issue="DSD-103"]'))
  if (dsd103WasOut) {
    await planDrag(
      $('[data-cycle-plan-column="backlog"] [data-issue="DSD-103"]'),
      $('[data-cycle-plan-column="cycle"]')
    )
    await until(() => Boolean($('[data-cycle-plan-column="cycle"] [data-issue="DSD-103"]')))
  }
  await check(
    "capacity starts at DSD-103's own 4h (0.5d) of the no-dates default (10d)",
    (await until(() => capacityUsed().includes('0.5d'))) &&
      capacityDays() === '10' &&
      $$('.cycle-plan-capacity-row').length === 1,
    `${capacityUsed()} / ${capacityDays()}d; in cycle: ${$$(
      '[data-cycle-plan-column="cycle"] [data-issue]'
    )
      .map((el) => el.dataset.issue)
      .join(', ')}`
  )
  await planDrag(
    $('[data-cycle-plan-column="backlog"] [data-issue="TEAMDATA-202"]'),
    $('[data-cycle-plan-column="cycle"]')
  )
  await check(
    'dragging a backlog ticket into the cycle column moves it in',
    await until(() => Boolean($('[data-cycle-plan-column="cycle"] [data-issue="TEAMDATA-202"]')))
  )
  await check(
    'capacity updates once a ticket with no estimate joins the cycle',
    await until(() =>
      /1 ticket has no estimate/.test($('.cycle-plan-capacity-note')?.textContent ?? '')
    ),
    $('.cycle-plan-capacity-note')?.textContent ?? 'no "no estimate" note'
  )
  // Undo the drag — leave TEAMDATA-202 back in the backlog for later rounds.
  await planDrag(
    $('[data-cycle-plan-column="cycle"] [data-issue="TEAMDATA-202"]'),
    $('[data-cycle-plan-column="backlog"]')
  )
  await check(
    'moving it back out restores the backlog column',
    await until(() => Boolean($('[data-cycle-plan-column="backlog"] [data-issue="TEAMDATA-202"]')))
  )
  if (dsd103WasOut) {
    await planDrag(
      $('[data-cycle-plan-column="cycle"] [data-issue="DSD-103"]'),
      $('[data-cycle-plan-column="backlog"]')
    )
    await until(() => Boolean($('[data-cycle-plan-column="backlog"] [data-issue="DSD-103"]')))
  }
  await key('Escape')

  // Plan cycle with the sidebar hidden: the sidebar row's hover action isn't
  // there, so the Filter menu's cycle list carries its own "Plan" action.
  await click($('[aria-label="Hide sidebar"]'))
  await wait(300)
  try {
    await click($('.backlog-menu-button[aria-label^="Filter"]'))
    await until(() => Boolean($('.backlog-filter-menu')))
    await check(
      'the Filter menu offers Plan cycle for the current cycle with the sidebar hidden',
      Boolean($('.backlog-menu-cycle-row [aria-label^="Plan "]')),
      $('.backlog-menu-cycle-row [aria-label^="Plan "]')?.getAttribute('aria-label') ?? 'no button'
    )
    await click($('.backlog-menu-cycle-row [aria-label^="Plan "]'))
    await check(
      'clicking it opens planning with no sidebar in the way',
      await until(() => Boolean($('.cr-modal-title')?.textContent?.startsWith('Plan '))),
      $('.cr-modal-title')?.textContent ?? 'no modal'
    )
    await key('Escape')
  } finally {
    // Never leave the sidebar hidden for later rounds' checks.
    await click($('[aria-label="Show sidebar"]'))
    await wait(300)
  }

  // ==== checks: sessions round — add this team's checks directly below ====

  // Opens the named session by its row title, not "whichever session is
  // first" (openFirstSession's order isn't guaranteed to match the fixture
  // record a check needs — see the Ship and hand-off notes below).
  const openSessionByTitle = async (title: string): Promise<void> => {
    await ctx.goTo('sessions')
    await wait(600)
    const row = byText('.sessions-row-title', title)?.closest<HTMLElement>('.sessions-row')
    await click(row)
    await wait(900)
  }

  // Several sessions deleted at once: tick them, then Delete in the bar.
  {
    type Created = { ok: boolean; error?: string; record?: { id: string; title: string } }
    const make = (name: string): Promise<Created> =>
      api.invoke<Created>('sessions:create', {
        creationId: crypto.randomUUID(),
        projectId: 'fixture-project',
        branch: `fixture/${name}`,
        basedOn: 'new',
        title: name
      })
    // Deleting keeps the branch, so each run needs names of its own.
    const run = Date.now().toString(36)
    const a = await make(`bulk-delete-a-${run}`)
    const b = await make(`bulk-delete-b-${run}`)
    await ctx.refreshSessions()
    await ctx.goTo('sessions')
    await wait(900)
    const rowFor = (id?: string): HTMLElement | null =>
      id ? $(`.sessions-row[data-record-id="${id}"]`) : null
    await until(() => Boolean(rowFor(a.record?.id) && rowFor(b.record?.id)), 4000)
    const bar = (): HTMLElement | null => $('.cr-selection-bar[aria-label="Selected sessions"]')
    await click(rowFor(a.record?.id)?.querySelector('.sessions-row-pick'))
    rowFor(b.record?.id)?.focus()
    await key('x')
    await check(
      'the check or X picks sessions, and the shared bar offers to act on them together',
      /2 selected/.test(bar()?.textContent ?? '') &&
        Boolean(byText('.cr-selection-bar button', 'Open in tabs')),
      bar()?.textContent ?? `no bar (${a.error ?? ''} ${b.error ?? ''})`
    )
    {
      const cap = bar()?.querySelector('kbd')
      const style = cap ? getComputedStyle(cap) : null
      await check(
        "the Sessions bar's key caps get the shared style, and nothing in it spills",
        style?.paddingLeft === '5px' && style?.lineHeight === '16px' && spills(bar()).length === 0,
        `padding ${style?.paddingLeft}, line ${style?.lineHeight}, spills: ${spills(bar()).join(', ')}`
      )
    }
    await key('Backspace')
    await until(() => Boolean(byText('.cr-modal button', 'Delete 2 sessions')), 3000)
    await check(
      'the delete dialog lists every picked session',
      /bulk-delete-a/.test($('.cr-modal')?.textContent ?? '') &&
        /bulk-delete-b/.test($('.cr-modal')?.textContent ?? '')
    )
    await click(byText('.cr-modal button', 'Delete 2 sessions'))
    await check(
      'both are deleted in one go',
      await until(() => !rowFor(a.record?.id) && !rowFor(b.record?.id) && !bar(), 8000),
      $('.cr-modal')?.textContent?.slice(0, 120) ?? 'dialog closed'
    )
  }

  // The sidebar's projects open to list their sessions, and a session opens
  // from there.
  {
    await ctx.goTo('sessions')
    await wait(600)
    const project = (): HTMLElement | null => $('[data-rail-project="fixture-project"]')
    await click(project()?.querySelector('.projects-rail-disclosure'))
    const item = (): HTMLElement | undefined =>
      $$<HTMLElement>('[data-rail-project="fixture-project"] .projects-rail-session').find((b) =>
        /Working session/.test(b.textContent ?? '')
      )
    await check(
      'a project in the sidebar opens to list its sessions, each with a status word',
      await until(() =>
        Boolean(item()?.querySelector('.projects-rail-session-status')?.textContent)
      ),
      project()?.textContent?.slice(0, 160) ?? 'no fixture-project in the sidebar'
    )
    await click(item())
    await check(
      'a session opens from under its project',
      await until(() =>
        /Working session/.test($('.session-detail-breadcrumb-title')?.textContent ?? '')
      ),
      $('.session-detail-breadcrumb-title')?.textContent ?? 'no session open'
    )
    await click(project()?.querySelector('.projects-rail-disclosure'))
    await check('and the project closes again', !item())
  }

  // Ship panel (plan 7 step 3). No CR_SHIP_FIXTURE from the gate's
  // shot:fixture env, so this only drives what works without the network:
  // the panel opens, shows real commits, defaults the PR title, and the
  // Jira/Slack sections render and work against the Jira fixture. It never
  // clicks "Push and open PR" — that would really try to push and call gh.
  // Only 'fixture-rec-working' (branch fixture/working) has commits, so this
  // opens it by name rather than "the first session" — the fixture doesn't
  // promise those are the same one.
  {
    const SHIP_RECORD = 'fixture-rec-working'
    await api.invoke('jira:link', SHIP_RECORD, null)
    await openSessionByTitle('Working session')

    await click($('[aria-label="Ship"]'))
    await until(() => Boolean($('.ship-panel')), 3000)
    await check(
      'Ship opens the panel from the header, on a branch with commits',
      Boolean($('.ship-panel')),
      $('.session-detail-header')?.textContent ?? 'no header'
    )

    await until(() => $$('.ship-panel-commit').length > 0, 3000)
    await check(
      "it lists the branch's real commits",
      $$('.ship-panel-commit').some((el) =>
        (el.textContent ?? '').includes('Work in progress on the working branch')
      ),
      $$('.ship-panel-commit')
        .map((el) => el.textContent)
        .join(' | ')
    )

    const sessionTitle = $('.session-detail-breadcrumb-title')?.textContent?.trim() ?? ''
    await until(
      () => ($('.ship-panel-pr-form input') as HTMLInputElement | null)?.value !== '',
      3000
    )
    const titleField = $<HTMLInputElement>('.ship-panel-pr-form input')
    await check(
      'an unlinked session defaults the PR title to the session title',
      Boolean(sessionTitle) && titleField?.value === sessionTitle,
      `wanted "${sessionTitle}", got "${titleField?.value}"`
    )
    await check(
      'there is no Jira section for an unlinked session',
      !$('.session-detail .ship-panel-jira-row') ||
        $$('.ship-panel-section-title').filter((el) => el.textContent?.includes('Jira')).length ===
          0
    )

    await key('Escape')
    await until(() => !$('.ship-panel'), 2000)

    // Link to a Jira ticket with a Slack link, and re-open: PR title takes
    // "KEY: summary", Jira and Slack sections both appear.
    await api.invoke('jira:link', SHIP_RECORD, 'DSD-101')
    await click($('[aria-label="Ship"]'))
    await until(() => Boolean($('.ship-panel')), 3000)
    await until(
      () =>
        ($('.ship-panel-pr-form input') as HTMLInputElement | null)?.value.startsWith('DSD-101:') ??
        false,
      3000
    )
    await check(
      'a linked session defaults the PR title to "KEY: summary"',
      ($<HTMLInputElement>('.ship-panel-pr-form input')?.value ?? '').startsWith('DSD-101:'),
      $<HTMLInputElement>('.ship-panel-pr-form input')?.value ?? 'empty'
    )

    const jiraHeading = byText('.ship-panel-section-title', '3. Jira')
    await check('the Jira section appears once linked', Boolean(jiraHeading))
    const moveBtn = byText('.ship-panel-jira-row button', 'Move to In Review')
    await check('it offers moving the ticket to the review status', Boolean(moveBtn))
    await click(moveBtn)
    await check(
      'moving it updates the ticket',
      await until(() => byText('.ship-panel-jira-row button', 'Moved to In Review') !== undefined)
    )
    // Reset the fixture ticket directly — the UI path is what's under test above.
    await api.invoke('jira:move', 'DSD-101', 'In Progress')

    const slackHeading = byText('.ship-panel-section-title', '4. Slack')
    await check('the Slack section appears for a ticket with a Slack link', Boolean(slackHeading))

    await key('Escape')
    await api.invoke('jira:link', SHIP_RECORD, null)
    // Leave the tab strip as this block found it, whether or not the checks
    // above passed.
    await click($('[aria-label="Close tab (⌘W)"]'))
    await wait(300)
  }

  // ⌘⇧T reopens the last closed session tab, like a browser (App.tsx). Its
  // only meaning app-wide now — "Focus terminal" moved to ⌘⇧E in keyboard.ts
  // so the two shortcuts never collide.
  {
    await ctx.goTo('sessions')
    await wait(600)
    const sessionRows = (): HTMLElement[] => $$('.sessions-row')
    const openTabs = (): HTMLElement[] => $$('.cr-tab:not(.cr-tab--home)')
    const tabTitle = (t: Element | undefined): string =>
      t?.querySelector('.cr-tab-title')?.textContent ?? ''

    // Meta-click opens a session as a background tab without switching to
    // it, as tabsCheck.ts does. A plain click on the second row would
    // otherwise land on the session detail screen a plain click on the first
    // row just switched to (SessionsScreen stays mounted behind it), not on
    // a second row.
    await click(sessionRows()[0], ['meta'])
    await wait(400)
    await click(sessionRows()[1] ?? sessionRows()[0], ['meta'])
    await wait(400)
    await check(
      'two sessions open as tabs, ready to close one',
      openTabs().length >= 2,
      `${openTabs().length} tabs`
    )

    // Switch into one of them so there's a live terminal to click into below.
    await click(openTabs()[0])
    await wait(600)

    const closing = openTabs()[openTabs().length - 1]
    const closingTitle = tabTitle(closing)
    await click(closing?.querySelector('.cr-tab-close'))
    await wait(400)
    await check(
      'the tab closes',
      !openTabs().map(tabTitle).includes(closingTitle),
      `still open: ${openTabs().map(tabTitle).join(', ')}`
    )

    // Click into the live terminal first — the shortcut has to survive
    // xterm's own keydown handling, not just fire into an unfocused window.
    await click($('.terminal-surface'))
    await wait(200)
    await key('t', ['meta', 'shift'])
    await wait(500)
    await check(
      '⌘⇧T reopens the last closed tab, even with the terminal focused',
      openTabs().map(tabTitle).includes(closingTitle),
      `open: ${openTabs().map(tabTitle).join(', ')} (wanted ${closingTitle})`
    )

    // Leave no tabs open behind this block, pass or fail.
    while (openTabs().length > 0) {
      await click(openTabs()[0]?.querySelector('.cr-tab-close'))
      await wait(200)
    }
  }

  // The footer hint under the terminal reads as the app's other meta text,
  // not a separate faint monospace style (TerminalFrame). Opens its own
  // session rather than relying on a tab the block above happened to leave
  // open.
  await openSessionByTitle('Working session')
  await check(
    'the terminal footer hint uses sentence case',
    /^[A-Z]/.test($('.terminal-frame-focus-hint')?.textContent?.trim() ?? ''),
    $('.terminal-frame-focus-hint')?.textContent ?? 'no hint'
  )
  await click($('[aria-label="Close tab (⌘W)"]'))
  await wait(300)

  // Hand-off note: header overflow menu -> dialog with the note built from
  // the branch's own history -> Post to a linked ticket, or Copy when
  // unlinked. Linked and unlinked in the same block, so this leaves the
  // fixture as it found it.
  {
    const HANDOFF_RECORD = 'fixture-rec-working'
    // This record's own branch (scripts/fixtures/build-fixture.ts). Read from
    // the sessions list instead, this would silently check whichever row's
    // branch renders first rather than this record's.
    const branchText = 'fixture/working'

    await api.invoke('jira:link', HANDOFF_RECORD, 'DSD-101')
    await openSessionByTitle('Working session')

    await click($('[aria-label="More actions"]'))
    await click(byText('.session-detail-menu button', 'Write hand-off note'))
    await until(() => Boolean($('.cr-modal-title')), 3000)
    await check(
      '"Write hand-off note" opens a dialog from the header menu',
      ($('.cr-modal-title')?.textContent ?? '').toLowerCase().includes('hand-off note'),
      $('.cr-modal-title')?.textContent ?? 'no dialog'
    )

    await until(() => {
      const value = $<HTMLTextAreaElement>('[aria-label="Hand-off note"]')?.value ?? ''
      return value.length > 0 && !value.includes('Building the note')
    }, 4000)
    const noteValue = $<HTMLTextAreaElement>('[aria-label="Hand-off note"]')?.value ?? ''
    await check(
      'the note carries the branch name',
      Boolean(branchText) && noteValue.includes(branchText),
      `branch "${branchText}" not found in: ${noteValue.slice(0, 200)}`
    )

    const postBtn = byText('.cr-modal button', 'Post to DSD-101')
    await check(
      'a session linked to a ticket offers Post to the ticket, not Copy',
      Boolean(postBtn),
      $('.cr-modal')?.textContent ?? 'no dialog'
    )
    await click(postBtn)
    await check('posting closes the dialog', await until(() => !$('.cr-modal'), 3000))

    // Unlink, and reopen the same dialog: no ticket means Copy instead of
    // Post. The clipboard isn't readable back from this harness, so this
    // checks the toast HandoffNoteDialog's copy() pushes rather than the
    // clipboard contents themselves.
    await api.invoke('jira:link', HANDOFF_RECORD, null)
    // The menu closed when the first dialog opened; open it again.
    await click($('[aria-label="More actions"]'))
    await until(() => Boolean(byText('.session-detail-menu button', 'Write hand-off note')))
    await click(byText('.session-detail-menu button', 'Write hand-off note'))
    await until(() => Boolean($('.cr-modal')), 3000)

    const copyBtn = byText('.cr-modal button', 'Copy')
    await check(
      'unlinking swaps Post for Copy',
      Boolean(copyBtn),
      $('.cr-modal')?.textContent ?? 'no dialog'
    )
    await until(() => {
      const value = $<HTMLTextAreaElement>('[aria-label="Hand-off note"]')?.value ?? ''
      return value.length > 0 && !value.includes('Building the note')
    }, 4000)
    await click(copyBtn)
    await check(
      'Copy pushes a toast confirming the note was copied',
      // Post's own toast may still be showing; look at every toast.
      await until(() =>
        $$('.toast-message').some((t) => /copied|could not copy/i.test(t.textContent ?? ''))
      ),
      $$('.toast-message')
        .map((t) => t.textContent)
        .join(' | ') || 'no toast'
    )

    await click($('[aria-label="Close tab (⌘W)"]'))
    await wait(300)
  }

  // ==== checks: projects round — add this team's checks directly below ====
  await ctx.goTo('home')
  await wait(400)
  // ⌘⇧1, the app-wide shortcut to the Projects list (keyboard.ts).
  await key('1', ['meta', 'shift'])
  await wait(600)
  await check('⌘⇧1 opens the Projects list', Boolean($('.projects-list-screen')))

  // Item 1: a long repo path used to be truncated with a CSS rtl trick that
  // moved its leading "/" to the end ("Users/…/project/" instead of
  // "/Users/…/project"). The fix wraps the path in a <bdi> and swaps a
  // leading home dir for "~" — check the text itself reads correctly (the
  // rtl truncation is a paint-only effect a DOM check can't see).
  {
    const pathEl = $<HTMLElement>('.project-row-path bdi')
    const text = pathEl?.textContent ?? ''
    await check(
      'a project path reads with a leading "/" or "~", not a trailing "/"',
      /^[/~]/.test(text) && !text.endsWith('/'),
      `path text: "${text}" (raw ${$('.project-row-path')?.getAttribute('title') ?? 'none'})`
    )
  }

  // Item 4: the composer's CTA used to say "Start in ~/" with no project
  // selected — it should name where the session actually lands (the General
  // project, home screen sessions with no project chosen).
  await ctx.goTo('home')
  await wait(400)
  {
    const cta = byText('.home-composer button', 'Start in')
    await check(
      'the composer button names General instead of "Start in ~/"',
      Boolean(cta) && cta!.textContent!.includes('General'),
      cta?.textContent ?? 'no CTA found'
    )
  }

  // Item 4: the four composer icon buttons (Attach, Model, Plan mode,
  // Background) need a real tooltip each, and the two toggles need a
  // visibly different on state, not just aria-pressed. Clicks them back
  // afterwards so the composer is left as it was found. IconButton swallows
  // `title` (it would double up with its own hover tooltip), so a DOM check
  // reads the same text off `aria-label`, which Tooltip's label defaults to.
  {
    const toggles = $$<HTMLElement>('.home-composer-toggles button.cr-icon-button')
    await check(
      'all four composer icon buttons carry a label (used as both tooltip and accessible name)',
      toggles.length === 4 &&
        toggles.every((el) => (el.getAttribute('aria-label') ?? '').length > 0),
      `${toggles.length} buttons, labels: ${toggles.map((el) => el.getAttribute('aria-label')).join(' | ')}`
    )

    const planButton = $<HTMLElement>(
      '.home-composer-toggles [aria-pressed][aria-label^="Plan mode"]'
    )
    const backgroundButton = $<HTMLElement>(
      '.home-composer-toggles [aria-pressed][aria-label^="Start in background"]'
    )

    const flipsVisibly = async (button: HTMLElement | null, label: string): Promise<void> => {
      if (!button) {
        await check(`${label} toggle found`, false)
        return
      }
      const before = button.getAttribute('aria-pressed') === 'true'
      const classesBefore = button.className
      await click(button)
      const after = button.getAttribute('aria-pressed') === 'true'
      const classesAfter = button.className
      await check(`${label} flips aria-pressed when clicked`, after !== before)
      await check(
        `${label}'s on state looks different, not just aria-pressed`,
        classesAfter !== classesBefore,
        `before "${classesBefore}", after "${classesAfter}"`
      )
      // Click it back — this check shouldn't change what Home starts with.
      await click(button)
    }

    await flipsVisibly(planButton, 'Plan mode')
    await flipsVisibly(backgroundButton, 'Start in background')
  }

  // Step 2 — the fixture seeds two projects on the same repo path/worktreeRoot
  // ("fixture-project" and "data-infrastructure"), which used to disagree on
  // session counts between the Sessions rail (matched by projectId OR a
  // cwd-prefix, so both projects' sessions landed on both) and the Projects
  // list (matched by projectId alone). Both now go through the same rule
  // (resolveSessionProjectId in state/useSessions.ts) — check they agree,
  // whatever the number turns out to be, rather than hardcoding "9".
  {
    await ctx.goTo('home')
    await wait(400)
    await key('1', ['meta', 'shift'])
    await wait(600)

    const countOnCard = (name: string): number | null => {
      const label = byText('.project-row-name', name)
      const card = label?.closest('.project-row-card')
      const text = card?.textContent ?? ''
      const match = /(\d+)\s+sessions?\b/.exec(text)
      return match ? Number(match[1]) : null
    }
    const listFixtureCount = countOnCard('fixture-project')
    const listInfraCount = countOnCard('data-infrastructure')

    await ctx.goTo('sessions')
    await wait(600)

    const countInRail = (name: string): number | null => {
      const label = byText('.projects-rail-label', name)
      const item = label?.closest('.projects-rail-item')
      const text = item?.querySelector('.projects-rail-count')?.textContent ?? ''
      return text.trim() === '' ? null : Number(text.trim())
    }
    const railFixtureCount = countInRail('fixture-project')
    const railInfraCount = countInRail('data-infrastructure')

    await check(
      'the Sessions rail and Projects list agree on fixture-project’s session count',
      listFixtureCount !== null && listFixtureCount === railFixtureCount,
      `list ${listFixtureCount}, rail ${railFixtureCount}`
    )
    await check(
      'the Sessions rail and Projects list agree on data-infrastructure’s session count ' +
        '(a second project on the same path as fixture-project, so it should not inherit ' +
        'fixture-project’s sessions by path match)',
      listInfraCount !== null && listInfraCount === railInfraCount,
      `list ${listInfraCount}, rail ${railInfraCount}`
    )
  }

  // Step 2 — "Clean up worktrees" dialog on the project detail Overview tab.
  // Opens it, checks the fixture's real worktrees are listed, and that a
  // worktree with a live session on it (feature-working) can't be selected.
  // Cancels rather than removing anything, so the fixture is untouched.
  {
    await ctx.goTo('home')
    await wait(400)
    await key('1', ['meta', 'shift'])
    await wait(600)
    const fixtureRow = byText('.project-row-name', 'fixture-project')?.closest(
      '.project-row-card'
    ) as HTMLElement | undefined
    await click(fixtureRow)
    await until(() => Boolean($('.project-detail')), 3000)

    const worktreesHeader = byText('.cr-disclosure-label', 'Worktrees')?.closest(
      '.cr-disclosure-header'
    ) as HTMLElement | undefined
    await click(worktreesHeader)
    await wait(300)

    const cleanupButton = byText('.overview-worktrees-actions button', 'Clean up worktrees')
    await click(cleanupButton)
    await until(
      () => Boolean($('.cr-modal-title')?.textContent?.includes('Clean up worktrees')),
      3000
    )
    await check(
      '"Clean up worktrees" opens a dialog',
      Boolean($('.cr-modal-title')?.textContent?.includes('Clean up worktrees')),
      $('.cr-modal-title')?.textContent ?? 'no dialog'
    )

    // Give the dialog's own worktree listing (a real `git worktree list`, plus
    // merged/PR/dirty checks) a moment to load before reading it.
    // The "Looking at…" loading line shares the note class, so wait past it
    // — the merged/PR checks go through git and gh and can take a while.
    await until(
      () =>
        $$('.wt-cleanup-row').length > 0 ||
        Boolean(
          $('.wt-cleanup-note') && !/Looking at/.test($('.wt-cleanup-note')!.textContent ?? '')
        ),
      20000
    )
    const rows = $$('.wt-cleanup-row')
    await check(
      'it lists the fixture’s worktrees',
      rows.length > 0,
      rows.length === 0 ? ($('.wt-cleanup-note')?.textContent ?? 'no rows') : `${rows.length} rows`
    )

    const liveRow = rows.find((r) => r.textContent?.includes('fixture/working'))
    await check(
      'the worktree a live session is using is disabled, not offered for removal',
      Boolean(liveRow) &&
        liveRow!.classList.contains('wt-cleanup-row--disabled') &&
        (liveRow as HTMLButtonElement).disabled === true,
      liveRow?.textContent ?? 'fixture/working row not found'
    )
    await check(
      'each worktree says when it was last committed to, so abandoned ones stand out',
      rows.some((r) =>
        /Last commit .+ ago/.test(r.querySelector('.wt-cleanup-row-age')?.textContent ?? '')
      ),
      rows.map((r) => r.querySelector('.wt-cleanup-row-age')?.textContent ?? 'no age').join(' | ')
    )

    await click(byText('.cr-modal button', 'Cancel'))
    await until(() => !$('.cr-modal'), 2000)
  }

  // Step 3 — pin a session from Home's recent list: it should jump to the
  // front (pinned now sorts ahead of attention rank — see HomeScreen's
  // comparator) and carry a quiet mark, and unpinning should put things
  // back. Targets the card by its title/data-session-key, never by index,
  // and always tries to unpin in a finally-style block — including a direct
  // IPC fallback — so a failed assertion above can't leave the fixture with
  // a stray pin.
  {
    await ctx.goTo('home')
    await wait(600)
    const cardsBefore = $$('.cr-session-card:not(.cr-session-card--new)')
    await check('Home has at least two recent sessions to pin against', cardsBefore.length >= 2)

    const wrapOf = (card: Element): HTMLElement | null =>
      card.closest<HTMLElement>('.cr-session-card-wrap')
    const titleOf = (card: Element): string =>
      card.querySelector('.cr-session-card-title')?.textContent?.trim() ?? ''
    const keyOf = (card: Element): string | null =>
      wrapOf(card)?.getAttribute('data-session-key') ?? null
    const findByKey = (key: string): Element | undefined =>
      $$('.cr-session-card:not(.cr-session-card--new)').find((c) => keyOf(c) === key)
    const isPinned = (card: Element): boolean =>
      Boolean(wrapOf(card)?.querySelector('.cr-session-card-pinned'))

    const target = cardsBefore[1]
    const targetTitle = titleOf(target)
    const targetKey = keyOf(target)
    const targetId = targetKey?.startsWith('record:') ? targetKey.slice('record:'.length) : null

    const openMenuFor = async (card: Element): Promise<HTMLElement | undefined> => {
      const button =
        wrapOf(card)?.querySelector<HTMLElement>('[aria-label^="Actions for"]') ?? undefined
      await click(button)
      return button
    }

    try {
      await openMenuFor(target)
      const pinItem = byText('.cr-session-card-menu-list .cr-popover-item', 'Pin')
      await check('the session card menu offers Pin', Boolean(pinItem))
      await click(pinItem)
      await until(() => (targetKey ? isPinned(findByKey(targetKey) ?? target) : true), 3000)

      const cardsAfterPin = $$('.cr-session-card:not(.cr-session-card--new)')
      await check(
        'pinning a session moves it to the front of Home',
        titleOf(cardsAfterPin[0]) === targetTitle,
        `front is now "${titleOf(cardsAfterPin[0])}", expected "${targetTitle}"`
      )
      await check('the pinned session shows a pin mark', isPinned(cardsAfterPin[0]))
    } finally {
      // Unpin by key, wherever the card ended up — never by index, since a
      // failed assertion above may have left it somewhere other than the
      // front this check expected.
      const stillThere = targetKey ? findByKey(targetKey) : undefined
      if (stillThere && isPinned(stillThere)) {
        await openMenuFor(stillThere)
        const unpinItem = byText('.cr-session-card-menu-list .cr-popover-item', 'Unpin')
        if (unpinItem) {
          await click(unpinItem)
          await until(() => !isPinned(findByKey(targetKey!) ?? stillThere), 3000)
        } else if (targetId) {
          // The menu didn't offer Unpin (e.g. it re-rendered mid-click) —
          // fall back to the same IPC call the menu item would have made,
          // so the fixture never comes out of this check with a stray pin.
          await api.invoke('sessions:setPinned', targetId, false)
        }
      } else if (targetId) {
        // Belt and braces: whatever the DOM shows, make sure the record
        // itself isn't left pinned.
        await api.invoke('sessions:setPinned', targetId, false)
      }
      await check(
        'unpinning removes the mark',
        !$$('.cr-session-card:not(.cr-session-card--new)').some(isPinned)
      )
    }
  }

  // ==== checks: palette round — add this team's checks directly below ====
  await ctx.goTo('home')
  await wait(400)

  // Typing a ticket key on the loaded board — DSD-101 is on the fixture
  // board — shows it and Enter opens its Backlog panel.
  await key('k', ['meta'])
  await until(() => Boolean($('.command-palette-input')))
  await typeText('DSD-101')
  await until(() => Boolean(byText('.command-palette-item-label', 'DSD-101')), 3000)
  await check(
    '⌘K "DSD-101" shows the ticket, from the loaded board',
    Boolean(byText('.command-palette-item-label', 'DSD-101'))
  )
  await key('Enter')
  await until(() => Boolean($('.backlog-drawer')))
  await check(
    'choosing it opens DSD-101’s panel on the Backlog',
    ($('.backlog-drawer')?.getAttribute('aria-label') ?? '').startsWith('DSD-101')
  )

  // "dsd 101" (space, lower case) normalizes the same way.
  await ctx.goTo('home')
  await wait(400)
  await key('k', ['meta'])
  await until(() => Boolean($('.command-palette-input')))
  await typeText('dsd 101')
  await check(
    '⌘K normalizes "dsd 101" to the ticket, case and separator insensitive',
    await until(() => Boolean(byText('.command-palette-item-label', 'DSD-101')), 3000)
  )
  await key('Escape')

  // DSD-104 is Done, so it isn't on the fixture board's Backlog — the result
  // says so, and Enter would send it to Jira in the browser rather than open
  // a panel that doesn't exist for it.
  await ctx.goTo('home')
  await wait(400)
  await key('k', ['meta'])
  await until(() => Boolean($('.command-palette-input')))
  await typeText('DSD-104')
  await until(() => Boolean(byText('.command-palette-item-label', 'DSD-104')), 3000)
  const doneTicketItem = byText('.command-palette-item-label', 'DSD-104')?.closest(
    '.command-palette-item'
  )
  await check(
    '⌘K on a Done ticket not on the board says "Opens in Jira"',
    Boolean(
      doneTicketItem
        ?.querySelector('.command-palette-item-sublabel')
        ?.textContent?.includes('Opens in Jira')
    )
  )
  await key('Escape')

  // A branch name (3+ characters): the fixture origin has feature/remote-only.
  // Choosing it must open the composer already set to run on that branch —
  // not the default branch (checkout mode dropped the preset) or the
  // new-branch-name field (worktree mode misread it as one to create).
  await ctx.goTo('home')
  await wait(400)
  try {
    await key('k', ['meta'])
    await until(() => Boolean($('.command-palette-input')))
    await typeText('remote-only')
    await check(
      '⌘K matches a branch name across projects',
      await until(() => Boolean(byText('.command-palette-item-label', 'feature/remote-only')), 5000)
    )
    await click(byText('.command-palette-item-label', 'feature/remote-only'))
    await check(
      'choosing a branch opens the composer already set to run on it',
      await until(() => Boolean(byText('button', 'Start on feature/remote-only')), 3000)
    )
  } finally {
    // Whether the assertion above passed or not, close whatever the palette
    // or the composer sheet left open so the next check starts clean.
    await key('Escape')
    await key('Escape')
  }

  await log(`SUMMARY ${passed} passed, ${failed} failed`)
}
