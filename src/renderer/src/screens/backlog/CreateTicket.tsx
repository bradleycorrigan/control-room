import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, Textarea } from '../../components/primitives'
import {
  createJiraIssue,
  loadJiraIssueTypes,
  type JiraBoardData,
  type JiraIssue,
  type JiraIssueType
} from '../../api'
import type { TicketDraftResult } from '../../api-sessions'
import { useStoredState } from '../../state/useStoredState'
import Select from '../../components/Select'

/**
 * New ticket (C). The fields every ticket here needs up front — project,
 * type, summary — and the ones people set straight after anyway: epic,
 * priority, labels, the current cycle, and taking it yourself.
 */
export function CreateTicket({
  projects,
  board,
  defaultInCycle,
  initialSummary = '',
  initialDescription = '',
  draft,
  onCreated,
  onClose
}: {
  projects: string[]
  board: JiraBoardData
  defaultInCycle: boolean
  /** Prefill — e.g. from a session: its title and what it was asked to do. */
  initialSummary?: string
  initialDescription?: string
  /**
   * Fills the fields from elsewhere once it answers (a session's draft by
   * Haiku). Anything the user has already changed by then stays theirs.
   */
  draft?: () => Promise<TicketDraftResult>
  onCreated: (issue: JiraIssue, skipped: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [project, setProject] = useStoredState<string>('backlog-create-project', projects[0] ?? '')
  const [lastTypes, setLastTypes] = useStoredState<Record<string, string>>(
    'backlog-create-types',
    {}
  )
  const [types, setTypes] = useState<JiraIssueType[] | null>(null)
  const [typeId, setTypeId] = useState('')
  const [summary, setSummary] = useState(initialSummary)
  const [description, setDescription] = useState(initialDescription)
  const [parentKey, setParentKey] = useState('')
  const [priority, setPriority] = useState(
    board.priorities.includes('Medium') ? 'Medium' : (board.priorities[0] ?? '')
  )
  const [labels, setLabels] = useState('')
  const activeSprint = board.sprints.find((s) => s.state === 'active') ?? null
  const [sprintId, setSprintId] = useState<number | null>(
    defaultInCycle && activeSprint ? activeSprint.id : null
  )
  const [assignToMe, setAssignToMe] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentProject = projects.includes(project) ? project : (projects[0] ?? '')

  const [drafting, setDrafting] = useState(Boolean(draft))
  const [draftError, setDraftError] = useState<string | null>(null)
  const touched = useRef(new Set<string>())
  const touch = (field: string): void => {
    touched.current.add(field)
  }
  useEffect(() => {
    if (!draft) return
    let live = true
    void draft()
      .catch((e: unknown): TicketDraftResult => ({ ok: false, error: String(e) }))
      .then((r) => {
        if (!live) return
        setDrafting(false)
        if (!r.ok) {
          setDraftError(r.error)
          return
        }
        const t = touched.current
        const d = r.value
        if (!t.has('summary')) setSummary(d.summary)
        if (!t.has('description') && d.description) setDescription(d.description)
        if (!t.has('priority') && d.priority) setPriority(d.priority)
        if (!t.has('epic') && d.epicKey) setParentKey(d.epicKey)
        if (!t.has('labels') && d.labels.length > 0) setLabels(d.labels.join(', '))
      })
    return () => {
      live = false
    }
    // Drafts once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let live = true
    void loadJiraIssueTypes(currentProject).then((r) => {
      if (!live) return
      if (!r.ok) {
        setError(r.error)
        setTypes([])
        return
      }
      setTypes(r.value)
      const remembered = r.value.find((t) => t.id === lastTypes[currentProject])
      const fallback =
        r.value.find((t) => /^task$/i.test(t.name)) ?? r.value.find((t) => t.name !== 'Epic')
      setTypeId((remembered ?? fallback ?? r.value[0])?.id ?? '')
    })
    return () => {
      live = false
    }
    // lastTypes is read once per project switch, not re-run on every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject])

  const submit = async (): Promise<void> => {
    if (!summary.trim() || !typeId || busy) return
    setBusy(true)
    setError(null)
    const r = await createJiraIssue({
      project: currentProject,
      issueTypeId: typeId,
      summary,
      descriptionWiki: description,
      priority: priority || null,
      parentKey: parentKey || null,
      labels: labels
        .split(/[\s,]+/)
        .map((l) => l.trim())
        .filter(Boolean),
      sprintId,
      assignToMe
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setLastTypes({ ...lastTypes, [currentProject]: typeId })
    onCreated(r.value.issue, r.value.skipped)
    onClose()
  }

  return (
    <Modal title="New ticket" icon="SquarePen" width={560} onClose={onClose}>
      <form
        className="backlog-create"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.metaKey) {
            e.preventDefault()
            void submit()
          }
        }}
      >
        <div className="backlog-create-row">
          <label className="backlog-field">
            <span>Project</span>
            <Select
              className="backlog-select"
              aria-label="Project"
              value={currentProject}
              onChange={(e) => setProject(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </label>
          <label className="backlog-field">
            <span>Type</span>
            <Select
              className="backlog-select"
              aria-label="Type"
              value={typeId}
              disabled={!types}
              onChange={(e) => setTypeId(e.target.value)}
            >
              {!types && <option value="">Loading…</option>}
              {types?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {(drafting || draftError) && (
          <p className="backlog-note backlog-create-draft" role="status">
            {drafting
              ? 'Drafting the fields from this session…'
              : `Couldn't draft from the session (${draftError}). The title and last prompt are filled in instead.`}
          </p>
        )}
        <label className="backlog-field">
          <span>Summary</span>
          <Input
            autoFocus
            aria-label="Summary"
            placeholder="What needs doing"
            value={summary}
            onChange={(e) => {
              touch('summary')
              setSummary(e.target.value)
            }}
          />
        </label>
        <label className="backlog-field">
          <span>Description</span>
          <Textarea
            aria-label="Description"
            className="backlog-drawer-textarea"
            rows={5}
            placeholder="Context, links, what done looks like"
            value={description}
            onChange={(e) => {
              touch('description')
              setDescription(e.target.value)
            }}
          />
        </label>
        <div className="backlog-create-row">
          <label className="backlog-field">
            <span>Epic</span>
            <Select
              className="backlog-select"
              aria-label="Epic"
              value={parentKey}
              onChange={(e) => {
                touch('epic')
                setParentKey(e.target.value)
              }}
            >
              <option value="">No epic</option>
              {board.epics.map((ep) => (
                <option key={ep.key} value={ep.key}>
                  {ep.summary} ({ep.key})
                </option>
              ))}
            </Select>
          </label>
          <label className="backlog-field">
            <span>Priority</span>
            <Select
              className="backlog-select"
              aria-label="Priority"
              value={priority}
              onChange={(e) => {
                touch('priority')
                setPriority(e.target.value)
              }}
            >
              {board.priorities.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="backlog-create-row">
          <label className="backlog-field">
            <span>Labels</span>
            <Input
              aria-label="Labels"
              placeholder={board.labels.slice(0, 3).join(', ') || 'data-ask'}
              list="backlog-create-labels"
              value={labels}
              onChange={(e) => {
                touch('labels')
                setLabels(e.target.value)
              }}
            />
            <datalist id="backlog-create-labels">
              {board.labels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>
          {board.sprints.length > 0 && (
            <label className="backlog-field">
              <span>Cycle</span>
              <Select
                className="backlog-select"
                aria-label="Cycle"
                value={sprintId === null ? '' : String(sprintId)}
                onChange={(e) => setSprintId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Backlog</option>
                {board.sprints.map((sp) => (
                  <option key={sp.id} value={String(sp.id)}>
                    {sp.state === 'active' ? `Current cycle · ${sp.name}` : `${sp.name} · upcoming`}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
        <div className="backlog-create-checks">
          <label className="backlog-check">
            <input
              type="checkbox"
              checked={assignToMe}
              onChange={(e) => setAssignToMe(e.target.checked)}
            />
            Assign to me
          </label>
        </div>
        {error && <p className="backlog-error">{error}</p>}
        <div className="backlog-columns-actions">
          <span className="backlog-note">⌘↩ to create</span>
          <span className="backlog-card-spacer" />
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" type="submit" disabled={busy || !summary.trim() || !typeId}>
            {busy ? 'Creating…' : 'Create ticket'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
