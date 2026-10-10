import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log'

/**
 * Jira, for the Backlog screen — enough to stay out of Jira for day-to-day
 * work: every open ticket in the configured projects (plus Done ones still in
 * the current cycle), and the edits people actually make: summary,
 * description, comments, status (a board drag), assignee, parent epic, and
 * which cycle (sprint) a ticket is in.
 *
 * Talks to Jira Cloud's REST APIs directly with an API token. The token is
 * encrypted with Electron's safeStorage — a key macOS keeps in the Keychain —
 * and stored as an opaque blob in jira.json in the app's data folder. It is
 * decrypted only in this process, only to send to the configured Jira site,
 * and never logged or handed to the renderer.
 *
 * Descriptions and comments go through API v2, whose text is Jira wiki
 * markup: it round-trips a description's formatting, where editing v3's
 * rich document as plain text would flatten it.
 */

interface StoredConfig {
  site: string // "yourcompany.atlassian.net"
  email: string
  projects: string[] // ["DSD", "TEAMDATA"]
  tokenEnc: string // base64 of safeStorage.encryptString(token)
}

export interface JiraStatus {
  configured: boolean
  site: string | null
  email: string | null
  projects: string[]
  /** safeStorage can't encrypt (no Keychain access) — nothing can be saved. */
  encryptionUnavailable: boolean
}

export interface JiraSprint {
  id: number
  name: string
  state: 'active' | 'future' | 'closed' | string
  startDate?: string
  endDate?: string
  /** What the cycle is for, as set in Jira. */
  goal?: string
  /** The board the cycle belongs to: where a next cycle gets created. */
  boardId?: number
}

/** A board column: a name, and the statuses that land in it. */
export interface JiraColumn {
  name: string
  statuses: string[]
}

export interface JiraLink {
  url: string
  title: string
}

export interface JiraIssue {
  key: string
  url: string
  summary: string
  /** Plain text, for a session's prompt. The editable version is in the detail. */
  description: string
  status: string
  statusCategory: 'new' | 'indeterminate' | 'done' | string
  project: string
  issueType: string
  isEpic: boolean
  priority: string | null
  assignee: string | null
  assignedToMe: boolean
  updated: string
  sprint: JiraSprint | null
  parent: { key: string; summary: string } | null
  /** "Open in Slack" and friends — the ticket's remote links. */
  links: JiraLink[]
  /** Tickets that have to finish before this one can (Jira's "is blocked by"). */
  blockedBy: JiraBlockLink[]
  /** Tickets waiting on this one (Jira's "blocks"). */
  blocking: JiraBlockLink[]
  // The fields these projects actually fill in (sampled across 100 recent
  // tickets): reporter and created always, request type ~70%, labels ~70%,
  // estimate ~40%, the free-text "why" ~57%. The always-template fields
  // ("Bug details", "Overview") and always-default ones are left out.
  reporter: string | null
  created: string
  labels: string[]
  requestType: string | null
  /** Original estimate, e.g. "4h", "2d". */
  estimate: string | null
  /** Jira's field is named "Data source"; what people write there is why it matters. */
  why: string | null
  /**
   * Pull requests Jira knows about (its development panel — the GitHub
   * integration links them by key): open if any is open, merged if one
   * merged and none are open, else null.
   */
  pullRequests: 'open' | 'merged' | null
  /** A sub-task of another issue — never a top-level row of its own. */
  isSubtask?: boolean
  /** Keys of this ticket's sub-tasks, worked out from the same search. */
  subtasks?: string[]
}

/**
 * One side of a "Blocks" link, as the ticket at the other end sees it. The
 * other ticket can be in any project, so it carries its own summary and status.
 */
export interface JiraBlockLink {
  /** The link's own id: what removing it deletes. */
  linkId: string
  key: string
  summary: string
  status: string
  statusCategory: string
}

export type BlockDirection = 'blockedBy' | 'blocking'

export interface TicketPullRequest {
  name: string
  url: string
  status: 'OPEN' | 'MERGED' | 'DECLINED' | string
  branch: string | null
  updated: string | null
}

export interface JiraComment {
  id: string
  author: string
  created: string
  body: string
  /** A Jira Service Management internal note: only the team sees it. */
  internal?: boolean
}

export interface JiraIssueDetail {
  key: string
  /** Jira wiki markup — what the description editor edits. */
  descriptionWiki: string
  comments: JiraComment[]
  links: JiraLink[]
  attachments: { name: string; url: string }[]
  /** Names for the people tagged in the text ([~accountid:…] → display name). */
  people?: Record<string, string>
  /**
   * Everyone on the ticket — who raised it, who has it, who has commented —
   * for @-mentions. The person who raised a service desk ticket usually
   * can't be assigned it, so the assignable list alone left them out.
   */
  participants?: JiraPerson[]
}

export interface JiraBoardData {
  issues: JiraIssue[]
  /** Board columns: every status the projects use, To do → In progress → Done. */
  statuses: { name: string; category: string }[]
  /** Active and upcoming cycles, for the filter and "Add to cycle". */
  sprints: JiraSprint[]
  /** Open epics, for "Set parent". */
  epics: { key: string; summary: string }[]
  /** The site's priorities, highest first. */
  priorities: string[]
  /**
   * The columns of the board the current cycle runs on, as set up in Jira —
   * null when there is no such board. The Backlog uses these unless you've
   * customised your own.
   */
  columns: JiraColumn[] | null
  /** That board's name, for "Reset to …". */
  columnsFrom: string | null
  /** Which statuses each project's workflow has — a drop picks one of these. */
  projectStatuses: Record<string, string[]>
  /** Every label in use, for suggestions. */
  labels: string[]
}

const DEFAULT_PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest']

export type JiraResult<T> = { ok: true; value: T } | { ok: false; error: string }

const configPath = (): string => join(app.getPath('userData'), 'jira.json')

function readConfig(): StoredConfig | null {
  try {
    if (!existsSync(configPath())) return null
    return JSON.parse(readFileSync(configPath(), 'utf8')) as StoredConfig
  } catch (err) {
    log.error('jira: failed to read jira.json', { error: String(err) })
    return null
  }
}

function decryptToken(config: StoredConfig): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(config.tokenEnc, 'base64'))
  } catch {
    return null
  }
}

/** "https://x.atlassian.net/" or "x.atlassian.net" → "x.atlassian.net"; anything else → null. */
function normaliseSite(raw: string): string | null {
  const host = raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
  return /^[a-z0-9-]+\.atlassian\.net$/.test(host) ? host : null
}

// ---------------------------------------------------------------------------
// Transport

interface Conn {
  site: string
  email: string
  secret: string
}

class JiraError extends Error {}

async function callJson<T>(
  conn: Conn,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`https://${conn.site}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${conn.email}:${conn.secret}`).toString('base64')}`,
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000)
  })
  if (res.status === 401)
    throw new JiraError('Jira turned the saved token down - connect Jira again')
  if (res.status === 403) throw new JiraError("your Jira account isn't allowed to do that")
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as {
        errorMessages?: string[]
        errors?: Record<string, string>
      }
      detail = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join('; ')
    } catch {
      /* no JSON body */
    }
    throw new JiraError(`Jira answered ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function connection(): Conn | { error: string } {
  const config = readConfig()
  if (!config) return { error: 'Jira is not connected' }
  const secret = decryptToken(config)
  if (!secret) return { error: "the saved token can't be read - connect Jira again" }
  return { site: config.site, email: config.email, secret }
}

async function attempt<T>(fn: () => Promise<T>): Promise<JiraResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    if (err instanceof JiraError) return { ok: false, error: err.message }
    const config = readConfig()
    return { ok: false, error: `couldn't reach ${config?.site ?? 'Jira'}: ${String(err)}` }
  }
}

/** Runs `fn` over `items`, `limit` at a time. */
async function mapLimit<A, B>(items: A[], limit: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

// ---------------------------------------------------------------------------
// Parsing

// Atlassian Document Format → plain text, enough for a prompt: paragraph and
// list breaks kept, marks dropped.
function adfToText(node: unknown): string {
  const n = node as { type?: string; text?: string; content?: unknown[] } | null
  if (!n) return ''
  if (n.type === 'text') return n.text ?? ''
  if (n.type === 'hardBreak') return '\n'
  const inner = (n.content ?? []).map(adfToText).join('')
  switch (n.type) {
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'codeBlock':
      return `${inner}\n\n`
    case 'listItem':
      return `- ${inner.trim()}\n`
    case 'bulletList':
    case 'orderedList':
      return `${inner}\n`
    default:
      return inner
  }
}

// The Sprint field's id on Jira Cloud (checked against this site's field names).
const SPRINT_FIELD = 'customfield_10020'
const REQUEST_TYPE_FIELD = 'customfield_10010'
const WHY_FIELD = 'customfield_10327'
/** The link type behind "blocks" / "is blocked by". */
const BLOCKS_LINK = 'Blocks'
const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'project',
  'issuetype',
  'priority',
  'assignee',
  'updated',
  'parent',
  'reporter',
  'created',
  'labels',
  'issuelinks',
  'timeoriginalestimate',
  SPRINT_FIELD,
  REQUEST_TYPE_FIELD,
  WHY_FIELD
].join(',')

/** Seconds → Jira's own shorthand: 8h days, as Jira counts them. */
function formatEstimate(seconds: number | null | undefined): string | null {
  if (!seconds) return null
  const hours = seconds / 3600
  if (hours >= 8 && hours % 8 === 0) return `${hours / 8}d`
  return `${Math.round(hours * 10) / 10}h`
}

interface RawIssue {
  id?: string
  key: string
  fields: Record<string, unknown>
}

type RawLinkedIssue = {
  key?: string
  fields?: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } } }
}
interface RawIssueLink {
  id?: string
  type?: { name?: string }
  inwardIssue?: RawLinkedIssue
  outwardIssue?: RawLinkedIssue
}

