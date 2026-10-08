import { useEffect, useState } from 'react'
import type { LiveSession, Project, SessionRecord } from '../../../main/store/types'
import Tabs, { type TabItem } from '../components/Tabs'
import {
  Button,
  Disclosure,
  Icon,
  IconButton,
  Input,
  Row,
  SegmentedControl,
  useConfirm
} from '../components/primitives'
import GitTab from './tabs/GitTab'
import FilesTab from './tabs/FilesTab'
import SkillsTab from './tabs/SkillsTab'
import RulesTab from './tabs/RulesTab'
import HistoryPanel from './HistoryPanel'
import { useSessionActions } from '../components/useSessionActions'
import HomeScreen from './HomeScreen'
import SessionCard from '../components/SessionCard'
import WorktreeCleanupDialog from '../components/WorktreeCleanupDialog'
import { useWorktreeChoice } from '../state/useWorktreeChoice'
import { useHomeDir } from '../state/useHomeDir'
import { formatHomePath } from '../lib/format-path'
import { revealProjectInFinder } from '../api-projects'
import {
  createSession,
  listAllWorktrees,
  adoptWorktree,
  removeWorktree,
  listSessionRecordsForProject,
  updateWorktreeDefaults,
  type ProjectWorktree,
  type WorktreeDefaultsPatch
} from '../api'

const TABS: TabItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'git', label: 'Git' },
  { id: 'files', label: 'Files' },
  { id: 'skills', label: 'Skills' },
  { id: 'rules', label: 'Rules' }
]

function isLive(status: LiveSession['status']): boolean {
  return status !== 'stopped' && status !== 'missing'
}

interface Props {
  project: Project
  sessions: LiveSession[]
  onBack: () => void
  onSessionsChanged: () => void
  onProjectsChanged: () => void
  onOpenSession: (liveKey: string, background?: boolean) => void
  pushToast: (message: string) => void
  // Dev shot harness only: lets `npm run shot` land directly on a tab other
  // than the default (e.g. `project-detail-git`, `project-detail-files`).
  initialTab?: string
  // Dev shot harness only: lands the Overview tab's History section on CLI.
  initialHistoryTab?: 'recent' | 'cli'
}

export default function ProjectDetail({
  project,
  sessions,
  onBack,
  onSessionsChanged,
  onProjectsChanged,
  onOpenSession,
  pushToast,
  initialTab,
  initialHistoryTab
}: Props): React.JSX.Element {
  const homeDir = useHomeDir()
  const displayPath = formatHomePath(project.repoPath, homeDir)

  const handleCopyPath = (): void => {
    void navigator.clipboard
      .writeText(project.repoPath)
      .then(() => {
        pushToast('Copied')
      })
      .catch(() => {
        pushToast('Could not copy the path')
      })
  }

  const handleReveal = async (): Promise<void> => {
    const error = await revealProjectInFinder(project.id)
    if (error) pushToast(error)
  }

  const [activeTab, setActiveTab] = useState(initialTab ?? 'overview')
  // Only used by the dev shot harness: when a caller re-renders this screen
  // with a different `initialTab` for the same project (switching which shot
  // screen is being captured), follow it rather than staying stuck on
  // whichever tab was active first. Adjusted during render (React's own
  // pattern for "state derived from a changed prop") rather than an effect,
  // so it never causes an extra commit.
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab)
  if (initialTab !== prevInitialTab) {
    setPrevInitialTab(initialTab)
    setActiveTab(initialTab ?? 'overview')
  }

  return (
    <div className="project-detail">
      <div className="project-detail-header">
        <button
          type="button"
          className="project-detail-back"
          onClick={onBack}
          title="Back to projects"
          aria-label="Back to projects"
        >
          ←
        </button>
        <span className="project-detail-folder" aria-hidden="true">
          <Icon name={project.id === 'general' ? 'Terminal' : 'Folder'} size={16} />
        </span>
        <div className="project-detail-title">
          <h2>{project.name}</h2>
          <span className="project-detail-path-row">
            <button
              type="button"
              className="project-detail-path"
              onClick={handleCopyPath}
              title={`${project.repoPath} - click to copy`}
            >
              <bdi>{displayPath}</bdi>
            </button>
            <IconButton
              icon="FolderOpen"
              label="Reveal in Finder"
              size={28}
              variant="ghost"
              onClick={handleReveal}
            />
          </span>
        </div>
      </div>

      <Tabs tabs={TABS} activeId={activeTab} onSelect={setActiveTab} />

      <div className="project-detail-body">
        {activeTab === 'overview' && (
          <OverviewTab
            project={project}
            sessions={sessions}
            onSessionsChanged={onSessionsChanged}
            onProjectsChanged={onProjectsChanged}
            onOpenSession={onOpenSession}
            pushToast={pushToast}
            initialHistoryTab={initialHistoryTab}
          />
        )}
        {activeTab === 'git' && (
          <GitTab
            projectId={project.id}
            // Every session of this project that has a branch of its own —
            // which is every one started on a worktree.
            worktrees={sessions
              .filter((s) => s.record && s.record.projectId === project.id && s.record.branch)
              .map((s) => ({
                id: s.record!.id,
                title: s.record!.title,
                branch: s.record!.branch
              }))}
          />
        )}
        {activeTab === 'files' && <FilesTab projectId={project.id} />}
        {activeTab === 'skills' && <SkillsTab projectId={project.id} pushToast={pushToast} />}
        {activeTab === 'rules' && <RulesTab projectId={project.id} pushToast={pushToast} />}
      </div>
    </div>
  )
}

