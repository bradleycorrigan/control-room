export type PillSize = 28 | 36

export interface PillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** CSS variable like var(--accent) or var(--status-working) — defaults to accent */
  tone?: string
  /** If true, fills with tone at 15% opacity */
  active?: boolean
  /**
   * Same two sizes as IconButton, and the same rule: 36 for chrome — a title
   * bar or a screen header — and 28 for anything inline, inside a row or a
   * card. A pill sitting in a row of 36px icon buttons has to be 36 too, or it
   * reads as a different kind of thing.
   */
  size?: PillSize
  children: React.ReactNode
}

/**
 * Pill component (plan 7, stage A2).
 *
 * A rounded button with radius 999, 28px or 36px tall.
 * Can be in an active state that fills with its tone at 15%.
 * Used for toggleable options and actions (e.g., "Add Project").
 *
 * Example:
 * ```tsx
 * <Pill tone="var(--accent)" active={isActive} onClick={…}>
 *   + Project
 * </Pill>
 * ```
 */
export default function Pill({
  tone = 'var(--accent)',
  active = false,
  size = 28,
  className = '',
  style = {},
  children,
  ...rest
}: PillProps): React.JSX.Element {
  return (
    <button
      className={`cr-pill cr-pill--${size} ${active ? 'cr-pill--active' : ''} ${className}`}
      style={
        {
          ...style,
          '--pill-tone': tone
        } as React.CSSProperties
      }
      {...rest}
    >
      {children}
    </button>
  )
}
