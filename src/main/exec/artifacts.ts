import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getState } from '../store/store'
import { listAllTranscriptArtifacts } from './transcripts'

/**
 * Every Claude artifact Control Room knows about, for the Artifacts screen,
 * the ticket drawer and the composers' artifact picker. Three sources:
 * pages a Claude Code session published, pages a session read or opened
 * (often someone else's, shared with you), and links you added yourself.
 * claude.ai's own list of your artifacts isn't reachable from here.
 */

export interface ArtifactSession {
  /** Control Room's session record, to open it. */
  recordId: string
  title: string
  /** The project it ran in. */
  project: string | null
}

export interface Artifact {
  /** The page's link without a share key: what identifies it. */
  url: string
  /** The link to open, with a share key when one was used. */
  link: string
  title: string
  /**
   * made: a session published it. opened: a session read it. listed: only
   * seen in claude.ai's own list. added: you added the link.
   */
  source: 'made' | 'opened' | 'listed' | 'added'
  /** False when claude.ai said someone else owns it; null when nothing said. */
  owned: boolean | null
  /** Last published, read, updated or added. */
  at: string | null
  /** First published or seen. */
  firstAt: string | null
  /** Its publisher's icon word (chart, calculator…) or an emoji. */
  icon: string | null
  /** Who can see it, as claude.ai says: owner (only you), org… */
  audience: string | null
  /** How many versions it has been published in. */
  versions: number | null
  /** The one line written when it was published. */
  description: string | null
  /** Its Artifact type (Design System, Slides…), when made from one. */
  kind: string | null
  /** A local copy of its page exists, so a preview can be drawn. */
  preview: boolean
  /** You hid it: it shows only under Hidden. */
  hidden: boolean
  /** The folder you filed it in; null when unfiled. */
  folder: string | null
  /** Your tags on it, in the order added. */
  tags: string[]
  /** Control Room sessions that published or read it, newest last. */
  sessions: ArtifactSession[]
}

interface Saved {
  added: { url: string; link: string; title: string; at: string }[]
  /** Names you gave artifacts, by url. */
  names: Record<string, string>
  /** Artifacts you hid, by url. */
  hidden: string[]
  folders: ArtifactFolder[]
  /** Folder id by url. */
  folderOf: Record<string, string>
  /** Tags by url. */
  tags: Record<string, string[]>
}

/** A folder of artifacts. Folders nest: parent is another folder's id, or null at the top. */
export interface ArtifactFolder {
  id: string
  name: string
  parent: string | null
}

const EMPTY = (): Saved => ({
  added: [],
  names: {},
  hidden: [],
  folders: [],
  folderOf: {},
  tags: {}
})
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export const ARTIFACT_LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{8,}/

const savedPath = (): string => join(app.getPath('userData'), 'artifacts.json')

function readSaved(): Saved {
  try {
    if (!existsSync(savedPath())) return EMPTY()
    const raw = JSON.parse(readFileSync(savedPath(), 'utf8')) as Partial<Saved>
    return {
      added: Array.isArray(raw.added) ? raw.added : [],
      names: raw.names && typeof raw.names === 'object' ? raw.names : {},
      hidden: Array.isArray(raw.hidden) ? raw.hidden.filter((u) => typeof u === 'string') : [],
      folders: Array.isArray(raw.folders)
        ? raw.folders.filter(
            (f) => isRecord(f) && typeof f.id === 'string' && typeof f.name === 'string'
          )
        : [],
      folderOf: isRecord(raw.folderOf) ? (raw.folderOf as Record<string, string>) : {},
      tags: isRecord(raw.tags) ? (raw.tags as Record<string, string[]>) : {}
    }
  } catch {
    return EMPTY()
  }
}

function writeSaved(s: Saved): void {
  writeFileSync(savedPath(), JSON.stringify(s))
}

/** The page a link points to, or null when it isn't a claude.ai artifact link. */
export function artifactUrl(link: string): string | null {
  return ARTIFACT_LINK.exec(link.trim())?.[0] ?? null
}

