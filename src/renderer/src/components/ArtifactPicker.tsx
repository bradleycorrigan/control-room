import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from './primitives'
import { Picker, type PickerOption } from '../screens/backlog/Picker'
import { addArtifact, listArtifacts, type Artifact } from '../api'
import { ARTIFACT_LINK, artifactName, type PickedArtifact } from '../state/useArtifacts'

/** The artifacts shown before you type; the rest are found by a search. */
const SHOWN = 30

/**
 * The artifact chooser itself, hung off `anchor`: type to search what sessions
 * made or read and the links you added, or paste a claude.ai link to use one
 * that isn't listed (it's added to the Artifacts list too). Opened by the
 * ticket drawer's button and by a message box's Attach menu.
 */
export function ArtifactPickerPanel({
  anchor,
  exclude = [],
  onPick,
  onClose
}: {
  anchor: HTMLElement
  /** Urls already used here, left out of the list. */
  exclude?: string[]
  onPick: (a: PickedArtifact) => void
  onClose: () => void
}): React.JSX.Element | null {
  const [list, setList] = useState<Artifact[] | null>(null)
  useEffect(() => {
    let live = true
    void listArtifacts().then((a) => live && setList(a ?? []))
    return () => {
      live = false
    }
  }, [])
  if (!list) return null
  const shown = list.filter((a) => !exclude.includes(a.url))
  const options: PickerOption[] = shown.map((a, i) => ({
    value: a.url,
    label: artifactName(a),
    icon: <Icon name="AppWindow" size={14} />,
    searchOnly: i >= SHOWN
  }))
  return (
    <Picker
      anchor={anchor}
      title="Find an artifact, or paste a link"
      options={options}
      emptyText={list.length === 0 ? 'No artifacts yet - paste a link' : 'No match'}
      searchHint="older"
      custom={(text) => {
        const url = ARTIFACT_LINK.exec(text)?.[0]
        if (!url) return null
        const known = list.find((a) => a.url === url)
        return known ? `Use ${artifactName(known)}` : 'Use this link'
      }}
      onClose={onClose}
      onPick={(value) => {
        const known = list.find((a) => a.url === value)
        if (known) {
          onPick({ url: known.url, link: known.link, title: artifactName(known) })
          return
        }
        const url = ARTIFACT_LINK.exec(value)?.[0]
        if (!url) return
        const link = value.trim().match(/^\S+/)?.[0] ?? url
        const had = list.find((a) => a.url === url)
        if (had) {
          onPick({ url, link: had.link, title: artifactName(had) })
          return
        }
        // A link you were sent: remember it in the Artifacts list too.
        void addArtifact(link, '')
        onPick({ url, link, title: 'Claude artifact' })
      }}
    />
  )
}

/** A quiet text button that opens the artifact chooser, as in the ticket drawer. */
export function ArtifactPicker({
  label = 'Add an artifact',
  exclude = [],
  disabled,
  onPick
}: {
  label?: string
  exclude?: string[]
  disabled?: boolean
  onPick: (a: PickedArtifact) => void
}): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  return (
    <span ref={anchor} className="cr-artifact-picker" data-artifact-picker>
      <Button
        variant="ghost"
        size="compact"
        disabled={disabled}
        onClick={() => setAnchorEl(anchor.current)}
      >
        <Icon name="AppWindow" size={12} />
        {label}
      </Button>
      {anchorEl && (
        <ArtifactPickerPanel
          anchor={anchorEl}
          exclude={exclude}
          onPick={onPick}
          onClose={() => setAnchorEl(null)}
        />
      )}
    </span>
  )
}
