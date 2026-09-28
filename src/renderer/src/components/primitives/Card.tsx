import type { HTMLAttributes } from 'react'
import './primitives.css'

export type CardLevel = 'flat' | 'raised' | 'outlined'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Container level per plan 1.2. Defaults to 'raised' — the common case
   * (a session, a project, a skill). */
  level?: CardLevel
}

/** A container holding related content, per plan 3 section 1.2. A card never
 * contains another card — group nested content with a divider instead. */
export default function Card({
  level = 'raised',
  className,
  children,
  ...rest
}: CardProps): React.JSX.Element {
  const cls = ['cr-card', `cr-card--${level}`, className].filter(Boolean).join(' ')
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  )
}
