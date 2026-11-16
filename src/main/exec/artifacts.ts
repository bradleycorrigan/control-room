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
}

export interface Artifact {
  /** The page's link without a share key: what identifies it. */
  url: string
  /** The link to open, with a share key when one was used. */
  link: string
  title: string
  /** made: a session published it. opened: a session read it. added: you added the link. */
  source: 'made' | 'opened' | 'added'
  /** False when claude.ai said someone else owns it; null when nothing said. */
  owned: boolean | null
  /** Last published, read or added. */
  at: string | null
  /** Control Room sessions that published or read it, newest last. */
  sessions: ArtifactSession[]
}

interface Saved {
  added: { url: string; link: string; title: string; at: string }[]
  /** Names you gave artifacts, by url. */
  names: Record<string, string>
}

export const ARTIFACT_LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{8,}/

const savedPath = (): string => join(app.getPath('userData'), 'artifacts.json')

function readSaved(): Saved {
  try {
    if (!existsSync(savedPath())) return { added: [], names: {} }
    const raw = JSON.parse(readFileSync(savedPath(), 'utf8')) as Partial<Saved>
    return {
      added: Array.isArray(raw.added) ? raw.added : [],
      names: raw.names && typeof raw.names === 'object' ? raw.names : {}
    }
  } catch {
    return { added: [], names: {} }
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
  const byClaudeId = new Map<string, ArtifactSession>()
  for (const r of records) {
    const s = { recordId: r.id, title: r.title }
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
