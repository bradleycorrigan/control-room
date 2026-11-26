import type { SessionStatus } from '../../../../main/store/types'
import StatusDot from './StatusDot'
import { statusWord } from '../../lib/statusWords'

export type BadgeVariant = 'chip' | 'bare'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: SessionStatus
  /**
   * Sizing/emphasis context:
   * - 'chip': compact pill background (sessions list row)
   * - 'bare': dot + word without background (session detail header)
   */
  variant?: BadgeVariant
}

/**
 * Badge component (plan 7, stage A2).
 *
 * Status badge showing a donut dot + word, never colour alone (for accessibility).
 * Uses the StatusDot primitive for the icon.
 *
 * Variant 'chip' includes a pill background; 'bare' is just the dot and word.
 */
export default function Badge({
  status,
  variant = 'chip',
  className = '',
  ...rest
}: BadgeProps): React.JSX.Element {
  const word = statusWord(status)

  return (
    <span
      className={`status-badge ${variant === 'chip' ? 'status-badge--chip' : 'status-badge--bare'} ${className}`}
      data-status={status}
      {...rest}
    >
      <StatusDot status={status} size={8} />
      <span className="status-badge-word">{word}</span>
    </span>
  )
}

export { STATUS_WORDS } from '../../lib/statusWords'
