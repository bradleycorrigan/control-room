import { useEffect, useState } from 'react'
import type { SessionRecord } from '../../../main/store/types'
import { deleteSession, getGitStatus } from '../api'
import { Modal, Button, Stack, Row, Icon } from './primitives'

interface Props {
  record: SessionRecord
  branch: string | null
  onCancel: () => void
  onDeleted: () => void
}

/** Shared with SessionDetail.tsx's Delete action so the destructive path
 * (worktree removal, dirty-worktree check, tmux window kill) exists in one
 * place rather than two that could drift. Always a centered modal — an
 * inline confirm card works fine on a full detail page but not inside a
 * 56px session row. */
export default function DeleteSessionDialog({
  record,
  branch,
  onCancel,
  onDeleted
}: Props): React.JSX.Element {
  // An investigation session's worktreePath IS the project's own repoPath —
  // never offer to "remove the worktree" for one (deleteSession refuses
  // this server-side too, but the option shouldn't even be on screen for
  // something this destructive to get right only on the backend).
  const [removeWorktree, setRemoveWorktree] = useState(!record.investigation)
  const [discardChanges, setDiscardChanges] = useState(false)
  const [deleteDirty, setDeleteDirty] = useState<boolean | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  useEffect(() => {
    if (record.investigation) return
    let cancelled = false
    getGitStatus(record.projectId, record.id).then((status) => {
      if (!cancelled) setDeleteDirty(status ? status.files.length > 0 : null)
    })
    return () => {
      cancelled = true
    }
  }, [record.investigation, record.projectId, record.id])

  const handleDelete = async (): Promise<void> => {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const result = await deleteSession(record.id, removeWorktree, discardChanges)
      if (!result.ok) {
        setDeleteError(result.error ?? 'failed to delete session')
        return
      }
      onDeleted()
    } catch {
      setDeleteError('failed to delete session')
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <Modal title="Delete session?" icon="Trash2" onClose={onCancel} width={520}>
      <Stack gap={16}>
        {record.investigation ? (
          <p className="delete-dialog-copy">
            This ends the session and closes its terminal window. It runs in the project&rsquo;s own
            checkout, not a worktree, so nothing on disk is touched.
          </p>
        ) : (
          <>
            <p className="delete-dialog-copy">
              This closes the terminal window for <code>{branch ?? record.title}</code>.
            </p>

            <div className="delete-dialog-path">
              <span className="delete-dialog-field-label">Worktree</span>
              <code className="delete-dialog-path-value">{record.worktreePath}</code>
            </div>

            {deleteDirty !== null &&
              (deleteDirty ? (
                <Row gap={8} align="flex-start" className="delete-dialog-warning">
                  <Icon name="AlertTriangle" size={16} />
                  <span>This worktree has uncommitted changes.</span>
                </Row>
              ) : (
                <p className="delete-dialog-note">This worktree has no uncommitted changes.</p>
              ))}

            <label className="delete-dialog-checkbox">
              <input
                type="checkbox"
                checked={removeWorktree}
                onChange={(e) => setRemoveWorktree(e.target.checked)}
              />
              Remove the worktree
            </label>
            {removeWorktree && (
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

        {deleteError && <p className="settings-error">{deleteError}</p>}

        <Row gap={8} justify="flex-end">
          <Button variant="outlined" onClick={onCancel} disabled={deleteBusy}>
            Cancel
          </Button>
          <Button
            variant="filled"
            className="delete-dialog-destructive"
            onClick={handleDelete}
            disabled={deleteBusy}
          >
            {deleteBusy ? 'Deleting…' : 'Confirm delete'}
          </Button>
        </Row>
      </Stack>
    </Modal>
  )
}