// Jira lists each link from this ticket's side and names the ticket at the
// other end: an inwardIssue blocks this one, an outwardIssue is blocked by it.
function parseBlockLinks(links: RawIssueLink[] | undefined): {
  blockedBy: JiraBlockLink[]
  blocking: JiraBlockLink[]
} {
  const blockedBy: JiraBlockLink[] = []
  const blocking: JiraBlockLink[] = []
  const side = (id: string, other: RawLinkedIssue): JiraBlockLink => ({
    linkId: id,
    key: other.key ?? '',
    summary: other.fields?.summary ?? other.key ?? '',
    status: other.fields?.status?.name ?? 'Unknown',
    statusCategory: other.fields?.status?.statusCategory?.key ?? 'new'
  })
  for (const link of links ?? []) {
    if (link.type?.name !== BLOCKS_LINK || !link.id) continue
    if (link.inwardIssue?.key) blockedBy.push(side(link.id, link.inwardIssue))
    if (link.outwardIssue?.key) blocking.push(side(link.id, link.outwardIssue))
  }
  return { blockedBy, blocking }
}

function parseIssue(site: string, raw: RawIssue, me: string | null, links: JiraLink[]): JiraIssue {
  const f = raw.fields as {
    summary?: string
    description?: unknown
    status?: { name?: string; statusCategory?: { key?: string } }
    project?: { key?: string }
    issuetype?: { name?: string; hierarchyLevel?: number; subtask?: boolean }
    priority?: { name?: string } | null
    assignee?: { accountId?: string; displayName?: string } | null
    updated?: string
    parent?: { key?: string; fields?: { summary?: string } } | null
    reporter?: { displayName?: string } | null
    created?: string
    labels?: string[]
    timeoriginalestimate?: number | null
    issuelinks?: RawIssueLink[]
  } & Record<string, unknown>
  const requestType = f[REQUEST_TYPE_FIELD] as { requestType?: { name?: string } } | null
  const why = f[WHY_FIELD]
  const sprints = (f[SPRINT_FIELD] as JiraSprint[] | null | undefined) ?? []
  // A ticket can carry several (carried over): the open one is the one that matters.
  const sprint =
    sprints.find((s) => s.state === 'active') ?? sprints.find((s) => s.state === 'future') ?? null
  return {
    key: raw.key,
    url: `https://${site}/browse/${raw.key}`,
    summary: f.summary ?? raw.key,
    description:
      typeof f.description === 'string'
        ? f.description
        : adfToText(f.description)
            .replace(/\n{3,}/g, '\n\n')
            .trim(),
    status: f.status?.name ?? 'Unknown',
    statusCategory: f.status?.statusCategory?.key ?? 'new',
    project: f.project?.key ?? raw.key.split('-')[0],
    issueType: f.issuetype?.name ?? 'Issue',
    isEpic: f.issuetype?.name === 'Epic' || f.issuetype?.hierarchyLevel === 1,
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    assignedToMe: Boolean(me && f.assignee?.accountId === me),
    updated: f.updated ?? '',
    sprint: sprint ? { id: sprint.id, name: sprint.name, state: sprint.state } : null,
    parent: f.parent?.key
      ? { key: f.parent.key, summary: f.parent.fields?.summary ?? f.parent.key }
      : null,
    links,
    ...parseBlockLinks(f.issuelinks),
    reporter: f.reporter?.displayName ?? null,
    created: f.created ?? '',
    labels: f.labels ?? [],
    requestType: requestType?.requestType?.name ?? null,
    estimate: formatEstimate(f.timeoriginalestimate),
    why: typeof why === 'string' && why.trim() ? why.trim() : null,
    pullRequests: null,
    isSubtask: Boolean(f.issuetype?.subtask),
    subtasks: []
  }
}

// ---------------------------------------------------------------------------
// Dev fixture: an in-memory Jira for the shot harness and the gate, so the
// Backlog can be driven — edits, drags, comments — without anyone's token.
// `npm run shot:fixture` sets CR_JIRA_FIXTURE. Never read in a packaged build.

interface FixtureStore {
  issues: JiraIssue[]
  details: Record<string, JiraIssueDetail>
  statuses: { name: string; category: string }[]
  sprints: JiraSprint[]
  columns: JiraColumn[] | null
  projectStatuses: Record<string, string[]>
  prefs: BacklogPrefs
  nextId: number
}

let fixture: FixtureStore | null | undefined

/**
 * Dev only: fills the fixture with `count` realistic tickets (0 removes them),
 * so a check can see a screen at real volume. The base fixture stays small so
 * every other check keeps its exact numbers.
 */
export function fixtureFiller(count: number): boolean {
  const store = fixtureStore()
  if (!store) return false
  const isFiller = (k: string): boolean => k.startsWith('FILL-')
  store.issues = store.issues.filter((i) => !isFiller(i.key))
  for (const k of Object.keys(store.details)) if (isFiller(k)) delete store.details[k]
  const base = store.issues.find((i) => !i.isEpic && !i.isSubtask)
  const active = store.sprints.find((sp) => sp.state === 'active') ?? null
  if (!base) return false
  const titles = [
    'Backfill partner metrics after the warehouse migration so dashboards stop showing gaps',
    'Exclude non-ICP orgs from the churn reports',
    'Donation ageing percentiles',
    'Could we get a dashboard for the new partner, as requested in the ticket above',
    'Map the critical pipeline end to end'
  ]
  for (let n = 0; n < count; n++) {
    const key = `FILL-${n + 1}`
    store.issues.push({
      ...structuredClone(base),
      key,
      url: `https://example.atlassian.net/browse/${key}`,
      summary: `${titles[n % titles.length]} (${n + 1})`,
      sprint: n % 3 === 2 || !active ? null : { ...active },
      estimate: n % 4 === 0 ? null : ['4h', '1d', '2d'][n % 3],
      assignee: n % 5 === 0 ? null : ['You', 'Someone Else'][n % 2],
      assignedToMe: n % 2 === 0 && n % 5 !== 0,
      status: n % 6 === 0 ? 'Done' : base.status,
      statusCategory: n % 6 === 0 ? 'done' : base.statusCategory,
      blockedBy: [],
      blocking: [],
      links: [],
      subtasks: []
    })
    store.details[key] = {
      key,
      descriptionWiki: '',
      comments: [],
      links: [],
      attachments: []
    }
  }
  return true
}

function fixtureStore(): FixtureStore | null {
  if (fixture !== undefined) return fixture
  const path = !app.isPackaged ? process.env.CR_JIRA_FIXTURE : undefined
  if (!path || !existsSync(path)) return (fixture = null)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    issues: (Omit<JiraIssue, 'url' | 'blockedBy' | 'blocking'> &
      Partial<Pick<JiraIssue, 'blockedBy' | 'blocking'>>)[]
    statuses: { name: string; category: string }[]
    sprints: JiraSprint[]
    columns?: JiraColumn[]
    projectStatuses?: Record<string, string[]>
  }
  const issues = raw.issues.map((i) => ({
    ...i,
    blockedBy: i.blockedBy ?? [],
    blocking: i.blocking ?? [],
    url: `https://example.atlassian.net/browse/${i.key}`
  }))
  const details: Record<string, JiraIssueDetail> = {}
  for (const i of issues) {
    details[i.key] = {
      key: i.key,
      descriptionWiki: i.description,
      comments: [],
      links: i.links,
      attachments: [],
      // Rae raised the ticket and can't be assigned it: only this list has her.
      participants: [
        { accountId: 'fixture-rae', name: 'Rae Reporter' },
        { accountId: 'fixture-someone', name: 'Someone Else' }
      ]
    }
  }
  // A comment that tags someone, the way Jira stores it, and the name it
  // resolves to.
  if (details['DSD-101']) {
    details['DSD-101'].comments.push({
      id: 'fixture-mention',
      author: 'Someone Else',
      created: '2026-09-20T10:00:00.000Z',
      body: '[~accountid:fixture-joanna] can you check the March totals?'
    })
    details['DSD-101'].people = { 'fixture-joanna': 'Joanna Fixture' }
  }
  return (fixture = {
    issues,
    details,
    statuses: raw.statuses,
    sprints: raw.sprints,
    columns: raw.columns ?? null,
    projectStatuses: raw.projectStatuses ?? {},
    prefs: { columns: null, views: [], capacity: {} },
    nextId: 200
  })
}

function fixtureUpdate(key: string, patch: (i: JiraIssue) => void): JiraResult<JiraIssue> {
  const issue = fixtureStore()!.issues.find((i) => i.key === key)
  if (!issue) return { ok: false, error: `no issue ${key}` }
  patch(issue)
  issue.updated = new Date().toISOString()
  return { ok: true, value: { ...issue } }
}

// ---------------------------------------------------------------------------
// Configuration

export function jiraStatus(): JiraStatus {
  if (fixtureStore()) {
    return {
      configured: true,
      site: 'example.atlassian.net',
      email: 'fixture@example.com',
      projects: ['DSD', 'TEAMDATA'],
      encryptionUnavailable: false
    }
  }
  const config = readConfig()
  return {
    configured: Boolean(config && decryptToken(config)),
    site: config?.site ?? null,
    email: config?.email ?? null,
    projects: config?.projects ?? [],
    encryptionUnavailable: !safeStorage.isEncryptionAvailable()
  }
}

