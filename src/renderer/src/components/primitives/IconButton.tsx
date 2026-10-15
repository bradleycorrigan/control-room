import Icon, { type IconName } from './Icon'
import Tooltip from './Tooltip'

export type IconButtonVariant = 'ghost' | 'filled'
export type IconButtonSize = 28 | 36

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  icon: IconName
  /**
   * What this button does, in a few words. Used as the aria-label AND as the
   * hover tooltip — an icon-only control must always be able to say what it is.
   * Pass `tooltip` when the hover text should differ from the accessible name
   * (e.g. label "Active sessions", tooltip "3 active").
   */
  label: string
  /** Overrides the hover text; defaults to `title`, then `label`. */
  tooltip?: string
  /**
   * 28 or 36 pixels.
   *
   * The rule, so controls stop disagreeing with each other: **36 for chrome** —
   * the title bar and a screen header — and **28 for anything inline**, inside
   * a list row or a card. Every control in one row takes the same size,
   * including the Pill and IconTile beside it, which carry the same two
   * numbers for exactly this reason.
   */
  size?: IconButtonSize
  variant?: IconButtonVariant
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}

/**
 * Icon button (plan 7, stage A2).
 *
 * Icon buttons are circular, with size 28 or 36. The icon is always 16px.
 * Every one of them carries a tooltip: an icon with no words is a guess, and
 * the label is the accessible name anyway, so there is no excuse for both.
 */
export default function IconButton({
  icon,
  label,
  tooltip,
  title,
  size = 36,
  variant = 'ghost',
  className = '',
  ...rest
}: IconButtonProps): React.JSX.Element {
  const sizeClass = size === 28 ? 'cr-icon-button--28' : 'cr-icon-button--36'
  const variantClass = `cr-icon-button--${variant}`

  // `title` is swallowed deliberately: forwarding it to the <button> would put
  // the OS's own tooltip on top of ours.
  return (
    <Tooltip label={tooltip ?? title ?? label}>
      <button
        className={`cr-icon-button ${sizeClass} ${variantClass} ${className}`}
        aria-label={label}
        {...rest}
      >
        <Icon name={icon} size={16} />
      </button>
    </Tooltip>
  )
}
