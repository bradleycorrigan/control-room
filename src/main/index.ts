import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { load as loadStore, flushPendingSave } from './store/store'
import { registerIpcHandlers } from './ipc'
import { startPoller, stopPoller, triggerImmediateTick } from './engine/poller'
import {
  startHooksEngine,
  stopHooksServer,
  setHookEventListener,
  seedFixtureHookEvents
} from './engine/hooks-server'
import { checkRequiredBinaries } from './exec/run'
import { stopAllPtys } from './exec/tmux-pty'
import { stopAllControlSessions } from './exec/tmux-control'
import { log } from './log'
import { isScreenshotMode, runScreenshotFlow } from './dev/screenshot'

// Must run before app is ready — pins the data dir to the name in the plan
// regardless of packaging metadata (productName, appId, etc).
// Dev builds get a separate data dir so `npm run dev` never contends for the
// single-instance lock with, or writes into, the installed production app's
// real session/project state.
//
// The seeded fixture (`npm run fixture:build`, see scripts/fixtures/) points
// `CR_SESSIONS_DIR` at its synthetic `~/.claude/sessions`-shaped directory.
// When that's set, userData is pinned to the fixture's own root (which holds
// a matching state.json) instead of "Control Room Dev" — so `npm run shot`
// and verifiers always see the same documented synthetic dataset, never
// whatever real projects/sessions happen to be lying around in dev's store.
const fixtureSessionsDir = process.env.CR_SESSIONS_DIR || null
const isDevBuild = !app.isPackaged
app.setName(isDevBuild ? 'Control Room Dev' : 'Control Room')
app.setPath(
  'userData',
  fixtureSessionsDir
    ? join(fixtureSessionsDir, '..')
    : join(app.getPath('appData'), isDevBuild ? 'Control Room Dev' : 'Control Room')
)

function createWindow(): BrowserWindow {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    // Dev-only override so verification can check narrow widths (e.g. the
    // U8 1000px usability pass) without resizing by hand; never read in a
    // packaged build.
    width: (!app.isPackaged && Number(process.env.CR_WINDOW_WIDTH)) || 1200,
    height: (!app.isPackaged && Number(process.env.CR_WINDOW_HEIGHT)) || 800,
    show: false,
    autoHideMenuBar: true,
    // Traffic lights sit in our own custom title bar (AppShell) rather than
    // a native one — see plan section 2.0.
    titleBarStyle: 'hiddenInset',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // ⌘W closes the open session tab rather than the whole window. The default
  // app menu claims it before the page ever sees the key, so it's caught here
  // and handed to the renderer, which closes the window itself when there is
  // no tab to close (window:close).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      (input.meta || input.control) &&
      !input.shift &&
      !input.alt &&
      input.key.toLowerCase() === 'w'
    ) {
      // Swallow the key-up too: a key-up whose key-down the page never saw
      // is an orphan, and it's no business of the page's either way.
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) {
        mainWindow.webContents.send('shortcut:closeTab')
      }
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// Only one instance may run — two hook listeners would fight over the port.
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existingWindow] = BrowserWindow.getAllWindows()
    if (existingWindow) {
      if (existingWindow.isMinimized()) existingWindow.restore()
      existingWindow.show()
      existingWindow.focus()
    }
  })

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  // A crashed GPU or renderer process used to leave no trace here (only in
  // macOS's DiagnosticReports), so "the screen hung with a sad face" had
  // nothing to go on. Log every child process that goes away.
  app.on('child-process-gone', (_evt, details) => {
    log.warn('child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name
    })
  })
  app.on('render-process-gone', (_evt, _contents, details) => {
    log.warn('renderer gone', { reason: details.reason, exitCode: details.exitCode })
  })

  app.whenReady().then(async () => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.electron')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // IPC test
    ipcMain.on('ping', () => console.log('pong'))

    loadStore()
    log.info('app: state loaded', { userDataPath: app.getPath('userData') })
    registerIpcHandlers()

    // Fixture only: 'done' and 'errored' statuses are derived from Stop /
    // StopFailure hook events, which normally only ever arrive over the
    // loopback hook server — a session-file fixture alone can't produce
    // them. Seed the same in-memory state from a file next to the fixture's
    // session files instead of firing real hook requests.
    if (fixtureSessionsDir) {
      const hooksFixturePath = join(fixtureSessionsDir, '..', 'hooks.json')
      try {
        if (existsSync(hooksFixturePath)) {
          const events = JSON.parse(readFileSync(hooksFixturePath, 'utf8'))
          if (Array.isArray(events)) seedFixtureHookEvents(events)
        }
      } catch (err) {
        log.error('app: failed to load fixture hook events', { error: String(err) })
      }
    }

    setHookEventListener(() => {
      // Hooks beat the poll interval, so a hook event is worth an immediate
      // tick — and nothing else. This used to toast every event with its full
      // message, and a Stop hook carries `last_assistant_message`, so finishing
      // a turn threw an entire assistant reply across the window. A hook firing
      // is not news: the session list already shows each session's status, the
      // rail counts what needs you, and macOS notifies when the app is not
      // focused. In-app toasts are for results of things the user just clicked.
      triggerImmediateTick()
    })
    const hookPort = await startHooksEngine()
    log.info(hookPort ? 'hooks: engine started' : 'hooks: degraded to polling-only', { hookPort })

    startPoller()

    const mainWindow = createWindow()

    if (isScreenshotMode) {
      // Nothing else in this block matters for a screenshot run — no binary
      // check toast, no activate handler needed for a process that exits itself.
      runScreenshotFlow(mainWindow).catch((error) => {
        log.error('dev-shot: failed', { error: String(error) })
        app.exit(1)
      })
      return
    }

    const binaryCheck = checkRequiredBinaries()

    mainWindow.webContents.once('did-finish-load', () => {
      binaryCheck.then((results) => {
        const missing = results.filter((r) => !r.found)
        if (missing.length === 0) {
          log.info('startup: all required binaries resolved', { results })
          return
        }
        log.warn('startup: missing required binaries', { missing })
        const names = missing.map((r) => r.name).join(', ')
        mainWindow.webContents.send(
          'toast',
          `Not found on PATH: ${names} - some features will not work`
        )
      })
    })

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // A mutation right before quit must not be lost to the 200ms save debounce.
  app.on('before-quit', () => {
    stopPoller()
    stopHooksServer()
    flushPendingSave()
    stopAllPtys()
    stopAllControlSessions()
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