/** Checks the credentials against Jira before saving anything. */
export async function configureJira(input: {
  site: string
  email: string
  token: string
  projects: string[]
}): Promise<JiraResult<JiraStatus>> {
  const site = normaliseSite(input.site)
  if (!site) return { ok: false, error: 'the site should look like yourcompany.atlassian.net' }
  const email = input.email.trim()
  if (!email.includes('@')) return { ok: false, error: 'enter the email you sign in to Jira with' }
  const projects = input.projects.map((p) => p.trim().toUpperCase()).filter(Boolean)
  if (projects.length === 0) return { ok: false, error: 'name at least one project, like DSD' }
  if (projects.some((p) => !/^[A-Z][A-Z0-9_]*$/.test(p))) {
    return { ok: false, error: 'project keys are letters and numbers, like DSD or TEAMDATA' }
  }
  const secret = input.token.trim()
  if (!secret) return { ok: false, error: 'paste an API token' }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      error: "this Mac won't let Control Room encrypt the token, so it can't be saved"
    }
  }

  const checked = await attempt(() => callJson({ site, email, secret }, '/rest/api/3/myself'))
  if (!checked.ok) {
    return {
      ok: false,
      error: checked.error.startsWith('Jira turned')
        ? 'Jira turned those down - check the email and token'
        : checked.error
    }
  }

  const stored: StoredConfig = {
    site,
    email,
    projects,
    tokenEnc: safeStorage.encryptString(secret).toString('base64')
  }
  writeFileSync(configPath(), JSON.stringify(stored), { mode: 0o600 })
  boardCache = null
  myAccountId = null
  return { ok: true, value: jiraStatus() }
}

export function disconnectJira(): void {
  rmSync(configPath(), { force: true })
  boardCache = null
  myAccountId = null
  linksCache.clear()
  rmSync(linksCachePath(), { force: true })
}

// ---------------------------------------------------------------------------
// Reading

let boardCache: { at: number; value: JiraBoardData } | null = null
const BOARD_TTL_MS = 60_000
let myAccountId: string | null = null
// Remote links cost one request per ticket, so they're kept per ticket and
// only asked again when the ticket's `updated` moves, or after LINKS_TTL_MS:
// Zapier adding a Slack link doesn't move `updated`. They're kept on disk
// too, so the first board after a restart isn't one request per ticket.
type CachedLinks = { updated: string; links: JiraLink[]; at: number }
const LINKS_TTL_MS = 6 * 60 * 60 * 1000
const linksCachePath = (): string => join(app.getPath('userData'), 'jira-remote-links.json')
const linksCache = new Map<string, CachedLinks>()
let linksCacheLoaded = false
function loadLinksCache(): void {
  if (linksCacheLoaded) return
  linksCacheLoaded = true
  try {
    const saved = JSON.parse(readFileSync(linksCachePath(), 'utf8')) as Record<string, CachedLinks>
    const now = Date.now()
    for (const [key, entry] of Object.entries(saved)) {
      if (entry && Array.isArray(entry.links) && now - entry.at < LINKS_TTL_MS) {
        linksCache.set(key, entry)
      }
    }
  } catch {
    /* none saved yet, or unreadable: start empty */
  }
}
function saveLinksCache(): void {
  try {
    writeFileSync(linksCachePath(), JSON.stringify(Object.fromEntries(linksCache)))
  } catch (err) {
    log.warn('jira: could not save the remote links cache', { error: String(err) })
  }
}

async function me(conn: Conn): Promise<string | null> {
  if (myAccountId) return myAccountId
  const who = await callJson<{ accountId?: string }>(conn, '/rest/api/3/myself')
  myAccountId = who.accountId ?? null
  return myAccountId
}

async function linksFor(conn: Conn, key: string, updated: string): Promise<JiraLink[]> {
  loadLinksCache()
  const cached = linksCache.get(key)
  if (cached && cached.updated === updated && Date.now() - cached.at < LINKS_TTL_MS) {
    return cached.links
  }
  try {
    const raw = await callJson<Array<{ object?: { url?: string; title?: string } }>>(
      conn,
      `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`
    )
    const links = raw
      .map((l) => ({ url: l.object?.url ?? '', title: (l.object?.title ?? '').trim() }))
      .filter((l) => /^https:\/\//.test(l.url))
    linksCache.set(key, { updated, links, at: Date.now() })
    return links
  } catch {
    return cached?.links ?? []
  }
}

/** Keys only, for "which tickets match" questions. */
async function searchKeys(conn: Conn, jql: string, max = 500): Promise<RawIssue[]> {
  const out: RawIssue[] = []
  let nextPageToken: string | undefined
  while (out.length < max) {
    const q = new URLSearchParams({ jql, fields: 'key', maxResults: '200' })
    if (nextPageToken) q.set('nextPageToken', nextPageToken)
    const body = await callJson<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
      conn,
      `/rest/api/3/search/jql?${q}`
    )
    out.push(...(body.issues ?? []))
    if (body.isLast !== false || !body.nextPageToken) break
    nextPageToken = body.nextPageToken
  }
  return out
}

/** Key + immediate parent only — for filling in sub-tasks a status/sprint
 * filter would otherwise drop off their parent's list. */
async function searchParentedKeys(
  conn: Conn,
  jql: string,
  max = 500
): Promise<{ key: string; parentKey: string | null }[]> {
  const out: { key: string; parentKey: string | null }[] = []
  let nextPageToken: string | undefined
  while (out.length < max) {
    const q = new URLSearchParams({ jql, fields: 'key,parent', maxResults: '200' })
    if (nextPageToken) q.set('nextPageToken', nextPageToken)
    const body = await callJson<{
      issues?: { key: string; fields?: { parent?: { key?: string } } }[]
      nextPageToken?: string
      isLast?: boolean
    }>(conn, `/rest/api/3/search/jql?${q}`)
    for (const r of body.issues ?? []) {
      out.push({ key: r.key, parentKey: r.fields?.parent?.key ?? null })
    }
    if (body.isLast !== false || !body.nextPageToken) break
    nextPageToken = body.nextPageToken
  }
  return out
}

async function searchIssues(
  conn: Conn,
  jql: string,
  max = 300,
  fields = ISSUE_FIELDS
): Promise<RawIssue[]> {
  const out: RawIssue[] = []
  let nextPageToken: string | undefined
  while (out.length < max) {
    const q = new URLSearchParams({ jql, fields, maxResults: '100' })
    if (nextPageToken) q.set('nextPageToken', nextPageToken)
    const body = await callJson<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
      conn,
      `/rest/api/3/search/jql?${q}`
    )
    out.push(...(body.issues ?? []))
    if (body.isLast !== false || !body.nextPageToken) break
    nextPageToken = body.nextPageToken
  }
  return out
}

