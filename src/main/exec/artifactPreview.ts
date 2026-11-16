import { app, BrowserWindow, session } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { log } from '../log'
import { artifactHtmlPath } from './artifacts'

/**
 * A picture of an artifact, drawn from the local copy of its page: the file a
 * session published, or the copy Claude Code saved when one read it. The page
 * is someone's HTML, so it runs in a window that is never shown, in its own
 * empty session (no cookies, no preload, no Node), may load web resources but
 * no other local file, and can't navigate, open windows, download or ask for
 * permissions. The picture is kept on disk until the page changes.
 */

const PARTITION = 'artifact-preview'
const WIDTH = 1280
const HEIGHT = 800
const SETTLE_MS = 1500
const LOAD_TIMEOUT_MS = 10_000

const dir = (): string => join(app.getPath('userData'), 'artifact-previews')

let locked = false
function lockSession(): void {
  if (locked) return
  locked = true
  const s = session.fromPartition(PARTITION)
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.setPermissionCheckHandler(() => false)
  s.on('will-download', (e) => e.preventDefault())
  // Web resources (a chart library from a CDN) load; local files other than
  // the page being drawn don't.
  s.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url
    if (u.startsWith('https:') || u.startsWith('data:') || u.startsWith('blob:')) return cb({})
    if (u.startsWith('file:') && allowed.has(u.split('#')[0].split('?')[0])) return cb({})
    cb({ cancel: true })
  })
}
const allowed = new Set<string>()

// One page at a time: each is a whole renderer.
let queue: Promise<unknown> = Promise.resolve()

export function artifactPreview(url: string): Promise<string | null> {
  const run = queue.then(() => draw(url))
  queue = run.catch(() => null)
  return run
}

async function draw(url: string): Promise<string | null> {
  const html = artifactHtmlPath(url)
  if (!html) return null
  let mtime = 0
  try {
    mtime = statSync(html).mtimeMs
  } catch {
    return null
  }
  const key = createHash('sha1').update(`${url}\n${html}\n${mtime}`).digest('hex').slice(0, 20)
  const out = join(dir(), `${key}.png`)
  if (existsSync(out)) return `data:image/png;base64,${readFileSync(out).toString('base64')}`

  const pageUrl = pathToFileURL(html).toString()
  lockSession()
  allowed.add(pageUrl)
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-redirect', (e) => e.preventDefault())
  try {
    await Promise.race([
      win.loadURL(pageUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), LOAD_TIMEOUT_MS))
    ])
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) return null
    const small = image.resize({ width: 640 })
    mkdirSync(dir(), { recursive: true })
    writeFileSync(out, small.toPNG())
    return small.toDataURL()
  } catch (err) {
    log.warn('artifacts: could not draw a preview', { error: String(err) })
    return null
  } finally {
    allowed.delete(pageUrl)
    win.destroy()
  }
}
