import { wantsYou, type Project, type LiveSession } from '../../../main/store/types'
import { addProject } from '../api'
import Icon from '../components/primitives/Icon'
import StatusDot from '../components/primitives/StatusDot'
import { resolveSessionProjectId } from '../state/useSessions'

interface Props {
  projects: Project[]
  sessions: LiveSession[]
  selectedProjectId: string | null
  onSelectProject: (id: string | null) => void
  onProjectsChanged: () => void
  onNewSession?: () => void
}

export default function ProjectRail({
  projects,
  sessions,
  selectedProjectId,
  onSelectProject,
  onProjectsChanged,
  onNewSession
}: Props): React.JSX.Element {
  const handleAdd = async (): Promise<void> => {
    const project = await addProject()
    if (project) onProjectsChanged()
  }

  // Count sessions for each project and check for needs_attention. Each
  // session is attributed to exactly one project (resolveSessionProjectId) —
  // matching by project id OR cwd-prefix here let a session double-count
  // into two projects that share a worktreeRoot.
  const sessionCountByProjectId = new Map<string, number>()
  const hasAttentionByProjectId = new Map<string, boolean>()
  for (const project of projects) {
    const projectSessions = sessions.filter(
      (s) => resolveSessionProjectId(s, projects) === project.id
    )
    const count = projectSessions.length
    sessionCountByProjectId.set(project.id, count)
    hasAttentionByProjectId.set(
      project.id,
      projectSessions.some((s) => wantsYou(s.status))
    )
  }

  // Count total sessions for "All"
  const allSessionsCount = sessions.length

  // Separate General project from others
  const generalProject = projects.find((p) => p.id === 'general')
  const otherProjects = projects.filter((p) => p.id !== 'general')

  // Combine with General first, then others
  const sortedProjects = [...(generalProject ? [generalProject] : []), ...otherProjects]

  return (
    <div className="projects-rail">
      <div className="projects-rail-header">
        <h2 className="projects-rail-title">Projects</h2>
        <button
          className="projects-rail-add-button"
          onClick={handleAdd}
          title="Add project"
          aria-label="Add project"
        >
          +
        </button>
      </div>
      <div className="projects-rail-items">
        <button
          className={
            selectedProjectId === null
              ? 'projects-rail-item projects-rail-item-selected'
              : 'projects-rail-item'
          }
          onClick={() => onSelectProject(null)}
        >
          <span className="projects-rail-label">All</span>
          <span className="projects-rail-count">{allSessionsCount}</span>
        </button>
        {sortedProjects.map((project) => {
          const hasAttention = hasAttentionByProjectId.get(project.id) ?? false
          const iconName = project.id === 'general' ? 'Terminal' : 'Folder'

          return (
            <button
              key={project.id}
              className={
                selectedProjectId === project.id
                  ? 'projects-rail-item projects-rail-item-selected'
                  : 'projects-rail-item'
              }
              onClick={() => onSelectProject(project.id)}
            >
              <span className="projects-rail-label-wrapper">
                <Icon name={iconName} size={16} aria-label={project.name} />
                <span className="projects-rail-label">{project.name}</span>
              </span>
              <span className="projects-rail-count-wrapper">
                {hasAttention && (
                  <StatusDot
                    status="needs_attention"
                    size={8}
                    className="projects-rail-attention-dot"
                    aria-label="Has sessions needing attention"
                  />
                )}
                <span className="projects-rail-count">
                  {sessionCountByProjectId.get(project.id) ?? 0}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      {onNewSession && (
        <div className="projects-rail-footer">
          <button
            className="projects-rail-new-session-button"
            onClick={onNewSession}
            disabled={projects.length === 0}
          >
            + New session
          </button>
        </div>
      )}
    </div>
  )
}
