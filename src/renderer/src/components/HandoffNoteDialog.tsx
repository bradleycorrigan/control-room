import { useEffect, useState } from 'react'
import type { SessionRecord } from '../../../main/store/types'
import { Modal, Button, Row, Stack, Textarea } from './primitives'
import { getSessionHandoffNote } from '../api-sessions'
import { addJiraComment, getSessionTicketLinks } from '../api'

interface Props {
  record: SessionRecord
  onClose: () => void
  pushToast?: (message: string) => void
}

/**
 * Hand-off note (plan 7, sessions round, step 2): a note built with no LLM
 * call, from the branch's own history — commits and diffstat since it left
 * the base branch, the open pull request, and the transcript's last
 * assistant reply. Editable before it goes anywhere. "Post to KEY" only
 * appears when the session is linked to a Jira ticket; otherwise the only
 * way out is Copy, same as every other control that only works when it can
 * actually work (CLAUDE.md).
 */
export default function HandoffNoteDialog({
  record,
  onClose,
  pushToast
}: Props): React.JSX.Element {
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [ticketKey, setTicketKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([getSessionHandoffNote(record.id), getSessionTicketLinks()])
      .then(([result, links]) => {
        if (cancelled) return
        setNote(result?.note ?? 'Could not build a hand-off note for this session.')
        setTicketKey(links[record.id] ?? null)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setNote('Could not build a hand-off note for this session.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [record.id])

  const post = async (): Promise<void> => {
    if (!ticketKey) return
    setBusy(true)
    const result = await addJiraComment(ticketKey, note)
    setBusy(false)
    if (result.ok) {
      pushToast?.(`Posted to ${ticketKey}.`)
      onClose()
    } else {
      pushToast?.(result.error ?? 'Could not post the comment.')
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(note)
      pushToast?.('Hand-off note copied.')
      onClose()
    } catch {
      pushToast?.('Could not copy the note - try selecting and copying it by hand.')
    }
  }

  return (
    <Modal title="Write hand-off note" icon="FileText" width={560} onClose={onClose}>
      <Stack gap={16}>
        <Textarea
          value={loading ? 'Building the note…' : note}
          onChange={(e) => setNote(e.target.value)}
          rows={16}
          disabled={loading}
          aria-label="Hand-off note"
        />
        <Row gap={8} justify="end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {ticketKey ? (
            <Button onClick={() => void post()} disabled={busy || loading}>
              {busy ? 'Posting…' : `Post to ${ticketKey}`}
            </Button>
          ) : (
            <Button onClick={() => void copy()} disabled={loading}>
              Copy
            </Button>
          )}
        </Row>
      </Stack>
    </Modal>
  )
}
