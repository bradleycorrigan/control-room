export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Progress value from 0 to 1 */
  value: number
  /** CSS variable like var(--status-done) — defaults to accent */
  tone?: string
  /** Height in pixels — defaults to 2 */
  height?: number
}

/**
 * Progress bar component (plan 7, stage A2).
 *
 * A horizontal progress bar showing a value from 0 to 1.
 * Can optionally interpolate through multiple color stops based on value.
 *
 * Default height is 2px. The bar has 8px radius to match card styling.
 *
 * Example:
 * ```tsx
 * <ProgressBar value={0.056} tone="var(--status-done)" />
 * ```
 */
export default function ProgressBar({
  value,
  tone = 'var(--accent)',
  height = 2,
  className = '',
  style = {},
  ...rest
}: ProgressBarProps): React.JSX.Element {
  const percentage = Math.min(Math.max(value * 100, 0), 100)

  return (
    <div
      className={`cr-progress-bar ${className}`}
      style={
        {
          ...style,
          '--progress-tone': tone,
          height
        } as React.CSSProperties
      }
      {...rest}
    >
      <div
        className="cr-progress-bar-fill"
        style={{
          width: `${percentage}%`
        }}
      />
    </div>
  )
}
