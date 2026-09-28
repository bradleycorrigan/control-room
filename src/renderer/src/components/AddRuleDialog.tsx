import { useState } from 'react'
import { appendRule } from '../api'
import { Modal, Button, Stack, Row } from './primitives'

interface Props {
  projectId: string
  hasProject: boolean
  // Pre-fills the rule text — from a terminal selection, or empty for the
  // "Add rule…" command-palette / Rules-tab entry point.
  initialText?: string
  globalPath: string
  projectPath: string | null
  onClose: () => void
  onAdded: (result: { scope: 'global' | 'project'; path: string; backupPath?: string }) => void
}

// Section 2.7 "Adding a rule in one click" — appending is the only automatic
// edit a rules file allows, so the dialog's whole job is to make that one
// edit legible before it happens: exactly the lines that will be added,
// never a rewrite of what is already there.
export default function AddRuleDialog({
  projectId,
  hasProject,
  initialText,
  globalPath,
  projectPath,
  onClose,
  onAdded
}: Props): React.JSX.Element {
  const [scope, setScope] = useState<'global' | 'project'>(hasProject ? 'project' : 'global')
  const [text, setText] = useState(initialText ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const targetPath = scope === 'global' ? globalPath : (projectPath ?? '(no project selected)')
  const diffLines = text.split('\n').filter((l) => l.length > 0)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!text.trim()) {
      setError('rule text is empty')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await appendRule(scope, projectId, text)
      if (result.ok) {
        onAdded({ scope, path: targetPath, backupPath: result.backupPath })
        onClose()
      } else {
        setError(result.error ?? 'could not append to the rules file')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Add to rules" icon="ListPlus" onClose={onClose}>
      <form onSubmit={submit} aria-label="Add to rules">
        <Stack gap={16} className="add-rule-dialog">
          <label>
            Target
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'global' | 'project')}
              disabled={busy}
            >
              <option value="global">Global: {globalPath}</option>
              <option value="project" disabled={!hasProject}>
                Project: {projectPath ?? 'no project selected'}
              </option>
            </select>
          </label>

          <label>
            Rule text
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder="- always run npm run gate before calling a milestone done"
              disabled={busy}
              autoFocus
            />
          </label>

          <div className="add-rule-diff-preview">
            <span className="add-rule-diff-label">Will append to {targetPath}:</span>
            <pre className="add-rule-diff">
              {diffLines.length === 0
                ? '(nothing yet)'
                : diffLines.map((line, i) => (
                    <div key={i} className="add-rule-diff-line-added">
                      + {line}
                    </div>
                  ))}
            </pre>
          </div>

          {error && <p className="settings-error">{error}</p>}

          <Row gap={8} justify="flex-end">
            <Button type="button" variant="outlined" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="filled" disabled={busy || !text.trim()}>
              {busy ? 'Adding…' : 'Add to rules'}
            </Button>
          </Row>
        </Stack>
      </form>
    </Modal>
  )
}
