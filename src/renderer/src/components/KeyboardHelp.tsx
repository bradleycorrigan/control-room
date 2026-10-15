import { KEYBOARD_MAP } from '../keyboard'
import { Modal } from './primitives'

interface Props {
  onClose: () => void
}

// Backlog shortcuts, on the focused ticket row or the ticket open in the
// panel. They live here rather than in keyboard.ts, which is a shared,
// screen-agnostic map.
const BACKLOG_SHORTCUTS = [
  { id: 'backlog-open-session', combo: 'O', description: 'Open its session, or start one' }
]

// Reopen closed tab lives in App.tsx, not keyboard.ts, so it isn't a fixed
// entry in the shared map. ⌘⇧T has one meaning app-wide: it does nothing
// when there's no closed tab to bring back.
const SESSION_TAB_SHORTCUTS = [
  { id: 'reopen-closed-tab', combo: '⌘⇧T', description: 'Reopen closed tab' }
]

export default function KeyboardHelp({ onClose }: Props): React.JSX.Element {
  return (
    <Modal title="Keyboard shortcuts" icon="Keyboard" width={420} onClose={onClose}>
      <div className="keyboard-help-list">
        {KEYBOARD_MAP.map((entry) => (
          <div key={entry.id} className="keyboard-help-row">
            <span className="keyboard-help-combo">{entry.combo}</span>
            <span className="keyboard-help-description">{entry.description}</span>
          </div>
        ))}
        {SESSION_TAB_SHORTCUTS.map((entry) => (
          <div key={entry.id} className="keyboard-help-row">
            <span className="keyboard-help-combo">{entry.combo}</span>
            <span className="keyboard-help-description">{entry.description}</span>
          </div>
        ))}
        {BACKLOG_SHORTCUTS.map((entry) => (
          <div key={entry.id} className="keyboard-help-row">
            <span className="keyboard-help-combo">{entry.combo}</span>
            <span className="keyboard-help-description">{entry.description}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