export function listArtifacts(): Artifact[] {
  const saved = readSaved()
  const records = getState().sessions.filter((r) => !r.deletedAt)
  const projects = new Map(getState().projects.map((p) => [p.id, p.name]))
  const byClaudeId = new Map<string, ArtifactSession>()
  for (const r of records) {
    const s = { recordId: r.id, title: r.title, project: projects.get(r.projectId) ?? null }
    if (r.originalClaudeSessionId) byClaudeId.set(r.originalClaudeSessionId, s)
    if (r.claudeSessionId) byClaudeId.set(r.claudeSessionId, s)
  }
  const out = new Map<string, Artifact>()
  for (const a of listAllTranscriptArtifacts()) {
    const sessions: ArtifactSession[] = []
    for (const id of a.claudeSessionIds) {
      const s = byClaudeId.get(id)
      if (s && !sessions.some((x) => x.recordId === s.recordId)) sessions.push(s)
    }
    out.set(a.url, {
      url: a.url,
      link: a.link,
      title: a.title,
      source: a.source,
      owned: a.owned,
      at: a.at,
      firstAt: a.firstAt,
      icon: a.icon,
      audience: a.audience,
      versions: a.versions,
      description: a.description,
      kind: a.kind,
      preview: previewable(a),
      hidden: saved.hidden.includes(a.url),
      folder: folderOf(saved, a.url),
      tags: saved.tags[a.url] ?? [],
      sessions
    })
  }
  for (const a of saved.added) {
    const had = out.get(a.url)
    if (had) {
      if (!had.title) had.title = a.title
      if (a.link.includes('?') && !had.link.includes('?')) had.link = a.link
      continue
    }
    out.set(a.url, {
      url: a.url,
      link: a.link,
      title: a.title,
      source: 'added',
      owned: null,
      at: a.at,
      firstAt: a.at,
      icon: null,
      audience: null,
      versions: null,
      description: null,
      kind: null,
      preview: false,
      hidden: saved.hidden.includes(a.url),
      folder: folderOf(saved, a.url),
      tags: saved.tags[a.url] ?? [],
      sessions: []
    })
  }
  for (const [url, name] of Object.entries(saved.names)) {
    const a = out.get(url)
    if (a && name.trim()) a.title = name.trim()
  }
  return [...out.values()].sort((x, y) => (y.at ?? '').localeCompare(x.at ?? ''))
}

/** Adds a link you were sent. Adding one already listed only names it. */
export function addArtifact(
  link: string,
  title: string
): { ok: true; artifact: Artifact } | { ok: false; error: string } {
  const url = artifactUrl(link)
  if (!url) return { ok: false, error: 'That isn’t a claude.ai artifact link.' }
  const clean = link.trim().match(/^\S+/)?.[0] ?? url
  const saved = readSaved()
  if (!saved.added.some((a) => a.url === url))
    saved.added.push({ url, link: clean, title: title.trim(), at: new Date().toISOString() })
  if (title.trim()) saved.names[url] = title.trim()
  writeSaved(saved)
  const artifact = listArtifacts().find((a) => a.url === url)
  return artifact ? { ok: true, artifact } : { ok: false, error: 'Could not save the link.' }
}

/** Takes a link you added off the list. Ones a session made or read stay. */
export function removeArtifact(url: string): void {
  const saved = readSaved()
  saved.added = saved.added.filter((a) => a.url !== url)
  delete saved.names[url]
  writeSaved(saved)
}

/** Your own name for an artifact; an empty name goes back to its own. */
export function renameArtifact(url: string, title: string): void {
  const saved = readSaved()
  if (title.trim()) saved.names[url] = title.trim()
  else delete saved.names[url]
  writeSaved(saved)
}

/** The local copy of an artifact's page, for its preview. Never sent to the page. */
export function artifactHtmlPath(url: string): string | null {
  const a = listAllTranscriptArtifacts().find((x) => x.url === url)
  return a && previewable(a) ? a.html : null
}

