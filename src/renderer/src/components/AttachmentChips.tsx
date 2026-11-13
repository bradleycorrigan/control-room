import { Icon, IconButton } from './primitives'
import type { Attachments } from './useAttachments'
import './attachments.css'

/** The files on a prompt, one chip each: pending, ready, or why it failed. */
export default function AttachmentChips({
  attachments
}: {
  attachments: Attachments
}): React.JSX.Element | null {
  if (attachments.chips.length === 0) return null
  return (
    <div className="cr-attachments">
      {attachments.chips.map((chip) => (
        <div
          key={chip.id}
          className={`cr-attachment-chip cr-attachment-chip--${chip.status}`}
          title={
            chip.status === 'error'
              ? chip.error
              : chip.source === 'paste'
                ? `${chip.name}: copied to a temporary file for the agent to read`
                : chip.name
          }
        >
          {chip.status === 'pending' && (
            <Icon name="Loader2" size={14} className="cr-attachment-chip-spinner" />
          )}
          {chip.status === 'error' && <Icon name="AlertCircle" size={14} />}
          {chip.status === 'ok' && <Icon name="Paperclip" size={14} />}
          <span className="cr-attachment-chip-name">
            {chip.status === 'error' ? chip.error : chip.name}
          </span>
          <IconButton
            icon="X"
            label={`Remove ${chip.name}`}
            size={28}
            variant="ghost"
            onClick={() => attachments.remove(chip.id)}
          />
        </div>
      ))}
    </div>
  )
}
