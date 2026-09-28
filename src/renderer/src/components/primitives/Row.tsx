import type { CSSProperties, HTMLAttributes } from 'react'
import type { SpaceStep } from './Stack'
import './primitives.css'

export interface RowProps extends HTMLAttributes<HTMLDivElement> {
  /** Gap between children, on the 8pt grid. Defaults to 8 (tightly-related
   * items in a row). */
  gap?: SpaceStep
  justify?: CSSProperties['justifyContent']
  align?: CSSProperties['alignItems']
  /** Row grows to fill its container width. */
  fill?: boolean
}

/** A horizontal flex layout. Per plan 3 section 1.4, right-alignment inside a
 * Row is reserved for trailing metadata or a header row's primary action —
 * never mix left- and right-aligned items in a body. */
export default function Row({
  gap = 8,
  justify,
  align = 'center',
  fill,
  style,
  className,
  children,
  ...rest
}: RowProps): React.JSX.Element {
  const cls = ['cr-row', className].filter(Boolean).join(' ')
  return (
    <div
      className={cls}
      style={{
        gap: `var(--space-${gap})`,
        justifyContent: justify,
        alignItems: align,
        width: fill ? '100%' : undefined,
        ...style
      }}
      {...rest}
    >
      {children}
    </div>
  )
}
