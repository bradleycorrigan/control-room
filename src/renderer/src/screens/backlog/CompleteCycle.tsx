import { useState } from 'react'
import { Button, Modal } from '../../components/primitives'
import type { JiraIssue, JiraSprint } from '../../api'
import { Avatar, StatusGlyph } from '../backlogGlyphs'
import { formatDays, hoursToDays, parseEstimateHours } from './cyclePlan'

type Cycle = Pick<JiraSprint, 'id' | 'name' | 'state' | 'startDate' | 'endDate'>

const BACKLOG = 'backlog'

/**
 * Completing a cycle, as Jira's Complete dialog does it, plus a review: every
 * unfinished ticket with where it goes (the next cycle unless you say
 * otherwise), what that does to the next cycle, then one button. Starting
 * the next cycle is offered, never assumed.
 */
export function CompleteCycle({
  cycle,
  unfinished,
  done,
  targets,
  nextLoad,
  onComplete,
  onClose
}: {
  cycle: Cycle
  unfinished: JiraIssue[]
  done: number
  /** Cycles the unfinished tickets can go to: the upcoming ones, soonest first. */
  targets: Cycle[]
  /** Days already estimated in each target cycle, for the preview. */
  nextLoad: Record<number, number>
  onComplete: (
    moves: { key: string; to: number | null }[],
    start: Cycle | null
  ) => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const first = targets[0] ?? null
  const [dest, setDest] = useState<Record<string, string>>(() =>
    Object.fromEntries(unfinished.map((i) => [i.key, first ? String(first.id) : BACKLOG]))
  )
  const [startNext, setStartNext] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameOf = (v: string): string =>
    v === BACKLOG ? 'the backlog' : (targets.find((t) => String(t.id) === v)?.name ?? v)
  const counts = new Map<string, JiraIssue[]>()
  for (const i of unfinished) counts.set(dest[i.key], [...(counts.get(dest[i.key]) ?? []), i])
  const days = (issues: JiraIssue[]): number =>
    hoursToDays(issues.reduce((sum, i) => sum + parseEstimateHours(i.estimate), 0))

  const options = (
    <>
      {targets.map((t) => (
        <option key={t.id} value={String(t.id)}>
          {t.name}
        </option>
      ))}
      <option value={BACKLOG}>Backlog</option>
    </>
  )

  return (
    <Modal title={`Complete ${cycle.name}`} icon="CircleCheck" width={720} onClose={onClose}>
      <div className="complete-cycle">
        <p className="complete-cycle-summary">
          {done} done, {unfinished.length} unfinished.{' '}
          {unfinished.length > 0
            ? 'Choose where each unfinished ticket goes; then the cycle closes in Jira.'
            : 'Nothing to move; the cycle closes in Jira.'}
        </p>

        {unfinished.length > 1 && (
          <label className="complete-cycle-all">
            Move all to
            <select
              aria-label="Move all unfinished tickets to"
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (v) setDest(Object.fromEntries(unfinished.map((i) => [i.key, v])))
              }}
            >
              <option value="">Choose…</option>
              {options}
            </select>
          </label>
        )}

        <div className="complete-cycle-list">
          {unfinished.map((i) => (
            <div key={i.key} className="complete-cycle-row" data-issue={i.key}>
              <StatusGlyph name={i.status} category={i.statusCategory} size={12} />
              <span className="complete-cycle-key">{i.key}</span>
              <span className="complete-cycle-title" title={i.summary}>
                {i.summary}
              </span>
              <span className="complete-cycle-estimate">{i.estimate ?? '–'}</span>
              <Avatar name={i.assignee} size={16} />
              <select
                aria-label={`Where ${i.key} goes`}
                value={dest[i.key]}
                onChange={(e) => setDest((d) => ({ ...d, [i.key]: e.target.value }))}
              >
                {options}
              </select>
            </div>
          ))}
        </div>

        {unfinished.length > 0 && (
          <ul className="complete-cycle-preview" aria-label="What happens">
            {[...counts].map(([v, issues]) => (
              <li key={v}>
                {issues.length} to {nameOf(v)}
                {v !== BACKLOG &&
                  ` · ${formatDays((nextLoad[Number(v)] ?? 0) + days(issues))} estimated there after`}
              </li>
            ))}
          </ul>
        )}

        {first && (
          <label className="complete-cycle-start">
            <input
              type="checkbox"
              checked={startNext}
              onChange={(e) => setStartNext(e.target.checked)}
            />
            Start {first.name} now
          </label>
        )}

        {error && (
          <p className="complete-cycle-error" role="alert">
            {error}
          </p>
        )}

        <div className="complete-cycle-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="filled"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setError(null)
              void onComplete(
                unfinished.map((i) => ({
                  key: i.key,
                  to: dest[i.key] === BACKLOG ? null : Number(dest[i.key])
                })),
                startNext ? first : null
              ).then((err) => {
                setBusy(false)
                if (err) setError(err)
              })
            }}
          >
            {busy ? 'Completing…' : `Complete ${cycle.name} in Jira`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
