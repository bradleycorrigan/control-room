import { openExternal } from '../api'
import './pr-chip.css'

export type PrChipState = 'OPEN' | 'MERGED' | 'CLOSED' | null

const PR_WORDS: Record<'OPEN' | 'MERGED' | 'CLOSED', string> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed'
}

export interface PrChipProps {
  pr: { number: number; url: string; state: PrChipState }
  /** Shown before the number when the PR is in a repo other than the session's own. */
  repo?: string
  /** 20 to sit beside the session header's ticket pill; 22 in lists. */
  size?: 20 | 22
}

/** Dot, number and state. A button, so it opens the PR without opening the row. */
export default function PrChip({ pr, repo, size = 22 }: PrChipProps): React.JSX.Element {
  const state = pr.state ? pr.state.toLowerCase() : 'unknown'
  const name = repo ? `${repo} #${pr.number}` : `#${pr.number}`
  return (
    <button
      type="button"
      className={`cr-pr-chip cr-pr-chip--${state}${size === 20 ? ' cr-pr-chip--20' : ''}`}
      title={`Open pull request ${name} on GitHub`}
      onClick={(e) => {
        e.stopPropagation()
        void openExternal(pr.url)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="cr-pr-chip-dot" aria-hidden="true" />
      {repo && <span className="cr-pr-chip-repo">{repo}</span>}
      PR #{pr.number}
      {pr.state && ` ${PR_WORDS[pr.state]}`}
    </button>
  )
}
