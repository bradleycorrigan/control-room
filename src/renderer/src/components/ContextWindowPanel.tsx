import type { ContextWindowUsage } from '../../../main/exec/transcripts'
import { Modal } from './primitives'
import './context-window-panel.css'

export interface ContextWindowPanelProps {
  usage: ContextWindowUsage | null
  onClose: () => void
}

interface Props extends ContextWindowPanelProps {}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return String(tokens)
}

export default function ContextWindowPanel({ usage, onClose }: Props): React.JSX.Element {
  if (!usage) {
    return (
      <Modal title="Token usage" icon="Database" width={560} onClose={onClose}>
        <p className="context-window-empty">No usage data available yet.</p>
      </Modal>
    )
  }

  return (
    <Modal title="Token usage" icon="Database" width={560} onClose={onClose}>
      <div className="context-window-content">
        <div className="context-window-tokens">
          <div className="context-window-token-box">
            <div className="context-window-token-label">Input</div>
            <div className="context-window-token-value">
              {/* Fresh input only. Adding cache reads in made this read 251.9M on a
                  session whose real input was 1.6k — cache reads are a property of
                  how the turn was served, not of how much you sent. They stay in
                  the breakdown below, where they are labelled. */}
              {formatTokenCount(usage.cumulativeInputFresh)}
            </div>
          </div>
          <div className="context-window-token-box">
            <div className="context-window-token-label">Output</div>
            <div className="context-window-token-value">
              {formatTokenCount(usage.cumulativeOutput)}
            </div>
          </div>
        </div>

        {/* No cost, and no cache-read line. Cost was an estimate against a
            hand-maintained price table, which is the wrong thing to show on
            team pricing. Cache reads are a property of how a turn was served
            rather than of the work done, and they run to millions of tokens on
            an ordinary session, which reads as a fault rather than a fact.
            Input and output are what the session actually sent and got back. */}
        <div className="context-window-info">
          <div className="context-window-info-row">
            <span className="context-window-info-label">Model</span>
            <span className="context-window-info-value">{usage.model || 'Unknown'}</span>
          </div>
        </div>
      </div>
    </Modal>
  )
}
