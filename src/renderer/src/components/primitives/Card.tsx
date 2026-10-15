import type { HTMLAttributes, Ref } from 'react'
import './primitives.css'

/** 'floating' is a panel that sits inside the window rather than against its
 * edge: rounded, raised, with a soft ring and shadow instead of a hard line.
 * The ticket panel and the Sessions and Tickets sidebars use it. It sets only
 * the chrome; where it sits (inset, width, position) stays with the caller. */
export type CardLevel = 'flat' | 'raised' | 'outlined' | 'floating'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Container level per plan 1.2. Defaults to 'raised' — the common case
   * (a session, a project, a skill). */
  level?: CardLevel
  /** The element to render, for a card that is also a landmark or dialog. */
  as?: 'div' | 'aside' | 'nav' | 'section'
  ref?: Ref<HTMLElement>
}

/** A container holding related content, per plan 3 section 1.2. A card never
 * contains another card — group nested content with a divider instead. */
export default function Card({
  level = 'raised',
  as: Tag = 'div',
  className,
  children,
  ref,
  ...rest
}: CardProps): React.JSX.Element {
  const cls = ['cr-card', `cr-card--${level}`, className].filter(Boolean).join(' ')
  return (
    // The union of element refs is wider than any one tag's; every tag here
    // is a plain HTMLElement.
    <Tag className={cls} ref={ref as Ref<HTMLDivElement>} {...rest}>
      {children}
    </Tag>
  )
}
