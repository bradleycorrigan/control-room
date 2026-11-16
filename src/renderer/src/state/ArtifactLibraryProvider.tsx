import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createArtifactFolder,
  deleteArtifactFolder,
  fileArtifacts,
  hideArtifact,
  listArtifactFolders,
  listArtifacts,
  moveArtifactFolder,
  renameArtifactFolder,
  setArtifactTags,
  type Artifact,
  type ArtifactFolder
} from '../api'
import { useStoredState } from './useStoredState'
import { LibraryContext, type Library, type Place } from './artifactLibrary'

/**
 * The artifacts library, shared by the Artifacts screen and its side panel:
 * the artifacts, your folders and tags, and which of them you're looking at.
 * Read again every 15 seconds while `active`, so a page a session just
 * published turns up on its own.
 */
export function ArtifactLibraryProvider({
  active,
  children
}: {
  active: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [artifacts, setArtifacts] = useState<Artifact[] | undefined>(undefined)
  const [folders, setFolders] = useState<ArtifactFolder[]>([])
  const [place, setPlace] = useStoredState<Place>('cr.artifacts.place', { type: 'all' })

  const refresh = useCallback(() => {
    void Promise.all([listArtifacts(), listArtifactFolders()]).then(([a, f]) => {
      setArtifacts(a ?? [])
      setFolders(f ?? [])
    })
  }, [])
  useEffect(() => {
    if (!active) return
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [active, refresh])

  // A folder that was deleted elsewhere can't stay the place you're in.
  const safePlace = useMemo<Place>(
    () =>
      place.type === 'folder' && artifacts && !folders.some((f) => f.id === place.id)
        ? { type: 'all' }
        : place,
    [place, artifacts, folders]
  )

  const value = useMemo<Library>(() => {
    const within = (id: string): Set<string> => {
      const out = new Set([id])
      let grew = true
      while (grew) {
        grew = false
        for (const f of folders)
          if (f.parent && out.has(f.parent) && !out.has(f.id)) {
            out.add(f.id)
            grew = true
          }
      }
      return out
    }
    const pathOf = (id: string): string => {
      const names: string[] = []
      const seen = new Set<string>()
      for (let f = folders.find((x) => x.id === id); f && !seen.has(f.id);) {
        seen.add(f.id)
        names.unshift(f.name)
        const parent = f.parent
        f = parent ? folders.find((x) => x.id === parent) : undefined
      }
      return names.join(' / ')
    }
    const counts = new Map<string, number>()
    for (const a of artifacts ?? [])
      if (!a.hidden) for (const t of a.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    const tags = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((x, y) => y.count - x.count || x.tag.localeCompare(y.tag))
    const after = async (p: Promise<unknown>): Promise<void> => {
      await p
      refresh()
    }
    return {
      artifacts,
      folders,
      place: safePlace,
      setPlace,
      refresh,
      tags,
      within,
      pathOf,
      hide: (url, h) => after(hideArtifact(url, h)),
      file: (urls, folder) => after(fileArtifacts(urls, folder)),
      setTags: (url, t) => after(setArtifactTags(url, t)),
      createFolder: async (name, parent) => {
        const f = await createArtifactFolder(name, parent)
        refresh()
        return f
      },
      renameFolder: (id, name) => after(renameArtifactFolder(id, name)),
      moveFolder: (id, parent) => after(moveArtifactFolder(id, parent)),
      deleteFolder: (id) => after(deleteArtifactFolder(id))
    }
  }, [artifacts, folders, safePlace, setPlace, refresh])

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}
