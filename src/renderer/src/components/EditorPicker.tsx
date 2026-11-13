import { useEffect, useState } from 'react'
import { detectEditors, type DetectedEditor } from '../api'
import type { AppSettings } from '../../../main/store/types'
import { DEFAULT_EDITOR_COMMAND, type EditorChoice } from '../../../main/store/editors'
import { Icon, Input } from './primitives'
import './editor-picker.css'

interface EditorPickerProps {
  editor: AppSettings['editor']
  editorCommand: string
  onChange: (patch: Partial<Pick<AppSettings, 'editor' | 'editorCommand'>>) => void
}

/**
 * Which editor "Open in …" uses. Settings › Editor and the setup dialog both
 * show this one list. Only editors this Mac has are offered, plus the current
 * choice if it has since been uninstalled, plus your own command.
 */
export function EditorPicker({
  editor,
  editorCommand,
  onChange
}: EditorPickerProps): React.JSX.Element {
  const [found, setFound] = useState<DetectedEditor[] | null>(null)
  const [draft, setDraft] = useState(editorCommand || DEFAULT_EDITOR_COMMAND)

  useEffect(() => {
    let live = true
    void detectEditors().then((list) => {
      if (live) setFound(list)
    })
    return () => {
      live = false
    }
  }, [])

  if (!found) return <p className="editor-picker-note">Looking for editors…</p>

  const shown = found.filter((e) => e.installed || e.id === editor)
  const pick = (choice: EditorChoice): void => {
    if (choice === editor) return
    onChange(choice === 'custom' ? { editor: choice, editorCommand: draft } : { editor: choice })
  }

  return (
    <div className="editor-picker">
      <div className="editor-picker-list" role="radiogroup" aria-label="Editor">
        {shown.map((e) => (
          <Option
            key={e.id}
            label={e.name}
            note={e.installed ? undefined : 'Not found on this Mac'}
            selected={editor === e.id}
            onPick={() => pick(e.id)}
          />
        ))}
        <Option
          label="Another editor"
          note="Run your own command"
          selected={editor === 'custom'}
          onPick={() => pick('custom')}
        />
      </div>
      {shown.length === 0 && (
        <p className="editor-picker-note">
          No editor from the usual list is installed. Use your own command instead.
        </p>
      )}
      {editor === 'custom' && (
        <label className="editor-picker-command">
          <span className="editor-picker-note">
            {'{folder}'} is replaced with the worktree. Runs directly, not through a shell.
          </span>
          <Input
            aria-label="Editor command"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const next = draft.trim() || DEFAULT_EDITOR_COMMAND
              setDraft(next)
              if (next !== editorCommand) onChange({ editorCommand: next })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </label>
      )}
    </div>
  )
}

function Option({
  label,
  note,
  selected,
  onPick
}: {
  label: string
  note?: string
  selected: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`editor-picker-option${selected ? ' editor-picker-option--selected' : ''}`}
      onClick={onPick}
    >
      <span className="editor-picker-label">{label}</span>
      {note && <span className="editor-picker-note">{note}</span>}
      {selected && <Icon name="Check" size={14} className="editor-picker-check" />}
    </button>
  )
}
