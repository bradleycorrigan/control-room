// Dev-only interaction check for session tabs (`npm run shot:fixture --
// tabs-interactions <theme>`). Drives the real app with real input via
// main's `dev:input` and logs one PASS/FAIL line per behaviour to the run
// output. Only ever registered as a shot screen; never runs otherwise.

type Api = { invoke: <T>(channel: string, ...args: unknown[]) => Promise<T> }
const api = (window as unknown as { api: Api }).api

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (message: string): Promise<void> => api.invoke('dev:log', message)
const input = (event: Record<string, unknown>): Promise<void> => api.invoke('dev:input', event)

type Modifier = 'meta' | 'shift' | 'alt' | 'control'

async function click(
  el: Element | null,
  button: 'left' | 'middle' | 'right' = 'left',
  modifiers: Modifier[] = []
): Promise<boolean> {
  if (!el) return false
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + Math.min(r.width / 2, 40))
  const y = Math.round(r.top + r.height / 2)
  await input({ type: 'mouseMove', x, y, modifiers })
  await input({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers })
  await input({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers })
  await wait(250)
  return true
}

async function key(keyCode: string, modifiers: Modifier[] = []): Promise<void> {
  await input({ type: 'keyDown', keyCode, modifiers })
  await input({ type: 'keyUp', keyCode, modifiers })
  await wait(300)
}

// Session tabs only — the pinned house tab is checked on its own.
const tabs = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.cr-tab:not(.cr-tab--home)')
]
const homeTab = (): HTMLElement | null => document.querySelector('.cr-tab--home')
const onList = (): boolean => homeTab()?.classList.contains('cr-tab--active') ?? false
const activeIndex = (): number => tabs().findIndex((t) => t.classList.contains('cr-tab--active'))
const stored = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem('session-tabs') ?? '[]') as string[]
  } catch {
    return []
  }
}
const onSessionScreen = (): boolean =>
  Boolean(document.querySelector('.cr-session-body > .session-detail'))
const title = (el: HTMLElement | undefined): string =>
  el?.querySelector('.cr-tab-title')?.textContent ?? ''

export interface TabsCheckContext {
  goToSessionsList: () => Promise<void>
  goHome: () => Promise<void>
}

