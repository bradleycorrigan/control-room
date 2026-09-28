import { useMemo, useRef, useState } from 'react'
import { Icon, Popover } from '../../components/primitives'

export interface PickerOption {
  value: string
  label: string
  icon?: React.ReactNode
  checked?: boolean
  /** Left out of the list until you type — found by a search. */
  searchOnly?: boolean
}

/**
 * A keyboard-first chooser, opened by a shortcut (S for status, P for
 * priority) at the ticket it acts on: type to narrow, arrows to move, Enter
 * to pick. Escape and clicking away close it (the Popover handles both).
 */
export function Picker({
  anchor,
  title,
  options,
  onPick,
  onClose,
  custom,
  emptyText = 'No match',
  searchHint = 'hidden'
}: {
  anchor: HTMLElement
  title: string
  options: PickerOption[]
  onPick: (value: string) => void
  onClose: () => void
  /** Typed text becomes an option of its own ("Set to 3h"), when this says what it'd set. */
  custom?: (text: string) => string | null
  /** Shown when nothing is listed (default "No match"). */
  emptyText?: string
  /** What the search-only options are, for the "N more" line. */
  searchHint?: string
}): React.JSX.Element {
  const anchorRef = useRef<HTMLElement | null>(anchor)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const hiddenCount = options.filter((o) => o.searchOnly).length
  const shown = useMemo(() => {
    const text = filter.trim()
    const matching = options.filter(
      (o) => (text || !o.searchOnly) && o.label.toLowerCase().includes(text.toLowerCase())
    )
    const label = text && custom ? custom(text) : null
    return label && !matching.some((o) => o.value === text)
      ? [{ value: text, label }, ...matching]
      : matching
  }, [options, filter, custom])
  const pick = (value: string | undefined): void => {
    if (value === undefined) return
    onClose()
    onPick(value)
  }
  return (
    <Popover
      open
      onClose={onClose}
      anchorRef={anchorRef}
      placement="bottom-start"
      className="backlog-menu backlog-picker"
      role="listbox"
      aria-label={title}
    >
      <input
        autoFocus
        className="backlog-picker-input"
        aria-label={title}
        placeholder={`${title}…`}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(i + 1, shown.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            pick(shown[active]?.value)
          }
        }}
      />
      <div className="backlog-picker-list">
        {shown.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`cr-popover-item backlog-menu-item${i === active ? ' cr-popover-item--active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(o.value)}
          >
            <span className="backlog-menu-item-label">
              {o.icon}
              {o.label}
            </span>
            {o.checked && <Icon name="Check" size={14} />}
          </button>
        ))}
        {shown.length === 0 && <p className="cr-popover-empty">{emptyText}</p>}
        {!filter.trim() && hiddenCount > 0 && (
          <p className="cr-popover-empty">
            {hiddenCount} more ({searchHint}) - type to search
          </p>
        )}
      </div>
    </Popover>
  )
}
