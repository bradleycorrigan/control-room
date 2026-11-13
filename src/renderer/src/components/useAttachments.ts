import { useCallback, useState } from 'react'
import {
  pickAttachments,
  addDroppedPaths,
  pasteAttachmentImage,
  pasteAttachmentText,
  getPathForDroppedFile,
  type AttachmentResult
} from '../api'

/**
 * Files on a prompt: the paperclip, a drop, a pasted image, and a long paste,
 * which becomes a file rather than a wall of text. Shared by every place you
 * write to Claude (Home's composer, a session's chat), so they behave alike.
 *
 * A file picked or dropped already has a real path — never copied, just
 * referenced (main validates it in exec/attachments.ts before it can reach a
 * prompt). Pasted images and long pastes have no path, so main writes them to
 * a temp file and hands back the path to that.
 */
export interface AttachmentChip {
  id: string
  name: string
  path: string | null
  status: 'pending' | 'ok' | 'error'
  error?: string
  source: 'path' | 'paste'
}

// Keeps the prompt's attachment block — and therefore the whole literal typed
// into the pane — bounded. See withAttachments in engine/sessions.ts.
export const MAX_ATTACHMENTS = 10

// Above this many lines a paste becomes a file attachment rather than going
// into the box. A prompt with a thousand lines of log in the middle is
// unreadable and uneditable; a chip saying how much you pasted is neither.
export const PASTE_AS_FILE_LINES = 20

export interface Attachments {
  chips: AttachmentChip[]
  dragOver: boolean
  pending: boolean
  /** Paths of the files ready to send. */
  readyPaths: () => string[]
  remove: (id: string) => void
  clear: () => void
  pick: () => Promise<void>
  dropProps: {
    onDragOver: (e: React.DragEvent<HTMLElement>) => void
    onDragEnter: (e: React.DragEvent<HTMLElement>) => void
    onDragLeave: (e: React.DragEvent<HTMLElement>) => void
    onDrop: (e: React.DragEvent<HTMLElement>) => Promise<void>
  }
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>
}