/**
 * Whether a picture can be drawn here: a local page, not the data of one
 * made from an Artifact type (Slides, Docs…), which only claude.ai can draw.
 */
function previewable(a: {
  html: string | null
  typed: boolean
}): a is { html: string; typed: boolean } {
  return !a.typed && !!a.html && /\.html?$/i.test(a.html) && existsSync(a.html)
}

/** Hides an artifact from the list, or (hide false) shows it again. */
export function hideArtifact(url: string, hide: boolean): void {
  const saved = readSaved()
  saved.hidden = saved.hidden.filter((u) => u !== url)
  if (hide) saved.hidden.push(url)
  writeSaved(saved)
}

/** The folder an artifact is filed in, if that folder still exists. */
function folderOf(saved: Saved, url: string): string | null {
  const id = saved.folderOf[url]
  return id && saved.folders.some((f) => f.id === id) ? id : null
}

export function listArtifactFolders(): ArtifactFolder[] {
  return readSaved().folders
}

/** A new folder, at the top or inside another. */
export function createArtifactFolder(name: string, parent: string | null): ArtifactFolder | null {
  const clean = name.trim().slice(0, 80)
  if (!clean) return null
  const saved = readSaved()
  const folder: ArtifactFolder = {
    id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    parent: parent && saved.folders.some((f) => f.id === parent) ? parent : null
  }
  saved.folders.push(folder)
  writeSaved(saved)
  return folder
}

export function renameArtifactFolder(id: string, name: string): void {
  const clean = name.trim().slice(0, 80)
  if (!clean) return
  const saved = readSaved()
  const f = saved.folders.find((x) => x.id === id)
  if (!f) return
  f.name = clean
  writeSaved(saved)
}

/**
 * Moves a folder inside another (or to the top, parent null). Refused when
 * the new parent is the folder itself or inside it.
 */
export function moveArtifactFolder(id: string, parent: string | null): void {
  const saved = readSaved()
  const f = saved.folders.find((x) => x.id === id)
  if (!f) return
  for (let p = parent; p; p = saved.folders.find((x) => x.id === p)?.parent ?? null) {
    if (p === id) return
  }
  f.parent = parent
  writeSaved(saved)
}

/**
 * Deletes a folder. What was in it (artifacts and folders) moves up to its
 * parent: deleting a folder never loses an artifact.
 */
export function deleteArtifactFolder(id: string): void {
  const saved = readSaved()
  const f = saved.folders.find((x) => x.id === id)
  if (!f) return
  for (const child of saved.folders) if (child.parent === id) child.parent = f.parent
  for (const [url, fid] of Object.entries(saved.folderOf)) {
    if (fid !== id) continue
    if (f.parent) saved.folderOf[url] = f.parent
    else delete saved.folderOf[url]
  }
  saved.folders = saved.folders.filter((x) => x.id !== id)
  writeSaved(saved)
}

/** Files artifacts in a folder, or (folder null) takes them out of any. */
export function fileArtifacts(urls: string[], folder: string | null): void {
  const saved = readSaved()
  const ok = folder && saved.folders.some((f) => f.id === folder)
  for (const url of urls) {
    if (ok) saved.folderOf[url] = folder
    else delete saved.folderOf[url]
  }
  writeSaved(saved)
}

/** An artifact's tags, replaced: trimmed, de-duplicated, at most 20. */
export function setArtifactTags(url: string, tags: string[]): void {
  const saved = readSaved()
  const clean: string[] = []
  for (const t of tags) {
    const c = t.trim().replace(/\s+/g, ' ').slice(0, 40)
    if (c && !clean.some((x) => x.toLowerCase() === c.toLowerCase())) clean.push(c)
  }
  if (clean.length) saved.tags[url] = clean.slice(0, 20)
  else delete saved.tags[url]
  writeSaved(saved)
}
