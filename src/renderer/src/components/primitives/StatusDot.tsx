import type { SessionStatus } from '../../../../main/store/types'

export type StatusDotSize = 8 | 10

export interface StatusDotProps extends React.SVGAttributes<SVGSVGElement> {
  status: SessionStatus
  size?: StatusDotSize
}

// Dot colour comes from the theme's status tokens (plan 1.2) — never a hex
// literal. Statuses with no dedicated token borrow the closest one in
// meaning: `shell` is an active-but-quiet state like idle; `stopped`,
// `missing` and `unknown` are all "nothing is happening here" states and
// read as faint/neutral rather than any of the five status hues.
const DOT_CLASS: Record<SessionStatus, string> = {
  working: 'status-dot-working',
  needs_attention: 'status-dot-attention',
  ready: 'status-dot-done',
  done: 'status-dot-done',
  // Reads "your turn", same as `ready` — so the same green.
  idle: 'status-dot-done',
  shell: 'status-dot-idle',
  errored: 'status-dot-error',
  stopped: 'status-dot-faint',
  missing: 'status-dot-faint',
  unknown: 'status-dot-faint',
  external: 'status-dot-faint'
}

/**
 * Status dot (plan 7, stage A2).
 *
 * A donut SVG (outer ring + inner fill) representing session status.
 * Pulses when working or needs_attention.
 * Size is 8 or 10 pixels.
 *
 * The donut design:
 * - outer circle: cx=5 cy=5 r=4 stroke-width=1.2 fill=none
 * - inner circle: r=2 fill={color}
 */
export default function StatusDot({
  status,
  size = 10,
  className = '',
  ...rest
}: StatusDotProps): React.JSX.Element {
  // `ready` deliberately does not pulse. A session can sit finished for hours,
  // and a pulse that never stops is just something to learn to ignore.
  // `done` stopped pulsing too: a session you marked done is the last thing
  // that should call for attention, and "something new here" is the unread
  // highlight's job now.
  const shouldPulse = status === 'needs_attention'
  const dotClass = DOT_CLASS[status]
  const animClass = shouldPulse ? 'status-dot-animate' : ''

  return (
    <svg
      viewBox="0 0 10 10"
      width={size}
      height={size}
      className={`status-dot ${dotClass} ${animClass} ${className}`}
      {...rest}
    >
      <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="5" cy="5" r="2" fill="currentColor" />
    </svg>
  )
}
