import { useId } from 'react'
import Icon from './Icon'
import './primitives.css'

export interface DisclosureProps {
  /** The header text. Rendered in the caption style sections use. */
  label: React.ReactNode
  /** Sits after the label in a quieter colour — a count, or a one-line summary. */
  hint?: React.ReactNode
  open: boolean
  onToggle: (open: boolean) => void
  children: React.ReactNode
  className?: string
}

/**
 * A section you can fold away.
 *
 * The whole header is the control, with a chevron, a hover state and a focus
 * ring — the three hand-rolled versions this replaces were a 6px text caret
 * beside a heading, with no hover and nothing to say the row could be clicked
 * at all. If a thing collapses, it has to look like it collapses.
 */
export default function Disclosure({
  label,
  hint,
  open,
  onToggle,
  children,
  className = ''
}: DisclosureProps): React.JSX.Element {
  const id = useId()
  return (
    <div className={className ? `cr-disclosure ${className}` : 'cr-disclosure'}>
      <button
        type="button"
        className="cr-disclosure-header"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onToggle(!open)}
      >
        <Icon
          name="ChevronRight"
          size={16}
          className={`cr-disclosure-chevron${open ? ' cr-disclosure-chevron--open' : ''}`}
        />
        <span className="cr-disclosure-label">{label}</span>
        {hint !== undefined && <span className="cr-disclosure-hint">{hint}</span>}
      </button>
      {open && (
        <div id={id} className="cr-disclosure-body">
          {children}
        </div>
      )}
    </div>
  )
}
