import './primitives.css'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

/**
 * Textarea component (plan 7, stage A2).
 *
 * Multi-line text input matching the design system.
 */
export default function Textarea({ className = '', ...rest }: TextareaProps): React.JSX.Element {
  return <textarea className={`cr-textarea ${className}`} {...rest} />
}
