import { useCallback, useEffect, useState } from 'react'
import { listRules, restoreRuleBackup, type RuleInfo } from '../../api'
import { requestOpenFile } from './openFileBus'
import AddRuleDialog from '../../components/AddRuleDialog'
import type { ToastAction } from '../../state/useToasts'
import './RulesTab.css'

interface Props {
  projectId: string
  pushToast: (message: string, action?: ToastAction) => void
}

// Cards for every CLAUDE.md that actually governs this project: the global
// ~/.claude/CLAUDE.md (applies everywhere), the project's own root
// CLAUDE.md ("not created" when absent, as before), and any nested
// CLAUDE.md rules:list finds — Claude Code applies one of those only to
// work under its own directory, so each card says which directory that is.
// rules:list is still the only handler for discovery; there is still no
// create/write action beyond "Add to rules…", which — because it can only
// ever target the two fixed slots (global, project root) AddRuleDialog's
// dropdown can express — keeps doing exactly that. A nested file is edited
// by opening it in the Files tab instead, the same way SkillsTab already
// opens a SKILL.md (openFileBus's relPath contract). CLAUDE.md: "Status is
// always shown as a colour and a word."
export default function RulesTab({ projectId, pushToast }: Props): React.JSX.Element {
  const [rules, setRules] = useState<RuleInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddRule, setShowAddRule] = useState(false)

  const reload = useCallback(() => {
    let cancelled = false
    listRules(projectId)
      .then((result) => {
        if (cancelled) return
        setRules(result)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError('Could not load rules.')
        setRules([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  // Mirrors GitTab/SkillsTab's mount pattern: setState only ever happens
  // inside a promise callback, never synchronously reachable from the effect
  // body (react-hooks/set-state-in-effect).
  useEffect(() => reload(), [reload])

  const globalRule = rules.find((r) => r.scope === 'global')
  // The dialog can only ever target the project's *root* CLAUDE.md — its
  // dropdown has no way to name one of several nested files, and
  // AddRuleDialog isn't ours to extend. dir === '' picks that one out of
  // what may now be several 'project'-scope entries.
  const projectRootRule = rules.find((r) => r.scope === 'project' && r.dir === '')

  const handleAdded = (result: {
    scope: 'global' | 'project'
    path: string
    backupPath?: string
  }): void => {
    reload()
    const undo = result.backupPath
      ? {
          label: 'Undo',
          onClick: () => {
            restoreRuleBackup(result.scope, projectId, result.backupPath!).then((r) => {
              pushToast(r.ok ? 'Restored.' : (r.error ?? 'Could not restore the backup.'))
              reload()
            })
          }
        }
      : undefined
    pushToast(`Added to ${result.path}.`, undo)
  }

  return (
    <div className="rules-tab">
      <div className="rules-tab-toolbar">
        <button type="button" className="rules-tab-add-button" onClick={() => setShowAddRule(true)}>
          Add to rules…
        </button>
      </div>

      {showAddRule && (
        <AddRuleDialog
          projectId={projectId}
          hasProject={projectRootRule !== undefined}
          globalPath={globalRule?.path ?? ''}
          projectPath={projectRootRule?.path ?? null}
          onClose={() => setShowAddRule(false)}
          onAdded={handleAdded}
        />
      )}

      {loading && <div className="rules-tab-muted">Loading rules…</div>}
      {!loading && error && <div className="rules-tab-error">{error}</div>}

      {!loading && !error && rules.length === 0 && (
        <div className="rules-tab-empty">No rule files found for this project.</div>
      )}

      {!loading && !error && rules.length > 0 && (
        <div className="rules-tab-grid">
          {rules.map((rule) => (
            <RuleCard key={`${rule.scope}:${rule.path}`} rule={rule} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  )
}

// What Claude Code actually does with this file, in words — which
// directory it governs is the one thing this tab exists to make obvious.
function appliesToLabel(rule: RuleInfo): string {
  if (rule.scope === 'global') return 'Applies everywhere'
  if (!rule.dir) return 'Applies to the whole project'
  return `Applies to ${rule.dir}/`
}

function RuleCard({ rule, projectId }: { rule: RuleInfo; projectId: string }): React.JSX.Element {
  const scopeLabel = rule.scope === 'global' ? 'Global' : 'Project'

  // Only a project-scope file that actually exists can be opened — the
  // global file sits outside every registered project (files.ts's own
  // boundary; the Files editor can't reach it), and there is nothing to
  // edit for a "not created" placeholder either way.
  const canOpen = rule.exists && rule.relPath !== undefined

  const openInFiles = (): void => {
    if (canOpen) requestOpenFile(projectId, rule.relPath!)
  }

  return (
    <div
      className={'rules-tab-card' + (rule.exists ? '' : ' rules-tab-card-missing')}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={canOpen ? openInFiles : undefined}
      onKeyDown={
        canOpen
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openInFiles()
              }
            }
          : undefined
      }
      aria-label={
        canOpen
          ? `Open ${rule.path} in the Files editor`
          : rule.exists
            ? rule.path
            : `${rule.path}, not created`
      }
    >
      <div className="rules-tab-card-header">
        <span
          className={
            'rules-tab-scope-badge ' +
            (rule.scope === 'global'
              ? 'rules-tab-scope-badge-global'
              : 'rules-tab-scope-badge-project')
          }
        >
          {scopeLabel}
        </span>
        <span
          className={
            'rules-tab-exists-word ' +
            (rule.exists ? 'rules-tab-exists-word-yes' : 'rules-tab-exists-word-no')
          }
        >
          {rule.exists ? 'exists' : 'not created'}
        </span>
      </div>
      <span className="rules-tab-applies-to">{appliesToLabel(rule)}</span>
      <span className="rules-tab-card-path">{rule.path}</span>
    </div>
  )
}