/** One ticket, fresh from Jira, patched into the board cache too. */
async function loadIssue(conn: Conn, key: string): Promise<JiraIssue> {
  // Straight from the issue, not from search: search is indexed and can
  // still hold the old value a second after a change, which put an edit back
  // on screen as though it hadn't happened.
  const raw = await callJson<RawIssue>(
    conn,
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`
  )
  if (!raw?.key) throw new JiraError(`${key} wasn't found`)
  const updated = (raw.fields as { updated?: string }).updated ?? ''
  const issue = parseIssue(conn.site, raw, await me(conn), await linksFor(conn, key, updated))
  if (boardCache) {
    const list = boardCache.value.issues
    const i = list.findIndex((x) => x.key === key)
    // PR state comes from the board's development search, not the issue.
    if (i >= 0) issue.pullRequests = list[i].pullRequests
    if (i >= 0) list[i] = issue
    else list.unshift(issue)
  }
  return issue
}

const CATEGORY_RANK: Record<string, number> = { new: 0, indeterminate: 1, done: 2 }
const COMMON_ORDER = [
  'Backlog',
  'To Do',
  'Selected for Development',
  'In Progress',
  'In Review',
  'Pending',
  'Blocked',
  'Blocked/Waiting',
  'Done'
]

function orderStatuses(
  list: { name: string; category: string }[]
): { name: string; category: string }[] {
  const unique = [...new Map(list.map((s) => [s.name, s])).values()]
  const rank = (name: string): number => {
    const i = COMMON_ORDER.indexOf(name)
    return i === -1 ? 50 : i
  }
  return unique.sort(
    (a, b) =>
      (CATEGORY_RANK[a.category] ?? 1) - (CATEGORY_RANK[b.category] ?? 1) ||
      rank(a.name) - rank(b.name) ||
      a.name.localeCompare(b.name)
  )
}

/**
 * Everything the Backlog shows: every open ticket in the projects, plus Done
 * ones still in an open cycle (a board's Done column), the columns, the
 * cycles, and the open epics.
 */
export async function loadBoard(refresh = false): Promise<JiraResult<JiraBoardData>> {
  const store = fixtureStore()
  if (store) {
    return {
      ok: true,
      value: {
        issues: store.issues.map((i) => ({
          ...i,
          subtasks: store.issues
            .filter((c) => c.isSubtask && c.parent?.key === i.key)
            .map((c) => c.key)
        })),
        statuses: store.statuses,
        sprints: store.sprints,
        epics: store.issues
          .filter((i) => i.isEpic && i.statusCategory !== 'done')
          .map((i) => ({ key: i.key, summary: i.summary })),
        priorities: DEFAULT_PRIORITIES,
        columns: store.columns,
        columnsFrom: store.columns ? 'Data team cycle board' : null,
        projectStatuses: store.projectStatuses,
        labels: [...new Set(store.issues.flatMap((i) => i.labels))].sort()
      }
    }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  if (!refresh && boardCache && Date.now() - boardCache.at < BOARD_TTL_MS) {
    return { ok: true, value: boardCache.value }
  }
  // Two parts of the app asking at once (the Backlog and a ticket panel over
  // a session) share one load rather than each going to Jira.
  if (boardLoading) return boardLoading
  boardLoading = loadBoardFresh(conn).finally(() => {
    boardLoading = null
  })
  return boardLoading
}

let boardLoading: Promise<JiraResult<JiraBoardData>> | null = null

async function loadBoardFresh(conn: Conn): Promise<JiraResult<JiraBoardData>> {
  const config = readConfig()!
  const projectList = config.projects.map((p) => `"${p}"`).join(', ')

  return attempt(async () => {
    // How long each step took, logged once the board is in, so a slow load
    // says where the time went.
    const started = Date.now()
    const timings: Record<string, number> = {}
    const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
      const t = Date.now()
      try {
        return await run()
      } finally {
        timings[step] = Date.now() - t
      }
    }

    // Which tickets have pull requests, from Jira's development data: two
    // key-only searches rather than one call per ticket. A site without a
    // GitHub integration rejects the field — then nobody has any.
    const keysWhere = async (jql: string): Promise<Set<string>> => {
      try {
        return new Set((await searchKeys(conn, jql)).map((r) => r.key))
      } catch {
        return new Set()
      }
    }

    // Everything that doesn't need the ticket search starts now, beside it,
    // rather than one after another once it's back.
    const accountIdP = timed('me', () => me(conn))
    const rawsP = timed('search', () =>
      searchIssues(
        conn,
        `project in (${projectList}) AND (statusCategory != Done OR sprint in openSprints()) ORDER BY updated DESC`
      )
    )
    const prsP = timed('pullRequests', () =>
      Promise.all([
        keysWhere(`project in (${projectList}) AND development[pullrequests].open > 0`),
        keysWhere(`project in (${projectList}) AND development[pullrequests].all > 0`)
      ])
    )
    // Columns: every status the projects' workflows use, not only the ones
    // tickets happen to be in today — an empty column is still a drop target.
    const statusListsP = timed('statuses', () =>
      mapLimit(config.projects, 4, async (p) => {
        try {
          const byType = await callJson<
            Array<{
              statuses?: Array<{ id?: string; name: string; statusCategory?: { key?: string } }>
            }>
          >(conn, `/rest/api/3/project/${encodeURIComponent(p)}/statuses`)
          return byType.flatMap((t) =>
            (t.statuses ?? []).map((s) => ({
              id: s.id ?? '',
              name: s.name,
              category: s.statusCategory?.key ?? 'new'
            }))
          )
        } catch {
          return []
        }
      })
    )
    // Each project's own boards, for its cycles.
    const projectBoardsP = timed('boards', () =>
      mapLimit(config.projects, 4, async (p) => {
        try {
          const boards = await callJson<{ values?: Array<{ id: number }> }>(
            conn,
            `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(p)}&maxResults=20`
          )
          return (boards.values ?? []).map((b) => b.id)
        } catch {
          /* a project with no board (or no Software licence) just has no cycles */
          return []
        }
      })
    )
    // Epics: open ones in the projects, for Set parent. A ticket's epic can
    // live in another project (DSD tickets sit under TEAMDATA epics). Only
    // the name is used, so only the name is asked for: this fetched every
    // field of up to 200 epics, descriptions and links included.
    const epicsP = timed('epics', () =>
      searchIssues(
        conn,
        `project in (${projectList}) AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`,
        200,
        'summary'
      )
    )
    // Priorities come back highest first.
    const prioritiesP = timed('priorities', async () => {
      try {
        const list = await callJson<Array<{ name?: string }>>(conn, '/rest/api/3/priority')
        const names = list.map((p) => p.name).filter((n): n is string => Boolean(n))
        return names.length ? names : DEFAULT_PRIORITIES
      } catch {
        return DEFAULT_PRIORITIES
      }
    })

    const raws = await rawsP
    // Parents, straight from the search, for the sub-task search below.
    const parentKeys = [
      ...new Set(
        raws
          .filter((r) => !(r.fields as { issuetype?: { subtask?: boolean } }).issuetype?.subtask)
          .map((r) => r.key)
      )
    ]
    const boardIdsFromTickets = new Set<number>()
    for (const r of raws) {
      const list = (r.fields as Record<string, unknown>)[SPRINT_FIELD] as Array<{
        boardId?: number
      }> | null
      for (const s of list ?? []) if (s.boardId) boardIdsFromTickets.add(s.boardId)
    }

    const [accountId, links, children, sprintLists] = await Promise.all([
      accountIdP,
      timed('remoteLinks', () =>
        mapLimit(raws, 8, (r) =>
          linksFor(conn, r.key, (r.fields as { updated?: string }).updated ?? '')
        )
      ),
      // The board search is `statusCategory != Done OR sprint in openSprints()`
      // — a Done sub-task whose parent isn't in an open sprint doesn't match
      // it and drops off the parent's list even though the parent is right
      // here. A second, key-only search for every sub-task of these parents
      // fills the gap without changing the main query.
      timed('subtasks', async () => {
        if (parentKeys.length === 0) return []
        try {
          return await searchParentedKeys(
            conn,
            `parent in (${parentKeys.map((k) => `"${k}"`).join(', ')})`
          )
        } catch {
          // Best-effort: the board still works with the count it already has.
          return []
        }
      }),
      // Cycles: the boards the tickets' sprints come from, plus each
      // project's own boards, asked for their active and upcoming sprints.
      timed('sprints', async () => {
        const boardIds = new Set([...boardIdsFromTickets, ...(await projectBoardsP).flat()])
        return mapLimit([...boardIds], 4, async (id) => {
          try {
            const body = await callJson<{
              values?: Array<JiraSprint & { originBoardId?: number }>
            }>(conn, `/rest/agile/1.0/board/${id}/sprint?state=active,future&maxResults=50`)
            return (body.values ?? []).map((s) => ({
              id: s.id,
              name: s.name,
              state: s.state,
              startDate: s.startDate,
              endDate: s.endDate,
              goal: s.goal || undefined,
              boardId: s.originBoardId ?? id
            }))
          } catch {
            return []
          }
        })
      })
    ])

    const issues = raws.map((r, i) => parseIssue(conn.site, r, accountId, links[i]))
    // Sub-tasks come back from the same search (their own project, own
    // status): give each parent the keys of its children, and never show a
    // sub-task as a row of its own.
    for (const issue of issues) {
      issue.subtasks = issues
        .filter((c) => c.isSubtask && c.parent?.key === issue.key)
        .map((c) => c.key)
    }
    const known = new Set(issues.map((i) => i.key))
    for (const { key, parentKey } of children) {
      if (known.has(key)) continue
      const issue = issues.find((i) => i.key === parentKey)
      if (issue && !issue.subtasks?.includes(key)) {
        issue.subtasks = [...(issue.subtasks ?? []), key]
      }
    }

    const [openPrs, anyPrs] = await prsP
    for (const issue of issues) {
      issue.pullRequests = openPrs.has(issue.key) ? 'open' : anyPrs.has(issue.key) ? 'merged' : null
    }

    const statusLists = await statusListsP
    const projectStatuses: Record<string, string[]> = {}
    config.projects.forEach((p, i) => {
      const names = [...new Set(statusLists[i].map((s) => s.name))]
      if (names.length) projectStatuses[p] = names
    })
    const statusNameById = new Map(statusLists.flat().map((s) => [s.id, s.name]))
    const statuses = orderStatuses([
      ...statusLists.flat(),
      ...issues.map((i) => ({ name: i.status, category: i.statusCategory }))
    ])

    const sprints = [...new Map(sprintLists.flat().map((s) => [s.id, s])).values()].sort(
      (a, b) => (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1) || a.id - b.id
    )

    const epics = (await epicsP).map((r) => ({
      key: r.key,
      summary: ((r.fields as { summary?: string }).summary ?? r.key).trim()
    }))
    const priorities = await prioritiesP

    // Columns: the board the current cycle runs on — the one most of the
    // tickets in an active sprint belong to — as its owner set it up in Jira.
    const boardVotes = new Map<number, number>()
    for (const r of raws) {
      const list = (r.fields as Record<string, unknown>)[SPRINT_FIELD] as Array<{
        boardId?: number
        state?: string
      }> | null
      for (const sp of list ?? []) {
        if (sp.state === 'active' && sp.boardId) {
          boardVotes.set(sp.boardId, (boardVotes.get(sp.boardId) ?? 0) + 1)
        }
      }
    }
    const cycleBoard = [...boardVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    let columns: JiraColumn[] | null = null
    let columnsFrom: string | null = null
    if (cycleBoard) {
      await timed('columns', async () => {
        try {
          const cfg = await callJson<{
            name?: string
            columnConfig?: { columns?: Array<{ name: string; statuses?: Array<{ id: string }> }> }
          }>(conn, `/rest/agile/1.0/board/${cycleBoard}/configuration`)
          // Statuses outside the projects' own lists (another project's)
          // still need names; one call has them all.
          const missing = (cfg.columnConfig?.columns ?? []).some((c) =>
            (c.statuses ?? []).some((st) => !statusNameById.has(st.id))
          )
          if (missing) {
            const all = await callJson<Array<{ id: string; name: string }>>(
              conn,
              '/rest/api/3/status'
            )
            for (const st of all) if (!statusNameById.has(st.id)) statusNameById.set(st.id, st.name)
          }
          columns = (cfg.columnConfig?.columns ?? []).map((c) => ({
            name: c.name,
            statuses: (c.statuses ?? [])
              .map((st) => statusNameById.get(st.id))
              .filter((n): n is string => Boolean(n))
          }))
          columnsFrom = cfg.name ?? null
        } catch {
          /* no board config — one column per status */
        }
      })
    }

    const value: JiraBoardData = {
      issues,
      statuses,
      sprints,
      epics,
      priorities,
      columns,
      columnsFrom,
      projectStatuses,
      labels: [...new Set(issues.flatMap((i) => i.labels))].sort()
    }
    log.info('jira: board loaded', {
      ms: Date.now() - started,
      tickets: issues.length,
      steps: timings
    })
    boardCache = { at: Date.now(), value }
    saveLinksCache()
    return value
  })
}

/** The editable description (wiki markup), comments, and links for one ticket. */
const peopleCache = new Map<string, string>()

export async function loadIssueDetail(key: string): Promise<JiraResult<JiraIssueDetail>> {
  const store = fixtureStore()
  if (store) {
    const d = store.details[key]
    return d ? { ok: true, value: structuredClone(d) } : { ok: false, error: `no issue ${key}` }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const issue = await callJson<{
      fields?: {
        description?: string | null
        updated?: string
        attachment?: Array<{ filename?: string; content?: string }>
        reporter?: JiraUserRef | null
        assignee?: JiraUserRef | null
      }
    }>(
      conn,
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=description,updated,attachment,reporter,assignee`
    )
    const comments = await callJson<{
      comments?: Array<{
        id: string
        author?: JiraUserRef
        created?: string
        body?: string
        jsdPublic?: boolean
      }>
    }>(conn, `/rest/api/2/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`)
    // Who raised it first, then the latest commenters, then who has it.
    const participants = toPeople([
      issue.fields?.reporter,
      ...(comments.comments ?? []).map((c) => c.author).reverse(),
      issue.fields?.assignee
    ])
    // Tags are stored as [~accountid:…]; look the names up once each.
    const texts = [
      issue.fields?.description ?? '',
      ...(comments.comments ?? []).map((c) => c.body ?? '')
    ]
    const ids = [
      ...new Set(
        texts.flatMap((t) => [...t.matchAll(/\[~accountid:([^\]|]+)\]/g)].map((m) => m[1]))
      )
    ]
    const people: Record<string, string> = {}
    await mapLimit(ids, 6, async (id) => {
      const known = peopleCache.get(id)
      if (known) {
        people[id] = known
        return
      }
      try {
        const u = await callJson<{ displayName?: string }>(
          conn,
          `/rest/api/3/user?accountId=${encodeURIComponent(id)}`
        )
        if (u.displayName) {
          people[id] = u.displayName
          peopleCache.set(id, u.displayName)
        }
      } catch {
        /* left as a tag */
      }
    })
    return {
      key,
      people,
      participants,
      descriptionWiki: issue.fields?.description ?? '',
      comments: (comments.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author?.displayName ?? 'Someone',
        created: c.created ?? '',
        body: c.body ?? '',
        internal: c.jsdPublic === false
      })),
      links: await linksFor(conn, key, issue.fields?.updated ?? ''),
      attachments: (issue.fields?.attachment ?? [])
        .filter((a) => a.filename)
        .map((a) => ({ name: a.filename!, url: `https://${conn.site}/browse/${key}` }))
    }
  })
}

// ---------------------------------------------------------------------------
// Writing. Each returns the ticket as Jira now has it.

export async function updateIssueText(
  key: string,
  patch: { summary?: string; descriptionWiki?: string }
): Promise<JiraResult<JiraIssue>> {
  if (patch.summary !== undefined && !patch.summary.trim()) {
    return { ok: false, error: 'a summary can’t be empty' }
  }
  const store = fixtureStore()
  if (store) {
    if (patch.descriptionWiki !== undefined && store.details[key]) {
      store.details[key].descriptionWiki = patch.descriptionWiki
    }
    return fixtureUpdate(key, (i) => {
      if (patch.summary !== undefined) i.summary = patch.summary.trim()
      if (patch.descriptionWiki !== undefined) i.description = patch.descriptionWiki
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const fields: Record<string, string> = {}
    if (patch.summary !== undefined) fields.summary = patch.summary.trim()
    if (patch.descriptionWiki !== undefined) fields.description = patch.descriptionWiki
    await callJson(conn, `/rest/api/2/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { fields }
    })
    return loadIssue(conn, key)
  })
}

/**
 * Adds a comment. `internal` makes it a Jira Service Management internal
 * note, which only the team sees; on a project that isn't a service desk
 * Jira ignores the flag and the comment is an ordinary one.
 */
export async function addComment(
  key: string,
  body: string,
  internal = false
): Promise<JiraResult<JiraComment>> {
  if (!body.trim()) return { ok: false, error: 'the comment is empty' }
  const store = fixtureStore()
  if (store) {
    const c = {
      id: String(Date.now()),
      author: 'You',
      created: new Date().toISOString(),
      body: body.trim(),
      internal
    }
    store.details[key]?.comments.push(c)
    return { ok: true, value: c }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const c = await callJson<{
      id: string
      author?: { displayName?: string }
      created?: string
      body?: string
      jsdPublic?: boolean
    }>(conn, `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: {
        body: body.trim(),
        ...(internal
          ? { properties: [{ key: 'sd.public.comment', value: { internal: true } }] }
          : {})
      }
    })
    return {
      id: c.id,
      author: c.author?.displayName ?? 'You',
      created: c.created ?? '',
      body: c.body ?? body,
      internal: c.jsdPublic === undefined ? internal : c.jsdPublic === false
    }
  })
}

/** Moves a ticket to a status by name — what dropping it in a board column does. */
export async function moveToStatus(key: string, status: string): Promise<JiraResult<JiraIssue>> {
  const store = fixtureStore()
  if (store) {
    const target = store.statuses.find((s) => s.name === status)
    if (!target) return { ok: false, error: `no status ${status}` }
    return fixtureUpdate(key, (i) => {
      i.status = target.name
      i.statusCategory = target.category
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const { transitions = [] } = await callJson<{
      transitions?: Array<{ id: string; to?: { name?: string } }>
    }>(conn, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
    const t = transitions.find((x) => x.to?.name === status)
    if (!t) throw new JiraError(`${key} can’t move to ${status} from where it is`)
    await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: { id: t.id } }
    })
    return loadIssue(conn, key)
  })
}

