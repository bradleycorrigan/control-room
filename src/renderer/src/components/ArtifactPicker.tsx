import { useRef, useState } from 'react'
import { Button, Icon, IconButton } from './primitives'
import { Picker, type PickerOption } from '../screens/backlog/Picker'
import { addArtifact, listArtifacts, type Artifact } from '../api'
import { ARTIFACT_LINK, artifactName, type PickedArtifact } from '../state/useArtifacts'

/** The artifacts shown before you type; the rest are found by a search. */
const SHOWN = 30

/**
 * Choose an artifact: type to search what sessions made or read and the
 * links you added, or paste a claude.ai link to use one that isn't listed
 * (it's added to the Artifacts list too). One chooser for the ticket drawer
 * and both message boxes.
 */
export function ArtifactPicker({
  look,
  label = 'Add an artifact',
  exclude = [],
  disabled,
  onPick
}: {
  /** icon: a 28px icon button, as in a message box's footer. button: a quiet text button. */
  look: 'icon' | 'button'
  label?: string
  /** Urls already used here, left out of the list. */
  exclude?: string[]
  disabled?: boolean
  onPick: (a: PickedArtifact) => void
}): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null)
  const [list, setList] = useState<Artifact[] | null>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = (): void => {
    setAnchorEl(anchor.current)
    void listArtifacts().then((a) => setList(a ?? []))
  }
  const shown = (list ?? []).filter((a) => !exclude.includes(a.url))
  const options: PickerOption[] = shown.map((a, i) => ({
    value: a.url,
    label: artifactName(a),
    icon: <Icon name="AppWindow" size={14} />,
    searchOnly: i >= SHOWN
  }))
  return (
    <span ref={anchor} className="cr-artifact-picker" data-artifact-picker>
      {look === 'icon' ? (
        <IconButton
          icon="AppWindow"
          label={label}
          size={28}
          variant="ghost"
          disabled={disabled}
          onClick={open}
        />
      ) : (
        <Button variant="ghost" size="compact" disabled={disabled} onClick={open}>
          <Icon name="AppWindow" size={12} />
          {label}
        </Button>
      )}
      {list && anchorEl && (
        <Picker
          anchor={anchorEl}
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
          onClose={() => setList(null)}
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
      )}
    </span>
  )
}
