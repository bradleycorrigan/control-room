import { useEffect, useMemo, useState } from 'react'
import { Button, Count, EmptyState, Icon, Input } from '../components/primitives'
import Modal from '../components/primitives/Modal'
import type { MenuItem } from '../components/MenuItems'
import { Picker } from './backlog/Picker'
import { OverflowMenu } from './SessionsScreen'
import {
  addArtifact,
  addJiraArtifactLink,
  copyText,
  getJiraStatus,
  loadJiraBoard,
  openExternal,
  removeArtifact,
  renameArtifact,
  type Artifact
} from '../api'
import type { JiraIssue } from '../../../main/exec/jira'
import { ARTIFACT_LINK, artifactName, useArtifacts } from '../state/useArtifacts'
import type { ComposerSeed } from './backlog/ticketSessions'
import { relativeTime } from '../lib/format-time'
import './sessions-list.css'
import './artifacts.css'

/** Yours: a session published it, or claude.ai says you own it. */
type Kind = 'yours' | 'shared' | 'other'
const KINDS: { id: Kind; label: string; title: string }[] = [
  { id: 'yours', label: 'Yours', title: 'Published by one of your sessions, or owned by you' },
  {
    id: 'shared',
    label: 'Shared with you',
    title: 'Someone else’s, opened in one of your sessions'
  },
  { id: 'other', label: 'Other', title: 'Added by link, or opened without saying whose it is' }
]

function kindOf(a: Artifact): Kind {
  if (a.source === 'made' || a.owned === true) return 'yours'
  if (a.owned === false) return 'shared'
  return 'other'
}

/** Where it came from, in a few words, for the row's second line. */
function sourceWords(a: Artifact): string {
  if (a.source === 'made') return 'Published'
  if (a.source === 'opened') return 'Opened'
  return 'Added'
}

/**
 * Every Claude artifact Control Room can see: what your sessions published,
 * what they opened (often someone else's, shared with you), and links you
 * added. Open one, start a session about it, or put it on a ticket.
 */
export default function ArtifactsScreen({
  onOpenSession,
  onStartSession,
  pushToast
}: {
  onOpenSession: (liveKey: string) => void
  onStartSession: (seed: ComposerSeed) => void
  pushToast: (message: string) => void
}): React.JSX.Element {
  const { artifacts, refresh, set } = useArtifacts()
  const [kind, setKind] = useState<Kind | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ticketFor, setTicketFor] = useState<{ artifact: Artifact; anchor: HTMLElement } | null>(
    null
  )
  const [tickets, setTickets] = useState<JiraIssue[] | null>(null)
  const [jira, setJira] = useState(false)
  useEffect(() => {
    void getJiraStatus().then((s) => setJira(s.configured))
  }, [])

  const all = useMemo(() => artifacts ?? [], [artifacts])
  const counts = useMemo(() => {
    const m = new Map<Kind, number>()
    for (const a of all) m.set(kindOf(a), (m.get(kindOf(a)) ?? 0) + 1)
    return m
  }, [all])
  const shown = all.filter((a) => {
    if (kind && kindOf(a) !== kind) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return (
      artifactName(a).toLowerCase().includes(q) ||
      a.url.toLowerCase().includes(q) ||
      a.sessions.some((s) => s.title.toLowerCase().includes(q))
    )
  })

  const copy = (a: Artifact): void => {
    void copyText(a.link).then((r) =>
      pushToast(r.ok ? 'Link copied.' : (r.error ?? 'Could not copy the link.'))
    )
  }
  const startAbout = (a: Artifact): void => {
    const name = artifactName(a)
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
  const openTicketPicker = (a: Artifact, anchor: HTMLElement): void => {
    setTicketFor({ artifact: a, anchor })
    if (tickets === null) void loadJiraBoard().then((r) => setTickets(r.ok ? r.value.issues : []))
  }

  const actions = (a: Artifact): MenuItem[] => [
    { label: 'Open in browser', icon: 'ExternalLink', onClick: () => void openExternal(a.link) },
    { label: 'Copy link', icon: 'Link', onClick: () => copy(a) },
    { label: 'Start a session about it', icon: 'MessageSquarePlus', onClick: () => startAbout(a) },
    ...(jira
      ? [
          {
            label: 'Add to a ticket',
            icon: 'Ticket' as const,
            onClick: () => {
              const el = document.querySelector<HTMLElement>(
                `[data-artifact-row="${CSS.escape(a.url)}"]`
              )
              if (el) openTicketPicker(a, el)
            }
          }
        ]
      : []),
    { label: 'Rename', icon: 'Pencil', group: 'edit', onClick: () => setRenaming(a.url) },
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
                title="Matches the name, link or session"
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
      ) : (
        <div className="artifacts-list">
          {shown.map((a) => (
            <ArtifactRow
              key={a.url}
              artifact={a}
              renaming={renaming === a.url}
              actions={actions(a)}
              onOpen={() => void openExternal(a.link)}
              onOpenSession={(id) => onOpenSession(`record:${id}`)}
              onRename={(title) => {
                setRenaming(null)
                if (title !== null) void renameArtifact(a.url, title).then(set)
              }}
            />
          ))}
        </div>
      )}

      {ticketFor && (
        <Picker
          anchor={ticketFor.anchor}
          title="Add to ticket"
          emptyText={tickets === null ? 'Loading tickets…' : 'No match'}
          options={(tickets ?? []).map((t) => ({ value: t.key, label: `${t.key} ${t.summary}` }))}
          onClose={() => setTicketFor(null)}
          onPick={(key) => {
            const a = ticketFor.artifact
            void addJiraArtifactLink(key, a.link, artifactName(a)).then((r) =>
              pushToast(r.ok ? `Added to ${key}.` : `Jira: ${r.error}`)
            )
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

function ArtifactRow({
  artifact: a,
  renaming,
  actions,
  onOpen,
  onOpenSession,
  onRename
}: {
  artifact: Artifact
  renaming: boolean
  actions: MenuItem[]
  onOpen: () => void
  onOpenSession: (recordId: string) => void
  /** The new name, or null to leave it as it was. */
  onRename: (title: string | null) => void
}): React.JSX.Element {
  const [name, setName] = useState(a.title)
  const session = a.sessions[a.sessions.length - 1]
  const when = a.at ? relativeTime(new Date(a.at).getTime()) : null
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
        <Icon name="AppWindow" size={14} />
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
      <div className="sessions-row-line2">
        <span className="artifacts-row-meta">
          {sourceWords(a)}
          {when ? ` ${when}` : ''}
          {a.owned === false ? ' · shared with you' : ''}
        </span>
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
