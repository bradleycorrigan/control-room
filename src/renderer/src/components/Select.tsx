import { Children, isValidElement, useState } from 'react'
import { Picker, type PickerOption } from '../screens/backlog/Picker'
import './select.css'

/**
 * The app's dropdown: a button showing the current choice that opens the same
 * picker as the ticket shortcuts (type to narrow, arrows, Enter), in place of
 * the native macOS menu, which looked like a different app.
 *
 * Written like a <select> so a native one swaps over as is: <option>
 * children, `value`, and `onChange` handed `{ target: { value } }`. A
 * disabled option is left out of the list.
 */
export default function Select({
  value,
  onChange,
  children,
  className = '',
  disabled = false,
  'aria-label': ariaLabel,
  title
}: {
  value: string
  onChange: (e: { target: { value: string } }) => void
  children: React.ReactNode
  className?: string
  disabled?: boolean
  'aria-label'?: string
  /** What the picker's search box says ("Status…"); the aria-label when left out. */
  title?: string
}): React.JSX.Element {
  // The button it opens from, while open.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const options = optionsFrom(children)
  const current = options.find((o) => o.value === value)
  const name = title ?? ariaLabel ?? 'Choose'

  return (
    <>
      <button
        type="button"
        className={`cr-select ${className}`.trim()}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        data-value={value}
        disabled={disabled}
        onClick={(e) => {
          // A select inside a clickable row or card shouldn't also open that.
          e.stopPropagation()
          setAnchor(e.currentTarget)
        }}
      >
        {current?.label ?? ''}
      </button>
      {anchor && (
        <Picker
          anchor={anchor}
          title={name}
          options={options
            .filter((o) => !o.disabled)
            .map((o) => ({ value: o.value, label: o.label, checked: o.value === value }))}
          onPick={(v) => {
            if (v !== value) onChange({ target: { value: v } })
          }}
          onClose={() => {
            anchor.focus()
            setAnchor(null)
          }}
        />
      )}
    </>
  )
}

type Option = PickerOption & { disabled?: boolean }

/** <option> elements, however they're nested in fragments and arrays, as plain options. */
function optionsFrom(children: React.ReactNode): Option[] {
  const out: Option[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    const props = child.props as {
      value?: string | number
      disabled?: boolean
      children?: React.ReactNode
    }
    if (child.type === 'option') {
      const label = textOf(props.children)
      out.push({
        value: props.value === undefined ? label : String(props.value),
        label,
        disabled: props.disabled
      })
    } else {
      out.push(...optionsFrom(props.children))
    }
  })
  return out
}

function textOf(node: React.ReactNode): string {
  let text = ''
  Children.forEach(node, (n) => {
    if (typeof n === 'string' || typeof n === 'number') text += String(n)
  })
  return text
}
