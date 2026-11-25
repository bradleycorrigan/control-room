import { LABEL_IDS, type LabelId } from '../theme/themes'
import { LABEL_NAMES } from '../lib/tabLayout'
import { Icon } from './primitives'

/**
 * A row of the label colours to pick from, for a menu: a tab's colour, a
 * group's colour. With `value` set and `allowNone`, the first swatch clears it.
 */
export default function ColourSwatches({
  label,
  value,
  onPick,
  allowNone = true
}: {
  /** Names the row for screen readers, and heads it on screen. */
  label: string
  value: LabelId | null
  /** null: no colour. */
  onPick: (colour: LabelId | null) => void
  /** A group always has a colour; a tab can have none. */
  allowNone?: boolean
}): React.JSX.Element {
  return (
    <div className="cr-swatches" role="radiogroup" aria-label={label}>
      <span className="cr-swatches-label">{label}</span>
      <div className="cr-swatches-row">
        {allowNone && (
          <button
            type="button"
            role="radio"
            aria-checked={value === null}
            aria-label="No colour"
            title="No colour"
            className="cr-swatch cr-swatch--none"
            onClick={() => onPick(null)}
          >
            <Icon name="X" size={10} />
          </button>
        )}
        {LABEL_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value === id}
            aria-label={LABEL_NAMES[id]}
            title={LABEL_NAMES[id]}
            data-colour={id}
            className="cr-swatch"
            style={{ '--swatch': `var(--label-${id})` } as React.CSSProperties}
            onClick={() => onPick(id)}
          />
        ))}
      </div>
    </div>
  )
}
