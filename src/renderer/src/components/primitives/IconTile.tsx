import Icon, { type IconName } from './Icon'

// 36 is the chrome size — it matches IconButton and Pill so a tile can sit in
// a header row without being the odd one out.
export type IconTileSize = 28 | 36 | 40 | 48

export interface IconTileProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: IconName
  size?: IconTileSize
  /** CSS variable like var(--accent) or var(--status-working) */
  tone?: string
}

/**
 * Icon tile (plan 7, stage A2).
 *
 * A tinted square containing an icon. Used for project/session displays.
 * Size is 28, 40, or 48 pixels. The icon inside is always 16px.
 * Tone defaults to --accent but can be any CSS color variable.
 */
export default function IconTile({
  icon,
  size = 40,
  tone = 'var(--accent)',
  className = '',
  style = {},
  ...rest
}: IconTileProps): React.JSX.Element {
  const sizeClass = `cr-icon-tile--${size}`

  return (
    <div
      className={`cr-icon-tile ${sizeClass} ${className}`}
      style={
        {
          ...style,
          '--icon-tile-tone': tone
        } as React.CSSProperties
      }
      {...rest}
    >
      <Icon name={icon} size={16} />
    </div>
  )
}
