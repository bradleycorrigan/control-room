import { useRef, useState } from 'react'
import { Icon, IconButton, Popover } from './primitives'
import { MenuItems, type MenuItem } from './MenuItems'
import { PillFolder } from './PillFolder'
import { addJiraComment, copyText, openExternal } from '../api'
import type { TranscriptArtifact } from '../api-sessions'
import './pr-chip.css'

/** More than this many artifacts fold into one "N artifacts" pill. */
const FOLD_OVER = 2

/** What can be done with an artifact: the one list, for its pill and its row. */
function artifactActions(
  artifact: TranscriptArtifact,
  ticketKey: string | null,
  pushToast?: (message: string) => void
): MenuItem[] {
  return [
    {
      label: 'Open artifact',
      icon: 'ExternalLink',
      onClick: () => void openExternal(artifact.url)
    },
    {
      label: 'Copy link',
      icon: 'Link',
      onClick: () =>
        void copyText(artifact.url).then((r) =>
          pushToast?.(r.ok ? 'Link copied.' : (r.error ?? 'Could not copy the link.'))
        )
    },
    ...(ticketKey
      ? [
          {
            label: `Add link to ${ticketKey}`,
            icon: 'MessageSquarePlus' as const,
            group: 'ticket',
            onClick: () =>
              void addJiraComment(
                ticketKey,
                `Artifact: [${artifact.title}|${artifact.url}]`,
                true
              ).then((r) => pushToast?.(r.ok ? `Link added to ${ticketKey}.` : `Jira: ${r.error}`))
          }
        ]
      : [])
  ]
}

/**
 * A page the session published with Claude's Artifact tool, beside its ticket
 * and pull requests in the session header. A click opens what you can do
 * with it: open it, copy its link, or note the link on the ticket.
 * Sharing is set on the page itself in claude.ai, so Open is the way there.
 */
export function ArtifactChip({
  artifact,
  ticketKey,
  pushToast
}: {
  artifact: TranscriptArtifact
  ticketKey: string | null
  pushToast?: (message: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <span className="cr-artifact-chip-wrap" ref={anchor}>
      <button
        type="button"
        className="cr-pr-chip cr-pr-chip--20 cr-artifact-chip"
        title={artifact.title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <Icon name="AppWindow" size={12} />
        <span className="cr-artifact-chip-title">{artifact.title}</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="bottom-start"
        aria-label={`${artifact.title} actions`}
      >
        <MenuItems
          items={artifactActions(artifact, ticketKey, pushToast)}
          onPicked={() => setOpen(false)}
        />
      </Popover>
    </span>
  )
}

/**
 * A session's artifacts: a pill each, or past a couple, one "N artifacts"
 * pill listing them. A row opens its artifact; its other actions show as
 * icons on the row.
 */
export function ArtifactPills({
  artifacts,
  ticketKey,
  pushToast
}: {
  artifacts: TranscriptArtifact[]
  ticketKey: string | null
  pushToast?: (message: string) => void
}): React.JSX.Element | null {
  if (artifacts.length === 0) return null
  if (artifacts.length <= FOLD_OVER) {
    return (
      <>
        {artifacts.map((a) => (
          <ArtifactChip key={a.url} artifact={a} ticketKey={ticketKey} pushToast={pushToast} />
        ))}
      </>
    )
  }
  // Newest first: the one just published is the one you're after.
  const newestFirst = [...artifacts].reverse()
  return (
    <PillFolder icon="AppWindow" label={`${artifacts.length} artifacts`} menuLabel="Artifacts">
      {(close) =>
        newestFirst.map((a) => {
          const [openIt, ...rest] = artifactActions(a, ticketKey, pushToast)
          return (
            <div key={a.url} className="cr-pill-folder-row">
              <button
                type="button"
                role="menuitem"
                className="cr-popover-item cr-pill-folder-main"
                title={`Open ${a.title}`}
                onClick={() => {
                  close()
                  openIt.onClick()
                }}
              >
                <Icon name="AppWindow" size={14} />
                <span className="cr-artifact-chip-title">{a.title}</span>
              </button>
              {rest.map((action) => (
                <IconButton
                  key={action.label}
                  icon={action.icon ?? 'Link'}
                  label={action.label}
                  size={28}
                  variant="ghost"
                  onClick={() => {
                    close()
                    action.onClick()
                  }}
                />
              ))}
            </div>
          )
        })
      }
    </PillFolder>
  )
}
