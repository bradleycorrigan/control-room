import { useEffect, useState } from 'react'
import type { SessionRecord } from '../../../main/store/types'
import type { CliHistoryEntry } from '../../../main/exec/transcripts'
import { SegmentedControl, Button } from '../components/primitives'
import { archiveSession, listCliHistory, resumeCliSession, resumeSession } from '../api'
import { relativeTime } from '../lib/format-time'

// Plan 3, Part 4 — Recent (this app's own sessions) and CLI (transcripts
// written by Claude Code sessions started outside the app) history, both
// read-only from disk, behind one Recent | CLI segmented control.

// 'done' is the user's own verdict: they are finished with this session. It
// is not the transient `done` status the agent's Stop hook sets, which decays
// after half an hour — a row can carry that badge and still be Active here.
// The stored field is still `archivedAt`; only the word people read changed.
type SessionState = 'active' | 'done' | 'ended'

const STATE_CAPTION: Record<SessionState, string> = {
  active: 'Running, or ready to open. Marking one done puts it aside without stopping it.',
  done: 'Finished with, not lost. Resume brings one back and puts it on Active.',
  ended:
    'Nothing here can start again: the session was deleted, or no conversation was recorded. A record of what ran.'
}

const STATE_EMPTY: Record<SessionState, string> = {
  active: 'Nothing active in this project.',
  done: 'Nothing marked done.',
  ended: 'Nothing here.'
}

interface Props {
  projectId: string
  records: SessionRecord[]
  findLiveKey: (recordId: string) => string | null
  /**
   * Whether the agent is actually running. Not the same as having a live
   * session key: discovery surfaces stopped and missing records as sessions
   * too, so findLiveKey answers "is there a row for this", which is true for
   * everything and told these three states apart not at all.
   */
  isRunning: (recordId: string) => boolean
  onOpenSession: (liveKey: string) => void
  pushToast: (message: string) => void
  /** Refreshes the project's records after one is put back on the board. */
  onRecordsChanged: () => void
  // Dev shot harness only — lands directly on the CLI sub-tab.
  initialTab?: 'recent' | 'cli'
}

