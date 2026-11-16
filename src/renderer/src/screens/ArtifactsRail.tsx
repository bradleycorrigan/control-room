import { useState } from 'react'
import Icon from '../components/primitives/Icon'
import type { IconName } from '../components/primitives'
import type { MenuItem } from '../components/MenuItems'
import { OverflowMenu } from './SessionsScreen'
import type { ArtifactFolder } from '../api'
import {
  DRAG_ARTIFACT,
  DRAG_FOLDER,
  dragChip,
  useArtifactLibrary,
  type Place
} from '../state/artifactLibrary'
import { useStoredState } from '../state/useStoredState'
import './project-rail.css'
import './artifacts.css'

const same = (a: Place, b: Place): boolean =>
  a.type === b.type &&
  (a.type !== 'folder' || (b.type === 'folder' && a.id === b.id)) &&
  (a.type !== 'tag' || (b.type === 'tag' && a.tag === b.tag))

/**
 * The Artifacts screen's side panel, a small file explorer: everything,
 * what's unfiled, your folders (nested; drop a card or a folder on one to
 * move it there), your tags, and what you hid. Built from the Sessions
 * panel's own pieces so the two read as one app.
 */
export default function ArtifactsRail(): React.JSX.Element {
  const lib = useArtifactLibrary()
  const all = lib.artifacts ?? []
  const visible = all.filter((a) => !a.hidden)
  const [expanded, setExpanded] = useStoredState<string[]>('cr.artifacts.expanded', [])
  // A folder being named: a new one (under `parent`), or an existing one.
  const [naming, setNaming] = useState<
    { kind: 'new'; parent: string | null } | { kind: 'rename'; id: string } | null
  >(null)
  const [dropOn, setDropOn] = useState<string | null>(null)

  const directCount = (id: string): number => visible.filter((a) => a.folder === id).length
  const deepCount = (id: string): number => {
    const ids = lib.within(id)
    return visible.filter((a) => a.folder && ids.has(a.folder)).length
  }
  const children = (parent: string | null): ArtifactFolder[] =>
    lib.folders.filter((f) => f.parent === parent).sort((a, b) => a.name.localeCompare(b.name))

  const startNew = (parent: string | null): void => {
    if (parent && !expanded.includes(parent)) setExpanded([...expanded, parent])
    setNaming({ kind: 'new', parent })
  }

  /** A drop target: a folder, or the top of the library (id null). */
  const dropProps = (
    id: string | null,
    key: string
  ): Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> & {
    'data-drop-target'?: true
  } => ({
    onDragOver: (e) => {
      const types = e.dataTransfer.types
      if (!types.includes(DRAG_ARTIFACT) && !types.includes(DRAG_FOLDER)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dropOn !== key) setDropOn(key)
    },
    onDragLeave: () => setDropOn((k) => (k === key ? null : k)),
    onDrop: (e) => {
      e.preventDefault()
      setDropOn(null)
      const url = e.dataTransfer.getData(DRAG_ARTIFACT)
      const folder = e.dataTransfer.getData(DRAG_FOLDER)
      if (url) void lib.file([url], id)
      else if (folder && folder !== id) void lib.moveFolder(folder, id)
    },
    ...(dropOn === key ? { 'data-drop-target': true as const } : {})
  })

  const item = (
    place: Place,
    icon: IconName,
    label: string,
    count: number,
    extra: Partial<React.ButtonHTMLAttributes<HTMLButtonElement>> = {}
  ): React.JSX.Element => (
    <button
      type="button"
      className={
        same(lib.place, place)
          ? 'projects-rail-item projects-rail-item-selected'
          : 'projects-rail-item'
      }
      onClick={() => lib.setPlace(place)}
      {...extra}
    >
      <span className="projects-rail-label-wrapper">
        <Icon name={icon} size={16} />
        <span className="projects-rail-label">{label}</span>
      </span>
      <span className="projects-rail-count-wrapper">
        <span className="projects-rail-count">{count}</span>
      </span>
    </button>
  )

  const nameField = (initial: string, onDone: (name: string | null) => void): React.JSX.Element => (
    <input
      autoFocus
      className="artifacts-rail-name"
      aria-label="Folder name"
      defaultValue={initial}
      placeholder="Folder name"
      onBlur={(e) => onDone(e.currentTarget.value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onDone(e.currentTarget.value.trim() || null)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onDone(null)
        }
      }}
    />
  )

  const newRow = (parent: string | null, depth: number): React.JSX.Element | null =>
    naming?.kind === 'new' && naming.parent === parent ? (
      <div className="projects-rail-row" style={{ paddingLeft: depth * 14 }}>
        <span className="projects-rail-disclosure-slot" />
        <span className="artifacts-rail-naming">
          <Icon name="FolderPlus" size={16} />
          {nameField('', (name) => {
            setNaming(null)
            if (name)
              void lib.createFolder(name, parent).then((f) => {
                if (f) lib.setPlace({ type: 'folder', id: f.id })
              })
          })}
        </span>
      </div>
    ) : null

  const folderRow = (f: ArtifactFolder, depth: number): React.JSX.Element => {
    const kids = children(f.id)
    const open = expanded.includes(f.id)
    const actions: MenuItem[] = [
      { label: 'New folder inside', icon: 'FolderPlus', onClick: () => startNew(f.id) },
      { label: 'Rename', icon: 'Pencil', onClick: () => setNaming({ kind: 'rename', id: f.id }) },
      ...(f.parent
        ? [
            {
              label: 'Move to the top',
              icon: 'ArrowUpToLine' as const,
              onClick: () => void lib.moveFolder(f.id, null)
            }
          ]
        : []),
      {
        label: 'Delete folder',
        icon: 'Trash2',
        group: 'delete',
        onClick: () => void lib.deleteFolder(f.id)
      }
    ]
    return (
      <div key={f.id} className="projects-rail-project" data-artifact-folder={f.id}>
        <div
          className="projects-rail-row artifacts-rail-folder"
          style={{ paddingLeft: depth * 14 }}
          {...dropProps(f.id, f.id)}
        >
          <span className="projects-rail-disclosure-slot">
            {(kids.length > 0 || (naming?.kind === 'new' && naming.parent === f.id)) && (
              <button
                type="button"
                className="projects-rail-disclosure"
                aria-expanded={open}
                aria-label={`${open ? 'Hide' : 'Show'} folders in ${f.name}`}
                onClick={() =>
                  setExpanded(open ? expanded.filter((x) => x !== f.id) : [...expanded, f.id])
                }
              >
                <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={12} />
              </button>
            )}
          </span>
          {naming?.kind === 'rename' && naming.id === f.id ? (
            <span className="artifacts-rail-naming">
              <Icon name="Folder" size={16} />
              {nameField(f.name, (name) => {
                setNaming(null)
                if (name && name !== f.name) void lib.renameFolder(f.id, name)
              })}
            </span>
          ) : (
            item(
              { type: 'folder', id: f.id },
              open ? 'FolderOpen' : 'Folder',
              f.name,
              deepCount(f.id),
              {
                draggable: true,
                title:
                  directCount(f.id) !== deepCount(f.id)
                    ? `${directCount(f.id)} here, ${deepCount(f.id)} with the folders inside`
                    : undefined,
                onDragStart: (e) => {
                  e.dataTransfer.setData(DRAG_FOLDER, f.id)
                  dragChip(e, f.name, 'folder')
                  e.dataTransfer.effectAllowed = 'move'
                }
              }
            )
          )}
          <OverflowMenu
            actions={actions}
            label={`${f.name} folder actions`}
            className="artifacts-rail-menu"
          />
        </div>
        {(open || (naming?.kind === 'new' && naming.parent === f.id)) && (
          <>
            {kids.map((k) => folderRow(k, depth + 1))}
            {newRow(f.id, depth + 1)}
          </>
        )}
      </div>
    )
  }

  const hidden = all.filter((a) => a.hidden).length
  return (
    <div className="projects-rail artifacts-rail" data-artifacts-rail>
      <div className="projects-rail-header">
        <h2 className="projects-rail-title">Library</h2>
        <button
          className="projects-rail-add-button"
          onClick={() => startNew(null)}
          title="New folder"
          aria-label="New folder"
        >
          <Icon name="FolderPlus" size={16} />
        </button>
      </div>
      <div className="projects-rail-items">
        <div className="projects-rail-row" {...dropProps(null, '__top')}>
          <span className="projects-rail-disclosure-slot" />
          {item({ type: 'all' }, 'LayoutGrid', 'All artifacts', visible.length)}
        </div>
        <div className="projects-rail-row">
          <span className="projects-rail-disclosure-slot" />
          {item({ type: 'unfiled' }, 'Inbox', 'Unfiled', visible.filter((a) => !a.folder).length)}
        </div>

        <h3 className="artifacts-rail-section">Folders</h3>
        {children(null).map((f) => folderRow(f, 0))}
        {newRow(null, 0)}
        {lib.folders.length === 0 && naming === null && (
          <button type="button" className="artifacts-rail-hint" onClick={() => startNew(null)}>
            <Icon name="FolderPlus" size={14} />
            New folder
          </button>
        )}

        {lib.tags.length > 0 && (
          <>
            <h3 className="artifacts-rail-section">Tags</h3>
            {lib.tags.map(({ tag, count }) => (
              <div key={tag} className="projects-rail-row" data-artifact-tag={tag}>
                <span className="projects-rail-disclosure-slot" />
                {item({ type: 'tag', tag }, 'Hash', tag, count)}
              </div>
            ))}
          </>
        )}

        {hidden > 0 && (
          <div className="projects-rail-row artifacts-rail-hidden">
            <span className="projects-rail-disclosure-slot" />
            {item({ type: 'hidden' }, 'EyeOff', 'Hidden', hidden)}
          </div>
        )}
      </div>
    </div>
  )
}
