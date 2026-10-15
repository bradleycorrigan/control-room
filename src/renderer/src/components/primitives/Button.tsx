import type { ButtonHTMLAttributes } from 'react'
import './primitives.css'

export type ButtonVariant = 'filled' | 'outlined' | 'ghost'
export type ButtonSize = 'compact' | 'default' | 'primary'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** Height per plan 1.6: 28 / 36 / 44px. */
  size?: ButtonSize
}

const sizeClass: Record<ButtonSize, string> = {
  compact: 'cr-button--compact',
  default: 'cr-button--default',
  primary: 'cr-button--primary-size'
}

/** Per plan 3 section 1.6: at most one filled (accent) button per screen —
 * everything else is outlined or ghost. */
export default function Button({
  variant = 'outlined',
  size = 'default',
  className,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const cls = ['cr-button', `cr-button--${variant}`, sizeClass[size], className]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  )
}
