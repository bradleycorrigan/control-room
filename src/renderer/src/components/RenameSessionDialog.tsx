import { useRef, useState } from 'react'
import type { SessionRecord } from '../../../main/store/types'
import { renameSession } from '../api'
import { Modal, Button, Input, Stack, Row } from './primitives'
import { useTitleSuggestion } from './useTitleSuggestion'

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
  const field = useRef<HTMLInputElement>(null)
  const suggestion = useTitleSuggestion(record.id, (title) => {
    setValue(title)
    // Selected, so typing replaces it and Enter keeps it.
    requestAnimationFrame(() => {
      field.current?.focus()
      field.current?.select()
    })
  })

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
          ref={field}
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
        {suggestion.error && (
          <p className="modal-error">Couldn&apos;t suggest one: {suggestion.error}</p>
        )}
        <Row gap={8} justify="space-between">
          <Button
            variant="ghost"
            onClick={suggestion.suggest}
            disabled={busy || suggestion.state === 'waiting'}
          >
            {suggestion.state === 'waiting' ? 'Suggesting…' : 'Suggest a name'}
          </Button>
          <Row gap={8}>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy || !value.trim()}>
              Rename
            </Button>
          </Row>
        </Row>
      </Stack>
    </Modal>
  )
}
