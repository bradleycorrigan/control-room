import { useTabLayoutInfo } from '../state/TabLayoutContext'
import { LABEL_NAMES, tabColour } from '../lib/tabLayout'

/**
 * A session's tab colour, and its tab group's name, where the session shows
 * up outside the tab strip: a card, a list row. Nothing when it has neither.
 * The swatch is the same rounded square as a group's label on the strip.
 *
 * In two parts: the swatch goes before the title, the group's name after it,
 * so a name doesn't push one row's title out of line with the next.
 */
export default function SessionLabel({
  sessionKey,
  part
}: {
  sessionKey: string
  part: 'swatch' | 'group'
}): React.JSX.Element | null {
  const layout = useTabLayoutInfo()
  const colour = tabColour(sessionKey, layout)
  if (!colour) return null
  const group = layout.groups.find((g) => g.id === layout.groupOf[sessionKey])
  const name = group?.name.trim()
  if (part === 'group' && !name) return null
  const label = group
    ? `In tab group ${name || `${LABEL_NAMES[colour]} group`}`
    : `${LABEL_NAMES[colour]} tab`
  return (
    <span
      className={part === 'group' ? 'cr-session-label cr-session-label--named' : 'cr-session-label'}
      style={{ '--tab-colour': `var(--label-${colour})` } as React.CSSProperties}
      title={label}
      aria-label={label}
      data-session-label={colour}
    >
      {part === 'swatch' ? (
        <span className="cr-session-label-swatch" aria-hidden="true" />
      ) : (
        <span className="cr-session-label-name">{name}</span>
      )}
    </span>
  )
}
