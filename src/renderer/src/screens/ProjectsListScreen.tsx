import { useMemo, useState } from 'react'
import type { LiveSession, Project } from '../../../main/store/types'
import ProjectRow from '../components/ProjectRow'
import { Button, Icon, SegmentedControl, useConfirm } from '../components/primitives'
import { addProject, removeProject, updateProject } from '../api'
import { resolveSessionProjectId } from '../state/useSessions'

type SortMode = 'changed' | 'lastSession' | 'activeSessions' | 'visits'

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'changed', label: 'Recently Changed' },
  { value: 'lastSession', label: 'Last Session' },
  { value: 'activeSessions', label: 'Active Sessions' },
  { value: 'visits', label: 'Most Visited' }
]

interface Props {
  projects: Project[]
  sessions: LiveSession[]
  onProjectsChanged: () => void
  onOpenProject: (id: string) => void
  pushToast: (message: string) => void
}

function isLive(status: LiveSession['status']): boolean {
  return status !== 'stopped' && status !== 'missing'
}

export default function ProjectsListScreen({
  projects,
  sessions,
  onProjectsChanged,
  onOpenProject,
  pushToast
}: Props): React.JSX.Element {
  const [sortMode, setSortMode] = useState<SortMode>('changed')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  const byProject = useMemo(() => {
    const map = new Map<
      string,
      { activeCount: number; totalCount: number; lastChangedAt: number | null; branch: string }
    >()
    for (const project of projects) {
      const projectSessions = sessions.filter(
        (s) => resolveSessionProjectId(s, projects) === project.id
      )
      const activeCount = projectSessions.filter((s) => isLive(s.status)).length
      // Not updatedAt: that's stamped with now on every check, so every
      // project with a session read "changed just now".
      const lastChangedAt = projectSessions.reduce<number | null>((max, s) => {
        const at = s.activityAt ?? s.record?.createdAt ?? null
        return at !== null && (max === null || at > max) ? at : max
      }, null)
      map.set(project.id, {
        activeCount,
        totalCount: projectSessions.length,
        lastChangedAt: lastChangedAt ?? project.addedAt,
        // No single "current branch" for a project with many worktrees —
        // show the base ref new sessions are cut from, which needs no
        // extra IPC round trip.
        branch: project.baseRef
      })
    }
    return map
  }, [projects, sessions])

  const sorted = useMemo(() => {
    const copy = [...projects]
    copy.sort((a, b) => {
      // General project sorts first, regardless of sort mode.
      if (a.id === 'general' && b.id !== 'general') return -1
      if (a.id !== 'general' && b.id === 'general') return 1
      // Pinned rows sort next, before other projects.
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1

      const infoA = byProject.get(a.id)
      const infoB = byProject.get(b.id)
      if (sortMode === 'activeSessions')
        return (infoB?.activeCount ?? 0) - (infoA?.activeCount ?? 0)
      if (sortMode === 'visits') return (infoB?.totalCount ?? 0) - (infoA?.totalCount ?? 0)
      if (sortMode === 'lastSession')
        return (infoB?.lastChangedAt ?? 0) - (infoA?.lastChangedAt ?? 0)
      // Default to 'changed'
      return (infoB?.lastChangedAt ?? 0) - (infoA?.lastChangedAt ?? 0)
    })
    return copy
  }, [projects, byProject, sortMode])

  const [confirmNode, confirm] = useConfirm()

  const handleAdd = async (): Promise<void> => {
    const project = await addProject()
    if (project) onProjectsChanged()
  }

  const handlePin = async (project: Project): Promise<void> => {
    const result = await updateProject(project.id, { pinned: !project.pinned })
    if (!result) {
      pushToast('Failed to update project.')
      return
    }
    // The row re-sorts under the cursor, which on its own reads as a glitch
    // rather than a result. Naming it is enough — the pin beside the name
    // says what the state is, so the toast does not have to explain it.
    pushToast(project.pinned ? `${project.name} unpinned` : `${project.name} pinned`)
    onProjectsChanged()
  }

  const startRename = (project: Project): void => {
    setRenamingId(project.id)
    setRenameValue(project.name)
    setRenameError(null)
  }

  const cancelRename = (): void => {
    setRenamingId(null)
    setRenameError(null)
  }

  const submitRename = async (project: Project): Promise<void> => {
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setRenameError('name cannot be empty')
      return
    }
    if (trimmed === project.name) {
      setRenamingId(null)
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      const result = await updateProject(project.id, { name: trimmed })
      if (!result) {
        setRenameError('failed to rename project')
        return
      }
      setRenamingId(null)
      onProjectsChanged()
    } catch {
      setRenameError('failed to rename project')
    } finally {
      setRenameBusy(false)
    }
  }

  const handleRemove = async (project: Project): Promise<void> => {
    const confirmed = await confirm({
      title: `Remove ${project.name}?`,
      body: 'This only removes it from Control Room. The repo on disk is never touched.',
      confirmLabel: 'Remove project',
      danger: true
    })
    if (!confirmed) return
    await removeProject(project.id)
    onProjectsChanged()
  }

  return (
    <div className="projects-list-screen">
      {confirmNode}
      <div className="projects-list-header">
        <div className="projects-list-title-row">
          <div className="projects-list-title-block">
            <h1 className="projects-list-title">Your Projects</h1>
            <p className="projects-list-count">
              {projects.length} project{projects.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="projects-list-header-buttons">
            <Button variant="filled" size="default" onClick={handleAdd}>
              + Add Project
            </Button>
          </div>
        </div>
        <div className="projects-list-sort">
          <Icon name="ArrowUpDown" size={16} />
          <span className="projects-list-sort-label">Sort by:</span>
          <SegmentedControl
            options={SORT_OPTIONS}
            value={sortMode}
            onChange={setSortMode}
            aria-label="Sort projects by"
          />
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="empty-state-block">
          <p className="empty-state-title">No projects yet</p>
          <p className="empty-state-caption">Add a git repo to start a session against it.</p>
          {/* The header's "Add project" button (above) is already the screen's one filled
              action (plan 3, 1.6 / checklist #7) — this stays outlined so the empty state
              never doubles up on it. */}
          <Button variant="outlined" onClick={handleAdd}>
            Add project
          </Button>
        </div>
      ) : (
        <div className="project-card-list">
          {sorted.map((project) => {
            const info = byProject.get(project.id)
            const isRenaming = renamingId === project.id
            return (
              <ProjectRow
                key={project.id}
                project={project}
                lastChangedAt={info?.lastChangedAt ?? null}
                branch={info?.branch ?? project.baseRef}
                activeCount={info?.activeCount ?? 0}
                totalCount={info?.totalCount ?? 0}
                onOpen={() => onOpenProject(project.id)}
                onPin={() => handlePin(project)}
                onEdit={() => startRename(project)}
                onRemove={() => handleRemove(project)}
                renaming={isRenaming}
                renameValue={isRenaming ? renameValue : ''}
                renameBusy={renameBusy}
                renameError={isRenaming ? renameError : null}
                onRenameChange={(value) => setRenameValue(value)}
                onRenameSubmit={() => submitRename(project)}
                onRenameCancel={cancelRename}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
