import { useState } from 'react'
import type { LiveSession } from '../../../main/store/types'
import type { SessionCardAction } from './SessionCard'
import DeleteSessionDialog from './DeleteSessionDialog'
import RenameSessionDialog from './RenameSessionDialog'
import HandoffNoteDialog from './HandoffNoteDialog'
import {
  archiveSession,
  unarchiveSession,
  openSessionInIde,
  copyWorktreePath,
  copyAttachCommand,
  focusSessionTerminal,
  acknowledgeSession,
  markSessionUnread
} from '../api'
import { setSessionPinned } from '../api-projects'

interface Options {
  pushToast?: (message: string) => void
  /** Called after anything here changes a record, so the caller's list reloads. */
  onChanged: () => void
  /**
   * Renames in place instead of opening the dialog. The session detail screen
   * and the sessions list both turn their own title into a field, which is
   * better than a dialog where there is a title to borrow — but the action
   * still belongs to the one menu rather than being bolted on beside it.
   */
  onRename?: (session: LiveSession) => void
}

/**
 * "Mark as unread" / "Mark as read". Every session gets it, with a record or
 * without, so it is exported for the rows that build their own menu.
 */
export function readAction(session: LiveSession, onChanged?: () => void): SessionCardAction {
  return session.unread
    ? {
        label: 'Mark as read',
        onClick: () => void acknowledgeSession(session.key).then(() => onChanged?.())
      }
    : {
        label: 'Mark as unread',
        onClick: () => void markSessionUnread(session.key).then(() => onChanged?.())
      }
}

/**
 * One menu for a session, wherever the session is shown.
 *
 * Home's recent cards carried "Mark as done" and nothing else, the project
 * board carried that plus Delete, and the full set only existed on the session
 * detail screen — so what you could do to a session depended on which surface
 * you happened to be looking at, for no reason a user could work out. The
 * actions live here; the surfaces only decide where the menu hangs.
 *
 * Returns the dialogs to render as well: Rename and Delete both need one, and
 * a card is too small to host either inline.
 */
export function useSessionActions({
  pushToast,
  onChanged,
  onRename
}: Options): [React.ReactNode, (session: LiveSession) => SessionCardAction[] | undefined] {
  const [deleting, setDeleting] = useState<LiveSession | null>(null)
  const [renaming, setRenaming] = useState<LiveSession | null>(null)
  const [writingHandoff, setWritingHandoff] = useState<LiveSession | null>(null)

  const actionsFor = (session: LiveSession): SessionCardAction[] | undefined => {
    const record = session.record
    if (!record) return undefined
    return [readAction(session, onChanged), ...recordActions(session, record)]
  }

  const recordActions = (
    session: LiveSession,
    record: NonNullable<LiveSession['record']>
  ): SessionCardAction[] => {
    // A session with no record is one discovered in a terminal: there is
    // nothing stored to rename, archive or delete. Adopting it is what gives
    // it a record, and that lives on the session itself.
    const actions: SessionCardAction[] = [
      {
        label: record.pinned ? 'Unpin' : 'Pin',
        onClick: () => {
          void setSessionPinned(record.id, !record.pinned).then((result) => {
            if (result.ok) onChanged()
            else pushToast?.(result.error ?? 'Could not pin it.')
          })
        }
      },
      {
        label: onRename ? 'Rename' : 'Rename…',
        onClick: () => (onRename ? onRename(session) : setRenaming(session))
      },
      record.archivedAt
        ? {
            label: 'Move back to Active',
            onClick: () => {
              void unarchiveSession(record.id).then((result) => {
                pushToast?.(
                  result.ok
                    ? `${record.title} is active again.`
                    : (result.error ?? 'Could not move it back.')
                )
                if (result.ok) onChanged()
              })
            }
          }
        : {
            label: 'Mark as done',
            onClick: () => {
              void archiveSession(record.id).then((result) => {
                pushToast?.(
                  result.ok
                    ? `${record.title} marked done. Nothing was stopped.`
                    : (result.error ?? 'Could not mark it done.')
                )
                if (result.ok) onChanged()
              })
            }
          },
      // Only with a pane to focus. Kept in list order rather than appended, so
      // the menu reads the same way every time it appears.
      ...(session.tmux
        ? [
            {
              label: 'Focus terminal',
              onClick: (): void => {
                void focusSessionTerminal(record.id).then((result) => {
                  if (!result.ok) pushToast?.(result.error ?? 'Could not focus the terminal.')
                })
              }
            }
          ]
        : []),
      {
        label: 'Open in IDE',
        onClick: () => {
          void openSessionInIde(record.id).then((result) => {
            if (!result.ok) pushToast?.(result.error ?? 'Could not open in Cursor.')
          })
        }
      },
      {
        label: 'Copy worktree path',
        onClick: () => {
          void copyWorktreePath(record.id).then((result) => {
            pushToast?.(
              result.ok ? 'Worktree path copied.' : (result.error ?? 'Failed to copy the path.')
            )
          })
        }
      },
      // Needs a worktree and branch to build anything from — the same
      // record every other action here already requires.
      { label: 'Write hand-off note…', onClick: () => setWritingHandoff(session) }
    ]

    // Only with a pane to attach to. The command would be a lie otherwise, and
    // a menu entry that cannot work does not belong on screen at all.
    if (session.tmux) {
      actions.push({
        label: 'Copy attach command',
        onClick: () => {
          void copyAttachCommand(record.id).then((result) => {
            pushToast?.(
              result.ok
                ? 'Attach command copied.'
                : (result.error ?? 'Failed to copy the attach command.')
            )
          })
        }
      })
    }

    actions.push({ label: 'Delete…', onClick: () => setDeleting(session), danger: true })
    return actions
  }

  const node = (
    <>
      {renaming?.record && (
        <RenameSessionDialog
          record={renaming.record}
          onCancel={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null)
            onChanged()
          }}
        />
      )}
      {deleting?.record && (
        <DeleteSessionDialog
          record={deleting.record}
          branch={deleting.record.branch ?? null}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            onChanged()
          }}
        />
      )}
      {writingHandoff?.record && (
        <HandoffNoteDialog
          record={writingHandoff.record}
          onClose={() => setWritingHandoff(null)}
          pushToast={pushToast}
        />
      )}
    </>
  )

  return [node, actionsFor]
}
