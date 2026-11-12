import { useState } from 'react'
import './primitives.css'

export interface CountProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number
}

/**
 * A number that rolls when it changes: up when it grows, down when it
 * shrinks, so a count going from 2 to 3 is seen to happen, not just noticed
 * later. The first render doesn't move. Plain text, so it reads and copies
 * like any number.
 */
export default function Count({ value, className, ...rest }: CountProps): React.JSX.Element {
  // Adjusted during render (React's pattern for state derived from a changed
  // prop), so the roll starts on the same commit as the new number.
  const [previous, setPrevious] = useState(value)
  const [direction, setDirection] = useState<'up' | 'down' | null>(null)
  if (value !== previous) {
    setPrevious(value)
    setDirection(value > previous ? 'up' : 'down')
  }
  return (
    <span
      // A new key restarts the animation on each change.
      key={value}
      className={['cr-count', direction ? `cr-count--${direction}` : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {value}
    </span>
  )
}
