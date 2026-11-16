import { useEffect, useMemo, useState } from 'react'
import { Button, Count, EmptyState, Icon, Input, Tooltip } from '../components/primitives'
import type { IconName } from '../components/primitives'
import { Meta, MetaItem } from '../components/primitives/Meta'
import Modal from '../components/primitives/Modal'
import type { MenuItem } from '../components/MenuItems'
import { Picker } from './backlog/Picker'
import { OverflowMenu } from './SessionsScreen'
import {
  addArtifact,
  addJiraArtifactLink,
  copyText,
  getArtifactPreview,
  getJiraStatus,
  loadJiraBoard,
  openExternal,
  removeArtifact,
  renameArtifact,
  type Artifact
} from '../api'
import type { JiraIssue } from '../../../main/exec/jira'
import { ARTIFACT_LINK, artifactName, useArtifacts } from '../state/useArtifacts'
import { useStoredState } from '../state/useStoredState'
import type { ComposerSeed } from './backlog/ticketSessions'
import { relativeTime } from '../lib/format-time'
import './sessions-list.css'
import './artifacts.css'

/** Yours: a session published it, or claude.ai says you own it. */
type Kind = 'yours' | 'shared' | 'other'
const KINDS: { id: Kind; label: string; title: string }[] = [
  { id: 'yours', label: 'Yours', title: 'Published by you' },
  { id: 'shared', label: 'Shared with you', title: 'Someone else’s, shared with you' },
  { id: 'other', label: 'Other', title: 'Added by link, without saying whose it is' }
]

function kindOf(a: Artifact): Kind {
  if (a.source === 'made' || a.owned === true) return 'yours'
  if (a.owned === false) return 'shared'
  return 'other'
}

/** Who can see it, in words. Null when claude.ai never said. */
function audienceWords(a: Artifact): string | null {
  if (a.owned === false) return 'Shared with you'
  if (a.audience === 'owner') return 'Only you'
  if (a.audience === 'org') return 'Your organisation'
  if (a.audience === 'public' || a.audience === 'link') return 'Anyone with the link'
  if (a.audience) return a.audience
  return null
}

/** The publisher's icon word, as one of ours; an emoji stays an emoji. */
const ICONS: Record<string, IconName> = {
  chart: 'ChartColumn',
  graph: 'ChartLine',
  calculator: 'Calculator',
  map: 'Map',
  calendar: 'Calendar',
  code: 'Code',
  table: 'Table',
  list: 'List',
  doc: 'FileText',
  document: 'FileText',
  report: 'FileText',
  plan: 'ClipboardList',
  slides: 'Presentation',
  deck: 'Presentation',
  design: 'Palette',
  dashboard: 'LayoutDashboard',
  form: 'ClipboardPen',
  game: 'Gamepad2',
  recipe: 'ChefHat',
  book: 'BookOpen',
  money: 'Banknote',
  people: 'Users',
  diagram: 'Workflow'
}

function ArtifactGlyph({ a, size }: { a: Artifact; size: number }): React.JSX.Element {
  const word = (a.icon ?? '').toLowerCase()
  if (word && !/^[a-z-]+$/.test(word)) {
    return (
      <span className="artifacts-emoji" style={{ fontSize: size }} aria-hidden>
        {a.icon}
      </span>
    )
  }
  const kindIcon: IconName | undefined = a.kind
    ? /slide|deck/i.test(a.kind)
      ? 'Presentation'
      : /design/i.test(a.kind)
        ? 'Palette'
        : /doc/i.test(a.kind)
          ? 'FileText'
          : /data|dashboard/i.test(a.kind)
            ? 'LayoutDashboard'
            : undefined
    : undefined
  return <Icon name={ICONS[word] ?? kindIcon ?? 'AppWindow'} size={size} />
}

// Pictures already drawn, by url, so scrolling back doesn't ask again.
const drawn = new Map<string, string | null>()

