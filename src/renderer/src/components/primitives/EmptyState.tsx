import Icon, { type IconName } from './Icon'

export interface EmptyStateProps {
  icon: IconName
  title: string
  body: string
  /** Spins the icon — for a state that is waiting on something, not empty. */
  iconSpins?: boolean
  /** Optional action button or element */
  action?: React.ReactNode
  className?: string
}

/**
 * Empty state component (plan 7, stage A2).
 *
 * Displayed when a list or section has no content.
 * Shows an icon (40px), title, body text, and optional action.
 */
export default function EmptyState({
  icon,
  title,
  body,
  iconSpins = false,
  action,
  className = ''
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className={`cr-empty-state ${className}`}>
      <div className={`cr-empty-state-icon${iconSpins ? ' cr-empty-state-icon--spins' : ''}`}>
        <Icon name={icon} size={40} />
      </div>
      <h2 className="cr-empty-state-title">{title}</h2>
      <p className="cr-empty-state-body">{body}</p>
      {action && <div className="cr-empty-state-action">{action}</div>}
    </div>
  )
}
