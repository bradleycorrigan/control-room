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
  acknowledgeSession,
  markSessionUnread,
  hideSession,
  openSessionFolderInIde,
  killSessionWindow,
  stopBackgroundAgent,
  dismissBackgroundAgent,
  killSessionProcess
} from '../api'
import { useConfirm } from './primitives'
import { setSessionPinned } from '../api-projects'
import { useEditorName } from '../state/useEditorName'

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
        group: 'organise',
        onClick: () => void acknowledgeSession(session.key).then(() => onChanged?.())
      }
    : {
        label: 'Mark as unread',
        group: 'organise',
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
}: Options): [React.ReactNode, (session: LiveSession) => SessionCardAction[]] {
  const [deleting, setDeleting] = useState<LiveSession | null>(null)
  const [renaming, setRenaming] = useState<LiveSession | null>(null)
  const [writingHandoff, setWritingHandoff] = useState<LiveSession | null>(null)

  const [confirmNode, confirm] = useConfirm()
  const editor = useEditorName()

  // Every session gets this menu, in this order, on every screen: Home, the
  // Sessions list and the session itself. Grouped: work on it, organise it,
  // copy from it, end it. An item that can never apply to a kind of session is
  // left out; one that can't be used right now stays put, greyed, saying why.
  const actionsFor = (session: LiveSession): SessionCardAction[] => {
    const record = session.record
    return record ? recordActions(session, record) : elsewhereActions(session)
  }

  /**
   * A session Control Room didn't start: running in another terminal (a
   * worktree opened in Cursor, say), or a background agent. Nothing stored to
   * rename or archive, so: open its folder, hide it, or end it.
   */
  const elsewhereActions = (session: LiveSession): SessionCardAction[] => {
    const id = session.claudeSessionId
    const actions: SessionCardAction[] = [
      {
        label: `Open in ${editor}`,
        icon: 'FolderOpen',
        group: 'work',
        disabled: id ? undefined : 'It isn’t working in a folder Control Room can open',
        onClick: () => {
          if (!id) return
          void openSessionFolderInIde(id).then((result) => {
            if (!result.ok) pushToast?.(result.error ?? `Could not open in ${editor}.`)
          })
        }
      },
      readAction(session, onChanged)
    ]
    if (!id && session.backgroundAgentId) {
      const agentId = session.backgroundAgentId
      actions.push({
        label: 'Hide',
        group: 'organise',
        onClick: () => void dismissBackgroundAgent(agentId).then(() => onChanged())
      })
    }
    if (id) {
      actions.push({
        label: 'Hide',
        group: 'organise',
        onClick: () => {
          void hideSession(id).then((result) => {
            pushToast?.(
              result.ok
                ? 'Hidden. It won’t come back, even while it keeps running.'
                : (result.error ?? 'Could not hide it.')
            )
            if (result.ok) onChanged()
          })
        }
      })
    }
    if (session.tmux || session.backgroundAgentId || session.claudePid) {
      actions.push({
        label: 'End session…',
        group: 'end',
        danger: true,
        onClick: () => void endElsewhere(session)
      })
    }
    return actions
  }

  // Stops a session Control Room didn't start: its terminal window if it's in
  // ours, `claude stop` for a background agent, else its process. Then hides
  // it, so a process slow to go doesn't flicker back.
  const endElsewhere = async (session: LiveSession): Promise<void> => {
    const ok = await confirm({
      title: session.backgroundAgentId ? 'Stop this background agent?' : 'End this session?',
      body: session.tmux
        ? `This closes its terminal window (${session.tmux.sessionName}:${session.tmux.windowName}) and stops Claude in it.`
        : session.backgroundAgentId
          ? 'Its conversation is kept: resume it later with `claude attach`.'
          : 'Claude stops in the other terminal it runs in. Its conversation stays in Claude’s history.',
      confirmLabel: session.backgroundAgentId ? 'Stop agent' : 'End session',
      danger: true
    })
    if (!ok) return
    const result = session.tmux
      ? await killSessionWindow(session.tmux.windowId)
      : session.backgroundAgentId
        ? await stopBackgroundAgent(session.backgroundAgentId)
        : session.claudePid
          ? await killSessionProcess(session.claudePid)
          : { ok: false, error: 'nothing to stop' }
    if (!result.ok) {
      // `claude stop`'s own background service can be wedged, and then it
      // fails every time. Offer what always works: stop showing it.
      if (session.backgroundAgentId) {
        const hide = await confirm({
          title: result.error ?? 'Couldn’t stop the agent.',
          body: 'Hide it instead? It keeps running; Control Room stops showing it.',
          confirmLabel: 'Hide it'
        })
        if (hide && (await dismissBackgroundAgent(session.backgroundAgentId)).ok) onChanged()
        return
      }
      pushToast?.(result.error ?? 'Could not end it.')
      return
    }
    if (session.claudeSessionId) await hideSession(session.claudeSessionId)
    pushToast?.('Session ended.')
    onChanged()
  }

  const recordActions = (
    session: LiveSession,
    record: NonNullable<LiveSession['record']>
  ): SessionCardAction[] => {
    const noTerminal = session.tmux
      ? undefined
      : session.status === 'stopped' || session.status === 'missing'
        ? 'It has no terminal: Claude isn’t running'
        : 'Its terminal isn’t attached yet'
    return [
      // Work on it.
      {
        label: `Open in ${editor}`,
        icon: 'FolderOpen',
        group: 'work',
        onClick: () => {
          void openSessionInIde(record.id).then((result) => {
            if (!result.ok) pushToast?.(result.error ?? `Could not open in ${editor}.`)
          })
        }
      },
      // Needs a worktree and branch to build anything from — the same
      // record every other action here already requires.
      { label: 'Write hand-off note…', group: 'work', onClick: () => setWritingHandoff(session) },
      // Organise it.
      {
        label: onRename ? 'Rename' : 'Rename…',
        icon: 'Pencil',
        group: 'organise',
        onClick: () => (onRename ? onRename(session) : setRenaming(session))
      },
      {
        label: record.pinned ? 'Unpin' : 'Pin',
        icon: record.pinned ? 'PinOff' : 'Pin',
        group: 'organise',
        onClick: () => {
          void setSessionPinned(record.id, !record.pinned).then((result) => {
            if (result.ok) onChanged()
            else pushToast?.(result.error ?? 'Could not pin it.')
          })
        }
      },
      readAction(session, onChanged),
      record.archivedAt
        ? {
            label: 'Move back to Active',
            icon: 'RotateCcw',
            group: 'organise',
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
            icon: 'CircleCheck',
            group: 'organise',
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
      // Copy from it.
      {
        label: 'Copy worktree path',
        group: 'copy',
        onClick: () => {
          void copyWorktreePath(record.id).then((result) => {
            pushToast?.(
              result.ok ? 'Worktree path copied.' : (result.error ?? 'Failed to copy the path.')
            )
          })
        }
      },
      ...(session.backgroundAgentId
        ? []
        : [
            {
              label: 'Copy attach command',
              group: 'copy',
              disabled: noTerminal,
              onClick: (): void => {
                void copyAttachCommand(record.id).then((result) => {
                  pushToast?.(
                    result.ok
                      ? 'Attach command copied.'
                      : (result.error ?? 'Failed to copy the attach command.')
                  )
                })
              }
            }
          ]),
      // End it.
      {
        label: 'Delete…',
        icon: 'Trash2',
        group: 'end',
        danger: true,
        onClick: () => setDeleting(session)
      }
    ]
  }

  const node = (
    <>
      {confirmNode}
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
