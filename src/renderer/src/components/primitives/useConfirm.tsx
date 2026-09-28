import { useCallback, useRef, useState } from 'react'
import Button from './Button'
import Modal from './Modal'
import './primitives.css'

export interface ConfirmRequest {
  title: string
  /** What the action will actually do. Say the irreversible part out loud. */
  body?: React.ReactNode
  /** Names the action, never "OK" — you should be able to read just this. */
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive: the confirm button carries the error colour. */
  danger?: boolean
}

/**
 * A confirmation that looks like the rest of the app.
 *
 * It replaces `window.confirm`, which drew a system dialog in a typeface and
 * shape that appear nowhere else here, ignored the theme, and could only offer
 * "OK" and "Cancel" — so the button never said what it was about to do. The
 * same dialog is what made the terminal's own link prompt feel broken.
 *
 * Returns the element to render and an awaitable ask, so a call site reads
 * almost exactly as it did:
 *
 *     if (!(await confirm({ title: 'End this session?', danger: true }))) return
 */
export function useConfirm(): [React.ReactNode, (req: ConfirmRequest) => Promise<boolean>] {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const settle = useCallback((ok: boolean) => {
    // Resolve before clearing, so a caller awaiting this is never left hanging
    // if the component unmounts as a result of what it does next.
    resolveRef.current?.(ok)
    resolveRef.current = null
    setRequest(null)
  }, [])

  const confirm = useCallback((next: ConfirmRequest): Promise<boolean> => {
    // A second ask while one is open cancels the first rather than losing it.
    resolveRef.current?.(false)
    setRequest(next)
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
    })
  }, [])

  const node = request ? (
    <Modal title={request.title} icon="TriangleAlert" width={480} onClose={() => settle(false)}>
      <div className="cr-confirm">
        {request.body && <div className="cr-confirm-body">{request.body}</div>}
        <div className="cr-confirm-actions">
          <Button onClick={() => settle(false)}>{request.cancelLabel ?? 'Cancel'}</Button>
          <Button
            variant="filled"
            className={request.danger ? 'cr-confirm-danger' : undefined}
            autoFocus
            onClick={() => settle(true)}
          >
            {request.confirmLabel ?? 'Confirm'}
          </Button>
        </div>
      </div>
    </Modal>
  ) : null

  return [node, confirm]
}
