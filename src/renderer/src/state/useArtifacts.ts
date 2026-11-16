import { useCallback, useEffect, useState } from 'react'
import { listArtifacts, type Artifact } from '../api'

/** A claude.ai artifact link anywhere in some text. */
export const ARTIFACT_LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{8,}/

/**
 * Every artifact Control Room knows about, newest first: undefined until the
 * first read. Read again every 15 seconds while shown, and on `refresh()`,
 * so one a session just published turns up without a reload.
 */
export function useArtifacts(): {
  artifacts: Artifact[] | undefined
  refresh: () => void
  set: (next: Artifact[]) => void
} {
  const [artifacts, setArtifacts] = useState<Artifact[] | undefined>(undefined)
  const refresh = useCallback(() => {
    void listArtifacts().then((a) => setArtifacts(a ?? []))
  }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [refresh])
  return { artifacts, refresh, set: setArtifacts }
}

/** What an artifact is called, or a stand-in naming its source. */
export function artifactName(a: Pick<Artifact, 'title' | 'owned'>): string {
  return a.title || (a.owned === false ? 'Shared artifact' : 'Untitled artifact')
}

export interface PickedArtifact {
  url: string
  /** The link to share: with its share key, when it has one. */
  link: string
  title: string
}

/**
 * A message with an artifact's link added on its own line, so Claude reads
 * the page (and can republish to the same link) when you send it.
 */
export function withArtifact(text: string, a: PickedArtifact): string {
  const line = `${a.title}: ${a.link}`
  if (text.includes(a.link)) return text
  return text.trim() ? `${text.replace(/\s+$/, '')}\n${line}\n` : `${line}\n`
}
