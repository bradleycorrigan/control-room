import './primitives.css'

export interface StepsProps {
  children: React.ReactNode
  className?: string
}

export interface StepProps {
  /** Its place in the list, shown in the circle. */
  number: number
  title: string
  /** A line or two on what this step is for. */
  note?: React.ReactNode
  /** What you do in this step: fields, a button, a command to copy. */
  children?: React.ReactNode
}

/**
 * Setup as a short numbered list: what each step is for on the left, the
 * thing you do on the right. For anything with an order to it, where a
 * single form would leave you guessing what comes first.
 */
export function Steps({ children, className }: StepsProps): React.JSX.Element {
  return <ol className={className ? `cr-steps ${className}` : 'cr-steps'}>{children}</ol>
}

export function Step({ number, title, note, children }: StepProps): React.JSX.Element {
  return (
    <li className="cr-step">
      <span className="cr-step-number" aria-hidden="true">
        {number}
      </span>
      <div className="cr-step-text">
        <h3 className="cr-step-title">{title}</h3>
        {note && <p className="cr-step-note">{note}</p>}
      </div>
      {children && <div className="cr-step-action">{children}</div>}
    </li>
  )
}