/** Someone a ticket can be assigned to. */
export interface JiraPerson {
  accountId: string
  name: string
}

/** A user as Jira returns one inside an issue, comment or search. */
interface JiraUserRef {
  accountId?: string
  displayName?: string
  active?: boolean
  accountType?: string
}

/** Real people only (no apps or deactivated accounts), each once, in order. */
function toPeople(users: Array<JiraUserRef | null | undefined>): JiraPerson[] {
  const seen = new Set<string>()
  const people: JiraPerson[] = []
  for (const u of users) {
    if (!u?.accountId || u.active === false || u.accountType === 'app') continue
    if (seen.has(u.accountId)) continue
    seen.add(u.accountId)
    people.push({ accountId: u.accountId, name: u.displayName ?? u.accountId })
  }
  return people
}

/**
 * Anyone on the Jira site whose name or email matches — for @-mentioning
 * someone who isn't on the ticket and can't be assigned tickets.
 */
export async function searchPeople(query: string): Promise<JiraResult<JiraPerson[]>> {
  const q = query.trim()
  if (!q) return { ok: true, value: [] }
  if (fixtureStore()) {
    const everyone = [{ accountId: 'fixture-sam', name: 'Sam Elsewhere' }]
    return {
      ok: true,
      value: everyone.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
    }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const users = await callJson<JiraUserRef[]>(
      conn,
      `/rest/api/3/user/search?query=${encodeURIComponent(q)}&maxResults=20`
    )
    return toPeople(users)
  })
}

const assignableCache: { at: number; people: JiraPerson[] } = { at: 0, people: [] }

/** Everyone who can be assigned tickets in the followed projects. */
export async function assignablePeople(): Promise<JiraResult<JiraPerson[]>> {
  if (fixtureStore()) {
    return {
      ok: true,
      value: [
        { accountId: 'fixture-me', name: 'You' },
        { accountId: 'fixture-someone', name: 'Someone Else' },
        { accountId: 'fixture-joanna', name: 'Joanna Fixture' }
      ]
    }
  }
  if (Date.now() - assignableCache.at < 10 * 60_000)
    return { ok: true, value: assignableCache.people }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  const config = readConfig()
  return attempt(async () => {
    const keys = encodeURIComponent((config?.projects ?? []).join(','))
    const users = await callJson<
      Array<{ accountId?: string; displayName?: string; active?: boolean; accountType?: string }>
    >(conn, `/rest/api/3/user/assignable/multiProjectSearch?projectKeys=${keys}&maxResults=500`)
    const people = users
      .filter((u) => u.accountId && u.active !== false && u.accountType !== 'app')
      .map((u) => ({ accountId: u.accountId!, name: u.displayName ?? u.accountId! }))
      .sort((a, b) => a.name.localeCompare(b.name))
    assignableCache.at = Date.now()
    assignableCache.people = people
    return people
  })
}

/**
 * Assigns a ticket: `true` to you, `false` to nobody, or a person's account
 * id to them.
 */
export async function assignIssue(
  key: string,
  who: boolean | string
): Promise<JiraResult<JiraIssue>> {
  if (fixtureStore()) {
    const people = (await assignablePeople()) as { ok: true; value: JiraPerson[] }
    const person = typeof who === 'string' ? people.value.find((p) => p.accountId === who) : null
    return fixtureUpdate(key, (i) => {
      const toMe = who === true || who === 'fixture-me'
      i.assignee = toMe ? 'You' : (person?.name ?? null)
      i.assignedToMe = toMe
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const accountId = who === true ? await me(conn) : who === false ? null : who
    await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
      method: 'PUT',
      body: { accountId }
    })
    return loadIssue(conn, key)
  })
}

export async function setParent(
  key: string,
  parentKey: string | null
): Promise<JiraResult<JiraIssue>> {
  const store = fixtureStore()
  if (store) {
    const parent = parentKey ? store.issues.find((i) => i.key === parentKey) : null
    if (parentKey && !parent) return { ok: false, error: `no issue ${parentKey}` }
    return fixtureUpdate(key, (i) => {
      i.parent = parent ? { key: parent.key, summary: parent.summary } : null
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { fields: { parent: parentKey ? { key: parentKey } : null } }
    })
    return loadIssue(conn, key)
  })
}

export async function setPriority(key: string, priority: string): Promise<JiraResult<JiraIssue>> {
  if (fixtureStore()) {
    return fixtureUpdate(key, (i) => {
      i.priority = priority
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { fields: { priority: { name: priority } } }
    })
    return loadIssue(conn, key)
  })
}

export async function setLabels(key: string, labels: string[]): Promise<JiraResult<JiraIssue>> {
  const clean = [...new Set(labels.map((l) => l.trim().replace(/\s+/g, '-')).filter(Boolean))]
  if (fixtureStore()) {
    return fixtureUpdate(key, (i) => {
      i.labels = clean
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { fields: { labels: clean } }
    })
    return loadIssue(conn, key)
  })
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

