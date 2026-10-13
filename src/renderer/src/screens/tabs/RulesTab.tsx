import { useCallback, useEffect, useState } from 'react'
import { listRules, readRule, restoreRuleBackup, type RuleInfo } from '../../api'
import { requestOpenFile } from './openFileBus'
import AddRuleDialog from '../../components/AddRuleDialog'
import DocReader from '../../components/DocReader'
import './doc-rows.css'
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
  const [reading, setReading] = useState<RuleInfo | null>(null)

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
        <div className="doc-rows">
          {rules.map((rule) => (
            <RuleRow
              key={`${rule.scope}:${rule.path}`}
              rule={rule}
              onOpen={() => setReading(rule)}
            />
          ))}
        </div>
      )}

      {reading && (
        <DocReader
          key={reading.path}
          title={appliesToLabel(reading)}
          location={tildify(reading.path)}
          load={() => readRule(projectId, reading.path)}
          onOpenInFiles={
            reading.relPath !== undefined
              ? () => {
                  const relPath = reading.relPath!
                  setReading(null)
                  requestOpenFile(projectId, relPath)
                }
              : undefined
          }
          onClose={() => setReading(null)}
        />
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

/** A path for display only: the home directory as ~. The renderer never acts on it. */
function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
}

/** One rule file: what it governs, where it is, and its scope. Not created yet: shown, not opened. */
function RuleRow({ rule, onOpen }: { rule: RuleInfo; onOpen: () => void }): React.JSX.Element {
  const canOpen = rule.exists
  return (
    <div
      className={canOpen ? 'doc-row' : 'doc-row doc-row--inert'}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      data-rule={rule.scope}
      onClick={canOpen ? onOpen : undefined}
      onKeyDown={
        canOpen
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen()
              }
            }
          : undefined
      }
      aria-label={canOpen ? `Read ${rule.path}` : `${rule.path}, not created`}
    >
      <div className="doc-row-main">
        <span className="doc-row-title">{appliesToLabel(rule)}</span>
        <span className="doc-row-sub doc-row-sub--path" title={rule.path}>
          {tildify(rule.path)}
        </span>
      </div>
      <div className="doc-row-meta">
        <span>{rule.scope === 'global' ? 'Global' : 'Project'}</span>
        {!rule.exists && <span>Not created</span>}
      </div>
    </div>
  )
}
