// Dev-only screenshot hook. Screens register themselves here so `npm run shot
// -- <screen> <theme>` can navigate to them before capture. Only wired up
// when the main process is actually running a screenshot pass, so this never
// touches normal app behaviour.
type ShotCommand = { screen: string; theme: string }
type ShotActivator = () => void | Promise<void>

const registry = new Map<string, ShotActivator>()
let reset: ShotActivator | null = null

export function registerShotScreen(name: string, activate: ShotActivator): void {
  registry.set(name, activate)
}

/**
 * Puts the app back to a known state before each screen is set up.
 *
 * A batch run reuses one window, so whatever the last screen left open is
 * still open for the next one — which is how a menu shot came back with the
 * menu toggled shut and a dialog shot came back buried under an unrelated
 * modal. A harness that quietly photographs the wrong thing is worse than no
 * harness, so every screen starts from the same place.
 */
export function registerShotReset(activate: ShotActivator): void {
  reset = activate
}

let disposePrevious: (() => void) | null = null

/**
 * Idempotent by design. App.tsx calls this from an effect whose deps include
 * `sessions`, which changes on every 2s poll, so it runs constantly — and this
 * used to add a listener each time without removing the last. Every stacked
 * listener then answered the same `dev:shot-command`, so main got N
 * `dev:shot-ready` replies for one command and captured on the first, which
 * could easily be a listener that had activated a different screen. That is how
 * a batch run produced one dialog's screenshot under another dialog's filename —
 * a verification harness quietly telling you about the wrong screen, which is
 * worse than no screenshot at all.
 */
export function initShotListener(setTheme: (theme: string) => void): void {
  const api = (
    window as unknown as {
      api?: {
        on: (channel: string, fn: (payload: unknown) => void) => () => void
        invoke: <T>(channel: string, payload?: unknown) => Promise<T>
      }
    }
  ).api
  if (!api) return

  disposePrevious?.()
  // Main sends the command on did-finish-load, which happens before React has
  // mounted and run this. The event is not a queue, so a command that arrives
  // first is simply lost and the shot falls through to main's safety net —
  // capturing whatever screen the app booted to. Announcing here lets main
  // send once it knows someone is listening.
  disposePrevious = api.on('dev:shot-command', async (payload: unknown) => {
    const { screen, theme } = payload as ShotCommand
    if (theme) setTheme(theme)
    const startedAt = Date.now()

    // The listener and the screen registry are set up by two different
    // effects, so a command can arrive in the gap between them. That used to
    // be hidden by how slow the reset was; once discovery went from 5.6s to
    // 56ms the race opened up and shots started coming back on whatever
    // screen the app happened to boot to. Wait for the screen to exist, and
    // say so loudly rather than photographing the wrong one.
    let activate = screen ? registry.get(screen) : undefined
    for (let waited = 0; screen && !activate && waited < 3000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      activate = registry.get(screen)
    }
    if (screen && !activate) {
      console.error(`dev-shot: no screen registered as "${screen}" — capturing as-is`)
    }

    // Anything thrown in here used to kill the handler outright: main then sat
    // on its safety net and captured whatever was on screen. The report below
    // always goes out, and carries the failure when there is one.
    let failure: string | null = null
    try {
      await reset?.()
      await activate?.()
    } catch (err) {
      failure = String(err)
      console.error('dev-shot: screen setup failed', err)
    }
    // A beat for React to commit the screen change. The two rAF ticks below
    // are about paint, not about state: in a window this small and fast they
    // can both fire inside the same commit, which is how a shot came back on
    // the screen the app booted to instead of the one it was asked for.
    await new Promise((resolve) => setTimeout(resolve, 150))
    console.log(`dev-shot: ${screen} set up in ${Date.now() - startedAt}ms`)
    // Printed so a shot that came back wrong can be told apart from a shot
    // that came back slow.
    console.log(`dev-shot: ${screen} ready in ${Date.now() - startedAt}ms`)
    // Two rAF ticks so React has committed and the browser has painted
    // before main captures the page. The payload is what the harness believes
    // it set up — main logs it, so a shot that came back on the wrong screen
    // says so in the run output instead of only in the PNG.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        api.invoke('dev:shot-ready', {
          screen,
          hadActivator: Boolean(activate),
          failure,
          onScreen: document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null,
          ms: Date.now() - startedAt
        })
      })
    })
  })

  api.invoke('dev:shot-listening')
}
