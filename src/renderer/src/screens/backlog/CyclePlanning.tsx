import { useState } from 'react'
import { Button } from '../../components/primitives'
import type { BacklogPrefs, JiraIssue, JiraSprint } from '../../api'
import { Avatar } from '../backlogGlyphs'
import { formatDays, hoursToDays, parseEstimateHours, workingDays } from './cyclePlan'

// Planning is a mode of the Tickets list, not a screen of its own: the list
// groups by cycle, and these sit under each cycle's group title. Tickets
// open, filter, show their epic and drag between groups as they do anywhere
// else in Tickets.

type Cycle = Pick<JiraSprint, 'id' | 'name' | 'state' | 'startDate' | 'endDate' | 'goal'>

const DAY_MS = 24 * 60 * 60 * 1000

/** yyyy-mm-dd, for a date input. */
const dateInput = (d: Date): string => d.toISOString().slice(0, 10)

/** A cycle's dates, short: "15 Sep – 29 Sep". */
function cycleDates(c: Pick<JiraSprint, 'startDate' | 'endDate'>): string | null {
  if (!c.startDate || !c.endDate) return null
  const f = (s: string): string =>
    new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${f(c.startDate)} – ${f(c.endDate)}`
}

const totalDays = (issues: JiraIssue[]): number =>
  hoursToDays(issues.reduce((sum, i) => sum + parseEstimateHours(i.estimate), 0))

/** "12 tickets · 9d estimated · 3 without an estimate" */
function Facts({
  issues,
  onNoEstimate
}: {
  issues: JiraIssue[]
  onNoEstimate?: () => void
}): React.JSX.Element {
  const missing = issues.filter((i) => !i.estimate).length
  return (
    <>
      <span>
        {issues.length} {issues.length === 1 ? 'ticket' : 'tickets'}
      </span>
      <span>{formatDays(totalDays(issues))} estimated</span>
      {missing > 0 &&
        (onNoEstimate ? (
          <button type="button" className="cycle-strip-link" onClick={onNoEstimate}>
            {missing} without an estimate
          </button>
        ) : (
          <span>{missing} without an estimate</span>
        ))}
    </>
  )
}

/** Under a cycle or Backlog group's title while planning. */
export function CycleStrip({
  kind,
  cycle,
  next,
  items,
  carrying,
  hidden,
  now,
  prefs,
  onSavePrefs,
  onNoEstimate,
  onSetGoal,
  onComplete
}: {
  /** next: the cycle being planned (the current one, or one coming up); current: the active one when it isn't. */
  kind: 'current' | 'next' | 'other' | 'backlog'
  cycle: Cycle | null
  /** The cycle being planned, for the current cycle's carry-over line. */
  next: Cycle | null
  items: JiraIssue[]
  /** The current cycle's unfinished tickets: Jira moves them to the next one. */
  carrying: JiraIssue[]
  /** How many of this cycle's tickets the filters keep off screen. */
  hidden: number
  now: number
  prefs: BacklogPrefs
  onSavePrefs: (patch: Partial<BacklogPrefs>) => void
  onNoEstimate: () => void
  onSetGoal: (sprintId: number, goal: string) => Promise<boolean>
  /** The active cycle only: completes it in Jira, after a review. */
  onComplete?: () => void
}): React.JSX.Element {
  const [goalDraft, setGoalDraft] = useState<string | null>(null)
  const [capacityDraft, setCapacityDraft] = useState<Record<string, string>>({})
  // Saved on Enter or on leaving the field, whichever comes first, once.
  const saveGoal = (): void => {
    if (goalDraft === null || !cycle) return
    if (goalDraft.trim() !== (cycle.goal ?? '')) void onSetGoal(cycle.id, goalDraft)
    setGoalDraft(null)
  }
  const dates = cycle ? cycleDates(cycle) : null
  const daysLeft =
    cycle?.state === 'active' && cycle?.endDate
      ? Math.max(0, Math.ceil((new Date(cycle.endDate).getTime() - now) / DAY_MS))
      : null

  if (kind !== 'next' || !cycle) {
    const unfinished = items.filter((i) => i.statusCategory !== 'done').length
    return (
      <div className="cycle-strip" data-cycle-strip={kind}>
        <div className="cycle-strip-facts">
          {dates && <span>{dates}</span>}
          {daysLeft !== null && <span>{daysLeft} days left</span>}
          <Facts issues={items} onNoEstimate={onNoEstimate} />
          {hidden > 0 && <span>{hidden} hidden by filters</span>}
          {onComplete && (
            <button type="button" className="cycle-strip-link" onClick={onComplete}>
              Complete cycle…
            </button>
          )}
        </div>
        {kind === 'current' && next && unfinished > 0 && (
          <p className="cycle-strip-note">
            {unfinished} unfinished {unfinished === 1 ? 'ticket carries' : 'tickets carry'} over to{' '}
            {next.name} when you complete {cycle?.name} in Jira.
          </p>
        )}
      </div>
    )
  }

  // The cycle being planned: its own tickets plus what carries over, per person.
  const planned = [...items, ...carrying]
  // Planning the current cycle: what's left of it is what anyone has.
  const defaultDays =
    cycle.state === 'active'
      ? workingDays(new Date(now).toISOString(), cycle.endDate)
      : workingDays(cycle.startDate, cycle.endDate)
  const capacity = prefs.capacity[String(cycle.id)] ?? {}
  const load = new Map<string, { own: JiraIssue[]; carry: JiraIssue[] }>()
  for (const [list, part] of [
    [items, 'own'],
    [carrying, 'carry']
  ] as const) {
    for (const issue of list) {
      const person = issue.assignee ?? 'Unassigned'
      const entry = load.get(person) ?? { own: [], carry: [] }
      entry[part].push(issue)
      load.set(person, entry)
    }
  }
  const people = [...load.keys()].sort((a, b) => a.localeCompare(b))

  return (
    <div className="cycle-strip" data-cycle-strip="next">
      <div className="cycle-strip-facts">
        {dates && <span>{dates}</span>}
        {daysLeft !== null && <span>{daysLeft} days left</span>}
        <Facts issues={planned} onNoEstimate={onNoEstimate} />
        {carrying.length > 0 && <span>incl. {carrying.length} carrying over</span>}
        {hidden > 0 && <span>{hidden} hidden by filters</span>}
        {onComplete && (
          <button type="button" className="cycle-strip-link" onClick={onComplete}>
            Complete cycle…
          </button>
        )}
        {!cycle.goal && goalDraft === null && (
          <button type="button" className="cycle-strip-link" onClick={() => setGoalDraft('')}>
            Add goal
          </button>
        )}
      </div>
      {/* Goals are optional and rarely used: a quiet line when set, a field
          only while editing. */}
      {goalDraft !== null ? (
        <input
          aria-label={`Goal for ${cycle.name}`}
          className="cycle-strip-goal-input"
          placeholder="Cycle goal"
          autoFocus
          value={goalDraft}
          onChange={(e) => setGoalDraft(e.target.value)}
          onBlur={saveGoal}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              saveGoal()
            }
            if (e.key === 'Escape') {
              e.stopPropagation()
              setGoalDraft(null)
            }
          }}
        />
      ) : (
        cycle.goal && (
          <button
            type="button"
            className="cycle-strip-goal"
            title="Edit goal"
            onClick={() => setGoalDraft(cycle.goal ?? '')}
          >
            {cycle.goal}
          </button>
        )
      )}
      {people.length > 0 && (
        <div className="cycle-strip-load">
          {people.map((person) => {
            const entry = load.get(person)!
            const own = totalDays(entry.own)
            const used = own + totalDays(entry.carry)
            const days = capacity[person] ?? defaultDays
            const over = days > 0 && used > days
            const pct = (d: number): number =>
              days > 0 ? Math.round(Math.min(1, d / days) * 100) : 0
            const draft = capacityDraft[person]
            return (
              <div className="cycle-plan-capacity-row" data-capacity-person={person} key={person}>
                <Avatar name={person === 'Unassigned' ? null : person} size={16} />
                <span className="cycle-plan-capacity-name">{person}</span>
                <span
                  className="cycle-plan-capacity-bar"
                  role="progressbar"
                  aria-valuenow={pct(used)}
                  aria-label={`${person} capacity`}
                >
                  <span
                    className={over ? 'cycle-plan-capacity-fill--over' : 'cycle-plan-capacity-fill'}
                    style={{ width: `${pct(own)}%` }}
                  />
                  <span
                    className="cycle-plan-capacity-fill--carry"
                    style={{ width: `${Math.max(0, pct(used) - pct(own))}%` }}
                  />
                </span>
                <span className="cycle-plan-capacity-numbers">
                  {formatDays(used)} of{' '}
                  <input
                    aria-label={`${person}'s capacity, in days`}
                    type="number"
                    min={0}
                    step={0.5}
                    className="cycle-plan-capacity-input"
                    value={draft ?? String(days)}
                    onChange={(e) => setCapacityDraft((d) => ({ ...d, [person]: e.target.value }))}
                    onBlur={() => {
                      const value = Number(draft)
                      if (draft !== undefined && draft !== '' && value >= 0) {
                        onSavePrefs({
                          capacity: {
                            ...prefs.capacity,
                            [String(cycle.id)]: { ...capacity, [person]: value }
                          }
                        })
                      }
                      setCapacityDraft((d) => {
                        const rest = { ...d }
                        delete rest[person]
                        return rest
                      })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }}
                  />
                  d
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The bar across the top of Tickets while planning: which cycle, a way to
 * create one when Jira has none coming up, and a way back to your view.
 */
export function PlanningBar({
  next,
  current,
  boardId,
  cycles,
  onPick,
  onCreate,
  onDone
}: {
  next: Cycle | null
  current: Cycle | null
  boardId: number | null
  /** Every open cycle: any of them can be planned. */
  cycles: Cycle[]
  onPick: (sprintId: number) => void
  onCreate: (input: {
    boardId: number
    name: string
    startDate: string
    endDate: string
  }) => Promise<boolean>
  onDone: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // A new cycle starts when the current one ends and runs as long.
  const [defaults] = useState(() => {
    const start = current?.endDate ? new Date(current.endDate) : new Date()
    const length =
      current?.startDate && current?.endDate
        ? new Date(current.endDate).getTime() - new Date(current.startDate).getTime()
        : 14 * DAY_MS
    return { start: dateInput(start), end: dateInput(new Date(start.getTime() + length)) }
  })
  const [draft, setDraft] = useState({ name: '', start: '', end: '' })

  return (
    <div className="planning-bar" role="region" aria-label="Planning">
      <span className="planning-bar-title">
        Planning
        {next ? (
          <select
            aria-label="Cycle to plan"
            className="planning-bar-pick"
            value={String(next.id)}
            onChange={(e) => onPick(Number(e.target.value))}
          >
            {cycles.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
                {c.state === 'active' ? ' (current)' : ''}
              </option>
            ))}
          </select>
        ) : (
          ' the next cycle'
        )}
      </span>
      <span className="planning-bar-hint">
        Drag tickets between cycles, or onto a cycle in the sidebar.
      </span>
      {!next && boardId !== null && !open && (
        <Button variant="outlined" size="compact" onClick={() => setOpen(true)}>
          Create cycle
        </Button>
      )}
      {open && boardId !== null && (
        <form
          className="planning-bar-create"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            void onCreate({
              boardId,
              name: draft.name.trim(),
              startDate: new Date(draft.start || defaults.start).toISOString(),
              endDate: new Date(draft.end || defaults.end).toISOString()
            }).then((ok) => {
              setBusy(false)
              if (ok) setOpen(false)
            })
          }}
        >
          <input
            aria-label="Cycle name"
            autoFocus
            placeholder="Name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            aria-label="Starts"
            type="date"
            value={draft.start || defaults.start}
            onChange={(e) => setDraft({ ...draft, start: e.target.value })}
          />
          <input
            aria-label="Ends"
            type="date"
            value={draft.end || defaults.end}
            onChange={(e) => setDraft({ ...draft, end: e.target.value })}
          />
          <Button
            type="submit"
            variant="filled"
            size="compact"
            disabled={busy || !draft.name.trim()}
          >
            {busy ? 'Creating…' : 'Create in Jira'}
          </Button>
          <Button variant="ghost" size="compact" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </form>
      )}
      <Button variant="ghost" size="compact" onClick={onDone}>
        Done planning
      </Button>
    </div>
  )
}
