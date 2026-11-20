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
import HomeScreen from './HomeScreen'
import { useDevContainer } from '../state/useDevContainer'
import { SessionCard } from './SessionsScreen'
import WorktreeCleanupDialog from '../components/WorktreeCleanupDialog'
import WorktreeOverlay from '../components/WorktreeOverlay'
import WorktreeCard from '../components/WorktreeCard'
import { groupOf, type WorktreeGroup } from '../lib/worktreeGroup'
import '../components/session-card.css'
import { useWorktreeChoice } from '../state/useWorktreeChoice'
import { useHomeDir } from '../state/useHomeDir'
import { useTicketKeys } from '../state/useTicketKeys'
import { formatHomePath } from '../lib/format-path'
import { revealProjectInFinder, wrapUpWorktree } from '../api-projects'
import {
  createSession,
  listAllWorktrees,
  adoptWorktree,
  removeWorktree,
  listSessionRecordsForProject,
  updateWorktreeDefaults,
  listWorktreePullRequests,
  type ProjectWorktree,
  type WorktreePullRequest,
  type WorktreeDefaultsPatch
} from '../api'
import type { PushToast } from '../state/useToasts'

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
  pushToast: PushToast
  // Dev shot harness only: lets `npm run shot` land directly on a tab other
  // than the default (e.g. `project-detail-git`, `project-detail-files`).
  initialTab?: string
  // Dev shot harness only: lands the Overview tab's History section on CLI.
  initialHistoryTab?: 'recent' | 'cli'
  /** Opens a Jira ticket in the side panel, as a session header's ticket pill does. */
  onOpenTicket?: (key: string, list?: string[]) => void
}

