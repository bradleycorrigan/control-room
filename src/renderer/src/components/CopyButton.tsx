import { useEffect, useState } from 'react'
import { IconButton } from './primitives'
import { copyText } from '../api'

/** Copies `text`, and ticks for a moment to say it did. */
export default function CopyButton({
  text,
  label,
  className
}: {
  text: string
  label: string
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  // The wrapper carries the placement: the button's tooltip wraps it in an
  // element of its own, so a class on the button can't place it.
  return (
    <span className={className} data-copied={copied || undefined}>
      <IconButton
        icon={copied ? 'Check' : 'Copy'}
        label={label}
        tooltip={copied ? 'Copied' : label}
        size={28}
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation()
          void copyText(text).then((r) => setCopied(r.ok))
        }}
      />
    </span>
  )
}
