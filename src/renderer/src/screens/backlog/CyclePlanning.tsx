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

const isBlocked = (i: JiraIssue): boolean => i.blockedBy.some((b) => b.statusCategory !== 'done')
const totalDays = (issues: JiraIssue[]): number =>
  hoursToDays(issues.reduce((sum, i) => sum + parseEstimateHours(i.estimate), 0))

/**
 * Plan the next cycle the way Jira's backlog and Linear's cycles do it: one
 * page of stacked sections (current cycle, next cycle, backlog) with
 * one-line rows, dragged between sections. Every move is the same sprint
 * write the rest of Tickets uses, so Jira has it straight away. The current
 * cycle's unfinished tickets aren't moved here: Jira moves them to the next
 * cycle when you complete the current one there, so this page shows them as
 * carrying over and counts them in the next cycle's load.
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
  const [folded, setFolded] = useState<Record<string, boolean>>({
    // Folded to start: its unfinished tickets already show in the next
    // cycle as carrying over, so the cycle being planned comes first.
    current: true,
    done: true
  })
  const [capacityDraft, setCapacityDraft] = useState<Record<string, string>>({})
  const [estimateDraft, setEstimateDraft] = useState<Record<string, string>>({})
  const [goalDraft, setGoalDraft] = useState<string | null>(null)

  // A new cycle starts when the current one ends and runs as long.
  const defaults = useMemo(() => {
    const start = current?.endDate ? new Date(current.endDate) : new Date(openedAt)
    const length =
      current?.startDate && current?.endDate
        ? new Date(current.endDate).getTime() - new Date(current.startDate).getTime()
        : 14 * DAY_MS
    return { start: dateInput(start), end: dateInput(new Date(start.getTime() + length)) }
  }, [current, openedAt])
  const [draft, setDraft] = useState({ name: '', start: '', end: '', goal: '' })
  const [showCreate, setShowCreate] = useState(false)
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
  // What the next cycle will hold once Jira completes the current one.
  const carrying = next ? unfinished : []

  // Load per person for the next cycle: its own tickets, plus what carries over.
  const defaultDays = next ? workingDays(next.startDate, next.endDate) : 0
  const capacity = next ? (prefs.capacity[String(next.id)] ?? {}) : {}
  const load = new Map<string, { own: JiraIssue[]; carry: JiraIssue[] }>()
  for (const [list, part] of [
    [inNext, 'own'],
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
  const planned = [...inNext, ...carrying]
  const unestimated = planned.filter((i) => !i.estimate).length

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

  const row = (issue: JiraIssue, quiet = false): React.JSX.Element => (
    <div
      key={issue.key}
      className={quiet ? 'cycle-plan-row cycle-plan-row--quiet' : 'cycle-plan-row'}
      data-issue={issue.key}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, issue.key)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <StatusGlyph name={issue.status} category={issue.statusCategory} size={12} />
      <span className="cycle-plan-row-key">{issue.key}</span>
      <span className="cycle-plan-row-summary" title={issue.summary}>
        {issue.summary}
      </span>
      {isBlocked(issue) && (
        <span className="cycle-plan-flag" title="Blocked by an unfinished ticket">
          Blocked
        </span>
      )}
      {issue.priority && <PriorityGlyph priority={issue.priority} />}
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
      <input
        aria-label={`Estimate for ${issue.key}`}
        className={
          issue.estimate
            ? 'cycle-plan-row-estimate'
            : 'cycle-plan-row-estimate cycle-plan-row-estimate--missing'
        }
        placeholder="–"
        value={estimateDraft[issue.key] ?? issue.estimate ?? ''}
        onChange={(e) => setEstimateDraft((d) => ({ ...d, [issue.key]: e.target.value }))}
        onBlur={() => saveEstimate(issue)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <span title={issue.assignee ?? 'Unassigned'}>
        <Avatar name={issue.assignee} size={18} />
      </span>
    </div>
  )

  const toggle = (id: string): void => setFolded((f) => ({ ...f, [id]: !f[id] }))
  const facts = (issues: JiraIssue[]): string => {
    const missing = issues.filter((i) => !i.estimate).length
    return [
      `${issues.length} ${issues.length === 1 ? 'ticket' : 'tickets'}`,
      `${formatDays(totalDays(issues))} estimated`,
      missing ? `${missing} without` : null
    ]
      .filter(Boolean)
      .join(' · ')
  }

  const section = (
    side: Side,
    title: React.ReactNode,
    meta: React.ReactNode,
    body: React.ReactNode,
    action?: React.ReactNode
  ): React.JSX.Element => (
    <section
      className={`cycle-plan-section${overSide === side ? ' cycle-plan-section--over' : ''}`}
      data-cycle-plan-column={side}
      onDragOver={side === 'backlog' || sideCycle(side) !== null ? dragOver(side) : undefined}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverSide(null)
      }}
      onDrop={dropOn(side)}
    >
      <header className="cycle-plan-section-header">
        <button
          type="button"
          className="cycle-plan-section-toggle"
          aria-expanded={!folded[side]}
          onClick={() => toggle(side)}
        >
          <Icon name={folded[side] ? 'ChevronRight' : 'ChevronDown'} size={14} />
          <h3>{title}</h3>
        </button>
        <span className="cycle-plan-section-meta">{meta}</span>
        {action}
      </header>
      {!folded[side] && body}
    </section>
  )

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
    if (ok) {
      setDraft({ name: '', start: '', end: '', goal: '' })
      setShowCreate(false)
    }
  }

  const daysLeft = current?.endDate
    ? Math.max(0, Math.ceil((new Date(current.endDate).getTime() - openedAt) / DAY_MS))
    : null

  return (
    <div className="cycle-plan">
      <div className="cycle-plan-header">
        <h1 className="cycle-plan-title">Plan {next ? next.name : 'next cycle'}</h1>
        {noEstimateOnly && (
          <button
            type="button"
            className="cycle-plan-filter-chip"
            onClick={() => setNoEstimateOnly(false)}
          >
            Without an estimate
            <Icon name="X" size={12} />
          </button>
        )}
        <input
          aria-label="Search tickets"
          className="cycle-plan-search"
          placeholder="Search tickets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <IconButton icon="X" label="Close planning" size={28} variant="ghost" onClick={onClose} />
      </div>

      <div className="cycle-plan-body">
        {current &&
          section(
            'current',
            current.name,
            <>
              {daysLeft !== null && <span>{daysLeft} days left</span>}
              <span>{facts(inCurrent)}</span>
            </>,
            <div className="cycle-plan-list">
              {unfinished.filter(shown).map((i) => row(i))}
              {finished.length > 0 && (
                <button
                  type="button"
                  className="cycle-plan-fold"
                  aria-expanded={!folded.done}
                  onClick={() => toggle('done')}
                >
                  <Icon name={folded.done ? 'ChevronRight' : 'ChevronDown'} size={12} />
                  {finished.length} done
                </button>
              )}
              {!folded.done && finished.filter(shown).map((i) => row(i, true))}
            </div>
          )}

        {next ? (
          section(
            'next',
            next.name,
            <>
              {cycleDates(next) && <span>{cycleDates(next)}</span>}
              <span>{facts(planned)}</span>
            </>,
            <>
              <div className="cycle-plan-next-top">
                <input
                  aria-label={`Goal for ${next.name}`}
                  className="cycle-plan-goal-input"
                  placeholder="Add a cycle goal"
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
                <div className="cycle-plan-capacity">
                  {people.map((person) => {
                    const entry = load.get(person)!
                    const own = totalDays(entry.own)
                    const carry = totalDays(entry.carry)
                    const days = capacity[person] ?? defaultDays
                    const used = own + carry
                    const over = days > 0 && used > days
                    const pct = (d: number): number =>
                      days > 0 ? Math.round(Math.min(1, d / days) * 100) : 0
                    const draftDays = capacityDraft[person]
                    return (
                      <div
                        className="cycle-plan-capacity-row"
                        data-capacity-person={person}
                        key={person}
                      >
                        <Avatar name={person === 'Unassigned' ? null : person} size={18} />
                        <span className="cycle-plan-capacity-name">{person}</span>
                        <span
                          className="cycle-plan-capacity-bar"
                          role="progressbar"
                          aria-valuenow={pct(used)}
                          aria-label={`${person} capacity`}
                        >
                          <span
                            className={
                              over ? 'cycle-plan-capacity-fill--over' : 'cycle-plan-capacity-fill'
                            }
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
                            value={draftDays ?? String(days)}
                            onChange={(e) =>
                              setCapacityDraft((d) => ({ ...d, [person]: e.target.value }))
                            }
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
                </div>
              </div>
              <div className="cycle-plan-list">
                {inNext.length === 0 && (
                  <p className="cycle-plan-hint">Drag tickets here from the backlog.</p>
                )}
                {inNext.filter(shown).map((i) => row(i))}
                {carrying.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="cycle-plan-fold"
                      aria-expanded={!folded.carry}
                      onClick={() => toggle('carry')}
                    >
                      <Icon name={folded.carry ? 'ChevronRight' : 'ChevronDown'} size={12} />
                      {carrying.length} carrying over: Jira moves them here when you complete{' '}
                      {current?.name}
                    </button>
                    {!folded.carry && (
                      <div data-carry-over>{carrying.filter(shown).map((i) => row(i, true))}</div>
                    )}
                  </>
                )}
              </div>
            </>
          )
        ) : (
          <section className="cycle-plan-section" data-cycle-plan-column="next">
            <header className="cycle-plan-section-header">
              <h3 className="cycle-plan-section-title">Next cycle</h3>
              <span className="cycle-plan-section-meta">Jira has no next cycle yet</span>
              {!showCreate && boardId !== null && (
                <Button variant="outlined" onClick={() => setShowCreate(true)}>
                  Create cycle
                </Button>
              )}
            </header>
            {boardId === null && (
              <p className="cycle-plan-hint">
                No Jira board found to add a cycle to. Create it in Jira instead.
              </p>
            )}
            {showCreate && (
              <form
                className="cycle-plan-create"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <input
                  aria-label="Cycle name"
                  autoFocus
                  value={draft.name}
                  placeholder="Name"
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
                <input
                  aria-label="Goal"
                  value={draft.goal}
                  placeholder="Goal (optional)"
                  onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                />
                <Button type="submit" variant="filled" disabled={creating || !draft.name.trim()}>
                  {creating ? 'Creating…' : 'Create in Jira'}
                </Button>
                <Button variant="ghost" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </form>
            )}
          </section>
        )}

        {section(
          'backlog',
          'Backlog',
          <span>{facts(backlog)}</span>,
          <div className="cycle-plan-list">
            {backlog.filter(shown).length === 0 && (
              <p className="cycle-plan-hint">
                Nothing here{q || noEstimateOnly ? ' matches' : ''}.
              </p>
            )}
            {backlog.filter(shown).map((i) => row(i))}
          </div>
        )}
      </div>
    </div>
  )
}
