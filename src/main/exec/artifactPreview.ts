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

// Three pages at a time: each is a whole renderer, and most of a draw is
// waiting for the page to settle, so a few overlap well. Asking twice for
// one page shares the one draw.
const AT_ONCE = 3
let running = 0
const waiting: (() => void)[] = []
const inFlight = new Map<string, Promise<string | null>>()

export function artifactPreview(url: string): Promise<string | null> {
  const had = inFlight.get(url)
  if (had) return had
  const run = (async () => {
    if (running >= AT_ONCE) await new Promise<void>((r) => waiting.push(r))
    running++
    try {
      return await draw(url)
    } finally {
      running--
      waiting.shift()?.()
      inFlight.delete(url)
    }
  })()
  inFlight.set(url, run)
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
  const key = createHash('sha1').update(`v2\n${url}\n${html}\n${mtime}`).digest('hex').slice(0, 20)
  const out = join(dir(), `${key}.png`)
  if (existsSync(out)) return `data:image/png;base64,${readFileSync(out).toString('base64')}`
  // Drawn before and came out blank: don't draw it again until the page changes.
  if (existsSync(`${out}.blank`)) return null

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
    // A page that needs claude.ai to draw itself comes out one flat colour
    // (or a lone "Loading…"): no picture beats a blank one.
    if (looksBlank(image)) {
      mkdirSync(dir(), { recursive: true })
      writeFileSync(`${out}.blank`, '')
      return null
    }
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

/**
 * Whether a picture is nearly one colour: 1,000 points across it, and at
 * least 98% of them within a few shades of the most common one.
 */
export function looksBlank(image: Electron.NativeImage): boolean {
  const { width, height } = image.getSize()
  const bmp = image.toBitmap()
  if (!width || !height || bmp.length < width * height * 4) return false
  const counts = new Map<string, number>()
  const points: [number, number, number][] = []
  for (let y = 0; y < 25; y++) {
    for (let x = 0; x < 40; x++) {
      const px = Math.floor(((x + 0.5) / 40) * width)
      const py = Math.floor(((y + 0.5) / 25) * height)
      const i = (py * width + px) * 4
      const c: [number, number, number] = [bmp[i], bmp[i + 1], bmp[i + 2]]
      points.push(c)
      const k = c.map((v) => v >> 4).join(',')
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split(',')
    .map(Number)
  const near = points.filter((c) => c.every((v, j) => Math.abs((v >> 4) - top[j]) <= 1)).length
  return near / points.length >= 0.98
}
