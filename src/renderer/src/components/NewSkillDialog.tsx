import { useState } from 'react'
import { createSkill } from '../api'
import { Modal, Button, Stack, Row } from './primitives'

interface Props {
  projectId: string
  hasProject: boolean
  // Pre-fills the body from a session selection (the "save from a session"
  // entry point, plan 3 section 2.6 #3). Undefined for the plain "New skill"
  // entry point.
  initialBody?: string
  onClose: () => void
  onCreated: (path: string, scope: 'global' | 'project') => void
}

const VAGUE_WORDS = ['stuff', 'things', 'misc', 'various', 'helper', 'utility', 'utils']

// A description that is too short or too generic is the single most common
// reason a skill never triggers (plan 3, 2.6 #1) — warn, don't block.
function descriptionWarning(description: string): string | null {
  const trimmed = description.trim()
  if (!trimmed) return null
  if (trimmed.length < 15)
    return 'This is quite short: Claude decides whether to use a skill from this text alone.'
  if (VAGUE_WORDS.some((w) => trimmed.toLowerCase().includes(w))) {
    return 'This reads as vague: say specifically when the skill should trigger.'
  }
  return null
}

export default function NewSkillDialog({
  projectId,
  hasProject,
  initialBody,
  onClose,
  onCreated
}: Props): React.JSX.Element {
  const [scope, setScope] = useState<'global' | 'project'>(hasProject ? 'project' : 'global')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState(initialBody ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const warning = descriptionWarning(description)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) {
      setError('name is required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await createSkill(scope, projectId, name, description, body || undefined)
      if (result.ok && result.path) {
        onCreated(result.path, scope)
        onClose()
      } else {
        setError(result.error ?? 'could not create the skill')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="New skill" icon="Sparkles" onClose={onClose}>
      <form onSubmit={submit} aria-label="New skill">
        <Stack gap={16} className="new-skill-dialog">
          <label>
            Scope
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'global' | 'project')}
              disabled={busy}
            >
              <option value="global">Global (~/.claude/skills)</option>
              <option value="project" disabled={!hasProject}>
                Project (.claude/skills)
              </option>
            </select>
          </label>

          <label>
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. deploy-checklist"
              disabled={busy}
              autoFocus
            />
          </label>

          <label>
            Description (decides when this skill triggers)
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Use when the user asks to…"
              disabled={busy}
            />
          </label>
          {warning && <p className="new-skill-dialog-warning">{warning}</p>}

          <label>
            Body
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="# Skill body (markdown)"
              disabled={busy}
            />
          </label>

          {error && <p className="settings-error">{error}</p>}

          <Row gap={8} justify="flex-end">
            <Button type="button" variant="outlined" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="filled" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create skill'}
            </Button>
          </Row>
        </Stack>
      </form>
    </Modal>
  )
}
