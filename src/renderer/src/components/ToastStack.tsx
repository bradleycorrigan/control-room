import { IconButton } from './primitives'
import type { Toast, ToastTone, ToastsController } from '../state/useToasts'

/** Drawn for the toast, not borrowed from the icon set: a tick, a bang and a
 * dot, each on the tone's own colour, sized to sit on the first line. */
function ToneGlyph({ tone }: { tone: ToastTone }): React.JSX.Element {
  return (
    <span className={`toast-glyph toast-glyph--${tone}`} aria-hidden>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7.25" className="toast-glyph-ring" />
        {tone === 'success' && (
          <path
            d="M5 8.25 7 10.25 11 6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {tone === 'error' && (
          <>
            <path d="M8 4.5v4.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.25" r="0.95" fill="currentColor" />
          </>
        )}
        {tone === 'info' && <circle cx="8" cy="8" r="2" fill="currentColor" />}
      </svg>
    </span>
  )
}

const TONE_WORD: Record<ToastTone, string> = {
  success: 'Done',
  error: 'Problem',
  info: 'Note'
}

function ToastItem({
  toast,
  controller
}: {
  toast: Toast
  controller: Omit<ToastsController, 'toasts' | 'push'>
}): React.JSX.Element {
  const { dismiss, pause, resume } = controller
  const run = (fn: () => void): void => {
    fn()
    dismiss(toast.id)
  }
  return (
    <div
      className={`toast toast--${toast.tone}${toast.leaving ? ' toast--leaving' : ''}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => pause(toast.id)}
      onMouseLeave={() => resume(toast.id)}
      onFocus={() => pause(toast.id)}
      onBlur={() => resume(toast.id)}
    >
      <ToneGlyph tone={toast.tone} />
      {/* Colour is never the only signal: screen readers get the word. */}
      <span className="sr-only">{TONE_WORD[toast.tone]}: </span>
      <div className="toast-body">
        {toast.title && <span className="toast-title">{toast.title}</span>}
        <span className="toast-text">
          <span className="toast-message">{toast.message}</span>
          {toast.count > 1 && (
            <span className="toast-count" aria-label={`${toast.count} times`}>
              {toast.count}
            </span>
          )}
        </span>
        {(toast.action || toast.secondary) && (
          <div className="toast-actions">
            {toast.action && (
              <button
                type="button"
                className="toast-action toast-action--primary"
                onClick={() => run(toast.action!.onClick)}
              >
                {toast.action.label}
              </button>
            )}
            {toast.secondary && (
              <button
                type="button"
                className="toast-action toast-action--quiet"
                onClick={() => run(toast.secondary!.onClick)}
              >
                {toast.secondary.label}
              </button>
            )}
          </div>
        )}
      </div>
      <IconButton
        icon="X"
        label="Dismiss"
        size={28}
        variant="ghost"
        className="toast-dismiss"
        onClick={() => dismiss(toast.id)}
      />
      {toast.lifetime !== null && (
        <span
          key={toast.round}
          className="toast-timer"
          style={{ animationDuration: `${toast.lifetime}ms` }}
          aria-hidden
        />
      )}
    </div>
  )
}

/** Bottom-right stack, newest nearest the corner. */
export default function ToastStack({
  controller
}: {
  controller: ToastsController
}): React.JSX.Element {
  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {controller.toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} controller={controller} />
      ))}
    </div>
  )
}
