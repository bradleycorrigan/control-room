import Icon, { type IconName } from './Icon'
import IconButton from './IconButton'
import { useDismissible } from '../../keyboard'

export interface ModalProps {
  title: string
  icon?: IconName
  width?: number
  onClose: () => void
  children: React.ReactNode
  /** Additional className for the modal container */
  className?: string
}

/**
 * Modal component (plan 7, stage A2).
 *
 * A centred modal dialog with a header (icon + title + close button) and content.
 * Width defaults to 560px per plan.
 * Closes on Escape key or close button click.
 * Background is --surface-raised with 8px radius.
 */
export default function Modal({
  title,
  icon,
  width = 560,
  onClose,
  children,
  className = ''
}: ModalProps): React.JSX.Element {
  // Escape closes this, unless a menu is open on top of it.
  useDismissible(true, 'modal', onClose)

  return (
    <>
      <div className="cr-modal-backdrop" onClick={onClose} />
      <div
        className={`cr-modal ${className}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="cr-modal-header">
          <div className="cr-modal-title-group">
            {icon && <Icon name={icon} size={20} />}
            <h2 className="cr-modal-title">{title}</h2>
          </div>
          <IconButton icon="X" label="Close" size={28} variant="ghost" onClick={onClose} />
        </div>
        <div className="cr-modal-content">{children}</div>
      </div>
    </>
  )
}