export default function HistoryPanel({
  projectId,
  records,
  findLiveKey,
  isRunning,
  onOpenSession,
  pushToast,
  onRecordsChanged,
  initialTab
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<'recent' | 'cli'>(initialTab ?? 'recent')
  const [cliEntries, setCliEntries] = useState<CliHistoryEntry[]>([])
  const [cliLoaded, setCliLoaded] = useState(false)
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  const [state, setState] = useState<SessionState>('active')

  const onArchive = async (record: SessionRecord): Promise<void> => {
    const result = await archiveSession(record.id)
    if (!result.ok) {
      pushToast(result.error ?? 'Could not archive it.')
      return
    }
    pushToast(`${record.title} marked done. Nothing was stopped - resume it from here.`)
    onRecordsChanged()
  }

  // The one way out of the archive, and it does what it says: the session
  // starts again and lands back on Active. Unarchiving on its own only moved a
  // row between lists, which is not a thing anyone wants to ask for.
  const onResume = async (record: SessionRecord): Promise<void> => {
    setBusySessionId(record.id)
    try {
      const result = await resumeSession(record.id)
      if (!result.ok) {
        pushToast(result.error ?? 'Could not resume it.')
        return
      }
      pushToast(`${record.title} resumed - it is back on Active.`)
      onRecordsChanged()
    } finally {
      setBusySessionId(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    listCliHistory(projectId).then((entries) => {
      if (cancelled) return
      setCliEntries(entries)
      setCliLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const handleResume = async (entry: CliHistoryEntry, fork: boolean): Promise<void> => {
    if (busySessionId) return
    setBusySessionId(entry.sessionId)
    try {
      const result = await resumeCliSession(projectId, entry.sessionId, entry.cwd, fork)
      if (!result.ok) {
        pushToast(result.error ?? `Could not ${fork ? 'fork' : 'resume'} that session.`)
      }
    } catch {
      pushToast(`Could not ${fork ? 'fork' : 'resume'} that session.`)
    } finally {
      setBusySessionId(null)
    }
  }

  // Three states, and a session can only be in one of them.
  //
  //   Active  on the board — running, or ready to be opened. Mark it done.
  //   Done    finished with, but `claude --resume` has an id to bring it back.
  //   Ended   no conversation was recorded, so nothing can bring it back.
  //
  // The capability is what decides, not the label: a record with no
  // claudeSessionId can never leave Ended, whatever anyone clicks.
  const stateOf = (record: SessionRecord): SessionState => {
    // Deleted first: the id survives a delete but the worktree does not, so
    // capability, not the id, decides whether Resume is on offer.
    if (record.deletedAt) return 'ended'
    if (!record.claudeSessionId && !isRunning(record.id)) return 'ended'
    return record.archivedAt ? 'done' : 'active'
  }
  const active = records.filter((r) => stateOf(r) === 'active')
  const done = records.filter((r) => stateOf(r) === 'done')
  const ended = records.filter((r) => stateOf(r) === 'ended')
  const shown = state === 'active' ? active : state === 'done' ? done : ended

  const renderRow = (
    record: SessionRecord,
    action: 'done' | 'resume' | null
  ): React.JSX.Element => {
    const liveKey = findLiveKey(record.id)
    return (
      <li
        key={record.id}
        className={`recent-session-row${liveKey ? ' recent-session-row-clickable' : ''}`}
        onClick={liveKey ? () => onOpenSession(liveKey) : undefined}
        role={liveKey ? 'button' : undefined}
        tabIndex={liveKey ? 0 : undefined}
      >
        <span className="recent-session-title">{record.title}</span>
        <span className="recent-session-branch">{record.branch}</span>
        <span className="recent-session-time">{relativeTime(record.createdAt)}</span>
        {action && (
          <span className="recent-session-actions">
            {/* The same Button the CLI rows opposite use. This was a bespoke
                outlined pill, so the two halves of one panel had two different
                button styles and neither was the app's. */}
            <Button
              variant="ghost"
              size="compact"
              disabled={busySessionId === record.id}
              onClick={(e) => {
                e.stopPropagation()
                if (action === 'done') void onArchive(record)
                else void onResume(record)
              }}
            >
              {action === 'done' ? 'Mark done' : 'Resume'}
            </Button>
          </span>
        )}
      </li>
    )
  }

  return (
    <section className="overview-section">
      <div className="overview-section-header-row">
        <h3 className="overview-section-header">HISTORY</h3>
        <SegmentedControl
          value={tab}
          onChange={(v) => setTab(v as 'recent' | 'cli')}
          aria-label="Session history source"
          options={[
            { value: 'recent', label: 'Started here' },
            { value: 'cli', label: 'Started in a terminal' }
          ]}
        />
      </div>

      {/* Two four-letter labels used to carry the whole distinction. They are
          different sources, not different filters, so the panel says which one
          you are looking at. */}
      <p className="history-panel-caption">
        {tab === 'recent'
          ? 'Sessions you started in Control Room.'
          : 'Sessions you started by running claude yourself, in a terminal. Read-only: Control Room found these on disk.'}
      </p>

      {tab === 'recent' ? (
        records.length === 0 ? (
          <p className="empty-state">No sessions yet.</p>
        ) : (
          <>
            {/* Three stacked sections with their own headings made the panel a
                page. One switcher says the same thing and shows only the list
                you asked for. Counts, so an empty state is a fact rather than
                a surprise. */}
            <div className="history-state-row">
              <SegmentedControl
                value={state}
                onChange={(v) => setState(v as SessionState)}
                aria-label="Which sessions to show"
                options={[
                  { value: 'active', label: `Active ${active.length}` },
                  { value: 'done', label: `Done ${done.length}` },
                  { value: 'ended', label: `Ended ${ended.length}` }
                ]}
              />
            </div>
            <p className="history-panel-caption history-panel-caption--state">
              {STATE_CAPTION[state]}
            </p>
            {shown.length === 0 ? (
              <p className="empty-state">{STATE_EMPTY[state]}</p>
            ) : (
              <ul className="recent-session-list">
                {shown.map((record) =>
                  renderRow(
                    record,
                    state === 'active' ? 'done' : state === 'done' ? 'resume' : null
                  )
                )}
              </ul>
            )}
          </>
        )
      ) : !cliLoaded ? (
        <p className="empty-state">Loading…</p>
      ) : cliEntries.length === 0 ? (
        <p className="empty-state">
          Nothing here yet. Run claude in a terminal inside this project and the session will show
          up.
        </p>
      ) : (
        <ul className="recent-session-list">
          {cliEntries.map((entry) => (
            <li key={entry.sessionId} className="recent-session-row cli-history-row">
              <span className="recent-session-title" title={entry.label}>
                {entry.label}
              </span>
              {entry.gitBranch && <span className="recent-session-branch">{entry.gitBranch}</span>}
              <span className="cli-history-count">
                {entry.messageCount} msg{entry.messageCount === 1 ? '' : 's'}
              </span>
              <span className="recent-session-time">
                {entry.updatedAt ? relativeTime(entry.updatedAt) : '-'}
              </span>
              <span className="cli-history-actions">
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={busySessionId === entry.sessionId}
                  onClick={() => void handleResume(entry, false)}
                >
                  Resume
                </Button>
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={busySessionId === entry.sessionId}
                  onClick={() => void handleResume(entry, true)}
                >
                  Fork
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
