import type { SessionStatus } from '../../../../main/store/types'
import StatusDot from './StatusDot'

// Short human words, not the raw enum values — this is the one place every
// SessionStatus in src/main/store/types.ts gets mapped to what a person reads.
const WORDS: Record<SessionStatus, string> = {
  working: 'working',
  // The pair people could not tell apart. "needs you" and "ready for you"
  // both said "you"; the difference is that one is blocked on an answer and
  // the other has simply finished and stopped.
  needs_attention: 'needs an answer',
  ready: 'your turn',
  // See status.ts rule 9. Claude Code reports `idle` for a session sitting at
  // its prompt, which is every session that has finished its turn — including
  // one that just asked you a question. "Idle" is its word for the process,
  // not a description of what you are looking at.
  done: 'done',
  idle: 'your turn',
  shell: 'shell',
  errored: 'errored',
  stopped: 'stopped',
  missing: 'missing',
  unknown: 'unknown',
  external: 'another terminal'
}

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
  const word = WORDS[status]

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

export { WORDS as STATUS_WORDS }
