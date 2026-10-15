import './primitives.css'

// `string | number` rather than `string`: the terminal text size is a real
// number in settings, and stringifying it just to feed a control would put the
// parsing back on every caller.
export interface SegmentedOption<T extends string | number> {
  value: T
  label: string
}

export interface SegmentedControlProps<T extends string | number> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  'aria-label'?: string
}

/** A single outlined container with a filled selected segment, per plan 3
 * section 1.6. Used for view toggles, tab-like choices and sort order. */
export default function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ...rest
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <div className="cr-segmented" role="tablist" aria-label={rest['aria-label']}>
      {options.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className={'cr-segmented__option' + (selected ? ' cr-segmented__option--selected' : '')}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
