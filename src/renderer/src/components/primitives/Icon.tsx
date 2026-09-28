import * as LucideIcons from 'lucide-react'

export type IconName = keyof typeof LucideIcons

export interface IconProps {
  name: IconName
  /** Size in pixels: 14 (metadata), 16 (buttons), 20 (icon tiles) */
  size?: number
  /** Stroke width for the icon — plan default 1.75 */
  strokeWidth?: number
  /** Color — always inherits currentColor unless explicitly overridden */
  color?: string
  className?: string
  /** aria-label for accessibility */
  'aria-label'?: string
}

/**
 * Icon wrapper from lucide-react (plan 7, icons section).
 *
 * size defaults:
 * - 14px in metadata
 * - 16px in buttons
 * - 20px in icon tiles
 *
 * Stroke width defaults to 1.75 to match Xirp's icon weight.
 * Color always inherits currentColor so it reads the text token beside it.
 */
export default function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  color = 'currentColor',
  className = '',
  ...rest
}: IconProps): React.JSX.Element {
  const IconComponent = LucideIcons[name] as React.ComponentType<{
    size: number
    strokeWidth: number
    color: string
    className: string
  }>

  if (!IconComponent) {
    console.warn(`Icon "${name}" not found in lucide-react`)
    return <span className={className} {...rest} />
  }

  return (
    <IconComponent
      size={size}
      strokeWidth={strokeWidth}
      color={color}
      className={className}
      {...rest}
    />
  )
}
