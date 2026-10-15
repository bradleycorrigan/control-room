import { useState } from 'react'
import type { SessionRecord } from '../../../main/store/types'
import { renameSession } from '../api'
import { Modal, Button, Input, Stack, Row } from './primitives'

interface Props {
  record: SessionRecord
  onCancel: () => void
  onRenamed: () => void
}

/**
 * Rename, for the surfaces that are not the session detail screen.
 *
 * Detail renames in place, by turning its heading into a field — which works
 * there and nowhere else. A card has no heading to borrow and no room for a
 * form, so the same action gets a dialog rather than being left out of card
 * menus entirely.
 */
export default function RenameSessionDialog({
  record,
  onCancel,
  onRenamed
}: Props): React.JSX.Element {
  const [value, setValue] = useState(record.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const title = value.trim()
    if (!title || title === record.title) {
      onCancel()
      return
    }
    setBusy(true)
    setError(null)
    const result = await renameSession(record.id, title)
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not rename it.')
      return
    }
    onRenamed()
  }

  return (
    <Modal title="Rename session" icon="Pencil" width={440} onClose={onCancel}>
      <Stack gap={16}>
        <Input
          value={value}
          autoFocus
          aria-label="Session name"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
          disabled={busy}
        />
        {error && <p className="modal-error">{error}</p>}
        <Row gap={8} justify="end">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !value.trim()}>
            Rename
          </Button>
        </Row>
      </Stack>
    </Modal>
  )
}
