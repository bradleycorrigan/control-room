import { useRef, useState } from 'react'
import { IconButton, Popover } from './primitives'
import { MenuItems } from './MenuItems'
import { ArtifactPickerPanel } from './ArtifactPicker'
import type { PickedArtifact } from '../state/useArtifacts'

/**
 * A message box's Attach button: one paperclip that opens a menu of what you
 * can attach, files from this Mac or a Claude artifact. The same menu in the
 * new-session box and the chat box.
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
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState<HTMLElement | null>(null)
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
        onClick={() => setOpen((v) => !v)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="top-start"
        gap={8}
        aria-label="Attach"
      >
        <MenuItems
          items={[
            { label: 'Files…', icon: 'Paperclip', onClick: onFiles },
            {
              label: 'Artifact…',
              icon: 'AppWindow',
              onClick: () => setPicking(anchor.current)
            }
          ]}
          onPicked={() => setOpen(false)}
        />
      </Popover>
      {picking && (
        <ArtifactPickerPanel
          anchor={picking}
          onPick={onArtifact}
          onClose={() => setPicking(null)}
        />
      )}
    </span>
  )
}
