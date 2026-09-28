import { useMemo, useState } from 'react'
import { Icon, Modal } from '../../components/primitives'
import type { BacklogPrefs, JiraIssue, JiraSprint } from '../../api'
import { Avatar, PriorityGlyph, StatusGlyph } from '../backlogGlyphs'
import { DRAG_TYPE } from '../backlogStatus'
import { formatDays, hoursToDays, parseEstimateHours, workingDays } from './cyclePlan'

type CycleLike = Pick<JiraSprint, 'id' | 'name' | 'state' | 'startDate' | 'endDate'>

/**
 * Plan a cycle without leaving Control Room: its tickets on the left,
 * everything still in the backlog on the right, drag between them (the same
 * optimistic sprint write the board and sidebar use), a Cycle picker on each
 * row for a cycle other than these two, and per-person capacity underneath.
 */
export function CyclePlanning({
  sprint,
  sprints,
  allTickets,
  prefs,
  onSavePrefs,
  onMove,
  onClose
}: {
  sprint: CycleLike
  /** Every open cycle, for the row-level "move to a different one" picker. */
  sprints: CycleLike[]
  allTickets: JiraIssue[]
  prefs: BacklogPrefs
  onSavePrefs: (patch: Partial<BacklogPrefs>) => void
  /** Into a cycle by id, or (null) out to the backlog — the existing sprint write. */
  onMove: (issue: JiraIssue, sprintId: number | null) => void
  onClose: () => void
}): React.JSX.Element {
  const [overSide, setOverSide] = useState<'cycle' | 'backlog' | null>(null)
  // Capacity input is saved async (IPC); keep what the person is typing here
  // so a slow round trip can't stomp a keystroke or force the field back to
  // its old value mid-edit. Committed on blur/Enter, and cleared once that
  // save is in, so the field then reflects `prefs` again.
  const [capacityDraft, setCapacityDraft] = useState<Record<string, string>>({})
  const inCycle = useMemo(
    () => allTickets.filter((i) => i.sprint?.id === sprint.id && !i.isSubtask),
    [allTickets, sprint.id]
  )
  const inBacklog = useMemo(() => allTickets.filter((i) => !i.sprint && !i.isSubtask), [allTickets])
  const byKey = useMemo(() => new Map(allTickets.map((i) => [i.key, i])), [allTickets])

  const defaultDays = workingDays(sprint.startDate, sprint.endDate)
  const capacity = prefs.capacity[String(sprint.id)] ?? {}
  const setCapacity = (person: string, days: number): void => {
    onSavePrefs({
      capacity: { ...prefs.capacity, [String(sprint.id)]: { ...capacity, [person]: days } }
    })
  }

  const byPerson = new Map<string, JiraIssue[]>()
  let unestimated = 0
  for (const issue of inCycle) {
    const person = issue.assignee ?? 'Unassigned'
    byPerson.set(person, [...(byPerson.get(person) ?? []), issue])
    if (!issue.estimate) unestimated++
  }
  const people = [...byPerson.keys()].sort((a, b) => a.localeCompare(b))

  const dropOn =
    (side: 'cycle' | 'backlog') =>
    (e: React.DragEvent): void => {
      e.preventDefault()
      setOverSide(null)
      const key = e.dataTransfer.getData(DRAG_TYPE)
      const issue = byKey.get(key)
      if (!issue) return
      onMove(issue, side === 'cycle' ? sprint.id : null)
    }

  const dragOver =
    (side: 'cycle' | 'backlog') =>
    (e: React.DragEvent): void => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      if (overSide !== side) setOverSide(side)
    }

  const row = (issue: JiraIssue, side: 'cycle' | 'backlog'): React.JSX.Element => (
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
      <StatusGlyph name={issue.status} category={issue.statusCategory} size={10} />
      <span className="cycle-plan-row-key">{issue.key}</span>
      <span className="cycle-plan-row-summary" title={issue.summary}>
        {issue.summary}
      </span>
      {issue.priority && <PriorityGlyph priority={issue.priority} />}
      <span className="cycle-plan-row-estimate">{issue.estimate ?? '-'}</span>
      <Avatar name={issue.assignee} size={18} />
      {sprints.length > 1 && (
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
      )}
      {side === 'backlog' ? (
        <button
          type="button"
          className="cycle-plan-row-move"
          title={`Add to ${sprint.name}`}
          onClick={() => onMove(issue, sprint.id)}
        >
          <Icon name="ArrowLeft" size={14} />
        </button>
      ) : (
        <button
          type="button"
          className="cycle-plan-row-move"
          title="Move to backlog"
          onClick={() => onMove(issue, null)}
        >
          <Icon name="ArrowRight" size={14} />
        </button>
      )}
    </div>
  )

  return (
    <Modal title={`Plan ${sprint.name}`} icon="LayoutList" width={920} onClose={onClose}>
      <div className="cycle-plan">
        <div className="cycle-plan-columns">
          <div
            className={`cycle-plan-column${overSide === 'cycle' ? ' cycle-plan-column--over' : ''}`}
            data-cycle-plan-column="cycle"
            onDragOver={dragOver('cycle')}
            onDragLeave={() => setOverSide(null)}
            onDrop={dropOn('cycle')}
          >
            <div className="cycle-plan-column-header">
              <h3>{sprint.name}</h3>
              <span className="cycle-plan-column-count">{inCycle.length}</span>
            </div>
            <div className="cycle-plan-column-list">
              {inCycle.length === 0 && (
                <p className="backlog-note">Nothing in this cycle yet. Drag tickets in.</p>
              )}
              {inCycle.map((i) => row(i, 'cycle'))}
            </div>
          </div>
          <div
            className={`cycle-plan-column${overSide === 'backlog' ? ' cycle-plan-column--over' : ''}`}
            data-cycle-plan-column="backlog"
            onDragOver={dragOver('backlog')}
            onDragLeave={() => setOverSide(null)}
            onDrop={dropOn('backlog')}
          >
            <div className="cycle-plan-column-header">
              <h3>Backlog</h3>
              <span className="cycle-plan-column-count">{inBacklog.length}</span>
            </div>
            <div className="cycle-plan-column-list">
              {inBacklog.length === 0 && <p className="backlog-note">Backlog is empty.</p>}
              {inBacklog.map((i) => row(i, 'backlog'))}
            </div>
          </div>
        </div>

        <div className="cycle-plan-capacity">
          <h3 className="cycle-plan-capacity-title">Capacity</h3>
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
            const draft = capacityDraft[person]
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
                    value={draft ?? String(days)}
                    onChange={(e) => setCapacityDraft((d) => ({ ...d, [person]: e.target.value }))}
                    onBlur={() => {
                      const next = Number(draft)
                      if (
                        draft !== undefined &&
                        draft !== '' &&
                        Number.isFinite(next) &&
                        next >= 0
                      ) {
                        setCapacity(person, next)
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
            <p className="cycle-plan-capacity-note">
              {unestimated} {unestimated === 1 ? 'ticket has' : 'tickets have'} no estimate
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}