export function useAttachments(onError: (message: string | null) => void): Attachments {
  const [chips, setChips] = useState<AttachmentChip[]>([])
  const [dragOver, setDragOver] = useState(false)

  // Turns one main-process AttachmentResult into the matching chip update.
  const resolveChip = (id: string, source: 'path' | 'paste', result: AttachmentResult): void => {
    setChips((prev) =>
      prev.map((c) =>
        c.id === id
          ? result.ok
            ? { ...c, status: 'ok', path: result.path, name: result.name, source }
            : { ...c, status: 'error', error: result.error, source }
          : c
      )
    )
  }

  const addPendingChip = (name: string, source: 'path' | 'paste'): string => {
    const id = crypto.randomUUID()
    setChips((prev) => [...prev, { id, name, path: null, status: 'pending', source }])
    return id
  }

  // How many more chips fit, with a clear message — never a silent drop —
  // when a batch overflows.
  const roomFor = (count: number): { room: number; note: string | null } => {
    const room = MAX_ATTACHMENTS - chips.length
    if (room <= 0) return { room: 0, note: `You can attach up to ${MAX_ATTACHMENTS} files.` }
    if (count > room) {
      return {
        room,
        note: `Only added ${room} of ${count} files: up to ${MAX_ATTACHMENTS} at a time.`
      }
    }
    return { room, note: null }
  }

  const pick = useCallback(async () => {
    const { room, note } = roomFor(1)
    if (room <= 0) {
      onError(note)
      return
    }
    const results = await pickAttachments()
    if (results.length === 0) return // canceled
    const capped = results.slice(0, room)
    setChips((prev) => [
      ...prev,
      ...capped.map((r) =>
        r.ok
          ? {
              id: crypto.randomUUID(),
              name: r.name,
              path: r.path,
              status: 'ok' as const,
              source: 'path' as const
            }
          : {
              id: crypto.randomUUID(),
              name: r.name,
              path: null,
              status: 'error' as const,
              error: r.error,
              source: 'path' as const
            }
      )
    ])
    if (capped.length < results.length) {
      onError(
        `Only added ${capped.length} of ${results.length} files: up to ${MAX_ATTACHMENTS} at a time.`
      )
    }
    // roomFor reads `chips` directly; its length is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chips.length])

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault()
      setDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return

      const { room, note } = roomFor(files.length)
      if (room <= 0) {
        onError(note)
        return
      }
      if (note) onError(note)

      // Keep every file now, before any await: a screenshot fresh from its
      // preview thumbnail sits in a temp folder macOS empties moments after
      // the drop, so main copies it out; anything with no path at all has
      // its image bytes read here while the File still holds them.
      for (const file of files.slice(0, room)) {
        const id = addPendingChip(file.name, 'path')
        let path = ''
        try {
          path = getPathForDroppedFile(file)
        } catch {
          path = ''
        }
        if (path) {
          void addDroppedPaths([path]).then(([result]) => resolveChip(id, 'path', result))
          continue
        }
        if (file.type.startsWith('image/')) {
          void file
            .arrayBuffer()
            .then((data) => pasteAttachmentImage(new Uint8Array(data), file.type))
            .then((result) => resolveChip(id, 'path', result))
            .catch(() =>
              resolveChip(id, 'path', {
                ok: false,
                name: file.name,
                error: "couldn't read the image"
              })
            )
          continue
        }
        resolveChip(id, 'path', {
          ok: false,
          name: file.name,
          error: "couldn't resolve this file's location on disk"
        })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chips.length]
  )

  // A long text paste and a pasted image become files; short text is left to
  // the box's own paste.
  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData?.items ?? [])
      const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'))

      // Text first, and only when there is real text. Copying from some apps
      // puts an image flavour on the clipboard alongside the text, so checking
      // for an image first sent a plain text paste down the image path, where
      // getAsFile() handed back nothing and the chip read "empty paste".
      const text = e.clipboardData?.getData('text/plain') ?? ''
      const lines = text ? text.split('\n').length : 0
      if (text.trim() && lines >= PASTE_AS_FILE_LINES) {
        e.preventDefault()
        const { room, note } = roomFor(1)
        if (room <= 0) {
          onError(note)
          return
        }
        const id = addPendingChip(`${lines} lines pasted`, 'paste')
        resolveChip(id, 'paste', await pasteAttachmentText(text, lines))
        return
      }

      if (!imageItem) return

      e.preventDefault()
      const { room, note } = roomFor(1)
      if (room <= 0) {
        onError(note)
        return
      }
      const file = imageItem.getAsFile()
      // No file, or an empty one: let the paste happen normally rather than
      // reporting a failure the user did not cause.
      if (!file || file.size === 0) return

      const id = addPendingChip('Pasted image', 'paste')
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const result = await pasteAttachmentImage(bytes, file.type || 'image/png')
        resolveChip(id, 'paste', result)
      } catch {
        resolveChip(id, 'paste', {
          ok: false,
          name: 'pasted image',
          error: 'failed to read the pasted image'
        })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chips.length]
  )

  return {
    chips,
    dragOver,
    pending: chips.some((c) => c.status === 'pending'),
    readyPaths: () =>
      chips
        .filter((c): c is AttachmentChip & { path: string } => c.status === 'ok' && c.path !== null)
        .map((c) => c.path),
    remove: (id) => setChips((prev) => prev.filter((c) => c.id !== id)),
    clear: () => setChips([]),
    pick,
    dropProps: {
      onDragOver: (e) => e.preventDefault(),
      onDragEnter: (e) => {
        e.preventDefault()
        if (e.dataTransfer.types.includes('Files')) setDragOver(true)
      },
      onDragLeave: (e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      },
      onDrop
    },
    onPaste
  }
}
