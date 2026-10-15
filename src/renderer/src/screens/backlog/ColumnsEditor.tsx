import { useState } from 'react'
import { Button, IconButton, Modal } from '../../components/primitives'
import type { JiraColumn } from '../../api'
import { StatusGlyph } from '../backlogGlyphs'
import { statusTone } from '../backlogStatus'

const STATUS_DRAG = 'application/x-jira-status'

/**
 * Your columns, set up the way Jira's board settings do it: each column is a
 * name and the statuses that land in it. Drag a status between columns, or
 * into Hidden to keep its tickets off the Backlog entirely. Saved on this
 * Mac; Jira's own board is never changed.
 */
export function ColumnsEditor({
  columns,
  statuses,
  jiraColumns,
  jiraBoardName,
  onSave,
  onReset,
  onClose
}: {
  columns: JiraColumn[]
  /** Every status the projects use, in workflow order. */
  statuses: { name: string; category: string }[]
  /** The Jira board's own columns, if there's a board to reset to. */
  jiraColumns: JiraColumn[] | null
  jiraBoardName: string | null
  onSave: (columns: JiraColumn[]) => void
  onReset: () => void
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<JiraColumn[]>(() => structuredClone(columns))
  const [over, setOver] = useState<number | 'hidden' | null>(null)
  const category = (name: string): string =>
    statuses.find((s) => s.name === name)?.category ?? 'new'
  const mapped = new Set(draft.flatMap((c) => c.statuses))
  const hidden = statuses.map((s) => s.name).filter((n) => !mapped.has(n))

  const moveStatus = (status: string, to: number | 'hidden'): void => {
    setDraft((cols) =>
      cols.map((c, i) => ({
        ...c,
        statuses:
          i === to
            ? [...c.statuses.filter((s) => s !== status), status]
            : c.statuses.filter((s) => s !== status)
      }))
    )
  }
  const moveColumn = (i: number, delta: number): void => {
    setDraft((cols) => {
      const next = [...cols]
      const j = i + delta
      if (j < 0 || j >= next.length) return cols
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const dropZone = (target: number | 'hidden'): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(STATUS_DRAG)) return
      e.preventDefault()
      if (over !== target) setOver(target)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
    },
    onDrop: (e) => {
      e.preventDefault()
      setOver(null)
      const status = e.dataTransfer.getData(STATUS_DRAG)
      if (status) moveStatus(status, target)
    }
  })

  const chip = (status: string): React.JSX.Element => (
    <div
      key={status}
      className="backlog-columns-status"
      data-status-chip={status}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(STATUS_DRAG, status)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <StatusGlyph name={status} category={category(status)} size={12} />
      {status}
    </div>
  )

  return (
    <Modal
      title="Columns"
      icon="Columns3"
      width={Math.min(1100, window.innerWidth - 48)}
      onClose={onClose}
    >
      <div className="backlog-columns-editor">
        <p className="backlog-note">
          Drag statuses between columns. Statuses in Hidden, and their tickets, stay off the
          Backlog. This only changes what you see here; your Jira board stays as it is.
        </p>
        <div className="backlog-columns-grid">
          <div
            className={`backlog-columns-col backlog-columns-col--hidden${over === 'hidden' ? ' backlog-columns-col--over' : ''}`}
            data-columns-target="hidden"
            {...dropZone('hidden')}
          >
            <div className="backlog-columns-head">
              <span className="backlog-columns-hidden-title">Hidden</span>
            </div>
            {hidden.map(chip)}
            {hidden.length === 0 && <p className="backlog-note">Drop a status here to hide it.</p>}
          </div>
          {draft.map((col, i) => (
            <div
              key={i}
              className={`backlog-columns-col${over === i ? ' backlog-columns-col--over' : ''}`}
              data-columns-target={i}
              style={
                {
                  '--column-tone': col.statuses[0]
                    ? statusTone(col.name, category(col.statuses[0]))
                    : 'var(--border)'
                } as React.CSSProperties
              }
              {...dropZone(i)}
            >
              <div className="backlog-columns-head">
                <input
                  className="backlog-columns-name"
                  aria-label={`Column ${i + 1} name`}
                  value={col.name}
                  onChange={(e) =>
                    setDraft((cols) =>
                      cols.map((c, j) => (j === i ? { ...c, name: e.target.value } : c))
                    )
                  }
                />
              </div>
              <div className="backlog-columns-tools">
                <IconButton
                  icon="ChevronLeft"
                  label="Move column left"
                  size={28}
                  disabled={i === 0}
                  onClick={() => moveColumn(i, -1)}
                />
                <IconButton
                  icon="ChevronRight"
                  label="Move column right"
                  size={28}
                  disabled={i === draft.length - 1}
                  onClick={() => moveColumn(i, 1)}
                />
                <IconButton
                  icon="Trash2"
                  label="Remove column"
                  tooltip="Remove column (its statuses move to Hidden)"
                  size={28}
                  onClick={() => setDraft((cols) => cols.filter((_, j) => j !== i))}
                />
              </div>
              {col.statuses.map(chip)}
              {col.statuses.length === 0 && (
                <p className="backlog-note">Empty columns don’t show.</p>
              )}
            </div>
          ))}
          <button
            type="button"
            className="backlog-columns-add"
            onClick={() => setDraft((cols) => [...cols, { name: 'New column', statuses: [] }])}
          >
            Add column
          </button>
        </div>
        <div className="backlog-columns-actions">
          {jiraColumns && (
            <Button
              variant="ghost"
              title={jiraBoardName ? `Use the columns from “${jiraBoardName}”` : undefined}
              onClick={() => {
                onReset()
                onClose()
              }}
            >
              Reset to Jira board
            </Button>
          )}
          <span className="backlog-card-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="filled"
            onClick={() => {
              onSave(
                draft
                  .map((c) => ({ ...c, name: c.name.trim() || 'Untitled' }))
                  .filter((c) => c.statuses.length > 0 || c.name !== 'New column')
              )
              onClose()
            }}
          >
            Save columns
          </Button>
        </div>
      </div>
    </Modal>
  )
}