/**
 * Adds a "Blocks" link. `blockedBy` makes `other` block this ticket;
 * `blocking` makes this ticket block `other`. Returns this ticket, updated.
 */
export async function addBlockLink(
  key: string,
  other: string,
  direction: BlockDirection
): Promise<JiraResult<JiraIssue>> {
  const target = other.trim().toUpperCase()
  if (!ISSUE_KEY_RE.test(target)) return { ok: false, error: `${other} isn't a ticket key` }
  if (target === key) return { ok: false, error: "a ticket can't block itself" }
  // Jira's inwardIssue is the blocker, its outwardIssue the ticket that waits.
  const [blocker, waiting] = direction === 'blockedBy' ? [target, key] : [key, target]
  const store = fixtureStore()
  if (store) {
    const a = store.issues.find((i) => i.key === blocker)
    const b = store.issues.find((i) => i.key === waiting)
    const self = store.issues.find((i) => i.key === key)
    if (!self) return { ok: false, error: `no issue ${key}` }
    if (!a || !b) return { ok: false, error: `${target} wasn't found` }
    const linkId = `fixture-link-${store.nextId++}`
    const sideOf = (i: JiraIssue): JiraBlockLink => ({
      linkId,
      key: i.key,
      summary: i.summary,
      status: i.status,
      statusCategory: i.statusCategory
    })
    b.blockedBy = [...b.blockedBy, sideOf(a)]
    a.blocking = [...a.blocking, sideOf(b)]
    return fixtureUpdate(key, () => {})
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    await callJson(conn, '/rest/api/3/issueLink', {
      method: 'POST',
      body: {
        type: { name: BLOCKS_LINK },
        inwardIssue: { key: blocker },
        outwardIssue: { key: waiting }
      }
    })
    await refreshIfOnBoard(conn, target)
    return loadIssue(conn, key)
  })
}

/** Removes a "Blocks" link from this ticket (and so from the ticket at its other end). */
export async function removeBlockLink(key: string, linkId: string): Promise<JiraResult<JiraIssue>> {
  const store = fixtureStore()
  if (store) {
    for (const i of store.issues) {
      i.blockedBy = i.blockedBy.filter((l) => l.linkId !== linkId)
      i.blocking = i.blocking.filter((l) => l.linkId !== linkId)
    }
    return fixtureUpdate(key, () => {})
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const before = boardCache?.value.issues.find((i) => i.key === key)
    const other = [...(before?.blockedBy ?? []), ...(before?.blocking ?? [])].find(
      (l) => l.linkId === linkId
    )
    await callJson(conn, `/rest/api/3/issueLink/${encodeURIComponent(linkId)}`, {
      method: 'DELETE'
    })
    if (other) await refreshIfOnBoard(conn, other.key)
    return loadIssue(conn, key)
  })
}

/** Re-reads a ticket the board already holds; one that isn't there stays off it. */
async function refreshIfOnBoard(conn: Conn, key: string): Promise<void> {
  if (!boardCache?.value.issues.some((i) => i.key === key)) return
  await loadIssue(conn, key).catch(() => undefined)
}

const ESTIMATE_RE = /^(\d+(\.\d+)?\s*[wdhm]\s*)+$/i

/** An original estimate in Jira's shorthand ("4h", "1d 2h"), or null to clear it. */
export async function setEstimate(
  key: string,
  estimate: string | null
): Promise<JiraResult<JiraIssue>> {
  const text = estimate?.trim().toLowerCase() || null
  if (text && !ESTIMATE_RE.test(text)) {
    return { ok: false, error: 'write estimates like 30m, 4h, 2d or 1d 4h' }
  }
  if (fixtureStore()) {
    return fixtureUpdate(key, (i) => {
      i.estimate = text
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { fields: { timetracking: { originalEstimate: text ?? '' } } }
    })
    return loadIssue(conn, key)
  })
}

export interface JiraIssueType {
  id: string
  name: string
}

const FIXTURE_TYPES: JiraIssueType[] = [
  { id: '10001', name: 'Task' },
  { id: '10002', name: 'Story' },
  { id: '10003', name: 'Bug' },
  { id: '10000', name: 'Epic' }
]
const FIXTURE_SUBTASK_TYPE: JiraIssueType = { id: '10099', name: 'Sub-task' }

/** The issue types a project lets you create, sub-tasks aside. */
export async function issueTypes(project: string): Promise<JiraResult<JiraIssueType[]>> {
  if (fixtureStore()) return { ok: true, value: FIXTURE_TYPES }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const body = await callJson<{
      issueTypes?: Array<{ id: string; name: string; subtask?: boolean }>
      values?: Array<{ id: string; name: string; subtask?: boolean }>
    }>(conn, `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`)
    return (body.issueTypes ?? body.values ?? [])
      .filter((t) => !t.subtask)
      .map((t) => ({ id: t.id, name: t.name }))
  })
}

/** The one sub-task type a project's workflow allows, if it has one. */
async function subtaskIssueType(project: string): Promise<JiraResult<JiraIssueType | null>> {
  if (fixtureStore()) return { ok: true, value: FIXTURE_SUBTASK_TYPE }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const body = await callJson<{
      issueTypes?: Array<{ id: string; name: string; subtask?: boolean }>
      values?: Array<{ id: string; name: string; subtask?: boolean }>
    }>(conn, `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`)
    return (body.issueTypes ?? body.values ?? []).find((t) => t.subtask) ?? null
  })
}

/** Creates a sub-task under `parentKey`, in the parent's own project. */
export async function createSubtask(
  project: string,
  parentKey: string,
  summary: string
): Promise<JiraResult<JiraIssue>> {
  const text = summary.trim()
  if (!text) return { ok: false, error: 'a summary can’t be empty' }
  const store = fixtureStore()
  if (store) {
    const parent = store.issues.find((i) => i.key === parentKey)
    if (!parent) return { ok: false, error: `no issue ${parentKey}` }
    const key = `${project}-${store.nextId++}`
    const status = store.statuses.find((st) => st.category === 'new') ?? store.statuses[0]
    const now = new Date().toISOString()
    const issue: JiraIssue = {
      key,
      url: `https://example.atlassian.net/browse/${key}`,
      summary: text,
      description: '',
      status: status.name,
      statusCategory: status.category,
      project,
      issueType: FIXTURE_SUBTASK_TYPE.name,
      isEpic: false,
      isSubtask: true,
      priority: null,
      assignee: null,
      assignedToMe: false,
      updated: now,
      sprint: null,
      parent: { key: parent.key, summary: parent.summary },
      links: [],
      blockedBy: [],
      blocking: [],
      reporter: 'You',
      created: now,
      labels: [],
      requestType: null,
      estimate: null,
      why: null,
      pullRequests: null,
      subtasks: []
    }
    store.issues.push(issue)
    store.details[key] = { key, descriptionWiki: '', comments: [], links: [], attachments: [] }
    return { ok: true, value: { ...issue } }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  const type = await subtaskIssueType(project)
  if (!type.ok) return type
  if (!type.value) return { ok: false, error: `${project} has no sub-task type` }
  return attempt(async () => {
    const created = await callJson<{ key: string }>(conn, '/rest/api/2/issue', {
      method: 'POST',
      body: {
        fields: {
          project: { key: project },
          issuetype: { id: type.value!.id },
          parent: { key: parentKey },
          summary: text
        }
      }
    })
    return loadIssue(conn, created.key)
  })
}

export interface JiraCreateInput {
  project: string
  issueTypeId: string
  summary: string
  descriptionWiki: string
  priority: string | null
  parentKey: string | null
  labels: string[]
  sprintId: number | null
  assignToMe: boolean
}

/**
 * Creates a ticket with what every create screen accepts (project, type,
 * summary, description), then sets the rest one field at a time — so a field
 * one project's screen doesn't allow costs that field, not the ticket.
 */
export async function createIssue(
  input: JiraCreateInput
): Promise<JiraResult<{ issue: JiraIssue; skipped: string[] }>> {
  const summary = input.summary.trim()
  if (!summary) return { ok: false, error: 'a summary can’t be empty' }
  const store = fixtureStore()
  if (store) {
    const key = `${input.project}-${store.nextId++}`
    const type = FIXTURE_TYPES.find((t) => t.id === input.issueTypeId)?.name ?? 'Task'
    const parent = input.parentKey ? store.issues.find((i) => i.key === input.parentKey) : null
    const sprint = input.sprintId ? store.sprints.find((sp) => sp.id === input.sprintId) : null
    const status = store.statuses.find((st) => st.category === 'new') ?? store.statuses[0]
    const now = new Date().toISOString()
    const issue: JiraIssue = {
      key,
      url: `https://example.atlassian.net/browse/${key}`,
      summary,
      description: input.descriptionWiki,
      status: status.name,
      statusCategory: status.category,
      project: input.project,
      issueType: type,
      isEpic: type === 'Epic',
      priority: input.priority ?? 'Medium',
      assignee: input.assignToMe ? 'You' : null,
      assignedToMe: input.assignToMe,
      updated: now,
      sprint: sprint ? { ...sprint } : null,
      parent: parent ? { key: parent.key, summary: parent.summary } : null,
      links: [],
      blockedBy: [],
      blocking: [],
      reporter: 'You',
      created: now,
      labels: input.labels,
      requestType: null,
      estimate: null,
      why: null,
      pullRequests: null
    }
    store.issues.unshift(issue)
    store.details[key] = {
      key,
      descriptionWiki: input.descriptionWiki,
      comments: [],
      links: [],
      attachments: []
    }
    return { ok: true, value: { issue: { ...issue }, skipped: [] } }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const created = await callJson<{ key: string }>(conn, '/rest/api/2/issue', {
      method: 'POST',
      body: {
        fields: {
          project: { key: input.project },
          issuetype: { id: input.issueTypeId },
          summary,
          ...(input.descriptionWiki.trim() ? { description: input.descriptionWiki } : {})
        }
      }
    })
    const key = created.key
    const skipped: string[] = []
    const put = async (label: string, fields: Record<string, unknown>): Promise<void> => {
      try {
        await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: { fields }
        })
      } catch {
        skipped.push(label)
      }
    }
    if (input.priority) await put('priority', { priority: { name: input.priority } })
    if (input.parentKey) await put('epic', { parent: { key: input.parentKey } })
    if (input.labels.length) await put('labels', { labels: input.labels })
    if (input.assignToMe) {
      try {
        await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
          method: 'PUT',
          body: { accountId: await me(conn) }
        })
      } catch {
        skipped.push('assignee')
      }
    }
    if (input.sprintId) {
      try {
        await callJson(conn, `/rest/agile/1.0/sprint/${input.sprintId}/issue`, {
          method: 'POST',
          body: { issues: [key] }
        })
      } catch {
        skipped.push('cycle')
      }
    }
    return { issue: await loadIssue(conn, key), skipped }
  })
}

