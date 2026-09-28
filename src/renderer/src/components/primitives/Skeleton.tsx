export type SkeletonShape = 'card' | 'row'

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  shape: SkeletonShape
  /** Optional height for rows — defaults to 56px for rows, 200px for cards */
  height?: number
  /** Optional width — defaults to 100% */
  width?: string | number
}

/**
 * Skeleton component (plan 7, stage A2).
 *
 * Placeholder loading state showing the real card or row shape at 50% surface opacity,
 * pulsing gently. Not grey bars, but actual card/row-shaped elements.
 *
 * Example:
 * ```tsx
 * <Skeleton shape="card" />
 * <Skeleton shape="row" height={56} />
 * ```
 */
export default function Skeleton({
  shape,
  height,
  width = '100%',
  className = '',
  style = {},
  ...rest
}: SkeletonProps): React.JSX.Element {
  const defaultHeight = shape === 'card' ? 200 : 56
  const actualHeight = height ?? defaultHeight

  return (
    <div
      className={`cr-skeleton cr-skeleton--${shape} ${className}`}
      style={{
        ...style,
        height: actualHeight,
        width
      }}
      {...rest}
    />
  )
}
