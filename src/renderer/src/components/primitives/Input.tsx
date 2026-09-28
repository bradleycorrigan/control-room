import type { InputHTMLAttributes } from 'react'
import './primitives.css'

export type InputProps = InputHTMLAttributes<HTMLInputElement>

/** Outlined text input per plan 3 section 1.6: outlined container, 8/16px
 * padding, 36px minimum height, accent focus ring at 2px with a 2px offset. */
export default function Input({ className, ...rest }: InputProps): React.JSX.Element {
  const cls = ['cr-input', className].filter(Boolean).join(' ')
  return <input className={cls} {...rest} />
}
