import type { CSSProperties, HTMLAttributes } from 'react'
import './primitives.css'

/** Legal gap steps, per plan 3 section 1.1 (the 8pt grid). */
export type SpaceStep = 4 | 8 | 16 | 24 | 32 | 48 | 64

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  /** Gap between children, on the 8pt grid. Defaults to 16 (the default gap
   * inside a container). */
  gap?: SpaceStep
  align?: CSSProperties['alignItems']
}

/** A vertical flex layout — the default composition primitive per plan 3
 * section 1.4 ("vertical rhythm beats horizontal fiddling"). */
export default function Stack({
  gap = 16,
  align,
  style,
  className,
  children,
  ...rest
}: StackProps): React.JSX.Element {
  const cls = ['cr-stack', className].filter(Boolean).join(' ')
  return (
    <div
      className={cls}
      style={{ gap: `var(--space-${gap})`, alignItems: align, ...style }}
      {...rest}
    >
      {children}
    </div>
  )
}
