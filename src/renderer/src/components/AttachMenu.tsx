import { useRef, useState } from 'react'
import { Icon, IconButton, Popover } from './primitives'
import { ArtifactPickerPanel } from './ArtifactPicker'
import type { PickedArtifact } from '../state/useArtifacts'

/**
 * A message box's Attach button: one paperclip that opens a menu of what you
 * can attach. Files opens the file chooser; Artifact opens a submenu beside
 * it, the artifact search, with the menu still open behind. The same menu in
 * the new-session box and the chat box.
 */
export function AttachMenu({
  disabled,
  onFiles,
  onArtifact
}: {
  disabled?: boolean
  onFiles: () => void
  onArtifact: (a: PickedArtifact) => void
}): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null)
  const artifactRow = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<HTMLElement | null>(null)
  const close = (): void => {
    setSub(null)
    setOpen(false)
  }
  const openSub = (): void => {
    if (artifactRow.current) setSub(artifactRow.current)
  }
  return (
    <span ref={anchor} className="cr-attach-menu" data-attach-menu>
      <IconButton
        icon="Paperclip"
        label="Attach"
        size={28}
        variant={open ? 'filled' : 'ghost'}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      />
      <Popover
        open={open}
        onClose={close}
        anchorRef={anchor}
        placement="top-start"
        gap={8}
        aria-label="Attach"
      >
        <button
          type="button"
          role="menuitem"
          className="cr-popover-item"
          onMouseEnter={() => setSub(null)}
          onClick={() => {
            close()
            onFiles()
          }}
        >
          <span className="cr-popover-item-icon" aria-hidden="true">
            <Icon name="Paperclip" size={14} />
          </span>
          Files…
        </button>
        <button
          ref={artifactRow}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={Boolean(sub)}
          className={`cr-popover-item${sub ? ' cr-popover-item--active' : ''}`}
          data-attach-artifact
          onMouseEnter={openSub}
          onClick={openSub}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault()
              openSub()
            }
          }}
        >
          <span className="cr-popover-item-icon" aria-hidden="true">
            <Icon name="AppWindow" size={14} />
          </span>
          Artifact
          <span className="cr-popover-item-kbd" aria-hidden="true">
            <Icon name="ChevronRight" size={14} />
          </span>
        </button>
      </Popover>
      {open && sub && (
        <ArtifactPickerPanel
          anchor={sub}
          submenu
          onPick={(a) => {
            close()
            onArtifact(a)
          }}
          onClose={() => setSub(null)}
        />
      )}
    </span>
  )
}
