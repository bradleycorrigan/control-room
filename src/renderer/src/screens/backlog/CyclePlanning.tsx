import { useMemo, useState } from 'react'
import { Button, Icon, IconButton } from '../../components/primitives'
import type { BacklogPrefs, JiraIssue, JiraSprint } from '../../api'
import { useDismissible } from '../../keyboard'
import { Avatar, PriorityGlyph, StatusGlyph } from '../backlogGlyphs'
import { DRAG_TYPE } from '../backlogStatus'
import { formatDays, hoursToDays, parseEstimateHours, workingDays } from './cyclePlan'

type CycleLike = Pick<JiraSprint, 'id' | 'name' | 'state' | 'startDate' | 'endDate'> &
  Pick<JiraSprint, 'goal' | 'boardId'>
type Side = 'backlog' | 'current' | 'next'

const DAY_MS = 24 * 60 * 60 * 1000

/** yyyy-mm-dd, for a date input. */
const dateInput = (d: Date): string => d.toISOString().slice(0, 10)

/** A cycle's dates, short: "15 Sep – 29 Sep". */
function cycleDates(c: CycleLike): string | null {
  if (!c.startDate || !c.endDate) return null
  const f = (s: string): string =>
    new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${f(c.startDate)} – ${f(c.endDate)}`
}

/** What stops a ticket being ready for a cycle. */
function notReady(issue: JiraIssue): string[] {
  const reasons: string[] = []
  if (!issue.estimate) reasons.push('No estimate')
  if (!issue.assignee) reasons.push('Unassigned')
  if (issue.blockedBy.some((b) => b.statusCategory !== 'done')) reasons.push('Blocked')
  return reasons
}

/**
 * Plan the next cycle: the backlog, the current cycle and the next one side by
 * side. Every move is the same sprint write the rest of Tickets uses, so Jira
 * has it straight away. Creating the next cycle and setting its goal also go
 * to Jira; starting and completing cycles stay in Jira, which handles the
 * unfinished tickets and reports when a cycle closes.
 */
export function CyclePlanning({
  current,
  next,
  sprints,
  allTickets,
  prefs,
  onSavePrefs,
  onMove,
  onEstimate,
  onCreateNext,
  onSetGoal,
  onClose
}: {
  /** The active cycle, if there is one. */
  current: CycleLike | null
  /** The cycle being planned; null when Jira has no future cycle yet. */
  next: CycleLike | null
  /** Every open cycle, for each row's "move to" picker. */
  sprints: CycleLike[]
  allTickets: JiraIssue[]
  prefs: BacklogPrefs
  onSavePrefs: (patch: Partial<BacklogPrefs>) => void
  /** Into a cycle by id, or (null) out to the backlog — the existing sprint write. */
  onMove: (issue: JiraIssue, sprintId: number | null) => void
  onEstimate: (issue: JiraIssue, estimate: string | null) => void
  onCreateNext: (input: {
    boardId: number
    name: string
    startDate: string
    endDate: string
    goal?: string
  }) => Promise<boolean>
  onSetGoal: (sprintId: number, goal: string) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  useDismissible(true, 'overlay', () => {
    const active = document.activeElement as HTMLElement | null
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      active.blur()
      return true
    }
    onClose()
    return true
  })

  // When planning opened: "days left" counts from here, not from each render.
  const [openedAt] = useState(() => Date.now())
  const [overSide, setOverSide] = useState<Side | null>(null)
  const [noEstimateOnly, setNoEstimateOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [capacityDraft, setCapacityDraft] = useState<Record<string, string>>({})
  const [estimateDraft, setEstimateDraft] = useState<Record<string, string>>({})
  const [goalDraft, setGoalDraft] = useState<string | null>(null)

  // A new cycle starts when the current one ends and runs as long.
  const defaults = useMemo(() => {
    const start = current?.endDate ? new Date(current.endDate) : new Date()
    const length =
      current?.startDate && current?.endDate
        ? new Date(current.endDate).getTime() - new Date(current.startDate).getTime()
        : 14 * DAY_MS
    return { start: dateInput(start), end: dateInput(new Date(start.getTime() + length)) }
  }, [current])
  const [draft, setDraft] = useState({ name: '', start: '', end: '', goal: '' })
  const [creating, setCreating] = useState(false)
  const boardId = current?.boardId ?? sprints.find((s) => s.boardId)?.boardId ?? null

  const topLevel = useMemo(() => allTickets.filter((i) => !i.isSubtask), [allTickets])
  const byKey = useMemo(() => new Map(allTickets.map((i) => [i.key, i])), [allTickets])
  const q = query.trim().toLowerCase()
  const shown = (i: JiraIssue): boolean =>
    (!noEstimateOnly || !i.estimate) &&
    (!q || i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q))

  const backlog = topLevel.filter((i) => !i.sprint && i.statusCategory !== 'done')
  const inCurrent = current ? topLevel.filter((i) => i.sprint?.id === current.id) : []
  const unfinished = inCurrent.filter((i) => i.statusCategory !== 'done')
  const finished = inCurrent.filter((i) => i.statusCategory === 'done')
  const inNext = next ? topLevel.filter((i) => i.sprint?.id === next.id) : []

  // Capacity is for the cycle being planned.
  const defaultDays = next ? workingDays(next.startDate, next.endDate) : 0
  const capacity = next ? (prefs.capacity[String(next.id)] ?? {}) : {}
  const byPerson = new Map<string, JiraIssue[]>()
  for (const issue of inNext) {
    const person = issue.assignee ?? 'Unassigned'
    byPerson.set(person, [...(byPerson.get(person) ?? []), issue])
  }
  const people = [...byPerson.keys()].sort((a, b) => a.localeCompare(b))
  const unestimated = inNext.filter((i) => !i.estimate).length
  const unassigned = inNext.filter((i) => !i.assignee).length
  const blocked = inNext.filter((i) => notReady(i).includes('Blocked')).length

  const sideCycle = (side: Side): number | null =>
    side === 'current' ? (current?.id ?? null) : side === 'next' ? (next?.id ?? null) : null

  const dropOn =
    (side: Side) =>
    (e: React.DragEvent): void => {
      e.preventDefault()
      setOverSide(null)
      const issue = byKey.get(e.dataTransfer.getData(DRAG_TYPE))
      if (issue) onMove(issue, sideCycle(side))
    }
  const dragOver =
    (side: Side) =>
    (e: React.DragEvent): void => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      if (overSide !== side) setOverSide(side)
    }

  const saveEstimate = (issue: JiraIssue): void => {
    const value = estimateDraft[issue.key]?.trim()
    setEstimateDraft((d) => {
      const rest = { ...d }
      delete rest[issue.key]
      return rest
    })
    if (value === undefined || value === (issue.estimate ?? '')) return
    onEstimate(issue, value || null)
  }

  const row = (issue: JiraIssue, side: Side): React.JSX.Element => {
    const flags = side === 'backlog' ? [] : notReady(issue).filter((f) => f !== 'No estimate')
    return (
      <div
        key={issue.key}
        className="cycle-plan-row"
        data-issue={issue.key}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, issue.key)
          e.dataTransfer.effectAllowed = 'move'
        }}
      >
        <div className="cycle-plan-row-main">
          <span className="cycle-plan-row-summary" title={issue.summary}>
            {issue.summary}
          </span>
          <div className="cycle-plan-row-meta">
            <StatusGlyph name={issue.status} category={issue.statusCategory} size={10} />
            <span className="cycle-plan-row-key">{issue.key}</span>
            {issue.priority && <PriorityGlyph priority={issue.priority} />}
            <input
              aria-label={`Estimate for ${issue.key}`}
              className={
                issue.estimate
                  ? 'cycle-plan-row-estimate'
                  : 'cycle-plan-row-estimate cycle-plan-row-estimate--missing'
              }
              placeholder="Estimate"
              value={estimateDraft[issue.key] ?? issue.estimate ?? ''}
              onChange={(e) => setEstimateDraft((d) => ({ ...d, [issue.key]: e.target.value }))}
              onBlur={() => saveEstimate(issue)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <Avatar name={issue.assignee} size={18} />
            {flags.map((f) => (
              <span key={f} className="cycle-plan-flag">
                {f}
              </span>
            ))}
            <select
              aria-label={`Cycle for ${issue.key}`}
              className="cycle-plan-row-cycle"
              value={issue.sprint ? String(issue.sprint.id) : '__backlog'}
              onChange={(e) => {
                const value = e.target.value
                onMove(issue, value === '__backlog' ? null : Number(value))
              }}
            >
              {sprints.map((sp) => (
                <option key={sp.id} value={String(sp.id)}>
                  {sp.name}
                </option>
              ))}
              <option value="__backlog">Backlog</option>
            </select>
          </div>
        </div>
      </div>
    )
  }

  const column = (
    side: Side,
    header: React.ReactNode,
    body: React.ReactNode,
    extra?: React.ReactNode
  ): React.JSX.Element => (
    <section
      className={`cycle-plan-column${overSide === side ? ' cycle-plan-column--over' : ''}`}
      data-cycle-plan-column={side}
      onDragOver={sideCycle(side) !== null || side === 'backlog' ? dragOver(side) : undefined}
      onDragLeave={() => setOverSide(null)}
      onDrop={dropOn(side)}
    >
      <div className="cycle-plan-column-header">{header}</div>
      {extra}
      <div className="cycle-plan-column-list">{body}</div>
    </section>
  )

  const daysLeft = current?.endDate
    ? Math.max(0, Math.ceil((new Date(current.endDate).getTime() - openedAt) / DAY_MS))
    : null

  const create = async (): Promise<void> => {
    if (boardId === null) return
    setCreating(true)
    const ok = await onCreateNext({
      boardId,
      name: draft.name.trim(),
      startDate: new Date(draft.start || defaults.start).toISOString(),
      endDate: new Date(draft.end || defaults.end).toISOString(),
      goal: draft.goal
    })
    setCreating(false)
    if (ok) setDraft({ name: '', start: '', end: '', goal: '' })
  }

  return (
    <div className="cycle-plan">
      <div className="cycle-plan-header">
        <h1 className="cycle-plan-title">Plan {next ? next.name : 'next cycle'}</h1>
        <input
          aria-label="Search tickets"
          className="cycle-plan-search"
          placeholder="Search tickets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {noEstimateOnly && (
          <button
            type="button"
            className="cycle-plan-filter-chip"
            onClick={() => setNoEstimateOnly(false)}
          >
            No estimate only
            <Icon name="X" size={12} />
          </button>
        )}
        <IconButton icon="X" label="Close planning" size={28} variant="ghost" onClick={onClose} />
      </div>

      <div className="cycle-plan-columns">
        {column(
          'backlog',
          <>
            <h3>Backlog</h3>
            <span className="cycle-plan-column-count">{backlog.length}</span>
          </>,
          <>
            {backlog.filter(shown).length === 0 && (
              <p className="backlog-note">Nothing here{q || noEstimateOnly ? ' matches' : ''}.</p>
            )}
            {backlog.filter(shown).map((i) => row(i, 'backlog'))}
          </>
        )}

        {column(
          'current',
          <>
            <h3>{current ? current.name : 'No current cycle'}</h3>
            {daysLeft !== null && (
              <span className="cycle-plan-column-sub">{daysLeft} days left</span>
            )}
            <span className="cycle-plan-column-count">{inCurrent.length}</span>
          </>,
          <>
            {unfinished.filter(shown).map((i) => row(i, 'current'))}
            {finished.length > 0 && (
              <button
                type="button"
                className="cycle-plan-done-toggle"
                aria-expanded={showDone}
                onClick={() => setShowDone((v) => !v)}
              >
                <Icon name={showDone ? 'ChevronDown' : 'ChevronRight'} size={12} />
                {finished.length} done
              </button>
            )}
            {showDone && finished.filter(shown).map((i) => row(i, 'current'))}
          </>,
          next && unfinished.length > 0 ? (
            <div className="cycle-plan-column-actions">
              <Button
                variant="outlined"
                onClick={() => unfinished.forEach((i) => onMove(i, next.id))}
              >
                Carry over {unfinished.length} unfinished to {next.name}
              </Button>
            </div>
          ) : undefined
        )}

        {next
          ? column(
              'next',
              <>
                <h3>{next.name}</h3>
                {cycleDates(next) && (
                  <span className="cycle-plan-column-sub">{cycleDates(next)}</span>
                )}
                <span className="cycle-plan-column-count">{inNext.length}</span>
              </>,
              <>
                {inNext.length === 0 && (
                  <p className="backlog-note">
                    Nothing in this cycle yet. Drag tickets in from the backlog or current cycle.
                  </p>
                )}
                {inNext.filter(shown).map((i) => row(i, 'next'))}
              </>,
              <div className="cycle-plan-goal">
                <input
                  aria-label={`Goal for ${next.name}`}
                  className="cycle-plan-goal-input"
                  placeholder="Cycle goal"
                  value={goalDraft ?? next.goal ?? ''}
                  onChange={(e) => setGoalDraft(e.target.value)}
                  onBlur={() => {
                    if (goalDraft !== null && goalDraft.trim() !== (next.goal ?? '')) {
                      void onSetGoal(next.id, goalDraft)
                    }
                    setGoalDraft(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                />
              </div>
            )
          : column(
              'next',
              <h3>Next cycle</h3>,
              <form
                className="cycle-plan-create"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <p className="backlog-note">
                  Jira has no next cycle yet. Create one here: it&rsquo;s added to the board as a
                  future cycle, and you start it in Jira as usual.
                </p>
                <label>
                  Name
                  <input
                    value={draft.name}
                    placeholder="Cycle name"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label>
                  Starts
                  <input
                    type="date"
                    value={draft.start || defaults.start}
                    onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                  />
                </label>
                <label>
                  Ends
                  <input
                    type="date"
                    value={draft.end || defaults.end}
                    onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                  />
                </label>
                <label>
                  Goal
                  <input
                    value={draft.goal}
                    placeholder="Optional"
                    onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                  />
                </label>
                {boardId === null ? (
                  <p className="backlog-note">
                    No Jira board found to add a cycle to. Create it in Jira instead.
                  </p>
                ) : (
                  <Button type="submit" disabled={creating || !draft.name.trim()}>
                    {creating ? 'Creating…' : 'Create in Jira'}
                  </Button>
                )}
              </form>
            )}
      </div>

      {next && (
        <div className="cycle-plan-capacity">
          <h3 className="cycle-plan-capacity-title">Capacity for {next.name}</h3>
          {people.length === 0 && (
            <p className="backlog-note">Add tickets to the cycle to see capacity.</p>
          )}
          {people.map((person) => {
            const hours = byPerson
              .get(person)!
              .reduce((sum, i) => sum + parseEstimateHours(i.estimate), 0)
            const used = hoursToDays(hours)
            const days = capacity[person] ?? defaultDays
            const over = days > 0 && used > days
            const share = days > 0 ? Math.min(1, used / days) : 0
            const draftDays = capacityDraft[person]
            return (
              <div className="cycle-plan-capacity-row" data-capacity-person={person} key={person}>
                <Avatar name={person === 'Unassigned' ? null : person} size={18} />
                <span className="cycle-plan-capacity-name">{person}</span>
                <span
                  className="cycle-plan-capacity-bar"
                  role="progressbar"
                  aria-valuenow={Math.round(share * 100)}
                  aria-label={`${person} capacity`}
                >
                  <span
                    className={over ? 'cycle-plan-capacity-fill--over' : 'cycle-plan-capacity-fill'}
                    style={{ width: `${Math.round(share * 100)}%` }}
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
                    value={draftDays ?? String(days)}
                    onChange={(e) => setCapacityDraft((d) => ({ ...d, [person]: e.target.value }))}
                    onBlur={() => {
                      const value = Number(draftDays)
                      if (draftDays !== undefined && draftDays !== '' && value >= 0) {
                        onSavePrefs({
                          capacity: {
                            ...prefs.capacity,
                            [String(next.id)]: { ...capacity, [person]: value }
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
          <div className="cycle-plan-capacity-notes">
            {unestimated > 0 && (
              <button
                type="button"
                className="cycle-plan-capacity-note"
                aria-pressed={noEstimateOnly}
                onClick={() => setNoEstimateOnly((v) => !v)}
              >
                {unestimated} {unestimated === 1 ? 'ticket has' : 'tickets have'} no estimate
              </button>
            )}
            {unassigned > 0 && (
              <span className="cycle-plan-capacity-fact">{unassigned} unassigned</span>
            )}
            {blocked > 0 && <span className="cycle-plan-capacity-fact">{blocked} blocked</span>}
          </div>
        </div>
      )}
    </div>
  )
}
