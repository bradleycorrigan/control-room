/**
 * The HTML5 drag-and-drop MIME type ticket rows use everywhere they're
 * draggable — the board, the sidebar, and the cycle planning view. One
 * constant so a drop target built in any of those files recognises a ticket
 * dragged from any other.
 */
export const DRAG_TYPE = 'application/x-jira-issue'

export type StatusKind =
  'backlog' | 'todo' | 'progress' | 'review' | 'blocked' | 'done' | 'cancelled'

/** What kind of step a status is, from its name and Jira's category. */
export function statusKind(name: string, category: string): StatusKind {
  if (category === 'done')
    return /cancel|won.?t|declin|duplicate/i.test(name) ? 'cancelled' : 'done'
  if (/block|wait|hold/i.test(name)) return 'blocked'
  if (category === 'new') return /backlog|triage/i.test(name) ? 'backlog' : 'todo'
  return /review|qa|test|verif/i.test(name) ? 'review' : 'progress'
}

/** The colour token for that kind of step. */
export function statusTone(name: string, category: string): string {
  const kind = statusKind(name, category)
  return kind === 'progress' || kind === 'review'
    ? 'var(--status-working)'
    : kind === 'blocked'
      ? 'var(--status-attention)'
      : kind === 'done'
        ? 'var(--status-done)'
        : 'var(--text-muted)'
}
