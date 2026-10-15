import { wantsYou, type Project, type LiveSession } from '../../../main/store/types'
import { addProject } from '../api'
import Icon from '../components/primitives/Icon'
import StatusDot from '../components/primitives/StatusDot'
import { STATUS_WORDS } from '../components/primitives/Badge'
import { resolveSessionProjectId } from '../state/useSessions'
import { useStoredState } from '../state/useStoredState'
import { sessionTitle } from '../lib/session-title'

interface Props {
  projects: Project[]
  sessions: LiveSession[]
  selectedProjectId: string | null
  onSelectProject: (id: string | null) => void
  onProjectsChanged: () => void
  onNewSession?: () => void
  /** Opens a session from under its project; `background` for ⌘-click. */
  onOpenSession?: (liveKey: string, background?: boolean) => void
  /** The session on screen now, highlighted under its project. */
  openSessionKey?: string | null
}

export default function ProjectRail({
  projects,
  sessions,
  selectedProjectId,
  onSelectProject,
  onProjectsChanged,
  onNewSession,
  onOpenSession,
  openSessionKey = null
}: Props): React.JSX.Element {
  // Projects opened to show their sessions, remembered between launches.
  const [expanded, setExpanded] = useStoredState<string[]>('rail-expanded-projects', [])
  const toggleExpanded = (id: string): void =>
    setExpanded(expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id])
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
  const sessionsByProjectId = new Map<string, LiveSession[]>()
  for (const project of projects) {
    const projectSessions = sessions.filter(
      (s) => resolveSessionProjectId(s, projects) === project.id
    )
    sessionsByProjectId.set(project.id, projectSessions)
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
        <div className="projects-rail-row">
          <span className="projects-rail-disclosure-slot" />
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
        </div>
        {sortedProjects.map((project) => {
          const hasAttention = hasAttentionByProjectId.get(project.id) ?? false
          const iconName = project.id === 'general' ? 'Terminal' : 'Folder'
          const projectSessions = sessionsByProjectId.get(project.id) ?? []
          const canExpand = Boolean(onOpenSession) && projectSessions.length > 0
          const isOpen = canExpand && expanded.includes(project.id)

          return (
            <div key={project.id} className="projects-rail-project" data-rail-project={project.id}>
              <div className="projects-rail-row">
                {/* A slot the same width either way, so names line up whether
                    or not a project has sessions to show. */}
                <span className="projects-rail-disclosure-slot">
                  {canExpand && (
                    <button
                      type="button"
                      className="projects-rail-disclosure"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Hide' : 'Show'} ${project.name} sessions`}
                      onClick={() => toggleExpanded(project.id)}
                    >
                      <Icon name={isOpen ? 'ChevronDown' : 'ChevronRight'} size={12} />
                    </button>
                  )}
                </span>
                <button
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
                    <span className="projects-rail-count">{projectSessions.length}</span>
                  </span>
                </button>
              </div>
              {isOpen && (
                <div className="projects-rail-sessions" role="list">
                  {projectSessions.map((session) => (
                    <button
                      key={session.key}
                      type="button"
                      role="listitem"
                      className={
                        session.key === openSessionKey
                          ? 'projects-rail-session projects-rail-session--open'
                          : 'projects-rail-session'
                      }
                      title={sessionTitle(session)}
                      data-rail-session={session.key}
                      onClick={(e) => onOpenSession?.(session.key, e.metaKey || e.ctrlKey)}
                      onAuxClick={(e) => {
                        if (e.button === 1) onOpenSession?.(session.key, true)
                      }}
                    >
                      <StatusDot status={session.status} size={8} />
                      <span className="projects-rail-session-title">{sessionTitle(session)}</span>
                      <span className="projects-rail-session-status">
                        {STATUS_WORDS[session.status]}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
