import { useCallback, useEffect, useMemo, useState } from 'react'
import { listProjects, listSkills, type SkillInfo } from '../../api'
import { requestOpenFile } from './openFileBus'
import NewSkillDialog from '../../components/NewSkillDialog'
import type { ToastAction } from '../../state/useToasts'
import './SkillsTab.css'

interface Props {
  projectId: string
  pushToast: (message: string, action?: ToastAction) => void
}

type ScopeFilter = 'all' | 'global' | 'project'

// Read-only cards from ~/.claude/skills/, <project>/.claude/skills/ and
// plugin skill directories (plan 2.2, Skills paragraph). skills:list is the
// only handler for this tab — there is no editor and no write action here.
// Clicking a card opens its SKILL.md in the Files tab via the openFileBus
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
        <div className="skills-tab-grid">
          {filtered.map((skill) => (
            <SkillCard
              key={`${skill.scope}:${skill.path}`}
              skill={skill}
              projectId={projectId}
              relPath={
                skill.scope === 'project' ? toProjectRelativePath(repoPath, skill.path) : null
              }
            />
          ))}
        </div>
      )}
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

/**
 * Where an unopenable skill lives, in as few characters as carry the meaning.
 *
 * Every global card used to end with "Global skill — outside this project,
 * open it at /Users/<you>/.claude/skills/<name>": three wrapped lines that
 * repeated the GLOBAL badge, repeated the skill's own name, and put the same
 * home directory on every card in the grid. The badge says the scope and the
 * heading says the name, so all that is left to say is the folder.
 */
function locationOf(skill: SkillInfo): string {
  // The renderer never learns the home directory — it only ever displays these
  // paths, so tildifying by pattern is honest here in a way acting on the path
  // would not be.
  const dir = skill.path.replace(/\/[^/]+$/, '').replace(/^\/Users\/[^/]+/, '~')
  return dir
}

function SkillCard({
  skill,
  projectId,
  relPath
}: {
  skill: SkillInfo
  projectId: string
  // The project-relative path to open this skill's SKILL.md at, or null
  // when it can't be expressed that way (every global skill, and a
  // project skill whose repoPath lookup hasn't resolved yet or failed).
  relPath: string | null
}): React.JSX.Element {
  const scopeLabel = skill.scope === 'global' ? 'Global' : 'Project'
  const fileCountLabel = skill.fileCount === 1 ? '1 file' : `${skill.fileCount} files`
  const canOpen = relPath !== null

  const openInFiles = (): void => {
    if (relPath !== null) requestOpenFile(projectId, relPath)
  }

  return (
    <div
      className={'skills-tab-card' + (canOpen ? '' : ' skills-tab-card-unopenable')}
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
          ? `Open ${skill.name} in the Files editor`
          : `${skill.name}, cannot be opened from here`
      }
    >
      <div className="skills-tab-card-header">
        <span className="skills-tab-card-name">{skill.name}</span>
        <span
          className={
            'skills-tab-scope-badge ' +
            (skill.scope === 'global'
              ? 'skills-tab-scope-badge-global'
              : 'skills-tab-scope-badge-project')
          }
        >
          {scopeLabel}
        </span>
      </div>
      {skill.description && <p className="skills-tab-card-description">{skill.description}</p>}
      <span className="skills-tab-card-filecount">{fileCountLabel}</span>
      {!canOpen && <span className="skills-tab-card-location">{locationOf(skill)}</span>}
    </div>
  )
}
