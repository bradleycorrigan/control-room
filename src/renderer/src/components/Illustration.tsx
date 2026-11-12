import './illustration.css'

export type IllustrationName = 'all-clear' | 'no-match' | 'first-session'

/**
 * Small flat drawings for empty screens, made for them rather than a stock
 * icon at 40px. Every colour is a theme token (illustration.css), so each
 * one reads in all the themes. Decorative: the words beside it say it all.
 */
export default function Illustration({
  name,
  className
}: {
  name: IllustrationName
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className ? `cr-ill ${className}` : 'cr-ill'}
      viewBox="0 0 160 112"
      width={160}
      height={112}
      aria-hidden="true"
      data-illustration={name}
    >
      {name === 'all-clear' && <AllClear />}
      {name === 'no-match' && <NoMatch />}
      {name === 'first-session' && <FirstSession />}
    </svg>
  )
}

/** Nothing waiting on you: a mug, still warm. */
function AllClear(): React.JSX.Element {
  return (
    <>
      <ellipse className="cr-ill-shadow" cx="80" cy="96" rx="46" ry="7" />
      <ellipse className="cr-ill-fill cr-ill-line" cx="80" cy="90" rx="40" ry="8" />
      <path
        className="cr-ill-fill cr-ill-line"
        d="M56 48 h48 v30 a14 14 0 0 1 -14 14 h-20 a14 14 0 0 1 -14 -14 z"
      />
      <path className="cr-ill-accent" d="M56 58 h48 v8 h-48 z" />
      <path className="cr-ill-line" d="M104 56 h6 a10 10 0 0 1 0 20 h-7" fill="none" />
      <path className="cr-ill-faint" d="M70 40 c-4 -6 4 -10 0 -18" fill="none" />
      <path className="cr-ill-faint" d="M80 38 c-4 -6 4 -10 0 -20" fill="none" />
      <path className="cr-ill-faint" d="M90 40 c-4 -6 4 -10 0 -18" fill="none" />
    </>
  )
}

/** A filter that matches nothing: a magnifier over a blank card. */
function NoMatch(): React.JSX.Element {
  return (
    <>
      <ellipse className="cr-ill-shadow" cx="76" cy="98" rx="50" ry="6" />
      <rect className="cr-ill-fill cr-ill-line" x="30" y="22" width="88" height="66" rx="8" />
      <rect className="cr-ill-faint-fill" x="42" y="36" width="44" height="5" rx="2.5" />
      <rect className="cr-ill-faint-fill" x="42" y="48" width="60" height="5" rx="2.5" />
      <rect className="cr-ill-faint-fill" x="42" y="60" width="34" height="5" rx="2.5" />
      <circle className="cr-ill-glass cr-ill-accent-line" cx="108" cy="64" r="16" />
      <path className="cr-ill-accent-line" d="M120 76 l14 14" fill="none" />
    </>
  )
}

/** Before the first session: a terminal, a prompt, a cursor waiting. */
function FirstSession(): React.JSX.Element {
  return (
    <>
      <ellipse className="cr-ill-shadow" cx="80" cy="100" rx="56" ry="6" />
      <rect className="cr-ill-fill cr-ill-line" x="24" y="16" width="112" height="78" rx="9" />
      <path className="cr-ill-line" d="M24 32 h112" fill="none" />
      <circle className="cr-ill-faint-fill" cx="35" cy="24" r="3" />
      <circle className="cr-ill-faint-fill" cx="45" cy="24" r="3" />
      <circle className="cr-ill-faint-fill" cx="55" cy="24" r="3" />
      <path className="cr-ill-line" d="M38 50 l8 6 l-8 6" fill="none" />
      <rect className="cr-ill-faint-fill" x="54" y="53" width="34" height="5" rx="2.5" />
      <rect className="cr-ill-accent cr-ill-cursor" x="92" y="50" width="7" height="12" rx="1.5" />
      <rect className="cr-ill-faint-fill" x="38" y="72" width="58" height="5" rx="2.5" />
    </>
  )
}
