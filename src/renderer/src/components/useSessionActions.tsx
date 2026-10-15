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
}: Options): [React.ReactNode, (session: LiveSession) => SessionCardAction[]] {
  const [deleting, setDeleting] = useState<LiveSession | null>(null)
  const [renaming, setRenaming] = useState<LiveSession | null>(null)
  const [writingHandoff, setWritingHandoff] = useState<LiveSession | null>(null)

  const [confirmNode, confirm] = useConfirm()

  // Every session gets this menu, in this order, on every screen: Home, the
  // Sessions list and the session itself. An item that can never apply to a
  // kind of session is left out; one that can't be used right now stays put,
  // greyed, saying why.
  const actionsFor = (session: LiveSession): SessionCardAction[] => {
    const record = session.record
    return record
      ? [readAction(session, onChanged), ...recordActions(session, record)]
      : [readAction(session, onChanged), ...elsewhereActions(session)]
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
        label: 'Open in IDE',
        disabled: id ? undefined : 'It isn’t working in a folder Control Room can open',
        onClick: () => {
          if (!id) return
          void openSessionFolderInIde(id).then((result) => {
            if (!result.ok) pushToast?.(result.error ?? 'Could not open in Cursor.')
          })
        }
      }
    ]
    if (!id && session.backgroundAgentId) {
      const agentId = session.backgroundAgentId
      actions.push({
        label: 'Hide',
        onClick: () => void dismissBackgroundAgent(agentId).then(() => onChanged())
      })
    }
    if (id) {
      actions.push({
        label: 'Hide',
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
      // Always in the same place. Without a pane it's greyed with why, rather
      // than missing, which read as the menu changing for no reason.
      ...(session.backgroundAgentId
        ? []
        : [
            {
              label: 'Focus terminal',
              disabled: noTerminal,
              onClick: (): void => {
                void focusSessionTerminal(record.id).then((result) => {
                  if (!result.ok) pushToast?.(result.error ?? 'Could not focus the terminal.')
                })
              }
            }
          ]),
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

    if (!session.backgroundAgentId) {
      actions.push({
        label: 'Copy attach command',
        disabled: noTerminal,
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
