import type { HTMLAttributes, ReactNode } from 'react'
import './primitives.css'

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Caption-style, uppercase header text (e.g. "ACTIVE", "WORKTREES"). */
  heading?: ReactNode
  /** Right-aligned controls on the header's baseline row. */
  controls?: ReactNode
}

/** A labelled group of content within a screen, per plan 3 section 1.7 — a
 * caption header, optional trailing controls, and 16px down to the body. */
export default function Section({
  heading,
  controls,
  className,
  children,
  ...rest
}: SectionProps): React.JSX.Element {
  const cls = ['cr-section', className].filter(Boolean).join(' ')
  return (
    <section className={cls} {...rest}>
      {(heading || controls) && (
        <div className="cr-section__header">
          {heading && <h2 className="cr-section__title">{heading}</h2>}
          {controls}
        </div>
      )}
      {children}
    </section>
  )
}
