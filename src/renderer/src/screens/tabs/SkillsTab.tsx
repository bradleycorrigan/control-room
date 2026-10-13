import { useCallback, useEffect, useMemo, useState } from 'react'
import { listProjects, listSkills, readSkill, type SkillInfo } from '../../api'
import { requestOpenFile } from './openFileBus'
import NewSkillDialog from '../../components/NewSkillDialog'
import DocReader from '../../components/DocReader'
import './doc-rows.css'
import type { ToastAction } from '../../state/useToasts'
import './SkillsTab.css'

interface Props {
  projectId: string
  pushToast: (message: string, action?: ToastAction) => void
}

type ScopeFilter = 'all' | 'global' | 'project'

// Read-only rows from ~/.claude/skills/, <project>/.claude/skills/ and
// plugin skill directories (plan 2.2, Skills paragraph). Clicking a row opens
// its SKILL.md in a reader (skills:read), global skills included; from there,
// a project skill's "Open in Files" goes to the editor via the openFileBus
// (FilesTab subscribes to that itself).
//
// skills:list hands back each skill's real, absolute filesystem path
// (main/exec/skills.ts). The openFileBus contract (see its file header)
// requires a path relative to the resolved project root, because it is
// replayed straight into files:read, and files:read's resolveProjectPath
// rejects an absolute path outright. So a project-scope skill's absolute
// path is turned into a project-relative one here by stripping the
// project's own repoPath prefix — repoPath itself came from main (via
// projects:list), never constructed by this tab, so this is a string
// transform on two main-supplied paths, not the renderer inventing a
// filesystem path to act on. A global skill has no project-relative
// expression at all (it lives outside every registered project root), so
// its card is shown read-only with its real path as text and is not
// clickable — sending it through the bus would only produce a silent
// files:read failure.
function toProjectRelativePath(repoPath: string | null, absoluteSkillDir: string): string | null {
  if (!repoPath) return null
  // absoluteSkillDir is the skill's directory (main/exec/skills.ts's
  // SkillInfo.path), not the SKILL.md file inside it — append the filename
  // so callers get a file path files:read will actually accept, never a
  // directory it rejects with "not a file".
  if (absoluteSkillDir === repoPath) return 'SKILL.md'
  const prefix = repoPath.endsWith('/') ? repoPath : repoPath + '/'
  if (!absoluteSkillDir.startsWith(prefix)) return null
  return `${absoluteSkillDir.slice(prefix.length)}/SKILL.md`
}

export default function SkillsTab({ projectId, pushToast }: Props): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [repoPath, setRepoPath] = useState<string | null>(null)
  const [showNewSkill, setShowNewSkill] = useState(false)
  const [reading, setReading] = useState<SkillInfo | null>(null)

  const reload = useCallback(() => {
    let cancelled = false
    listSkills(projectId)
      .then((result) => {
        if (cancelled) return
        setSkills(result)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError('Could not load skills.')
        setSkills([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  // Mirrors GitTab/RulesTab's mount pattern: setState only ever happens
  // inside a promise callback, never synchronously reachable from the effect
  // body (react-hooks/set-state-in-effect).
  useEffect(() => {
    const cancel = reload()

    // Needed only to turn a project-scope skill's absolute path into a
    // project-relative one (see toProjectRelativePath above). A failure
    // here just means project-scope cards fall back to the same
    // "can't be opened here" state as global ones — it never blocks the
    // list itself from loading.
    let cancelled = false
    listProjects()
      .then((projects) => {
        if (cancelled) return
        const project = projects.find((p) => p.id === projectId)
        setRepoPath(project?.repoPath ?? null)
      })
      .catch(() => {
        if (cancelled) return
        setRepoPath(null)
      })

    return () => {
      cancelled = true
      cancel()
    }
  }, [projectId, reload])

  const filtered = useMemo(() => {
    if (scopeFilter === 'all') return skills
    return skills.filter((skill) => skill.scope === scopeFilter)
  }, [skills, scopeFilter])

  return (
    <div className="skills-tab">
      <div className="skills-tab-toolbar">
        <div className="skills-tab-filters" role="group" aria-label="Filter skills by scope">
          <FilterPill
            label="All"
            active={scopeFilter === 'all'}
            onClick={() => setScopeFilter('all')}
          />
          <FilterPill
            label="Global"
            active={scopeFilter === 'global'}
            onClick={() => setScopeFilter('global')}
          />
          <FilterPill
            label="Project"
            active={scopeFilter === 'project'}
            onClick={() => setScopeFilter('project')}
          />
        </div>
        <button
          type="button"
          className="skills-tab-new-button"
          onClick={() => setShowNewSkill(true)}
        >
          New skill
        </button>
      </div>

      {showNewSkill && (
        <NewSkillDialog
          projectId={projectId}
          hasProject={repoPath !== null}
          onClose={() => setShowNewSkill(false)}
          onCreated={(_path, scope) => {
            pushToast(`Skill created (${scope}).`)
            reload()
          }}
        />
      )}

      {loading && <div className="skills-tab-muted">Loading skills…</div>}
      {!loading && error && <div className="skills-tab-error">{error}</div>}

      {!loading && !error && skills.length === 0 && (
        <div className="skills-tab-empty">No skills found for this project.</div>
      )}

      {!loading && !error && skills.length > 0 && filtered.length === 0 && (
        <div className="skills-tab-empty">No skills match this filter.</div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="doc-rows">
          {filtered.map((skill) => (
            <SkillRow
              key={`${skill.scope}:${skill.path}`}
              skill={skill}
              onOpen={() => setReading(skill)}
            />
          ))}
        </div>
      )}

      {reading &&
        (() => {
          const relPath =
            reading.scope === 'project' ? toProjectRelativePath(repoPath, reading.path) : null
          return (
            <DocReader
              key={reading.path}
              title={reading.name}
              location={`${tildify(reading.path)}/SKILL.md`}
              load={() => readSkill(projectId, reading.path)}
              onOpenInFiles={
                relPath
                  ? () => {
                      setReading(null)
                      requestOpenFile(projectId, relPath)
                    }
                  : undefined
              }
              onClose={() => setReading(null)}
            />
          )
        })()}
    </div>
  )
}

function FilterPill({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={'skills-tab-pill' + (active ? ' skills-tab-pill-active' : '')}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

/** A path for display only: the home directory as ~. The renderer never acts on it. */
function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
}

/** One skill: its name and what it's for, then where it comes from and how big it is. */
function SkillRow({ skill, onOpen }: { skill: SkillInfo; onOpen: () => void }): React.JSX.Element {
  const fileCountLabel = skill.fileCount === 1 ? '1 file' : `${skill.fileCount} files`
  return (
    <div
      className="doc-row"
      role="button"
      tabIndex={0}
      data-skill={skill.name}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      aria-label={`Read ${skill.name}`}
    >
      <div className="doc-row-main">
        <span className="doc-row-title">{skill.name}</span>
        {skill.description && (
          <span className="doc-row-sub" title={skill.description}>
            {skill.description}
          </span>
        )}
      </div>
      <div className="doc-row-meta">
        <span>{skill.scope === 'global' ? 'Global' : 'Project'}</span>
        <span>{fileCountLabel}</span>
      </div>
    </div>
  )
}
