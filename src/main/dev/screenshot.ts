import { app, ipcMain, type BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { log } from '../log'

// Dev-only capture flow, gated behind CR_SHOT. Verifier agents use this to
// LOOK at the UI (npm run shot -- <screen> <theme>) instead of only grepping
// source. Never runs in a packaged build.
export const isScreenshotMode = !app.isPackaged && process.env.CR_SHOT === '1'

// `app.exit(code)` tears the process down immediately and skips `before-quit`
// — the handler in index.ts that stops tmux control clients and ptys and
// flushes the last debounced fixture save. A failed shot run (including the
// gate's interactions run) left all of that running. `app.quit()` runs that
// cleanup first; `will-quit` is where the exit code is still ours to set.
function exitWithCode(code: number): void {
  app.once('will-quit', (e) => {
    e.preventDefault()
    app.exit(code)
  })
  app.quit()
}

export async function runScreenshotFlow(win: BrowserWindow): Promise<void> {
  const outDir = process.env.CR_SHOT_OUT_DIR ?? join(process.cwd(), '.dev', 'shots')
  const width = process.env.CR_SHOT_WIDTH ? parseInt(process.env.CR_SHOT_WIDTH, 10) : undefined
  // Verifier-only escape hatch for a screen taller than the default window
  // (e.g. Overview's History section, below the fold) — not part of the
  // documented `npm run shot -- <screen> <theme> [width]` interface.
  const heightOverride = process.env.CR_SHOT_HEIGHT
    ? parseInt(process.env.CR_SHOT_HEIGHT, 10)
    : undefined

  // Parse combinations from env var. For backward compatibility, also support
  // CR_SHOT_SCREEN/THEME single-shot mode.
  interface ShotCombo {
    screen: string
    theme: string
    name?: string
  }

  let combos: ShotCombo[] = []
  if (process.env.CR_SHOT_COMBOS) {
    try {
      combos = JSON.parse(process.env.CR_SHOT_COMBOS)
    } catch {
      log.error('dev-shot: failed to parse CR_SHOT_COMBOS')
      exitWithCode(1)
      return
    }
  } else {
    // Backward compatibility: single-shot mode
    const screen = process.env.CR_SHOT_SCREEN ?? ''
    const theme = process.env.CR_SHOT_THEME ?? ''
    const name = process.env.CR_SHOT_NAME ?? `${screen || 'app'}-${theme || 'default'}`
    combos = [{ screen, theme, name }]
  }

  if (combos.length === 0) {
    log.error('dev-shot: no combinations to capture')
    exitWithCode(1)
    return
  }

  if ((width && Number.isFinite(width)) || (heightOverride && Number.isFinite(heightOverride))) {
    const [defaultWidth, defaultHeight] = win.getSize()
    win.setSize(
      width && Number.isFinite(width) ? width : defaultWidth,
      heightOverride && Number.isFinite(heightOverride) ? heightOverride : defaultHeight
    )
  }

  await mkdir(outDir, { recursive: true })

  // Interaction checks drive the app with real input — a click, a key, a
  // modifier — through Chromium's own input pipeline, so a test exercises
  // the same path a hand on the trackpad does (⌘W's before-input-event
  // included), not a synthetic DOM event that skips half of it.
  ipcMain.handle('dev:input', (_evt, input: Electron.InputEvent) => {
    win.webContents.sendInputEvent(input as Parameters<typeof win.webContents.sendInputEvent>[0])
  })
  // Minimise/restore, for checks of what a window looks like coming back.
  ipcMain.handle('dev:window', async (_evt, action: 'minimize' | 'restore') => {
    if (action === 'minimize') win.minimize()
    else {
      win.restore()
      win.focus()
    }
  })
  // Rewrites one fixture session's status file, the way Claude Code does when
  // a turn starts or ends — for timing how fast the app notices. Fixture
  // directory only; never a real session.
  ipcMain.handle('dev:set-fixture-status', async (_evt, file: string, status: string) => {
    const dir = process.env.CR_SESSIONS_DIR
    if (!dir || !/^[a-z-]+\.json$/.test(file)) return
    const { readFile, writeFile: write } = await import('fs/promises')
    const path = join(dir, file)
    const data = JSON.parse(await readFile(path, 'utf8'))
    data.status = status
    data.statusUpdatedAt = Date.now()
    await write(path, JSON.stringify(data, null, 2))
  })
  // What macOS does with a screenshot dragged from its preview thumbnail: a
  // real PNG in a TemporaryItems/NSIRD_screencaptureui_… folder, deleted
  // moments after the drop. The page checks make one, drop it, then delete it.
  ipcMain.handle('dev:fresh-screenshot', async () => {
    const { tmpdir } = await import('os')
    const dir = join(tmpdir(), 'TemporaryItems', `NSIRD_screencaptureui_${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'Screenshot 2026-09-25 at 09.00.00.png')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    await writeFile(path, png)
    return path
  })
  ipcMain.handle('dev:delete-fresh-screenshot', async (_evt, path: string) => {
    if (!/NSIRD_screencaptureui_\d+/.test(path)) return
    const { rm } = await import('fs/promises')
    await rm(join(path, '..'), { recursive: true, force: true })
  })
  // Chromium's own warnings about GPU contexts, counted for the page checks:
  // "Too many active WebGL contexts" is what came before the terminal's sad face.
  let webglWarnings = 0
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { message?: string } | undefined
    const message = typeof args[2] === 'string' ? args[2] : (first?.message ?? '')
    if (/WebGL contexts|CONTEXT_LOST_WEBGL/i.test(message)) webglWarnings++
  })
  ipcMain.handle('dev:webgl-warnings', () => webglWarnings)
  // Hands a real fixture pane a "prompt" the way a new session's first prompt
  // goes in — with invisible characters and CRLFs in it — and reports whether
  // it actually ran (the shell echoes it back) without a second Enter.
  ipcMain.handle('dev:deliver-prompt', async () => {
    const { runTmux } = await import('../exec/run')
    const { deliverPrompt } = await import('../exec/tmux')
    const panes = await runTmux(['list-panes', '-s', '-t', '=cr-fixture', '-F', '#{pane_id}'])
    const pane = panes.stdout.split('\n').find(Boolean)
    if (!pane) return { ok: false, detail: 'no fixture pane' }
    const marker = `cr-prompt-${Date.now()}`
    const zw = String.fromCharCode(0x200b)
    const result = await deliverPrompt(pane, `echo ${zw}${marker}\r\n`)
    await new Promise((r) => setTimeout(r, 800))
    const out = await runTmux(['capture-pane', '-p', '-t', pane, '-S', '-20'])
    const ran = out.stdout.split('\n').some((l) => l.trim() === marker)
    return { ok: result.ok && ran, detail: result.error ?? (ran ? 'ran' : 'not run') }
  })
  // Types a command into every fixture pane (e.g. printing block characters
  // for a look at how the terminal draws them).
  ipcMain.handle('dev:pane-command', async (_evt, command: string) => {
    const { runTmux } = await import('../exec/run')
    const panes = await runTmux(['list-panes', '-s', '-t', '=cr-fixture', '-F', '#{pane_id}'])
    for (const pane of panes.stdout.split('\n').filter(Boolean)) {
      await runTmux(['send-keys', '-t', pane, '-l', '--', command])
      await runTmux(['send-keys', '-t', pane, 'C-m'])
    }
  })
  // The "+" terminal button splits a session's pane; the new shell must start
  // in that session's worktree. Picks a fixture pane that isn't the active
  // one, since tmux's own formats resolve against the active pane.
  ipcMain.handle('dev:split-check', async () => {
    const { runTmux } = await import('../exec/run')
    const { splitWindow } = await import('../exec/tmux')
    const panes = await runTmux([
      'list-panes',
      '-s',
      '-t',
      '=cr-fixture',
      '-F',
      '#{pane_active}#{window_active} #{pane_id} #{pane_current_path}'
    ])
    const target = panes.stdout
      .split('\n')
      .map((l) => l.split(' '))
      .find(([active, , path]) => active !== '11' && path?.includes('worktrees'))
    if (!target) return { target: null, got: null }
    const made = await splitWindow(target[1])
    if (!made.ok || !made.paneId) return { target: target[2], got: made.error ?? null }
    await new Promise((r) => setTimeout(r, 400))
    const got = await runTmux(['display-message', '-p', '-t', made.paneId, '#{pane_current_path}'])
    await runTmux(['kill-pane', '-t', made.paneId])
    return { target: target[2], got: got.stdout.trim() }
  })
  ipcMain.handle('dev:log', (_evt, message: string) => {
    log.info(`dev-check: ${message}`)
    // A check's SUMMARY is its last word. The renderer's ready signal after
    // it sometimes never arrived, and the run then sat out the whole time
    // cap — the "485s" tab runs that were really 35s.
    if (message.startsWith('SUMMARY')) setTimeout(() => readyResolve?.(), 500)
  })

  // Set up a single persistent handler for shot-ready that resolves a per-combo promise
  let readyResolve: (() => void) | null = null
  // The renderer announces when its shot listener is attached. That, not the
  // page load event, is when a command can actually be received: did-finish-load
  // fires before React has mounted, and `dev:shot-command` is an event, not a
  // queue, so a command sent then is simply dropped and the shot falls through
  // to the safety net on whatever screen the app booted to.
  let rendererListening = false
  let pendingSend: (() => void) | null = null
  ipcMain.handle('dev:shot-listening', () => {
    rendererListening = true
    pendingSend?.()
  })
  interface ShotReport {
    hadActivator: boolean
    failure: string | null
  }
  let lastReport: ShotReport | null = null
  ipcMain.handle('dev:shot-ready', (_evt, report?: unknown) => {
    log.info('dev-shot: renderer ready', { report })
    lastReport = report as ShotReport
    if (readyResolve) {
      readyResolve()
      readyResolve = null
    }
  })

  // What each combo actually did, so the run can exit non-zero on a real
  // failure instead of always looking like success. Exit code used to be
  // meaningless either way — 0 on an unknown screen name (it silently
  // captured whatever was on screen), and a bogus 1 whenever the process
  // was still doing teardown (ptys, tmux control sessions) when the outer
  // script's own timeout fired, even though the PNG had already landed.
  const failures: string[] = []

  // Capture each combination
  for (const combo of combos) {
    const { screen, theme } = combo
    const name = combo.name ?? `${screen || 'app'}-${theme || 'default'}`
    lastReport = null
    // Local to this combo, not shared: a shared flag meant an earlier combo's
    // safety-net timer, firing late in a run past 120s, could mark a later,
    // perfectly healthy combo as timed out after it had already reported
    // ready — bringing back the untrustworthy exit codes this was meant to fix.
    let timedOut = false
    const ready = new Promise<void>((resolve) => {
      // Safety net: a screen name the renderer doesn't recognise must not hang
      // forever. Generous, because the renderer now waits for sessions and
      // projects to actually load before setting a screen up — at 5s this
      // fired first and captured whatever happened to be on screen, which is
      // the harness silently photographing the wrong thing again.
      // Long, because a flow sweep really does drive several session
      // creations in one screen. Too short and this net fires mid-run and
      // captures a half-finished page as though it were the result.
      const timer = setTimeout(
        () => {
          log.warn('dev-shot: renderer never reported ready — capturing anyway', { screen, theme })
          timedOut = true
          resolve()
          // The interaction checks drive the whole app and have outgrown two
          // minutes; a healthy run is ~3.5. Runs used to stall for minutes
          // when this window sat behind others, because Chromium throttles
          // a hidden window's timers (fixed in index.ts); 10 is headroom.
        },
        /-interactions$/.test(screen) ? 600_000 : 120_000
      )
      // Resolved by the ready handler below (not just the timeout) — clear
      // the timer so it can't fire later, against a different combo, once
      // this one has already reported in.
      const resolveAndClear = (): void => {
        clearTimeout(timer)
        resolve()
      }
      readyResolve = resolveAndClear
    })

    // Once per combination, whichever trigger gets there first: the load
    // event, or the renderer announcing its listener. The renderer announces
    // on every re-render of the effect that attaches it, so without this the
    // command and the re-render fed each other in a loop.
    let sent = false
    const sendCommand = (): void => {
      if (sent) return
      sent = true
      win.webContents.send('dev:shot-command', { screen, theme })
    }

    pendingSend = sendCommand
    // Already announced (every combination after the first in a batch) — go
    // now. Otherwise the announcement above triggers it.
    if (rendererListening) sendCommand()

    await ready
    // Extra settle time past the renderer's own "ready" signal — some screens
    // (grid view) ack ready before their async IPC data (session list) has
    // resolved, since the shot listener doesn't wait on that fetch.
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    const outPath = join(outDir, `${name}.png`)
    await writeFile(outPath, png)
    log.info('dev-shot: captured', { screen, theme, outPath })

    // A screen the renderer doesn't know produced no failure of its own —
    // it just fell through to whatever was already on screen — so it has to
    // be caught here, from the report the renderer already sends, rather
    // than swallowed as a pass. Read through a function: the report arrives
    // from the `dev:shot-ready` handler above, on its own turn of the event
    // loop, so TS can't see it as a possible reassignment of `lastReport`
    // once narrowed to null earlier in this same scope.
    const report = ((): ShotReport | null => lastReport)()
    if (screen && report && !report.hadActivator) {
      failures.push(`"${screen}" is not a registered shot screen`)
    } else if (report?.failure) {
      failures.push(`"${screen}" setup threw: ${report.failure}`)
    } else if (timedOut) {
      failures.push(`"${screen}" never reported ready (renderer hung or crashed)`)
    } else if (png.length === 0) {
      failures.push(`"${screen}" captured an empty image`)
    }
  }

  if (failures.length > 0) {
    for (const message of failures) log.error(`dev-shot: ${message}`)
    exitWithCode(1)
    return
  }

  app.quit()
}
