import { createContext, useContext } from 'react'
import type { Artifact, ArtifactFolder } from '../api'

/** Where you are in the library: everything, a folder, a tag, or what you hid. */
export type Place =
  | { type: 'all' }
  | { type: 'unfiled' }
  | { type: 'hidden' }
  | { type: 'folder'; id: string }
  | { type: 'tag'; tag: string }

/** The drag type for an artifact card, and for a folder row. */
export const DRAG_ARTIFACT = 'application/x-cr-artifact'
export const DRAG_FOLDER = 'application/x-cr-artifact-folder'

export interface Library {
  artifacts: Artifact[] | undefined
  folders: ArtifactFolder[]
  place: Place
  setPlace: (p: Place) => void
  refresh: () => void
  /** Every tag in use, with how many artifacts carry it, most used first. */
  tags: { tag: string; count: number }[]
  /** A folder and every folder inside it, by id. */
  within: (id: string) => Set<string>
  /** "Clients / Acme": a folder's name with the folders above it. */
  pathOf: (id: string) => string
  hide: (url: string, hide: boolean) => Promise<void>
  file: (urls: string[], folder: string | null) => Promise<void>
  setTags: (url: string, tags: string[]) => Promise<void>
  createFolder: (name: string, parent: string | null) => Promise<ArtifactFolder | null>
  renameFolder: (id: string, name: string) => Promise<void>
  moveFolder: (id: string, parent: string | null) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
}

export const LibraryContext = createContext<Library | null>(null)

export function useArtifactLibrary(): Library {
  const lib = useContext(LibraryContext)
  if (!lib) throw new Error('useArtifactLibrary needs an ArtifactLibraryProvider')
  return lib
}

/** Whether an artifact belongs in the place you're looking at. */
export function inPlace(a: Artifact, place: Place, within: (id: string) => Set<string>): boolean {
  if (place.type === 'hidden') return a.hidden
  if (a.hidden) return false
  if (place.type === 'unfiled') return !a.folder
  if (place.type === 'folder') return !!a.folder && within(place.id).has(a.folder)
  if (place.type === 'tag') return a.tags.includes(place.tag)
  return true
}

/**
 * What follows the pointer while dragging: a small chip with the thing's
 * name, not the browser's full-size copy of a card. Built for the one drag
 * and removed straight after the browser has taken its picture.
 */
export function dragChip(e: React.DragEvent, label: string, kind: 'artifact' | 'folder'): void {
  const chip = document.createElement('div')
  chip.className = `artifacts-drag-chip artifacts-drag-chip--${kind}`
  chip.textContent = label
  document.body.appendChild(chip)
  e.dataTransfer.setDragImage(chip, 14, 14)
  requestAnimationFrame(() => chip.remove())
}