export default function ProjectDetail({
  project,
  sessions,
  onBack,
  onSessionsChanged,
  onProjectsChanged,
  onOpenSession,
  pushToast,
  onOpenTicket,
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
            onOpenTicket={onOpenTicket}
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
  onOpenTicket,
  initialHistoryTab
}: {
  project: Project
  sessions: LiveSession[]
  onSessionsChanged: () => void
  onProjectsChanged: () => void
  onOpenSession: (liveKey: string, background?: boolean) => void
  pushToast: PushToast
  onOpenTicket?: (key: string, list?: string[]) => void
  initialHistoryTab?: 'recent' | 'cli'
}): React.JSX.Element {
  const worktreeHomeDir = useHomeDir()
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
  // The worktree whose overlay is open, by path.
  const [openWorktree, setOpenWorktree] = useState<string | null>(null)

  // What each worktree is attached to beyond its session: the branch's pull
  // request, and the Jira ticket it's for. Both load after the cards.
  const [worktreePrs, setWorktreePrs] = useState<Record<string, WorktreePullRequest>>({})
  const ticketKey = useTicketKeys()

  const refreshWorktrees = (): void => {
    listAllWorktrees(project.id).then((all) => setWorktrees(all.filter((w) => !w.isMainCheckout)))
    void listWorktreePullRequests(project.id).then(setWorktreePrs)
  }

  // The Claude running in a worktree: its own session's, else any alive one
  // whose folder is inside it. "Mark as done" leaves Claude at its prompt, so
  // matching only by the open record called those "no session" and offered
  // Start agent beside a Claude that was still there.
  const claudeIn = (w: ProjectWorktree): LiveSession | undefined => {
    const own = w.sessionId ? sessions.find((s) => s.record?.id === w.sessionId) : undefined
    if (own && isLive(own.status)) return own
    const root = w.path.replace(/\/+$/, '')
    return sessions.find((s) => {
      if (!s.alive || s.status === 'shell' || !isLive(s.status)) return false
      const at = (s.record?.worktreePath ?? s.cwd).replace(/\/+$/, '')
      return at === root || at.startsWith(root + '/')
    })
  }

  // The ticket a worktree is for: the one its session is linked to, else a
  // key from one of your Jira projects in its branch or session title.
  const ticketFor = (w: ProjectWorktree, branch: string | null): string | null => {
    const recordId = w.sessionId ?? w.doneSession?.id
    const record = recordId ? records.find((r) => r.id === recordId) : undefined
    return ticketKey(record) ?? ticketKey({ id: '', branch })
  } // Every worktree's ticket, in card order, so J/K steps through them.
  const worktreeTickets = [
    ...new Set(
      worktrees
        .map((w) => ticketFor(w, w.branch?.replace(/^refs\/heads\//, '') ?? null))
        .filter((k): k is string => k !== null)
    )
  ]

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
  // It follows the Settings default for dev containers; the composer above
  // has the button for the other choice.
  const devContainer = useDevContainer(project.id)
  const startEmpty = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await createSession({
        creationId: crypto.randomUUID(),
        projectId: project.id,
        basedOn: worktreeMode ? 'new' : undefined,
        investigate: !worktreeMode,
        devContainer: devContainer.available && devContainer.byDefault
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

  const handleRemoveWorktree = async (path: string, sessionTitle?: string): Promise<void> => {
    const confirmed = await confirm({
      title: 'Remove this worktree?',
      body: sessionTitle
        ? `${path} will be deleted from disk. Its session, ${sessionTitle}, can't be resumed after this and moves to Ended in History.`
        : `${path} will be deleted from disk.`,
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
      refreshRecords()
      onSessionsChanged()
    } catch {
      pushToast(`Could not remove worktree at ${path}.`)
    }
  }

  const handleWrapUp = async (
    path: string,
    prNumber: number,
    sessionTitle?: string
  ): Promise<void> => {
    const confirmed = await confirm({
      title: 'Wrap up this worktree?',
      body: `Pull request #${prNumber} is merged. ${
        sessionTitle
          ? `The agent in ${sessionTitle} stops and the session moves to Ended in History. `
          : ''
      }${path} is deleted from disk and its branch is deleted locally. GitHub keeps everything.`,
      confirmLabel: 'Wrap up',
      danger: true
    })
    if (!confirmed) return
    try {
      const res = await wrapUpWorktree(project.id, path)
      if (!res.ok) {
        pushToast(res.error ?? `Could not wrap up the worktree at ${path}.`)
        return
      }
      pushToast(
        res.branchDeleted
          ? `Wrapped up #${prNumber}. Worktree and branch deleted.`
          : `Wrapped up #${prNumber}. Worktree deleted. ${res.note ?? 'The branch was kept.'}`
      )
      refreshWorktrees()
      refreshRecords()
      onSessionsChanged()
    } catch {
      pushToast(`Could not wrap up the worktree at ${path}.`)
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
        <h3 className="overview-section-header">Active</h3>
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
                onChanged={() => {
                  onSessionsChanged()
                  refreshRecords()
                }}
                pushToast={pushToast}
              />
            ))}
            <QuickEmptyTile onClick={handleStartEmpty} disabled={busy} />
          </div>
        )}
      </section>

      {confirmNode}

      <section className="overview-section">
        {(() => {
          // Every worktree with what it needs to judge it, worked out once.
          const cards = worktrees.map((w) => {
            const branch = w.branch?.replace(/^refs\/heads\//, '') ?? null
            const pr = branch ? worktreePrs[branch] : undefined
            const claude = claudeIn(w)
            const sessionRecord = w.sessionId
              ? records.find((r) => r.id === w.sessionId)
              : undefined
            const sessionTitle =
              claude?.record?.title ?? sessionRecord?.title ?? w.doneSession?.title ?? null
            return { w, branch, pr, claude, sessionTitle, group: groupOf(w, pr, claude) }
          })
          const counts = {
            ready: cards.filter((c) => c.group === 'ready').length,
            inUse: cards.filter((c) => c.group === 'inUse').length,
            idle: cards.filter((c) => c.group === 'idle').length
          }
          const GROUPS: { id: WorktreeGroup; label: string }[] = [
            { id: 'ready', label: 'Ready to remove' },
            { id: 'inUse', label: 'Claude running' },
            { id: 'idle', label: 'Idle' }
          ]
          const plural = (n: number): string => `${n} worktree${n === 1 ? '' : 's'}`
          return (
            <Disclosure
              label="Worktrees"
              hint={
                worktrees.length === 0
                  ? 'None yet: a session makes one when you start it on a new worktree'
                  : counts.ready > 0
                    ? `${plural(worktrees.length)}, ${counts.ready} ready to remove`
                    : plural(worktrees.length)
              }
              open={worktreesOpen}
              onToggle={setWorktreesOpen}
            >
              <Row justify="flex-start" className="overview-worktrees-actions">
                <Button variant="outlined" size="compact" onClick={() => setCleanupOpen(true)}>
                  Clean up worktrees
                </Button>
              </Row>
              {GROUPS.filter((g) => counts[g.id] > 0).map((g) => (
                <div key={g.id} className="cr-worktree-group">
                  <div className="cr-worktree-group-head">
                    <span className="cr-worktree-group-label">{g.label}</span>
                    <span className="cr-worktree-group-count">{counts[g.id]}</span>
                    {g.id === 'ready' && counts.ready > 1 && (
                      <Button
                        variant="ghost"
                        size="compact"
                        className="cr-worktree-group-action"
                        onClick={() => setCleanupOpen(true)}
                      >
                        Review and remove {counts.ready}
                      </Button>
                    )}
                  </div>
                  <div className="cr-worktree-grid">
                    {cards
                      .filter((c) => c.group === g.id)
                      .map(({ w, branch, pr, claude, sessionTitle }) => (
                        <WorktreeCard
                          key={w.path}
                          worktree={w}
                          branch={branch}
                          sessionTitle={sessionTitle}
                          claude={claude}
                          pr={pr}
                          ticket={ticketFor(w, branch)}
                          onOpen={() => setOpenWorktree(w.path)}
                          onOpenTicket={
                            onOpenTicket ? (key) => onOpenTicket(key, worktreeTickets) : undefined
                          }
                          onOpenSession={(key) => onOpenSession(key)}
                          onStartAgent={() => handleAdopt(w.path)}
                          onRemove={() => handleRemoveWorktree(w.path, sessionTitle ?? undefined)}
                          onWrapUp={(n) => handleWrapUp(w.path, n, sessionTitle ?? undefined)}
                        />
                      ))}
                    {g.id === 'idle' && (
                      <button
                        type="button"
                        className="cr-worktree-card cr-worktree-card--new"
                        onClick={handleStartEmpty}
                        disabled={busy}
                      >
                        ＋ New
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {counts.idle === 0 && (
                <div className="cr-worktree-grid">
                  <button
                    type="button"
                    className="cr-worktree-card cr-worktree-card--new"
                    onClick={handleStartEmpty}
                    disabled={busy}
                  >
                    ＋ New
                  </button>
                </div>
              )}
            </Disclosure>
          )
        })()}
      </section>

      {(() => {
        const w = worktrees.find((x) => x.path === openWorktree)
        if (!w) return null
        const branch = w.branch?.replace(/^refs\/heads\//, '') ?? null
        // The same Claude the card shows, so the overlay never offers Start
        // agent beside one that's still running.
        const liveSession =
          claudeIn(w) ??
          (w.sessionId ? sessions.find((s) => s.record?.id === w.sessionId) : undefined)
        const running = liveSession !== undefined && isLive(liveSession.status)
        const pastTitle = w.sessionId
          ? records.find((r) => r.id === w.sessionId)?.title
          : w.doneSession?.title
        const wrapPr = branch ? worktreePrs[branch] : undefined
        const close = (): void => setOpenWorktree(null)
        return (
          <WorktreeOverlay
            projectId={project.id}
            worktree={w}
            displayPath={formatHomePath(w.path, worktreeHomeDir)}
            branch={branch}
            liveSession={liveSession}
            sessionTitle={liveSession ? undefined : pastTitle}
            pr={branch ? worktreePrs[branch] : undefined}
            ticket={ticketFor(w, branch)}
            onOpenSession={
              liveSession
                ? () => {
                    close()
                    onOpenSession(liveSession.key)
                  }
                : undefined
            }
            onStartAgent={
              w.sessionId || running
                ? undefined
                : () => {
                    close()
                    void handleAdopt(w.path)
                  }
            }
            onRemove={
              liveSession?.status === 'working' || liveSession?.status === 'needs_attention'
                ? undefined
                : () => {
                    close()
                    void handleRemoveWorktree(w.path, liveSession?.record?.title ?? pastTitle)
                  }
            }
            onWrapUp={
              wrapPr?.state === 'MERGED'
                ? () => {
                    close()
                    void handleWrapUp(
                      w.path,
                      wrapPr.number,
                      liveSession?.record?.title ?? pastTitle
                    )
                  }
                : undefined
            }
            onOpenTicket={
              onOpenTicket
                ? (key) => {
                    close()
                    onOpenTicket(key, worktreeTickets)
                  }
                : undefined
            }
            pushToast={pushToast}
            onClose={close}
          />
        )
      })()}

      {cleanupOpen && (
        <WorktreeCleanupDialog
          projectId={project.id}
          projectName={project.name}
          onClose={() => setCleanupOpen(false)}
          onCleaned={refreshWorktrees}
          pushToast={pushToast}
          onOpenSession={(key) => onOpenSession(key)}
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
        liveOf={(recordId) => sessions.find((s) => s.record?.id === recordId)}
        onOpenTicket={onOpenTicket}
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
  pushToast: PushToast
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
