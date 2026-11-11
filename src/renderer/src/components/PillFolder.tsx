import { useRef, useState } from 'react'
import { Icon, Popover, type IconName } from './primitives'
import './pr-chip.css'

/**
 * Several of one kind of pill (artifacts, pull requests) folded into one, so
 * the session header stays one line: "4 artifacts", opening the list.
 */
export function PillFolder({
  icon,
  label,
  menuLabel,
  children
}: {
  icon: IconName
  label: string
  menuLabel: string
  /** The rows; `close` shuts the list once one is used. */
  children: (close: () => void) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const close = (): void => setOpen(false)
  return (
    <span className="cr-artifact-chip-wrap" ref={anchor}>
      <button
        type="button"
        className="cr-pr-chip cr-pr-chip--20 cr-artifact-chip cr-pill-folder"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <Icon name={icon} size={12} />
        {label}
        <Icon name="ChevronDown" size={12} />
      </button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={anchor}
        placement="bottom-start"
        className="cr-pill-folder-list"
        aria-label={menuLabel}
      >
        {children(close)}
      </Popover>
    </span>
  )
}
