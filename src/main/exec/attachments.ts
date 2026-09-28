import {
  statSync,
  accessSync,
  constants,
  realpathSync,
  mkdirSync,
  writeFileSync,
  copyFileSync
} from 'node:fs'
import { isAbsolute, basename, join, extname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { app } from 'electron'

/**
 * Attachments (Home composer's paperclip / paste / drag-drop).
 *
 * A file picked through the dialog, or dropped from Finder, already has an
 * absolute path on disk — it is never copied anywhere. CLAUDE.md treats a
 * worktree as a git checkout that must not accumulate stray files, and
 * copying would also let the attachment go stale the moment the user edits
 * their real file. We reference the file where it already lives, and only
 * validate that it is real, a plain file, readable and under a sane size
 * cap before its path is allowed anywhere near a prompt.
 *
 * The one exception is a paste of clipboard IMAGE bytes — there is no path
 * to reference, so those bytes are written to the OS temp directory (never
 * userData, never a project) under a name we invent ourselves (see
 * writePastedImage). Nothing from the renderer ever becomes part of that
 * path, so unlike exec/skills.ts's user-typed name there is nothing here
 * that needs sanitising.
 */

// Sanity cap, not a security boundary — generous enough for a screenshot, a
// log tail or a CSV export; small enough that a multi-GB drop becomes a
// clear "too big" chip instead of a prompt the agent chokes on later.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MB

export interface AttachmentOk {
  ok: true
  path: string
  name: string
  size: number
}

export interface AttachmentErr {
  ok: false
  name: string
  error: string
}

export type AttachmentResult = AttachmentOk | AttachmentErr

/**
 * Validates an absolute path the renderer handed back — one it got from our
 * own file dialog, or resolved from a dropped File via webUtils.getPathForFile
 * (preload's own bridge; see src/preload/index.ts). Either way it is exactly
 * as trustworthy as any other string from the renderer, i.e. not at all:
 * resolved through symlinks, then required to be absolute, to exist, to be a
 * regular file, to be readable, and to sit under the size cap, before it is
 * ever allowed near a prompt.
 */
export function validateAttachmentPath(rawPath: string): AttachmentResult {
  const displayName = (rawPath && basename(rawPath)) || rawPath || 'file'

  if (!rawPath || typeof rawPath !== 'string' || !isAbsolute(rawPath)) {
    return { ok: false, name: displayName, error: 'not a valid file path' }
  }

  let real: string
  try {
    real = realpathSync(rawPath)
  } catch {
    return { ok: false, name: displayName, error: "file doesn't exist" }
  }

  let size: number
  try {
    const stat = statSync(real)
    if (!stat.isFile()) return { ok: false, name: displayName, error: 'not a file' }
    size = stat.size
  } catch {
    return { ok: false, name: displayName, error: "file doesn't exist" }
  }

  try {
    accessSync(real, constants.R_OK)
  } catch {
    return { ok: false, name: displayName, error: 'file is not readable' }
  }

  if (size > MAX_ATTACHMENT_BYTES) {
    const capMb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
    return { ok: false, name: displayName, error: `larger than the ${capMb} MB limit` }
  }

  return { ok: true, path: real, name: basename(real), size }
}

// Clipboard image kinds we'll write out — paste is only ever offered for an
// image pasted into the textarea, so this stays small and image-only.
const PASTE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff'
}

let pasteDir: string | null = null
function resolvePasteDir(): string {
  if (!pasteDir) {
    const dir = join(app.getPath('temp'), 'control-room-pasted')
    mkdirSync(dir, { recursive: true })
    pasteDir = dir
  }
  return pasteDir
}

/**
 * Writes pasted clipboard image bytes to the OS temp dir and returns a real
 * path to them, validated the same as any other attachment from then on.
 * The filename is entirely our own invention (timestamp + random suffix +
 * an extension from the small allowlist above) — nothing the renderer sent
 * ever becomes part of it.
 */
export function writePastedImage(bytes: Uint8Array | null, mimeType: string): AttachmentResult {
  const displayName = 'pasted image'
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, name: displayName, error: 'empty paste' }
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    const capMb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
    return { ok: false, name: displayName, error: `larger than the ${capMb} MB limit` }
  }
  const ext = PASTE_EXTENSION_BY_MIME[mimeType]
  if (!ext) {
    return {
      ok: false,
      name: displayName,
      error: `unsupported image type (${mimeType || 'unknown'})`
    }
  }

  const name = `pasted-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`
  const path = join(resolvePasteDir(), name)
  try {
    writeFileSync(path, Buffer.from(bytes))
  } catch (err) {
    return { ok: false, name: displayName, error: String(err) }
  }
  return { ok: true, path, name, size: bytes.byteLength }
}

/**
 * Writes a large pasted block of text to the same temp dir, so the agent reads
 * it as a file instead of the composer swallowing a thousand lines.
 *
 * The filename is ours alone — timestamp, random suffix, fixed extension —
 * and nothing the renderer sent becomes part of it, exactly as for an image.
 */
export function writePastedText(text: string, lines: number): AttachmentResult {
  const displayName = `${lines} lines pasted`
  if (!text) return { ok: false, name: displayName, error: 'nothing to paste' }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_ATTACHMENT_BYTES) {
    const capMb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
    return { ok: false, name: displayName, error: `larger than the ${capMb} MB limit` }
  }

  const name = `pasted-${Date.now()}-${randomBytes(3).toString('hex')}.txt`
  const path = join(resolvePasteDir(), name)
  try {
    writeFileSync(path, text, 'utf8')
  } catch (err) {
    return { ok: false, name: displayName, error: String(err) }
  }
  return { ok: true, path, name: displayName, size: bytes }
}

/**
 * A dropped file, made safe to reference later.
 *
 * A screenshot dragged straight from macOS's preview thumbnail arrives as a
 * real file — in a temporary folder (…/TemporaryItems/NSIRD_screencaptureui_…/)
 * that macOS empties moments after the drop. Handing over that path meant the
 * agent went to read it and found nothing: "dropping a fresh screenshot
 * doesn't work", while a screenshot saved to disk did. So anything dropped
 * from the temp folder is copied, at once, into our own paste folder, and the
 * copy is what gets referenced. Files from anywhere else are referenced where
 * they live, as before.
 */
export function stashDroppedFile(rawPath: string): AttachmentResult {
  const checked = validateAttachmentPath(rawPath)
  if (!checked.ok) return checked
  let temp: string
  try {
    temp = realpathSync(tmpdir())
  } catch {
    temp = tmpdir()
  }
  const pasted = resolvePasteDir()
  const inTemp =
    checked.path.startsWith(temp + sep) || checked.path.includes(`${sep}TemporaryItems${sep}`)
  if (!inTemp || checked.path.startsWith(realpathSync(pasted) + sep)) return checked
  const ext = extname(checked.path)
    .slice(0, 12)
    .replace(/[^.\w]/g, '')
  const name = `dropped-${Date.now()}-${randomBytes(3).toString('hex')}${ext}`
  const dest = join(pasted, name)
  try {
    copyFileSync(checked.path, dest)
  } catch (err) {
    return { ok: false, name: checked.name, error: `couldn't keep a copy (${String(err)})` }
  }
  return { ok: true, path: dest, name: checked.name, size: checked.size }
}