function OverviewTab({
  project,
  sessions,
  onSessionsChanged,
  onProjectsChanged,
  onOpenSession,
  pushToast,
  initialHistoryTab
}: {
  project: Project
  sessions: LiveSession[]
  onSessionsChanged: () => void
  onProjectsChanged: () => void
  onOpenSession: (liveKey: string, background?: boolean) => void
  pushToast: (message: string) => void
  initialHistoryTab?: 'recent' | 'cli'
}): React.JSX.Element {
  const worktreeHomeDir = useHomeDir()
  const [sessionActionNode, sessionActions] = useSessionActions({
    pushToast,
    onChanged: () => {
      onSessionsChanged()
      refreshRecords()
    }
  })
  const [confirmNode, confirm] = useConfirm()
  const [worktreeMode] = useWorktreeChoice()
  const [busy, setBusy] = useState(false)
  // Every worktree on disk but the main checkout: the ones with a session
  // and the ones without. Listing only the unattached ones said "None yet"
  // to someone with two dozen.
  const [worktrees, setWorktrees] = useState<ProjectWorktree[]>([])
  const [records, setRecords] = useState<SessionRecord[]>([])
  const [worktreesOpen, setWorktreesOpen] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)

  const refreshWorktrees = (): void => {
    listAllWorktrees(project.id).then((all) => setWorktrees(all.filter((w) => !w.isMainCheckout)))
  }

  // History reads this list, so anything that changes a record has to call it.
  // It used to be loaded once per project and never again: `onRecordsChanged`
  // was wired to the app's live-session refresh, which reloads running
  // sessions and knows nothing about `archivedAt`. Marking a session done
  // therefore left its row sitting under Active until you navigated away from
  // the project and back — including when you marked it from History itself.
  const refreshRecords = (): void => {
    void listSessionRecordsForProject(project.id).then(setRecords)
  }

  useEffect(() => {
    refreshWorktrees()
    refreshRecords()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // Only the empty path remains here — the composer above owns the rest.
  // "Quick empty session" is the one creation that has no prompt to type.
  const startEmpty = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await createSession({
        creationId: crypto.randomUUID(),
        projectId: project.id,
        basedOn: worktreeMode ? 'new' : undefined,
        investigate: !worktreeMode
      })
      if (result.ok) {
        onSessionsChanged()
        listSessionRecordsForProject(project.id).then(setRecords)
      } else {
        pushToast(result.error ?? 'Could not start the session.')
      }
    } catch {
      pushToast('Could not start the session.')
    } finally {
      setBusy(false)
    }
  }

  const handleStartEmpty = (): void => {
    if (busy) return
    void startEmpty()
  }

  const handleAdopt = async (path: string): Promise<void> => {
    try {
      const record = await adoptWorktree(project.id, path)
      if (!record) {
        pushToast(`Could not adopt worktree at ${path}.`)
        return
      }
      refreshWorktrees()
      onSessionsChanged()
    } catch {
      pushToast(`Could not adopt worktree at ${path}.`)
    }
  }

  const handleRemoveWorktree = async (path: string): Promise<void> => {
    const confirmed = await confirm({
      title: 'Remove this worktree?',
      body: `${path} will be deleted from disk.`,
      confirmLabel: 'Remove worktree',
      danger: true
    })
    if (!confirmed) return
    try {
      const ok = await removeWorktree(project.id, path)
      if (!ok) {
        pushToast(`Could not remove worktree at ${path}.`)
        return
      }
      refreshWorktrees()
    } catch {
      pushToast(`Could not remove worktree at ${path}.`)
    }
  }

  const projectSessions = sessions.filter((s) => s.record?.projectId === project.id)
  // Archived records drop off the board without anything being stopped — that
  // is what the tile menu's "Remove from Active" does, and what History's
  // "Add to Active" undoes. Liveness alone decided this before, so the board
  // was a readout rather than something you could arrange.
  const activeSessions = projectSessions.filter((s) => isLive(s.status) && !s.record?.archivedAt)

  const findLiveKey = (recordId: string): string | null =>
    sessions.find((s) => s.record?.id === recordId)?.key ?? null

  return (
    <div className="overview-tab">
      {/* The same composer as Home and the New session sheet, locked to this
          project. This screen had its own, which meant starting a session from
          a project page silently gave you the default model, no plan mode, no
          thinking level and no attachments — four controls that simply did not
          exist here. "Start empty" went with it: the Quick empty session tile
          below already does exactly that. */}
      <HomeScreen
        variant="sheet"
        initialProjectId={project.id}
        lockProject
        onSessionCreated={(record) => {
          onSessionsChanged()
          onOpenSession(`record:${record.id}`)
        }}
      />

      <section className="overview-section">
        <h3 className="overview-section-header">ACTIVE</h3>
        {activeSessions.length === 0 ? (
          <div className="cr-active-grid">
            <QuickEmptyTile onClick={handleStartEmpty} disabled={busy} />
          </div>
        ) : (
          <div className="cr-active-grid">
            {activeSessions.map((session) => (
              <SessionCard
                key={session.key}
                session={session}
                onOpen={(background) => onOpenSession(session.key, background)}
                // The same menu a session gets on Home and anywhere else —
                // see useSessionActions.
                actions={sessionActions(session)}
              />
            ))}
            <QuickEmptyTile onClick={handleStartEmpty} disabled={busy} />
          </div>
        )}
      </section>

      {confirmNode}
      {sessionActionNode}

      <section className="overview-section">
        <Disclosure
          label="Worktrees"
          hint={(() => {
            if (worktrees.length === 0)
              return 'None yet: a session makes one when you start it on a new worktree'
            const idle = worktrees.filter((w) => !w.sessionId).length
            const total = `${worktrees.length} on disk`
            return idle ? `${total}, ${idle} with no session` : total
          })()}
          open={worktreesOpen}
          onToggle={setWorktreesOpen}
        >
          <Row justify="flex-start" className="overview-worktrees-actions">
            <Button variant="outlined" size="compact" onClick={() => setCleanupOpen(true)}>
              Clean up worktrees
            </Button>
          </Row>
          <div className="cr-worktree-grid">
            {worktrees.map((w) => (
              <div key={w.path} className="cr-worktree-card">
                <div className="cr-worktree-card-path" title={w.path}>
                  <bdi>{formatHomePath(w.path, worktreeHomeDir)}</bdi>
                </div>
                <div className="cr-worktree-card-branch">
                  {w.branch ?? 'detached'}
                  {w.dirty && <span className="cr-worktree-card-dirty">uncommitted changes</span>}
                </div>
                <div className="cr-worktree-card-actions">
                  {w.sessionId ? (
                    // In use: open its session. Removing it here would pull the
                    // worktree out from under a running agent.
                    (() => {
                      const live = findLiveKey(w.sessionId)
                      return live ? (
                        <button type="button" onClick={() => onOpenSession(live)}>
                          Open session
                        </button>
                      ) : (
                        <span className="cr-worktree-card-note">Session ended</span>
                      )
                    })()
                  ) : (
                    <>
                      <button type="button" onClick={() => handleAdopt(w.path)}>
                        Start agent
                      </button>
                      <button type="button" onClick={() => handleRemoveWorktree(w.path)}>
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              className="cr-worktree-card cr-worktree-card--new"
              onClick={handleStartEmpty}
              disabled={busy}
            >
              ＋ New
            </button>
          </div>
        </Disclosure>
      </section>

      {cleanupOpen && (
        <WorktreeCleanupDialog
          projectId={project.id}
          projectName={project.name}
          onClose={() => setCleanupOpen(false)}
          onCleaned={refreshWorktrees}
          pushToast={pushToast}
        />
      )}

      <WorktreeSettingsSection
        project={project}
        onProjectsChanged={onProjectsChanged}
        pushToast={pushToast}
      />

      <HistoryPanel
        projectId={project.id}
        records={records}
        findLiveKey={findLiveKey}
        isRunning={(recordId) =>
          sessions.some((s) => s.record?.id === recordId && isLive(s.status))
        }
        onOpenSession={onOpenSession}
        pushToast={pushToast}
        onRecordsChanged={() => {
          onSessionsChanged()
          refreshRecords()
        }}
        initialTab={initialHistoryTab}
      />
    </div>
  )
}

// Plan 4 Part 7.2 — per-project worktree settings (base branch, fetch
// before create, post-checkout/pre-delete commands, sparse checkout,
// ignored-file carry mode). Same collapsible-section shape as WORKTREES
// above; the fields themselves follow SettingsScreen's label/input/action
// pattern rather than inventing a new one.
function WorktreeSettingsSection({
  project,
  onProjectsChanged,
  pushToast
}: {
  project: Project
  onProjectsChanged: () => void
  pushToast: (message: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [baseBranch, setBaseBranch] = useState(project.worktreeBaseBranch ?? '')
  const [fetchBeforeCreate, setFetchBeforeCreate] = useState(
    project.worktreeFetchBeforeCreate ?? true
  )
  const [postCheckoutCommand, setPostCheckoutCommand] = useState(project.setupCommand ?? '')
  const [preDeleteCommand, setPreDeleteCommand] = useState(project.worktreePreDeleteCommand ?? '')
  const [sparseDirectories, setSparseDirectories] = useState(
    (project.worktreeSparseDirectories ?? []).join('\n')
  )
  const [ignoredFilesMode, setIgnoredFilesMode] = useState<'symlink' | 'copy' | 'none'>(
    project.ignoredFilesMode ?? 'symlink'
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Follow the project prop when it changes underneath this section (e.g.
  // switching projects, or a save landing) rather than fighting a stale
  // local draft.
  const [syncedProjectId, setSyncedProjectId] = useState(project.id)
  if (project.id !== syncedProjectId) {
    setSyncedProjectId(project.id)
    setBaseBranch(project.worktreeBaseBranch ?? '')
    setFetchBeforeCreate(project.worktreeFetchBeforeCreate ?? true)
    setPostCheckoutCommand(project.setupCommand ?? '')
    setPreDeleteCommand(project.worktreePreDeleteCommand ?? '')
    setSparseDirectories((project.worktreeSparseDirectories ?? []).join('\n'))
    setIgnoredFilesMode(project.ignoredFilesMode ?? 'symlink')
  }

  const handleSave = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const patch: WorktreeDefaultsPatch = {
      baseBranch: baseBranch.trim(),
      fetchBeforeCreate,
      postCheckoutCommand,
      preDeleteCommand: preDeleteCommand.trim(),
      sparseDirectories: sparseDirectories
        .split(/[\n,]/)
        .map((d) => d.trim())
        .filter(Boolean),
      ignoredFilesMode
    }
    try {
      const result = await updateWorktreeDefaults(project.id, patch)
      if (!result.ok) {
        setError(result.error ?? 'failed to save worktree settings')
        return
      }
      pushToast('Worktree settings saved.')
      onProjectsChanged()
    } catch {
      setError('failed to save worktree settings')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="overview-section">
      <Disclosure
        label="Worktree settings"
        hint="Used when a session starts on a new worktree"
        open={open}
        onToggle={setOpen}
      >
        <div className="cr-worktree-settings">
          <label className="cr-worktree-settings-field">
            Start from branch
            <Input
              placeholder="The remote's default branch"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className="cr-worktree-settings-field">
            Setup command
            <Input
              placeholder="npm install"
              value={postCheckoutCommand}
              onChange={(e) => setPostCheckoutCommand(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className="cr-worktree-settings-toggle">
            <input
              type="checkbox"
              checked={fetchBeforeCreate}
              onChange={(e) => setFetchBeforeCreate(e.target.checked)}
              disabled={busy}
            />
            Fetch from origin first
          </label>

          {/* The three below are the ones most projects never touch, so they
              start folded rather than making every visit read six fields to
              find the two that matter. */}
          <Disclosure label="Advanced" open={advancedOpen} onToggle={setAdvancedOpen}>
            <div className="cr-worktree-settings">
              <label className="cr-worktree-settings-field">
                Cleanup command
                <Input
                  placeholder="Runs before a worktree is deleted"
                  value={preDeleteCommand}
                  onChange={(e) => setPreDeleteCommand(e.target.value)}
                  disabled={busy}
                />
              </label>

              <label className="cr-worktree-settings-field">
                Check out only these folders
                <textarea
                  placeholder="One per line. Empty checks out everything."
                  value={sparseDirectories}
                  onChange={(e) => setSparseDirectories(e.target.value)}
                  disabled={busy}
                  rows={3}
                />
              </label>

              <div className="cr-worktree-settings-field">
                Ignored files
                <SegmentedControl
                  value={ignoredFilesMode}
                  onChange={setIgnoredFilesMode}
                  aria-label="What to do with ignored files"
                  options={[
                    { value: 'symlink', label: 'Link' },
                    { value: 'copy', label: 'Copy' },
                    { value: 'none', label: 'Skip' }
                  ]}
                />
              </div>
            </div>
          </Disclosure>

          {error && <p className="settings-error">{error}</p>}

          <div className="settings-actions">
            {/* Outlined, not filled: "Start session" at the top of this screen
                is its one accent button (plan 3 section 1.6). */}
            <Button onClick={handleSave} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Disclosure>
    </section>
  )
}

function QuickEmptyTile({
  onClick,
  disabled
}: {
  onClick: () => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="cr-session-card cr-session-card--new"
      onClick={onClick}
      disabled={disabled}
    >
      ＋ Quick empty session
    </button>
  )
}
