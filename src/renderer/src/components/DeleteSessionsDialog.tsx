import { useEffect, useState } from 'react'
import type { SessionRecord } from '../../../main/store/types'
import { deleteSession, getGitStatus } from '../api'
import { Modal, Button, Stack, Row, Icon } from './primitives'

interface Props {
  records: SessionRecord[]
  onCancel: () => void
  /** Called once every delete has been tried; `failed` lists the ones that didn't go. */
  onDone: (failed: { record: SessionRecord; error: string }[]) => void
}

/**
 * Deletes several sessions at once, with the same choices as one: close
 * each terminal window, and remove the worktrees too unless asked not to.
 * A session that runs in the project's own checkout never has anything on
 * disk removed. A worktree with uncommitted changes is only removed when
 * "Discard uncommitted changes" is ticked, and fails otherwise, as it does
 * for a single delete.
 */
export default function DeleteSessionsDialog({
  records,
  onCancel,
  onDone
}: Props): React.JSX.Element {
  const withWorktree = records.filter((r) => !r.investigation)
  const [removeWorktrees, setRemoveWorktrees] = useState(withWorktree.length > 0)
  const [discardChanges, setDiscardChanges] = useState(false)
  // Titles of the worktrees with uncommitted changes, once checked.
  const [dirty, setDirty] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      withWorktree.map((r) =>
        getGitStatus(r.projectId, r.id).then((s) => (s && s.files.length > 0 ? r.title : null))
      )
    ).then((titles) => {
      if (!cancelled) setDirty(titles.filter((t): t is string => t !== null))
    })
    return () => {
      cancelled = true
    }
    // The records are fixed for the dialog's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDelete = async (): Promise<void> => {
    setBusy(true)
    const failed: { record: SessionRecord; error: string }[] = []
    // One at a time: each delete removes a worktree and runs git in the
    // same repo, and several at once can trip over git's own lock.
    for (const [i, record] of records.entries()) {
      setProgress(i + 1)
      try {
        const result = await deleteSession(
          record.id,
          removeWorktrees && !record.investigation,
          discardChanges
        )
        if (!result.ok) failed.push({ record, error: result.error ?? 'failed to delete' })
      } catch {
        failed.push({ record, error: 'failed to delete' })
      }
    }
    setBusy(false)
    onDone(failed)
  }

  const count = records.length
  const noun = count === 1 ? 'session' : 'sessions'
  return (
    <Modal title={`Delete ${count} ${noun}?`} icon="Trash2" onClose={onCancel} width={520}>
      <Stack gap={16}>
        <p className="delete-dialog-copy">
          This ends {count === 1 ? 'the session' : `all ${count}`} and closes{' '}
          {count === 1 ? 'its terminal window' : 'their terminal windows'}.
        </p>
        <ul className="delete-dialog-list">
          {records.map((r) => (
            <li key={r.id}>{r.title}</li>
          ))}
        </ul>

        {withWorktree.length > 0 && (
          <>
            {dirty !== null &&
              (dirty.length > 0 ? (
                <Row gap={8} align="flex-start" className="delete-dialog-warning">
                  <Icon name="AlertTriangle" size={16} />
                  <span>
                    {dirty.length === 1 ? '1 worktree has' : `${dirty.length} worktrees have`}{' '}
                    uncommitted changes: {dirty.join(', ')}.
                  </span>
                </Row>
              ) : (
                <p className="delete-dialog-note">
                  None of these worktrees have uncommitted changes.
                </p>
              ))}
            <label className="delete-dialog-checkbox">
              <input
                type="checkbox"
                checked={removeWorktrees}
                onChange={(e) => setRemoveWorktrees(e.target.checked)}
              />
              Remove their worktrees ({withWorktree.length})
            </label>
            {removeWorktrees && (
              <label className="delete-dialog-checkbox">
                <input
                  type="checkbox"
                  checked={discardChanges}
                  onChange={(e) => setDiscardChanges(e.target.checked)}
                />
                Discard uncommitted changes
              </label>
            )}
          </>
        )}

        <Row gap={8} justify="flex-end">
          <Button variant="outlined" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="filled"
            className="delete-dialog-destructive"
            onClick={() => void handleDelete()}
            disabled={busy}
          >
            {busy ? `Deleting ${progress} of ${count}…` : `Delete ${count} ${noun}`}
          </Button>
        </Row>
      </Stack>
    </Modal>
  )
}
