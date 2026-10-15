import type { InputHTMLAttributes } from 'react'
import './switch.css'

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Whether the setting is on. Pair it with `onChange`, which gets the
   * native change event (`e.target.checked`). */
  checked: boolean
}

/**
 * An on/off setting that takes effect the moment you flip it.
 *
 * A native checkbox (role="switch") sits invisibly over a styled track and
 * thumb, so the keyboard, `aria-label`, `.checked` and change events are the
 * browser's own. The label belongs to the caller: put the Switch inside a
 * `<label>`, or give it an `aria-label`. Use a checkbox, not a Switch, for a
 * choice that waits for a Save.
 */
export default function Switch({ checked, className, ...rest }: SwitchProps): React.JSX.Element {
  const cls = ['cr-switch', className].filter(Boolean).join(' ')
  return (
    <span className={cls}>
      <input
        type="checkbox"
        role="switch"
        className="cr-switch-input"
        checked={checked}
        {...rest}
      />
      <span className="cr-switch-track" aria-hidden="true">
        <span className="cr-switch-thumb" />
      </span>
    </span>
  )
}
