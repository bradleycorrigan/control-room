import { Button, Icon, IconButton } from '../primitives'
import './selection.css'

/**
 * The check a picked row shows. Pass `onToggle` to make it a button you
 * click to pick the row; without it, it only marks the row.
 */
export function PickCheck({
  on,
  label,
  onToggle,
  className = ''
}: {
  on: boolean
  /** What clicking it picks, for a screen reader: "Select Working session". */
  label?: string
  onToggle?: () => void
  className?: string
}): React.JSX.Element {
  const classes = `cr-pick-check${on ? ' cr-pick-check--on' : ''} ${className}`.trim()
  const mark = on ? <Icon name="Check" size={12} /> : null
  if (!onToggle) {
    return (
      <span className={classes} aria-hidden="true">
        {mark}
      </span>
    )
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      className={classes}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {mark}
    </button>
  )
}

/**
 * The bar shown while things are picked: how many, what you can do to all
 * of them (each with its key), and a way out.
 */
export function SelectionBar({
  count,
  label,
  onClear,
  className = '',
  children
}: {
  count: number
  /** Names the toolbar for a screen reader: "Selected tickets". */
  label: string
  onClear: () => void
  /** A screen's own class, for where the bar sits on it. */
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`cr-selection-bar ${className}`.trim()} role="toolbar" aria-label={label}>
      <span className="cr-selection-bar-count">{count} selected</span>
      {children}
      <IconButton
        icon="X"
        label="Clear selection"
        tooltip="Clear selection (Esc)"
        size={28}
        onClick={onClear}
      />
    </div>
  )
}

/** One action in the selection bar, with the key that does the same. */
export function SelectionAction({
  shortcut,
  onClick,
  children
}: {
  shortcut?: string
  onClick: (anchor: HTMLElement) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button variant="ghost" size="compact" onClick={(e) => onClick(e.currentTarget)}>
      {children}
      {shortcut && <kbd>{shortcut}</kbd>}
    </Button>
  )
}