const prCache = new Map<string, { at: number; list: TicketPullRequest[] }>()

/**
 * A ticket's pull requests as Jira's development panel shows them (GitHub,
 * via Jira's own integration) — whichever repo and branch they came from, so
 * a PR opened from a session's main checkout still turns up.
 */
export async function ticketPullRequests(key: string): Promise<JiraResult<TicketPullRequest[]>> {
  const store = fixtureStore()
  if (store) {
    const issue = store.issues.find((i) => i.key === key)
    return {
      ok: true,
      value: issue?.pullRequests
        ? [
            {
              name: `${key} fixture pull request`,
              url: `https://github.com/example/fixture/pull/7`,
              status: issue.pullRequests === 'open' ? 'OPEN' : 'MERGED',
              branch: `${key.toLowerCase()}-fixture`,
              updated: null
            }
          ]
        : []
    }
  }
  const cached = prCache.get(key)
  if (cached && Date.now() - cached.at < 60_000) return { ok: true, value: cached.list }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const issue = await callJson<{ id: string }>(
      conn,
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`
    )
    // Ask which integrations hold this ticket's PRs rather than guessing the
    // name: the GitHub for Jira app and the older DVCS connector file them
    // under different application types, and the detail call returns an
    // empty list, not an error, for the wrong one.
    const apps = new Set<string>()
    try {
      const summary = await callJson<{
        summary?: {
          pullrequest?: { byInstanceType?: Record<string, { name?: string }> }
        }
      }>(conn, `/rest/dev-status/latest/issue/summary?issueId=${issue.id}`)
      for (const [type, v] of Object.entries(summary.summary?.pullrequest?.byInstanceType ?? {})) {
        apps.add(type)
        if (v.name) apps.add(v.name)
      }
    } catch (err) {
      // Fall back to the usual names below.
      log.warn('jira: PR summary failed', { key, error: String(err) })
    }
    for (const app of ['GitHub', 'githube']) apps.add(app)
    const list: TicketPullRequest[] = []
    const seen = new Set<string>()
    for (const app of apps) {
      try {
        const body = await callJson<{
          detail?: Array<{
            pullRequests?: Array<{
              name?: string
              url?: string
              status?: string
              lastUpdate?: string
              source?: { branch?: string }
            }>
          }>
        }>(
          conn,
          `/rest/dev-status/latest/issue/detail?issueId=${issue.id}&applicationType=${encodeURIComponent(app)}&dataType=pullrequest`
        )
        for (const d of body.detail ?? []) {
          for (const pr of d.pullRequests ?? []) {
            if (!pr.url || seen.has(pr.url)) continue
            seen.add(pr.url)
            list.push({
              name: pr.name ?? pr.url,
              url: pr.url,
              status: pr.status ?? 'OPEN',
              branch: pr.source?.branch ?? null,
              updated: pr.lastUpdate ?? null
            })
          }
        }
      } catch (err) {
        // That application isn't connected.
        log.info('jira: PR detail failed', { key, app, error: String(err) })
      }
    }
    // Open first, then most recently updated.
    list.sort(
      (a, b) =>
        Number(b.status === 'OPEN') - Number(a.status === 'OPEN') ||
        (b.updated ?? '').localeCompare(a.updated ?? '')
    )
    log.info('jira: PRs for ticket', { key, apps: [...apps], found: list.length })
    prCache.set(key, { at: Date.now(), list })
    return list
  })
}

/**
 * A Slack link in any of the shapes people copy: a message or thread link
 * (…/archives/C…/p1789660839431909, with or without https:// or a
 * ?thread_ts=…), a channel link (…/archives/C…), or an app.slack.com/client
 * thread link. Returns the https URL and the message timestamp, if any.
 */
function parseSlackLink(input: string): { url: string; ts: string | null } | null {
  const raw = input.trim().replace(/^<|>$/g, '')
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return null
  }
  if (!/(^|\.)slack\.com$/i.test(u.hostname)) return null
  const archive = u.pathname.match(/\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/i)
  if (archive) {
    return { url: u.toString(), ts: archive[2] ? `${archive[2]}.${archive[3]}` : null }
  }
  const client = u.pathname.match(
    /\/client\/[A-Z0-9]+\/[A-Z0-9]+(?:\/thread\/[A-Z0-9]+-(\d+\.\d+))?/i
  )
  if (client) return { url: u.toString(), ts: client[1] ?? null }
  return null
}

/**
 * Puts a Slack thread on a ticket the way the Zapier zaps do — same title,
 * same icon, the message's timestamp as its id — so Jira shows it exactly
 * like the ones that arrive on their own.
 */
export async function addSlackLink(key: string, url: string): Promise<JiraResult<JiraIssue>> {
  const parsed = parseSlackLink(url)
  if (!parsed) return { ok: false, error: 'that doesn’t look like a Slack link' }
  const clean = parsed.url
  const link = { url: clean, title: '💬 Open in Slack' }
  if (fixtureStore()) {
    const store = fixtureStore()!
    if (store.details[key]) store.details[key].links = [...store.details[key].links, link]
    return fixtureUpdate(key, (i) => {
      i.links = [...i.links, link]
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    await callJson(conn, `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, {
      method: 'POST',
      body: {
        globalId: parsed.ts ?? `slack-${Date.now()}`,
        object: {
          url: clean,
          title: link.title,
          icon: {
            url16x16:
              'https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png',
            title: 'Slack'
          }
        }
      }
    })
    // A new remote link doesn't touch the ticket's updated time, so the
    // links cache would keep the old list.
    linksCache.delete(key)
    return loadIssue(conn, key)
  })
}

/** Into a cycle, or (sprintId null) out of it and back to the backlog. */
export async function moveToSprint(
  key: string,
  sprintId: number | null
): Promise<JiraResult<JiraIssue>> {
  const store = fixtureStore()
  if (store) {
    const sprint = sprintId === null ? null : store.sprints.find((s) => s.id === sprintId)
    if (sprintId !== null && !sprint) return { ok: false, error: `no cycle ${sprintId}` }
    return fixtureUpdate(key, (i) => {
      i.sprint = sprint ? { ...sprint } : null
    })
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    await callJson(
      conn,
      sprintId === null
        ? '/rest/agile/1.0/backlog/issue'
        : `/rest/agile/1.0/sprint/${sprintId}/issue`,
      { method: 'POST', body: { issues: [key] } }
    )
    return loadIssue(conn, key)
  })
}

/**
 * Creates a future cycle on a board, the way Jira's "Create sprint" does. It
 * isn't started: starting and completing cycles stays in Jira.
 */
export async function createSprint(input: {
  boardId: number
  name: string
  startDate: string
  endDate: string
  goal?: string
}): Promise<JiraResult<JiraSprint>> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'a cycle needs a name' }
  const store = fixtureStore()
  if (store) {
    const sprint: JiraSprint = {
      id: Math.max(0, ...store.sprints.map((sp) => sp.id)) + 1,
      name,
      state: 'future',
      startDate: input.startDate,
      endDate: input.endDate,
      goal: input.goal?.trim() || undefined,
      boardId: input.boardId
    }
    store.sprints.push(sprint)
    return { ok: true, value: { ...sprint } }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const s = await callJson<JiraSprint & { originBoardId?: number }>(
      conn,
      '/rest/agile/1.0/sprint',
      {
        method: 'POST',
        body: {
          name,
          originBoardId: input.boardId,
          startDate: input.startDate,
          endDate: input.endDate,
          ...(input.goal?.trim() ? { goal: input.goal.trim() } : {})
        }
      }
    )
    boardCache = null
    return {
      id: s.id,
      name: s.name,
      state: s.state,
      startDate: s.startDate,
      endDate: s.endDate,
      goal: s.goal || undefined,
      boardId: s.originBoardId ?? input.boardId
    }
  })
}

/** Sets a cycle's goal in Jira (empty clears it). */
export async function setSprintGoal(
  sprintId: number,
  goal: string
): Promise<JiraResult<JiraSprint>> {
  const store = fixtureStore()
  if (store) {
    const sprint = store.sprints.find((sp) => sp.id === sprintId)
    if (!sprint) return { ok: false, error: `no cycle ${sprintId}` }
    sprint.goal = goal.trim() || undefined
    return { ok: true, value: { ...sprint } }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    // POST is Jira's partial update; PUT would replace every field.
    const s = await callJson<JiraSprint & { originBoardId?: number }>(
      conn,
      `/rest/agile/1.0/sprint/${sprintId}`,
      { method: 'POST', body: { goal: goal.trim() } }
    )
    boardCache = null
    return {
      id: s.id,
      name: s.name,
      state: s.state,
      startDate: s.startDate,
      endDate: s.endDate,
      goal: s.goal || undefined,
      boardId: s.originBoardId
    }
  })
}

/** Where one unfinished ticket goes when its cycle is completed. */
export interface CompletionMove {
  key: string
  /** A cycle's id, or null for the backlog. */
  to: number | null
}

