import { Card, Icon, IconTile, Meta, MetaItem, IconButton } from './primitives'
import type { Project } from '../../../main/store/types'
import { formatHomePath } from '../lib/format-path'
import { useHomeDir } from '../state/useHomeDir'

function relativeTime(ts: number | null): string {
  if (ts === null) return 'never'
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

interface Props {
  project: Project
  lastChangedAt: number | null
  branch: string
  activeCount: number
  totalCount: number
  onOpen: () => void
  onPin: () => void
  onEdit: () => void
  onRemove: () => void
  renaming?: boolean
  renameValue?: string
  renameBusy?: boolean
  renameError?: string | null
  onRenameChange?: (value: string) => void
  onRenameSubmit?: () => void
  onRenameCancel?: () => void
}

/** A project card, per plan 3 section 2.2 — a Raised container with a folder
 * glyph, the project name, its mono path, and a caption metadata row (last
 * changed, branch, active/total sessions) separated by dots. Hover raises the
 * card (handled by Card itself) and reveals trailing icon actions. */
export default function ProjectRow({
  project,
  lastChangedAt,
  branch,
  activeCount,
  totalCount,
  onOpen,
  onPin,
  onEdit,
  onRemove,
  renaming = false,
  renameValue = '',
  renameBusy = false,
  renameError = null,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel
}: Props): React.JSX.Element {
  const isGeneral = project.id === 'general'
  const iconName = isGeneral ? 'Terminal' : 'Folder'
  const homeDir = useHomeDir()
  const displayPath = formatHomePath(project.repoPath, homeDir)

  return (
    <Card
      level="flat"
      className="project-row-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="project-row-container">
        <IconTile icon={iconName} size={36} />
        <div className="project-row-content">
          {renaming ? (
            <form
              className="project-row-rename-form"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault()
                onRenameSubmit?.()
              }}
            >
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => onRenameChange?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onRenameCancel?.()
                }}
                disabled={renameBusy}
              />
              <button type="submit" disabled={renameBusy}>
                {renameBusy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={onRenameCancel} disabled={renameBusy}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <div className="project-row-title-row">
                {/* The title row is space-between, so the pin has to be
                    grouped with the name — on its own it drifted to the far
                    right of the card, nowhere near the thing it described. */}
                <div className="project-row-title-group">
                  <h3 className="project-row-name" title={project.name}>
                    {project.name}
                  </h3>
                  {/* Shown at rest, not just on hover. The actions below only
                      appear on hover, and the pin button used to be the sole
                      indication of the state — so a pinned project looked
                      exactly like an unpinned one until you reached for it. */}
                  {project.pinned && (
                    <span className="project-row-pinned" aria-label="Pinned">
                      <Icon name="Pin" size={12} />
                    </span>
                  )}
                </div>
                <div className="project-row-actions" onClick={(e) => e.stopPropagation()}>
                  {/* Two different icons. This read `project.pinned ? 'Pin' :
                      'Pin'` — the same glyph either way, so the control gave
                      no sign it had done anything. */}
                  <IconButton
                    icon={project.pinned ? 'PinOff' : 'Pin'}
                    label={project.pinned ? 'Unpin project' : 'Pin project'}
                    tooltip={project.pinned ? 'Unpin' : 'Pin to the top'}
                    size={28}
                    variant="ghost"
                    onClick={onPin}
                  />
                  <IconButton
                    icon="Pencil"
                    label="Rename project"
                    size={28}
                    variant="ghost"
                    onClick={onEdit}
                  />
                  <IconButton
                    icon="Trash2"
                    label="Remove project"
                    size={28}
                    variant="ghost"
                    onClick={onRemove}
                  />
                </div>
              </div>
              {/* The rtl/ellipsis trick below truncates from the start so the
                  end of a long path (the part that tells projects apart)
                  stays visible. Plain text inside it puts the leading "/" at
                  the end instead — a <bdi> isolates the path's own (auto-
                  detected, left-to-right) direction from that trick. */}
              <p className="project-row-path" title={project.repoPath}>
                <bdi>{displayPath}</bdi>
              </p>
            </>
          )}
          {renameError && <p className="project-row-error">{renameError}</p>}
          <Meta>
            <MetaItem icon="Clock">{relativeTime(lastChangedAt)}</MetaItem>
            <MetaItem icon="GitBranch" className="project-row-branch">
              {branch}
            </MetaItem>
            {activeCount > 0 && (
              <MetaItem icon="Boxes" className="project-row-active">
                {activeCount} active
              </MetaItem>
            )}
            <MetaItem icon="LayoutGrid">
              {totalCount} session{totalCount === 1 ? '' : 's'}
            </MetaItem>
          </Meta>
        </div>
      </div>
    </Card>
  )
}