/** The picture of an artifact's page: undefined while it's drawn, null when there's none. */
function usePreview(a: Artifact): string | null | undefined {
  const [src, setSrc] = useState<string | null | undefined>(() =>
    a.preview ? drawn.get(a.url) : null
  )
  useEffect(() => {
    if (!a.preview || drawn.has(a.url)) return
    let live = true
    void getArtifactPreview(a.url).then((s) => {
      drawn.set(a.url, s)
      if (live) setSrc(s)
    })
    return () => {
      live = false
    }
  }, [a.url, a.preview])
  return a.preview ? (src ?? drawn.get(a.url)) : null
}

function Thumb({ a, large }: { a: Artifact; large?: boolean }): React.JSX.Element {
  const src = usePreview(a)
  return (
    <div
      className={`artifacts-thumb${large ? ' artifacts-thumb--large' : ''}`}
      data-artifact-thumb={src ? 'picture' : src === undefined ? 'drawing' : 'none'}
    >
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <div className="artifacts-thumb-blank">
          <ArtifactGlyph a={a} size={large ? 40 : 28} />
          {src === undefined ? <span>Drawing a preview…</span> : a.kind && <span>{a.kind}</span>}
        </div>
      )}
    </div>
  )
}

/** "Published 3d ago", "Opened 2h ago": what happened last, and when. */
function lastWords(a: Artifact): string {
  const verb =
    a.source === 'made'
      ? 'Published'
      : a.source === 'opened'
        ? 'Opened'
        : a.source === 'added'
          ? 'Added'
          : 'Updated'
  return a.at ? `${verb} ${relativeTime(new Date(a.at).getTime())}` : verb
}

