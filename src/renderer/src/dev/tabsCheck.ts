// Dev-only interaction check for session tabs (`npm run shot:fixture --
// tabs-interactions <theme>`). Drives the real app with real input via
// main's `dev:input` and logs one PASS/FAIL line per behaviour to the run
// output. Only ever registered as a shot screen; never runs otherwise.

import { failureSnapshot, trackPointer } from './failureSnapshot'

type Api = { invoke: <T>(channel: string, ...args: unknown[]) => Promise<T> }
const api = (window as unknown as { api: Api }).api

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Polls until `cond` holds (or the time runs out). Only for the state the next line needs. */
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await wait(100)
  }
  return cond()
}
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
// Not the tabs folded away in a collapsed group: drawn, but not there for you.
const tabs = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.cr-tab:not(.cr-tab--home):not(.cr-tab--folded)')
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
  trackPointer()
  let passed = 0
  let failed = 0
  const check = async (name: string, ok: boolean, detail = ''): Promise<void> => {
    if (ok) passed++
    else failed++
    const where = ok ? '' : ` [${failureSnapshot()}]`
    await log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}${where}`)
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
  const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.session-card')]
  const storedBefore = stored().length
  // By session, not position: opening one in the background can re-order
  // the cards, and the second click then landed on one already open.
  const keyOf = (c: HTMLElement | undefined): string | null =>
    c?.closest('[data-session-key]')?.getAttribute('data-session-key') ?? null
  const cardFor = (k: string | null): HTMLElement | undefined => cards().find((c) => keyOf(c) === k)
  // And two that aren't open already: opening an open one adds no tab, which
  // is what this flaked on when the one tab left was one of them.
  const [firstKey, secondKey] = cards()
    .map(keyOf)
    .filter((k): k is string => Boolean(k) && !stored().includes(k!))
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
  // Re-add two, then close the others. Each pick reads the cards and the stored
  // list fresh, after the click before it has landed: the stored list updates
  // after an IPC round trip, so a pick made straight after a click still sees
  // that session as not open. Picks are by session, never by position.
  await ctx.goHome()
  await wait(400)
  const openedBefore = stored().length
  const unopenedKey = (): string | null =>
    cards()
      .map(keyOf)
      .find((k): k is string => Boolean(k) && !stored().includes(k as string)) ?? null
  const titleOf = (k: string | null): string =>
    cardFor(k)?.querySelector('.session-card-title')?.textContent ?? '?'
  const picked: string[] = []
  for (let i = 0; i < 2; i++) {
    const k = unopenedKey()
    picked.push(titleOf(k))
    await click(cardFor(k) ?? null, 'left', ['meta'])
    await until(() => stored().length === openedBefore + i + 1)
  }
  // A plain click switches to a session, which gives the strip an active tab.
  const last =
    unopenedKey() ??
    cards()
      .map(keyOf)
      .find((k): k is string => Boolean(k)) ??
    null
  picked.push(titleOf(last))
  await click(cardFor(last) ?? null, 'left')
  await until(onSessionScreen)
  await until(() => activeIndex() >= 0)
  await click(tabs()[activeIndex()] ?? null, 'right')
  const closeOtherItem = (): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('.cr-tab-menu .cr-popover-item')].find(
      (b) => b.textContent === 'Close other tabs'
    )
  await until(() => Boolean(closeOtherItem()))
  await click(closeOtherItem() ?? null)
  await check(
    'Close other tabs leaves one',
    stored().length === 1 && onSessionScreen(),
    `stored=${stored().length} picked=${picked.join(', ')} active=${activeIndex()}`
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

  // --- pinning, colour and groups
  {
    const menuItem = (label: string): HTMLElement | null =>
      [...document.querySelectorAll<HTMLElement>('.cr-tab-menu .cr-popover-item')].find(
        (b) => b.textContent === label
      ) ?? null
    const tabMenu = async (tab: HTMLElement | undefined, label: string): Promise<boolean> => {
      await click(tab ?? null, 'right')
      await until(() => Boolean(menuItem(label)))
      const item = menuItem(label)
      await click(item)
      return Boolean(item)
    }
    await ctx.goToSessionsList()
    await wait(400)
    await click(rows()[0], 'left', ['meta'])
    await click(rows()[1], 'left', ['meta'])
    await click(rows()[2])
    await until(onSessionScreen)
    await wait(300)

    const pinning = title(tabs()[2])
    const found = await tabMenu(tabs()[2], 'Pin tab')
    await wait(300)
    await check(
      'Pin tab moves the tab first, with a pin instead of the ×',
      found &&
        title(tabs()[0]) === pinning &&
        tabs()[0].classList.contains('cr-tab--pinned') &&
        !tabs()[0].querySelector('.cr-tab-close'),
      `found=${found} first=${title(tabs()[0])} wanted=${pinning}`
    )
    await tabMenu(tabs()[2], 'Close other tabs')
    await wait(300)
    await check(
      'Close other tabs keeps the pinned tab',
      tabs().length === 2 && title(tabs()[0]) === pinning,
      tabs().map(title).join(' | ')
    )

    await click(tabs()[1], 'right')
    await until(() =>
      Boolean(document.querySelector('.cr-tab-menu .cr-swatch[data-colour="green"]'))
    )
    await click(document.querySelector('.cr-tab-menu .cr-swatch[data-colour="green"]'))
    await wait(300)
    await check(
      'a colour from the tab menu colours the tab',
      tabs()[1]?.dataset.tabColour === 'green' && tabs()[1].classList.contains('cr-tab--coloured'),
      `colour=${tabs()[1]?.dataset.tabColour}`
    )
    if (document.querySelector('.cr-tab-menu')) await key('Escape')
    // The list stays mounted under an open session, so its rows can be read here.
    await check(
      'a coloured tab shows its colour on its Sessions row',
      Boolean(document.querySelector('.sessions-row [data-session-label="green"]'))
    )
    // And on the strip while you're in it: the line runs under the tab you're on.
    await click(tabs()[1])
    await check(
      'the tab you are on keeps its colour line',
      tabs()[1]?.classList.contains('cr-tab--active') &&
        getComputedStyle(tabs()[1], '::after').content !== 'none',
      `content=${tabs()[1] ? getComputedStyle(tabs()[1], '::after').content : '-'}`
    )

    await tabMenu(tabs()[1], 'Add to new group')
    const nameField = await until(() => Boolean(document.querySelector('.cr-tab-group-input')))
    const field = document.querySelector<HTMLInputElement>('.cr-tab-group-input')
    await check(
      'Add to new group makes a group and asks for its name',
      nameField &&
        Boolean(document.querySelector('.cr-tab-group')) &&
        document.activeElement === field,
      `field=${nameField} focus=${document.activeElement?.className}`
    )
    if (field) {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(field, 'Review')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      await key('Enter')
    }
    const groupLabel = (): HTMLElement | null => document.querySelector('.cr-tab-group-label')
    await check(
      'the group shows its name, in the tab’s colour',
      (groupLabel()?.textContent ?? '').includes('Review') &&
        !document.querySelector('.cr-tab-group-input') &&
        (
          document
            .querySelector<HTMLElement>('.cr-tab-group')
            ?.style.getPropertyValue('--tab-colour') ?? ''
        ).includes('green'),
      `label=${groupLabel()?.textContent}`
    )

    // Fold it away from the pinned tab, so the grouped one isn't the tab you're on.
    await click(tabs()[0])
    await click(groupLabel())
    await check(
      'clicking a group’s label folds its tabs away',
      tabs().length === 1 && groupLabel()?.getAttribute('aria-expanded') === 'false',
      `tabs=${tabs().length}`
    )
    // It slides shut rather than vanishing: still drawn, no width, out of reach.
    await wait(400)
    const folded = document.querySelector<HTMLElement>('.cr-tab--folded')
    await check(
      'a folded tab slides shut to no width and is out of reach',
      Boolean(folded) && (folded?.offsetWidth ?? 99) <= 2 && folded?.hasAttribute('inert') === true,
      `width=${folded?.offsetWidth}`
    )
    // Pinned, then the folded tab, then round to the house: ⌘⇧] skips the folded one.
    await key(']', ['meta', 'shift'])
    await check('⌘⇧] skips a folded tab', onList(), `active=${activeIndex()} onList=${onList()}`)
    await click(tabs()[0])
    await click(groupLabel())
    await check('clicking it again shows them', tabs().length === 2, `tabs=${tabs().length}`)

    // Several tabs at once: shift-click two, colour them, then group them.
    await click(tabs()[0], 'left', ['shift'])
    await click(tabs()[1], 'left', ['shift'])
    await check(
      'shift-click picks tabs',
      document.querySelectorAll('.cr-tab--picked').length === 2,
      `picked=${document.querySelectorAll('.cr-tab--picked').length}`
    )
    await click(tabs()[1], 'right')
    await until(() => Boolean(menuItem('Add 2 tabs to group')))
    const addTo = menuItem('Add 2 tabs to group')
    await check(
      'the menu acts on both picked tabs',
      Boolean(addTo) && Boolean(menuItem('Close 2 tabs'))
    )
    await click(addTo)
    const sub = await until(() =>
      [...document.querySelectorAll<HTMLElement>('[data-submenu] .cr-popover-item')].some((b) =>
        (b.textContent ?? '').includes('Review')
      )
    )
    await click(
      [...document.querySelectorAll<HTMLElement>('[data-submenu] .cr-popover-item')].find((b) =>
        (b.textContent ?? '').includes('Review')
      ) ?? null
    )
    await wait(300)
    await check(
      'existing groups are in a submenu, and picking one moves every picked tab',
      sub &&
        document.querySelectorAll('.cr-tab-group .cr-tab').length === 2 &&
        document.querySelectorAll('.cr-tab--picked').length === 0,
      `grouped=${document.querySelectorAll('.cr-tab-group .cr-tab').length}`
    )
    // Pinned tabs leave their group when pinned, so take the pinned one back out.
    await tabMenu(tabs()[0], 'Remove from group')
    await wait(300)
    if (!tabs()[0]?.classList.contains('cr-tab--pinned')) await tabMenu(tabs()[0], 'Pin tab')
    await wait(300)

    await click(groupLabel(), 'right')
    const ungroup = await until(() => Boolean(menuItem('Ungroup')))
    await click(menuItem('Ungroup'))
    await wait(300)
    await check(
      'Ungroup keeps the tab and drops the group',
      ungroup && !document.querySelector('.cr-tab-group') && tabs().length === 2,
      `tabs=${tabs().length}`
    )
    await tabMenu(tabs()[0], 'Unpin tab')
    await wait(300)
    await check(
      'Unpin tab gives it its × back',
      !document.querySelector('.cr-tab--pinned') &&
        Boolean(tabs()[0]?.querySelector('.cr-tab-close'))
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
  const first = rows()[0]
  // An earlier step left the list scrolled: bring the row out from under the tabs.
  first?.scrollIntoView({ block: 'center' })
  await wait(100)
  const box = first?.getBoundingClientRect()
  const under = box
    ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    : null
  await click(first)
  await wait(400)
  const opened = onSessionScreen()
  await click(nav('Home'))
  await click(nav('Sessions'))
  await check(
    'Sessions from elsewhere returns to the open session',
    onSessionScreen(),
    `row click opened it: ${opened}; under the pointer: ${under?.tagName}.${under?.className}`
  )
  await click(nav('Sessions'))
  await check(
    'Sessions again goes up to the list',
    !onSessionScreen() && Boolean(document.querySelector('.sessions-view'))
  )

  await log(`SUMMARY ${passed} passed, ${failed} failed`)
}
