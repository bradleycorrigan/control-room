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
  /** Replaces opening GitHub: the session header opens the PR's panel instead. */
  onOpen?: () => void
}

/**
 * A session's pull requests where there's room for one: the first (an open one
 * if there is one) as a chip, then "+N" for the rest, named in its tooltip.
 */
export function PrChips({
  prs,
  size = 22
}: {
  prs: PrChipProps['pr'][]
  size?: 20 | 22
}): React.JSX.Element | null {
  if (prs.length === 0) return null
  const first = prs.find((p) => p.state === 'OPEN') ?? prs[0]
  const rest = prs.filter((p) => p !== first)
  return (
    <>
      <PrChip pr={first} size={size} />
      {rest.length > 0 && (
        <span
          className={`cr-pr-chip-more${size === 20 ? ' cr-pr-chip-more--20' : ''}`}
          title={rest
            .map((p) => `PR #${p.number}${p.state ? ` ${PR_WORDS[p.state]}` : ''}`)
            .join('\n')}
        >
          +{rest.length}
        </span>
      )}
    </>
  )
}

/** Dot, number and state. A button, so it opens the PR without opening the row. */
export default function PrChip({ pr, repo, size = 22, onOpen }: PrChipProps): React.JSX.Element {
  const state = pr.state ? pr.state.toLowerCase() : 'unknown'
  const name = repo ? `${repo} #${pr.number}` : `#${pr.number}`
  return (
    <button
      type="button"
      className={`cr-pr-chip cr-pr-chip--${state}${size === 20 ? ' cr-pr-chip--20' : ''}`}
      title={onOpen ? `Pull request ${name}` : `Open pull request ${name} on GitHub`}
      onClick={(e) => {
        e.stopPropagation()
        if (onOpen) onOpen()
        else void openExternal(pr.url)
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