function dateWords(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

/**
 * Every Claude artifact Control Room can see: what your sessions published,
 * what they opened (often someone else's, shared with you), what claude.ai
 * listed for them, and links you added. Each opens a preview with what's
 * known about it; from there, open it, start a session about it, or put it
 * on a ticket.
 */
export default function ArtifactsScreen({
  onOpenSession,
  onOpenTicket,
  onStartSession,
  pushToast
}: {
  onOpenSession: (liveKey: string) => void
  onOpenTicket: (key: string) => void
  onStartSession: (seed: ComposerSeed) => void
  pushToast: (message: string) => void
}): React.JSX.Element {
  const { artifacts, refresh, set } = useArtifacts()
  const [kind, setKind] = useState<Kind | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useStoredState<'grid' | 'list'>('cr.artifacts.view', 'grid')
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [ticketFor, setTicketFor] = useState<{ artifact: Artifact; anchor: HTMLElement } | null>(
    null
  )
  const [board, setBoard] = useState<JiraIssue[] | null>(null)
  const [jira, setJira] = useState(false)
  useEffect(() => {
    void getJiraStatus().then((s) => {
      setJira(s.configured)
      if (s.configured) void loadJiraBoard().then((r) => setBoard(r.ok ? r.value.issues : []))
    })
  }, [])

  const all = useMemo(() => artifacts ?? [], [artifacts])
  // Which tickets carry each artifact, from their Jira web links.
  const ticketsOf = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const issue of board ?? []) {
      for (const l of issue.links) {
        const url = ARTIFACT_LINK.exec(l.url)?.[0]
        if (!url) continue
        const keys = m.get(url) ?? []
        if (!keys.includes(issue.key)) m.set(url, [...keys, issue.key])
      }
    }
    return m
  }, [board])
  const counts = useMemo(() => {
    const m = new Map<Kind, number>()
    for (const a of all) m.set(kindOf(a), (m.get(kindOf(a)) ?? 0) + 1)
    return m
  }, [all])
  const shown = all.filter((a) => {
    if (kind && kindOf(a) !== kind) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [artifactName(a), a.url, a.description ?? '', a.kind ?? '']
      .concat(a.sessions.flatMap((s) => [s.title, s.project ?? '']))
      .concat(ticketsOf.get(a.url) ?? [])
      .some((t) => t.toLowerCase().includes(q))
  })
  const opened = open ? all.find((a) => a.url === open) : undefined

  const copy = (a: Artifact): void => {
    void copyText(a.link).then((r) =>
      pushToast(r.ok ? 'Link copied.' : (r.error ?? 'Could not copy the link.'))
    )
  }
  const startAbout = (a: Artifact): void => {
    const name = artifactName(a)
    setOpen(null)
    onStartSession({
      prompt: `${name}: ${a.link}\n\n`,
      branch: `artifact-${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40)}`,
      title: name,
      jiraProject: ''
    })
  }
  const addToTicket = (a: Artifact, anchor: HTMLElement | null): void => {
    if (anchor) setTicketFor({ artifact: a, anchor })
  }
  const rowAnchor = (a: Artifact): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-artifact-row="${CSS.escape(a.url)}"]`)

  const actions = (a: Artifact): MenuItem[] => [
    { label: 'Open in browser', icon: 'ExternalLink', onClick: () => void openExternal(a.link) },
    { label: 'Copy link', icon: 'Link', onClick: () => copy(a) },
    { label: 'Start a session about it', icon: 'MessageSquarePlus', onClick: () => startAbout(a) },
    ...(jira
      ? [
          {
            label: 'Add to a ticket',
            icon: 'Ticket' as const,
            onClick: () => addToTicket(a, rowAnchor(a))
          }
        ]
      : []),
    {
      label: 'Rename',
      icon: 'Pencil',
      group: 'edit',
      onClick: () => {
        setView('list')
        setRenaming(a.url)
      }
    },
    ...(a.source === 'added'
      ? [
          {
            label: 'Remove from list',
            icon: 'Trash2' as const,
            group: 'edit',
            onClick: () => void removeArtifact(a.url).then(set)
          }
        ]
      : [])
  ]

  return (
    <div className="sessions-main artifacts-screen" data-artifacts-screen>
      <div className="sessions-main-header">
        <div className="sessions-main-heading">
          <h1 className="sessions-main-title">Artifacts</h1>
          {(kind || query) && artifacts && (
            <p className="sessions-main-caption">
              {shown.length} of {all.length} artifact{all.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
        <div className="sessions-main-controls">
          <Button variant="ghost" size="compact" onClick={() => setAdding(true)}>
            <Icon name="Plus" size={12} />
            Add link
          </Button>
          <div className="sessions-view-toggle" role="radiogroup" aria-label="View">
            {(
              [
                { value: 'grid', icon: 'LayoutGrid', label: 'Grid view' },
                { value: 'list', icon: 'List', label: 'List view' }
              ] as const
            ).map((o) => (
              <Tooltip key={o.value} label={o.label}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={view === o.value}
                  aria-label={o.label}
                  className={
                    view === o.value
                      ? 'sessions-view-option sessions-view-option--selected'
                      : 'sessions-view-option'
                  }
                  onClick={() => setView(o.value)}
                >
                  <Icon name={o.icon} size={16} />
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>

      {all.length > 0 && (
        <div className="sessions-filters">
          <div className="sessions-filter-tabs" role="group" aria-label="Filter artifacts">
            <button
              type="button"
              aria-pressed={kind === null}
              className={
                kind === null
                  ? 'sessions-filter-tab sessions-filter-tab--selected'
                  : 'sessions-filter-tab'
              }
              onClick={() => setKind(null)}
            >
              All
              <Count className="sessions-filter-count" value={all.length} />
            </button>
            {KINDS.filter((k) => (counts.get(k.id) ?? 0) > 0 || kind === k.id).map((k) => (
              <button
                key={k.id}
                type="button"
                title={k.title}
                aria-pressed={kind === k.id}
                className={
                  kind === k.id
                    ? 'sessions-filter-tab sessions-filter-tab--selected'
                    : 'sessions-filter-tab'
                }
                onClick={() => setKind(kind === k.id ? null : k.id)}
              >
                {k.label}
                <Count className="sessions-filter-count" value={counts.get(k.id) ?? 0} />
              </button>
            ))}
          </div>
          <div className="sessions-filter-row">
            <label className="sessions-search">
              <Icon name="Search" size={14} />
              <input
                type="search"
                aria-label="Search artifacts"
                placeholder="Search artifacts"
                title="Matches the name, description, session, project or ticket"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setQuery('')
                    e.currentTarget.blur()
                  }
                }}
              />
            </label>
          </div>
        </div>
      )}

      {artifacts === undefined ? null : all.length === 0 ? (
        <EmptyState
          icon="AppWindow"
          title="No artifacts yet"
          body="Pages your sessions publish or open with Claude’s Artifact tool show up here. You can also add a link someone sent you."
        />
      ) : shown.length === 0 ? (
        <p className="sessions-list-empty">Nothing matches.</p>
      ) : view === 'grid' ? (
        <div className="artifacts-grid">
          {shown.map((a) => (
            <ArtifactCard
              key={a.url}
              artifact={a}
              tickets={ticketsOf.get(a.url) ?? []}
              actions={actions(a)}
              onOpen={() => setOpen(a.url)}
              onOpenTicket={onOpenTicket}
            />
          ))}
        </div>
      ) : (
        <div className="artifacts-list">
          {shown.map((a) => (
            <ArtifactRow
              key={a.url}
              artifact={a}
              tickets={ticketsOf.get(a.url) ?? []}
              renaming={renaming === a.url}
              actions={actions(a)}
              onOpen={() => setOpen(a.url)}
              onOpenSession={(id) => onOpenSession(`record:${id}`)}
              onOpenTicket={onOpenTicket}
              onRename={(title) => {
                setRenaming(null)
                if (title !== null) void renameArtifact(a.url, title).then(set)
              }}
            />
          ))}
        </div>
      )}

      {opened && (
        <ArtifactPreview
          artifact={opened}
          tickets={ticketsOf.get(opened.url) ?? []}
          jira={jira}
          onClose={() => setOpen(null)}
          onCopy={() => copy(opened)}
          onStartSession={() => startAbout(opened)}
          onAddToTicket={(anchor) => addToTicket(opened, anchor)}
          onOpenSession={(id) => {
            setOpen(null)
            onOpenSession(`record:${id}`)
          }}
          onOpenTicket={(key) => {
            setOpen(null)
            onOpenTicket(key)
          }}
        />
      )}

      {ticketFor && (
        <Picker
          anchor={ticketFor.anchor}
          title="Add to ticket"
          emptyText={board === null ? 'Loading tickets…' : 'No match'}
          options={(board ?? []).map((t) => ({ value: t.key, label: `${t.key} ${t.summary}` }))}
          onClose={() => setTicketFor(null)}
          onPick={(key) => {
            const a = ticketFor.artifact
            void addJiraArtifactLink(key, a.link, artifactName(a)).then((r) => {
              pushToast(r.ok ? `Added to ${key}.` : `Jira: ${r.error}`)
              if (r.ok) void loadJiraBoard().then((b) => b.ok && setBoard(b.value.issues))
            })
          }}
        />
      )}

      {adding && (
        <AddLink
          onClose={() => setAdding(false)}
          onAdded={(a) => {
            setAdding(false)
            refresh()
            pushToast(`Added ${artifactName(a)}.`)
          }}
        />
      )}
    </div>
  )
}

/** The facts under a title: when, who can see it, versions, project and tickets. */
function Facts({
  a,
  tickets,
  onOpenTicket
}: {
  a: Artifact
  tickets: string[]
  onOpenTicket: (key: string) => void
}): React.JSX.Element {
  const audience = audienceWords(a)
  const session = a.sessions[a.sessions.length - 1]
  return (
    <Meta className="artifacts-facts">
      <MetaItem icon="Clock">{lastWords(a)}</MetaItem>
      {audience && (
        <MetaItem
          icon={a.owned === false ? 'UserRound' : a.audience === 'owner' ? 'Lock' : 'Users'}
        >
          {audience}
        </MetaItem>
      )}
      {a.versions && a.versions > 1 && <MetaItem icon="History">{a.versions} versions</MetaItem>}
      {session?.project && <MetaItem icon="Folder">{session.project}</MetaItem>}
      {tickets.map((k) => (
        <button
          key={k}
          type="button"
          className="sessions-ticket-pill"
          title={`Open ${k} in Tickets`}
          onClick={(e) => {
            e.stopPropagation()
            onOpenTicket(k)
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {k}
        </button>
      ))}
    </Meta>
  )
}

function ArtifactCard({
  artifact: a,
  tickets,
  actions,
  onOpen,
  onOpenTicket
}: {
  artifact: Artifact
  tickets: string[]
  actions: MenuItem[]
  onOpen: () => void
  onOpenTicket: (key: string) => void
}): React.JSX.Element {
  return (
    <div
      className="artifacts-card"
      role="button"
      tabIndex={0}
      data-artifact-row={a.url}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <Thumb a={a} />
      <div className="artifacts-card-body">
        <div className="artifacts-card-title-row">
          <span className="artifacts-card-glyph">
            <ArtifactGlyph a={a} size={14} />
          </span>
          <span className="sessions-row-title">{artifactName(a)}</span>
          <OverflowMenu
            actions={actions}
            label={`${artifactName(a)} actions`}
            className="sessions-row-overflow"
          />
        </div>
        {a.description && <p className="artifacts-description">{a.description}</p>}
        <Facts a={a} tickets={tickets} onOpenTicket={onOpenTicket} />
      </div>
    </div>
  )
}

function ArtifactRow({
  artifact: a,
  tickets,
  renaming,
  actions,
  onOpen,
  onOpenSession,
  onOpenTicket,
  onRename
}: {
  artifact: Artifact
  tickets: string[]
  renaming: boolean
  actions: MenuItem[]
  onOpen: () => void
  onOpenSession: (recordId: string) => void
  onOpenTicket: (key: string) => void
  /** The new name, or null to leave it as it was. */
  onRename: (title: string | null) => void
}): React.JSX.Element {
  const [name, setName] = useState(a.title)
  const session = a.sessions[a.sessions.length - 1]
  return (
    <div
      className="sessions-row sessions-row-clickable artifacts-row"
      role="button"
      tabIndex={0}
      data-artifact-row={a.url}
      title={a.link}
      onClick={() => !renaming && onOpen()}
      onKeyDown={(e) => {
        if (!renaming && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="sessions-row-line1">
        <span className="artifacts-card-glyph">
          <ArtifactGlyph a={a} size={14} />
        </span>
        {renaming ? (
          <form
            className="sessions-row-rename-form"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              onRename(name)
            }}
          >
            <Input
              autoFocus
              aria-label="Artifact name"
              value={name}
              placeholder={artifactName({ ...a, title: '' })}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => onRename(name)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  onRename(null)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  onRename(name)
                }
              }}
            />
          </form>
        ) : (
          <span className="sessions-row-title">{artifactName(a)}</span>
        )}
        <OverflowMenu
          actions={actions}
          label={`${artifactName(a)} actions`}
          className="sessions-row-overflow"
        />
      </div>
      {a.description && <p className="artifacts-description">{a.description}</p>}
      <div className="sessions-row-line2">
        <Facts a={a} tickets={tickets} onOpenTicket={onOpenTicket} />
        {session && (
          <button
            type="button"
            className="artifacts-row-session"
            title={`Open the session “${session.title}”`}
            onClick={(e) => {
              e.stopPropagation()
              onOpenSession(session.recordId)
            }}
          >
            <Icon name="SquareTerminal" size={12} />
            <span>{session.title}</span>
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * One artifact up close: a large picture of the page, what's known about
 * it, and what you can do with it.
 */
function ArtifactPreview({
  artifact: a,
  tickets,
  jira,
  onClose,
  onCopy,
  onStartSession,
  onAddToTicket,
  onOpenSession,
  onOpenTicket
}: {
  artifact: Artifact
  tickets: string[]
  jira: boolean
  onClose: () => void
  onCopy: () => void
  onStartSession: () => void
  onAddToTicket: (anchor: HTMLElement) => void
  onOpenSession: (recordId: string) => void
  onOpenTicket: (key: string) => void
}): React.JSX.Element {
  const audience = audienceWords(a)
  const rows: [string, React.ReactNode][] = [
    ...(audience ? [['Who can see it', audience] as [string, React.ReactNode]] : []),
    ['Last change', a.at ? `${lastWords(a)}, ${dateWords(a.at)}` : '-'],
    ['First seen', dateWords(a.firstAt)],
    ...(a.versions ? [['Versions', String(a.versions)] as [string, React.ReactNode]] : []),
    ...(a.kind ? [['Made from', a.kind] as [string, React.ReactNode]] : [])
  ]
  return (
    <Modal title={artifactName(a)} icon="AppWindow" width={880} onClose={onClose}>
      <div className="artifacts-preview" data-artifact-preview>
        <button
          type="button"
          className="artifacts-preview-picture"
          title="Open in your browser"
          onClick={() => void openExternal(a.link)}
        >
          <Thumb a={a} large />
        </button>
        {a.description && <p className="artifacts-preview-description">{a.description}</p>}
        <div className="artifacts-preview-actions">
          <Button variant="filled" size="compact" onClick={() => void openExternal(a.link)}>
            <Icon name="ExternalLink" size={12} />
            Open in browser
          </Button>
          <Button variant="ghost" size="compact" onClick={onStartSession}>
            <Icon name="MessageSquarePlus" size={12} />
            Start a session about it
          </Button>
          {jira && (
            <Button variant="ghost" size="compact" onClick={(e) => onAddToTicket(e.currentTarget)}>
              <Icon name="Ticket" size={12} />
              Add to a ticket
            </Button>
          )}
          <Button variant="ghost" size="compact" onClick={onCopy}>
            <Icon name="Link" size={12} />
            Copy link
          </Button>
        </div>
        <dl className="artifacts-preview-facts">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          {a.sessions.length > 0 && (
            <div>
              <dt>Sessions</dt>
              <dd className="artifacts-preview-links">
                {a.sessions.map((s) => (
                  <button
                    key={s.recordId}
                    type="button"
                    className="artifacts-row-session"
                    onClick={() => onOpenSession(s.recordId)}
                  >
                    <Icon name="SquareTerminal" size={12} />
                    <span>{s.title}</span>
                    {s.project && <span className="artifacts-muted">· {s.project}</span>}
                  </button>
                ))}
              </dd>
            </div>
          )}
          {tickets.length > 0 && (
            <div>
              <dt>Tickets</dt>
              <dd className="artifacts-preview-links">
                {tickets.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="sessions-ticket-pill"
                    onClick={() => onOpenTicket(k)}
                  >
                    {k}
                  </button>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </Modal>
  )
}

function AddLink({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded: (a: Artifact) => void
}): React.JSX.Element {
  const [link, setLink] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const valid = ARTIFACT_LINK.test(link)
  return (
    <Modal title="Add an artifact" icon="AppWindow" width={520} onClose={onClose}>
      <form
        className="artifacts-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid) return
          void addArtifact(link, title).then((r) => {
            if (r.ok) onAdded(r.artifact)
            else setError(r.error)
          })
        }}
      >
        <label className="artifacts-add-field">
          <span>Link</span>
          <Input
            autoFocus
            aria-label="Artifact link"
            placeholder="https://claude.ai/artifact/…"
            value={link}
            onChange={(e) => {
              setLink(e.target.value)
              setError(null)
            }}
          />
        </label>
        <label className="artifacts-add-field">
          <span>Name</span>
          <Input
            aria-label="Artifact name"
            placeholder="What it’s called (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {error ? (
          <p className="artifacts-add-error" role="alert">
            {error}
          </p>
        ) : (
          link.trim() &&
          !valid && <p className="artifacts-add-error">That isn’t a claude.ai artifact link.</p>
        )}
        <div className="artifacts-add-actions">
          <Button variant="ghost" size="compact" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" size="compact" type="submit" disabled={!valid}>
            Add
          </Button>
        </div>
      </form>
    </Modal>
  )
}