/**
 * Completes a cycle in Jira, in the only safe order. Jira's own Complete
 * dialog moves unfinished tickets for you; its API doesn't, and a closed
 * cycle can't be reopened. So: move every unfinished ticket where it was
 * asked to go, read the cycle back to confirm nothing unfinished is left in
 * it, then close it, then confirm it closed. Any failure stops before the
 * close, and says which tickets.
 */
export async function completeSprint(
  sprintId: number,
  moves: CompletionMove[]
): Promise<JiraResult<{ closed: true; moved: number }>> {
  const store = fixtureStore()
  if (store) {
    const sprint = store.sprints.find((sp) => sp.id === sprintId)
    if (!sprint) return { ok: false, error: `no cycle ${sprintId}` }
    for (const m of moves) {
      const to = m.to === null ? null : store.sprints.find((sp) => sp.id === m.to)
      if (m.to !== null && !to) return { ok: false, error: `no cycle ${m.to}` }
      fixtureUpdate(m.key, (i) => {
        i.sprint = to ? { ...to } : null
      })
    }
    const left = store.issues.filter(
      (i) => i.sprint?.id === sprintId && i.statusCategory !== 'done' && !i.isSubtask
    )
    if (left.length) {
      return { ok: false, error: `not closed: ${left.map((i) => i.key).join(', ')} still in it` }
    }
    // Closed cycles aren't listed; done tickets keep it in their history.
    store.sprints = store.sprints.filter((sp) => sp.id !== sprintId)
    for (const i of store.issues) if (i.sprint?.id === sprintId) i.sprint = null
    return { ok: true, value: { closed: true, moved: moves.length } }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    // 1. Move, at most 50 tickets a call (Jira's limit), grouped by target.
    const byTarget = new Map<number | null, string[]>()
    for (const m of moves) byTarget.set(m.to, [...(byTarget.get(m.to) ?? []), m.key])
    for (const [to, keys] of byTarget) {
      for (let n = 0; n < keys.length; n += 50) {
        await callJson(
          conn,
          to === null ? '/rest/agile/1.0/backlog/issue' : `/rest/agile/1.0/sprint/${to}/issue`,
          { method: 'POST', body: { issues: keys.slice(n, n + 50) } }
        )
      }
    }
    // 2. Read the cycle back, every page: nothing unfinished may be left.
    const left: string[] = []
    for (let startAt = 0; ; startAt += 50) {
      const page = await callJson<{
        issues?: Array<{ key: string; fields?: { status?: { statusCategory?: { key?: string } } } }>
        total?: number
      }>(
        conn,
        `/rest/agile/1.0/sprint/${sprintId}/issue?fields=status&maxResults=50&startAt=${startAt}`
      )
      const issues = page.issues ?? []
      for (const i of issues) {
        if (i.fields?.status?.statusCategory?.key !== 'done') left.push(i.key)
      }
      if (issues.length < 50 || startAt + 50 >= (page.total ?? 0)) break
    }
    if (left.length) {
      throw new JiraError(
        `not closed: ${left.length} unfinished still in it (${left.slice(0, 5).join(', ')}${
          left.length > 5 ? '…' : ''
        }). Nothing was closed; move them and try again.`
      )
    }
    // 3. Close (POST is a partial update), 4. confirm.
    await callJson(conn, `/rest/agile/1.0/sprint/${sprintId}`, {
      method: 'POST',
      body: { state: 'closed' }
    })
    const after = await callJson<{ state?: string }>(conn, `/rest/agile/1.0/sprint/${sprintId}`)
    if (after.state !== 'closed')
      throw new JiraError(`Jira didn’t close it (it says ${after.state})`)
    boardCache = null
    return { closed: true as const, moved: moves.length }
  })
}

/** Starts a future cycle in Jira. Jira needs its dates to start it. */
export async function startSprint(
  sprintId: number,
  startDate: string,
  endDate: string
): Promise<JiraResult<JiraSprint>> {
  const store = fixtureStore()
  if (store) {
    const sprint = store.sprints.find((sp) => sp.id === sprintId)
    if (!sprint) return { ok: false, error: `no cycle ${sprintId}` }
    if (store.sprints.some((sp) => sp.state === 'active')) {
      return { ok: false, error: 'another cycle is still active' }
    }
    Object.assign(sprint, { state: 'active', startDate, endDate })
    for (const i of store.issues) if (i.sprint?.id === sprintId) i.sprint = { ...sprint }
    return { ok: true, value: { ...sprint } }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const s = await callJson<JiraSprint & { originBoardId?: number }>(
      conn,
      `/rest/agile/1.0/sprint/${sprintId}`,
      { method: 'POST', body: { state: 'active', startDate, endDate } }
    )
    boardCache = null
    return {
      id: s.id,
      name: s.name,
      state: s.state,
      startDate: s.startDate,
      endDate: s.endDate,
      goal: s.goal || undefined,
      boardId: s.originBoardId
    }
  })
}

// ---------------------------------------------------------------------------
// Session ↔ ticket links, kept locally — Jira never hears about them. Keyed
// by session record id, so a link survives restarts and renames.

const linksPath = (): string => join(app.getPath('userData'), 'jira-session-links.json')

export function sessionTicketLinks(): Record<string, string> {
  try {
    return existsSync(linksPath())
      ? (JSON.parse(readFileSync(linksPath(), 'utf8')) as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

/** Links a session to a ticket, or (issueKey null) unlinks it. */
export function linkSessionToTicket(
  recordId: string,
  issueKey: string | null
): Record<string, string> {
  const links = sessionTicketLinks()
  if (issueKey) links[recordId] = issueKey
  else delete links[recordId]
  writeFileSync(linksPath(), JSON.stringify(links))
  return links
}

// ---------------------------------------------------------------------------
// Backlog preferences, kept on this Mac: your own columns and saved views.

export interface SavedView {
  id: string
  name: string
  who: string
  cycle: string
  /** Every cycle picked (the filter can combine them); older views have only `cycle`. */
  cycles?: string[]
  groupBy: string
  subGroup?: string
  /** Columns filtered out. */
  hidden?: string[]
  /** People filtered to (empty: everyone). */
  assignees?: string[]
  /** One epic's key ('__none': no epic), or every epic. */
  epic?: string | null
  view: string
  query: string
}

export interface BacklogPrefs {
  /** Your columns; null means "use the Jira board's". */
  columns: JiraColumn[] | null
  views: SavedView[]
  /**
   * Cycle planning capacity, in days per person: sprint id (as a string) →
   * assignee name → days. Missing means "use the cycle's working-day
   * default" — see `workingDays` in the renderer's cyclePlanning.ts.
   */
  capacity: Record<string, Record<string, number>>
}

const prefsPath = (): string => join(app.getPath('userData'), 'backlog-prefs.json')

export function backlogPrefs(): BacklogPrefs {
  const store = fixtureStore()
  if (store) return structuredClone(store.prefs)
  try {
    const raw = existsSync(prefsPath())
      ? (JSON.parse(readFileSync(prefsPath(), 'utf8')) as Partial<BacklogPrefs>)
      : {}
    return { columns: raw.columns ?? null, views: raw.views ?? [], capacity: raw.capacity ?? {} }
  } catch {
    return { columns: null, views: [], capacity: {} }
  }
}

export function saveBacklogPrefs(patch: Partial<BacklogPrefs>): BacklogPrefs {
  const next = { ...backlogPrefs(), ...patch }
  const store = fixtureStore()
  if (store) store.prefs = structuredClone(next)
  else writeFileSync(prefsPath(), JSON.stringify(next, null, 2))
  return next
}

export interface QuickIssue {
  key: string
  summary: string
  url: string
  /** On the loaded Backlog board — choosing it can open that panel directly. */
  onBoard: boolean
}

/**
 * ⌘K typing a ticket key: the loaded board first (no network call, and
 * whatever's on screen is what "choosing it" should match), else a direct
 * fetch — so a ticket that's Done, or in a project the board doesn't track,
 * still resolves instead of just failing.
 */
export async function quickIssueLookup(rawKey: string): Promise<JiraResult<QuickIssue>> {
  const key = rawKey.trim().toUpperCase()
  const store = fixtureStore()
  if (store) {
    const found = store.issues.find((i) => i.key === key)
    if (!found) return { ok: false, error: `${key} wasn't found` }
    // Mirrors the real board's JQL (project in the tracked list AND (not Done,
    // or Done but still in an open sprint)) — a Done ticket, or one from a
    // project this board doesn't track, isn't on the board, so ⌘K should send
    // it to Jira in the browser rather than claim a panel that doesn't exist.
    const openSprintIds = new Set(
      store.sprints.filter((s) => s.state === 'active').map((s) => s.id)
    )
    const onBoard =
      found.project in store.projectStatuses &&
      (found.statusCategory !== 'done' ||
        Boolean(found.sprint && openSprintIds.has(found.sprint.id)))
    return {
      ok: true,
      value: {
        key: found.key,
        summary: found.summary,
        url: `https://example.atlassian.net/browse/${found.key}`,
        onBoard
      }
    }
  }
  if (!boardCache) {
    // Empty only means "nothing has loaded the board yet this run" — not
    // "not on the board". Fill it (respecting its own TTL) before deciding.
    await loadBoard()
  }
  if (boardCache) {
    const found = boardCache.value.issues.find((i) => i.key === key)
    if (found) {
      return {
        ok: true,
        value: { key: found.key, summary: found.summary, url: found.url, onBoard: true }
      }
    }
  }
  const conn = connection()
  if ('error' in conn) return { ok: false, error: conn.error }
  return attempt(async () => {
    const raw = await callJson<{ key?: string; fields?: { summary?: string } }>(
      conn,
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`
    )
    if (!raw?.key) throw new JiraError(`${key} wasn't found`)
    return {
      key: raw.key,
      summary: raw.fields?.summary ?? '',
      url: `https://${conn.site}/browse/${raw.key}`,
      onBoard: false
    }
  })
}
