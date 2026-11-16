import type { Artifact } from '../api'

/** A claude.ai artifact link anywhere in some text. */
export const ARTIFACT_LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{8,}/

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