export async function runTabsCheck(ctx: TabsCheckContext): Promise<void> {
  let passed = 0
  let failed = 0
  const check = async (name: string, ok: boolean, detail = ''): Promise<void> => {
    if (ok) passed++
    else failed++
    await log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  await ctx.goToSessionsList()
  await wait(600)
  const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.sessions-row')]

  // --- opening in the background from the Sessions list
  await click(rows()[0], 'left', ['meta'])
  await check(
    '⌘-click a row opens a background tab',
    stored().length === 1 && !onSessionScreen(),
    `tabs=${stored().length} onSession=${onSessionScreen()}`
  )
  await click(rows()[1], 'middle')
  await check(
    'middle-click a row opens a background tab',
    stored().length === 2 && !onSessionScreen(),
    `tabs=${stored().length}`
  )
  await click(rows()[2], 'left', ['meta'])
  await click(rows()[3], 'left')
  await wait(500)
  await check(
    'plain click opens and switches',
    onSessionScreen() && tabs().length === 4,
    `tabs=${tabs().length} onSession=${onSessionScreen()}`
  )
  await check(
    'the clicked session is the active tab',
    activeIndex() === 3,
    `active=${activeIndex()}`
  )

  // --- switching
  await click(tabs()[0])
  await check('click a tab switches to it', activeIndex() === 0, `active=${activeIndex()}`)
  await key('9', ['meta'])
  await check(
    '⌘9 jumps to the last tab',
    activeIndex() === tabs().length - 1,
    `active=${activeIndex()}`
  )
  await key('3', ['meta'])
  await check('⌘3 jumps to the third tab', activeIndex() === 2, `active=${activeIndex()}`)
  await key('[', ['meta', 'shift'])
  await check('⌘⇧[ goes to the previous tab', activeIndex() === 1, `active=${activeIndex()}`)
  await key(']', ['meta', 'shift'])
  await check('⌘⇧] goes to the next tab', activeIndex() === 2, `active=${activeIndex()}`)
  await key('Tab', ['control'])
  await check('⌃Tab goes to the next tab', activeIndex() === 3, `active=${activeIndex()}`)
  await key('Tab', ['control', 'shift'])
  await check('⌃⇧Tab goes to the previous tab', activeIndex() === 2, `active=${activeIndex()}`)
  await key('[', ['meta'])
  await check(
    '⌘[ is still Back, not a tab switch',
    !onSessionScreen() || activeIndex() !== 1,
    `onSession=${onSessionScreen()} active=${activeIndex()}`
  )
  await key(']', ['meta'])
  await wait(300)

  // --- ⌘T opens the composer; Escape closes it and leaves the tabs alone
  const tabsBeforeT = tabs().length
  await key('t', ['meta'])
  const dialog = document.querySelector('[role="dialog"]')
  await check(
    '⌘T opens the new session composer',
    (dialog?.textContent ?? '').includes('New session'),
    dialog ? 'open' : 'no dialog'
  )
  await key('Escape')
  await check(
    'closing the composer leaves the tabs as they were',
    !document.querySelector('[role="dialog"]') && tabs().length === tabsBeforeT
  )

  // --- right-click menu
  const before = title(tabs()[0])
  await click(tabs()[0], 'right')
  const menu = document.querySelector('.cr-tab-menu')
  const labels = [...(menu?.querySelectorAll('.cr-popover-item') ?? [])].map((b) => b.textContent)
  await check(
    'right-click opens the tab menu',
    Boolean(menu) && labels.length >= 3,
    labels.join(', ')
  )
  const unreadItem = [...(menu?.querySelectorAll<HTMLElement>('.cr-popover-item') ?? [])].find(
    (b) => b.textContent === 'Mark as unread'
  )
  await click(unreadItem ?? null)
  await wait(2500)
  await check(
    'Mark as unread from the tab menu marks the tab',
    tabs()[0]?.classList.contains('cr-tab--unread') ?? false,
    before
  )

  // --- drag to reorder. DOM drag events only: synthetic mouse input can
  // start a real OS drag session but never finish it, which left a tab's
  // drag image floating over every app on the desktop and swallowed all
  // later input until something else ended the drag.
  const order = (): string[] => tabs().map((t) => title(t))
  const beforeOrder = order()
  const dt = new DataTransfer()
  tabs()[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  await wait(50)
  tabs()[2].dispatchEvent(
    new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
  )
  await wait(50)
  tabs()[2].dispatchEvent(
    new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
  )
  tabs()[0]?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  await wait(400)
  const afterOrder = order()
  await check(
    'drag reorders tabs (DOM drag events)',
    afterOrder[2] === beforeOrder[0] && afterOrder.length === beforeOrder.length,
    `${beforeOrder.join(' | ')} → ${afterOrder.join(' | ')}`
  )

  // --- closing
  const count = tabs().length
  const activeTitle = title(tabs()[activeIndex()])
  await key('w', ['meta'])
  await check(
    '⌘W closes the active tab',
    tabs().length === count - 1 && !order().includes(activeTitle),
    `${count} → ${tabs().length}`
  )
  await check('closing moves to a neighbour tab', onSessionScreen() && activeIndex() >= 0)
  // The next session's screen mounts after a close; give it a moment.
  await wait(800)
  const inactive = tabs().findIndex((t) => !t.classList.contains('cr-tab--active'))
  await click(tabs()[inactive], 'middle')
  await check('middle-click a tab closes it', tabs().length === count - 2, `${tabs().length}`)
  await click(tabs()[0].querySelector('.cr-tab-close'))
  await check(
    'the × closes a tab; the strip stays with one left',
    tabs().length === 1 && onSessionScreen(),
    `strip tabs=${tabs().length} stored=${stored().length}`
  )

  // --- Home cards, close others, close to the right
  await ctx.goHome()
  await wait(600)
  const cards = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('.cr-session-card:not(.cr-session-card--new)')
  ]
  const storedBefore = stored().length
  // By session, not position: opening one in the background can re-order
  // the cards, and the second click then landed on one already open.
  const keyOf = (c: HTMLElement | undefined): string | null =>
    c?.closest('[data-session-key]')?.getAttribute('data-session-key') ?? null
  const cardFor = (k: string | null): HTMLElement | undefined =>
    cards().find((c) => keyOf(c) === k)
  const [firstKey, secondKey] = [keyOf(cards()[1]), keyOf(cards()[2])]
  await click(cardFor(firstKey) ?? null, 'left', ['meta'])
  await click(cardFor(secondKey) ?? null, 'middle')
  const toast = [...document.querySelectorAll('.toast, [class*="toast"]')].some((t) =>
    (t.textContent ?? '').includes('in a tab')
  )
  await check(
    '⌘/middle-click on Home cards open background tabs',
    stored().length === storedBefore + 2 && !onSessionScreen(),
    `stored ${storedBefore} → ${stored().length}`
  )
  await check('a toast confirms the background tab', toast)
  await click(cards()[0])
  await wait(500)
  await check('opening a card shows the strip', tabs().length >= 3, `tabs=${tabs().length}`)
  await click(tabs()[0], 'right')
  const closeRight = [
    ...document.querySelectorAll<HTMLElement>('.cr-tab-menu .cr-popover-item')
  ].find((b) => b.textContent === 'Close tabs to the right')
  const n = tabs().length
  await click(closeRight ?? null)
  await check(
    'Close tabs to the right',
    stored().length === 1 || tabs().length < n,
    `${n} → ${stored().length}`
  )
  // Re-add two, then close the others.
  await ctx.goHome()
  await wait(400)
  await click(cards()[1], 'left', ['meta'])
  await click(cards()[2], 'left', ['meta'])
  await click(cards()[3], 'left')
  await wait(500)
  await click(tabs()[activeIndex()], 'right')
  const closeOthers = [
    ...document.querySelectorAll<HTMLElement>('.cr-tab-menu .cr-popover-item')
  ].find((b) => b.textContent === 'Close other tabs')
  await click(closeOthers ?? null)
  await check(
    'Close other tabs leaves one',
    stored().length === 1 && onSessionScreen(),
    `stored=${stored().length}`
  )
  // Only on a session: ⌘W anywhere else closes the window, and with it the run.
  if (onSessionScreen()) await key('w', ['meta'])
  await wait(300)
  await check(
    '⌘W on the last tab returns to the list',
    !onSessionScreen() && stored().length === 0,
    `onSession=${onSessionScreen()} stored=${stored().length}`
  )

  // --- ⌘⇧1 / ⌘⇧2 still reach Projects and Sessions
  await key('1', ['meta', 'shift'])
  await check(
    '⌘⇧1 opens Projects',
    document.querySelector('.main-pane')?.getAttribute('data-screen') === 'projects'
  )
  await key('2', ['meta', 'shift'])
  await check(
    '⌘⇧2 opens Sessions',
    document.querySelector('.main-pane')?.getAttribute('data-screen') === 'sessions'
  )

  // --- reopen closed tab, rename, J/K
  {
    await ctx.goToSessionsList()
    await wait(400)
    await click(rows()[0], 'left', ['meta'])
    await click(rows()[1], 'left', ['meta'])
    await click(rows()[2])
    await wait(500)
    const before = tabs().map((t) => title(t))
    const closing = title(tabs()[tabs().length - 1])
    await click(tabs()[tabs().length - 1]?.querySelector('.cr-tab-close') ?? null)
    await click(tabs()[0], 'right')
    const reopen = [
      ...document.querySelectorAll<HTMLElement>('.cr-tab-menu .cr-popover-item')
    ].find((b) => b.textContent === 'Reopen closed tab')
    await click(reopen ?? null)
    await wait(300)
    await check(
      'Reopen closed tab brings the last closed tab back',
      tabs()
        .map((t) => title(t))
        .includes(closing),
      `${before.join(' | ')} / reopened ${closing}`
    )

    const target = tabs()[0]
    const t = target?.querySelector('.cr-tab-title')
    if (t) t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(200)
    const input = document.querySelector<HTMLInputElement>('.cr-tab-rename')
    await check('double-clicking a tab title offers a rename field', Boolean(input))
    if (input) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wait(200)
    }
    await check('Escape cancels the rename', !document.querySelector('.cr-tab-rename'))

    await ctx.goToSessionsList()
    await wait(400)
    ;(document.activeElement as HTMLElement | null)?.blur()
    await key('j')
    const first = document.activeElement
    await key('j')
    const second = document.activeElement
    await check(
      'J focuses the first session, then the next, in screen order',
      first === rows()[0] && second === rows()[1],
      `${first?.className} / ${second?.className}`
    )
    await key('k')
    await check('K moves back up', document.activeElement === rows()[0])
    await key('Enter')
    await wait(400)
    await check('Enter opens the focused session', onSessionScreen())
  }

  // --- the header's close button closes the tab, and only the tab
  {
    await ctx.goToSessionsList()
    await wait(400)
    await click(rows()[0], 'left', ['meta'])
    await click(rows()[1])
    await wait(500)
    const n = tabs().length
    const closing = title(tabs()[activeIndex()])
    const x = document.querySelector<HTMLElement>('[aria-label="Close tab (⌘W)"]')
    await click(x)
    await wait(400)
    await ctx.goToSessionsList()
    await wait(400)
    const stillListed = rows().some((r) => r.textContent?.includes(closing))
    await check(
      'the header × closes the tab and the session stays',
      tabs().length === n - 1 && stillListed,
      `${n} → ${tabs().length}, listed=${stillListed}`
    )
  }

  // --- the pinned house tab
  await ctx.goToSessionsList()
  await wait(500)
  await check('the house tab is there, and active, on the list', onList())
  const main = (): HTMLElement | null => document.querySelector('.sessions-main')
  if (main()) main()!.scrollTop = 240
  await wait(200)
  const scrolled = main()?.scrollTop ?? 0
  const visibleRow = rows().find((r) => {
    const b = r.getBoundingClientRect()
    return b.top > 120 && b.bottom < window.innerHeight - 20
  })
  await click(visibleRow ?? null)
  await wait(500)
  await check('opening a session leaves the house tab inactive', onSessionScreen() && !onList())
  await click(homeTab())
  await wait(400)
  await check('clicking the house goes back to the list', onList() && !onSessionScreen())
  await check(
    'the list kept its scroll position',
    Math.abs((main()?.scrollTop ?? 0) - scrolled) < 2,
    `${scrolled} → ${main()?.scrollTop}`
  )
  await click(tabs()[0])
  await key('0', ['meta'])
  await check('⌘0 goes to the list', onList() && !onSessionScreen())
  await click(tabs()[0])
  await key('Tab', ['control', 'shift'])
  await check('the house is in the ⌃Tab cycle', onList())

  // --- Sessions in the top bar: back to your session, then up to the list
  const nav = (label: string): HTMLElement | null =>
    [...document.querySelectorAll<HTMLElement>('.app-titlebar-no-drag .cr-segmented__option')].find(
      (b) => b.textContent === label
    ) ?? null
  await ctx.goToSessionsList()
  await wait(400)
  await click(rows()[0])
  await wait(400)
  await click(nav('Home'))
  await click(nav('Sessions'))
  await check('Sessions from elsewhere returns to the open session', onSessionScreen())
  await click(nav('Sessions'))
  await check(
    'Sessions again goes up to the list',
    !onSessionScreen() && Boolean(document.querySelector('.sessions-view'))
  )

  await log(`SUMMARY ${passed} passed, ${failed} failed`)
}
