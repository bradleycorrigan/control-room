import { useEffect, useMemo, useRef, useState } from 'react'
import { copyText, getSessionDiff, readFile, writeFile, type SessionDiff } from '../api'
import { commitAndPushSessionFiles } from '../api-sessions'
import { Button, IconButton } from './primitives'
import { useDismissible } from '../keyboard'
import './diff-overlay.css'

interface Props {
  sessionId: string
  /** The session's project: file reads and writes are scoped to it. */
  projectId: string
  open: boolean
  onClose: () => void
}

/**
 * One row of a rendered patch: the text, and where it sits in each side.
 *
 * "Which line?" is the first question anyone asks of a diff, and a bare patch
 * cannot answer it — the numbers only exist in the `@@` headers, as a starting
 * point you are expected to count on from.
 */
interface PatchLine {
  text: string
  /** Line number in the base file, or null on an added line and a hunk header. */
  before: number | null
  /** Line number in the new file, or null on a removed line and a hunk header. */
  after: number | null
}

/** One file's slice of the unified patch, keyed by the path it belongs to. */
function splitPatchByFile(patch: string): Map<string, PatchLine[]> {
  const byPath = new Map<string, PatchLine[]>()
  let current: PatchLine[] | null = null
  let before = 0
  let after = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // `diff --git a/x b/x` — take the b-side, which is the path after any
      // rename and the one the file list is keyed by.
      const match = /^diff --git a\/.* b\/(.*)$/.exec(line)
      current = []
      byPath.set(match ? match[1] : line, current)
      continue
    }
    // Everything before the first header, and the per-file index/--- /+++
    // preamble, is noise once the file already has a heading of its own.
    if (!current) continue
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ')
    ) {
      continue
    }
    // `@@ -12,7 +12,9 @@` resets both counters. The counts after the commas
    // are hunk lengths, not needed — walking the lines gives the same answer.
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      before = Number(hunk[1])
      after = Number(hunk[2])
      current.push({ text: line, before: null, after: null })
      continue
    }
    if (line.startsWith('+')) {
      current.push({ text: line, before: null, after: after++ })
    } else if (line.startsWith('-')) {
      current.push({ text: line, before: before++, after: null })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" belongs to neither side.
      current.push({ text: line, before: null, after: null })
    } else {
      current.push({ text: line, before: before++, after: after++ })
    }
  }
  // A patch ends with a newline, so the last file always picked up a blank
  // line and its box drew an empty row under the final hunk.
  for (const lines of byPath.values()) {
    while (lines.length > 0 && lines[lines.length - 1].text.trim() === '') lines.pop()
  }
  return byPath
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-line diff-hunk'
  if (line.startsWith('+')) return 'diff-line diff-add'
  if (line.startsWith('-')) return 'diff-line diff-remove'
  return 'diff-line'
}

/** A file open for a quick edit: what's on disk, and what you've typed. */
interface Draft {
  saved: string
  text: string
}

function FileBox({
  path,
  status,
  added,
  removed,
  lines,
  openByDefault,
  projectId,
  sessionId,
  onDirtyChange,
  onSaved
}: {
  path: string
  status: string
  added: number
  removed: number
  lines: PatchLine[] | null
  openByDefault: boolean
  projectId: string
  sessionId: string
  onDirtyChange: (path: string, dirty: boolean) => void
  onSaved: (path: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(openByDefault)
  // Expand all / Collapse all, without remounting the box: a remount threw
  // away an edit in progress.
  const [lastDefault, setLastDefault] = useState(openByDefault)
  if (lastDefault !== openByDefault) {
    setLastDefault(openByDefault)
    setOpen(openByDefault)
  }
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dirty = draft !== null && draft.text !== draft.saved
  // Told at once, not from an effect: Esc pressed straight after typing
  // must already know there's something to lose.
  const changeDraft = (next: Draft | null): void => {
    setDraft(next)
    onDirtyChange(path, next !== null && next.text !== next.saved)
  }
  // Ticks for a moment after the name goes to the clipboard.
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  // A deleted file has nothing on disk to edit.
  const canEdit = status !== 'deleted'

  const startEdit = async (): Promise<void> => {
    setBusy(true)
    setEditError(null)
    const res = await readFile(projectId, path, sessionId)
    setBusy(false)
    if (!res.ok) {
      setEditError(res.error)
      return
    }
    changeDraft({ saved: res.content, text: res.content })
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    if (!draft || busy) return
    if (!dirty) {
      changeDraft(null)
      return
    }
    setBusy(true)
    setEditError(null)
    const res = await writeFile(projectId, path, draft.text, sessionId)
    setBusy(false)
    if (!res.ok) {
      setEditError(res.error ?? 'Save failed.')
      return
    }
    changeDraft(null)
    onSaved(path)
  }
  // Wide enough for this file's largest line number and no wider — a fixed
  // gutter is either cramped on a long file or wasted space on a short one.
  const widest = lines ? lines.reduce((n, l) => Math.max(n, l.before ?? 0, l.after ?? 0), 0) : 0
  const gutter = `${Math.max(2, String(widest).length)}ch`
  // The directory is context and the filename is the subject, so they are not
  // the same weight — a column of full paths reads as one long smear.
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : path.slice(0, slash + 1)
  const name = slash === -1 ? path : path.slice(slash + 1)
  // What Copy puts on the clipboard: the name without its extension, as you'd
  // type it to refer to a model ("orders", not "orders.sql"). A dotfile
  // such as ".cursor" keeps its name.
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name

  return (
    <div className="diff-file">
      <div className="diff-file-head">
        <button
          type="button"
          className="diff-file-header"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`diff-file-chevron${open ? ' diff-file-chevron--open' : ''}`}>›</span>
          <span className={`diff-status diff-status-${status}`}>{status}</span>
          <span className="diff-file-path">
            <span className="diff-file-dir">{dir}</span>
            <span className="diff-file-name">{name}</span>
          </span>
          <span className="diff-file-stat">
            {added > 0 && <span className="diff-stat-add">+{added}</span>}
            {removed > 0 && <span className="diff-stat-remove">−{removed}</span>}
          </span>
        </button>
        <IconButton
          icon={copied ? 'Check' : 'Copy'}
          label={`Copy ${stem}`}
          tooltip={copied ? 'Copied' : 'Copy file name'}
          size={28}
          className="diff-file-copy"
          onClick={() =>
            void copyText(stem).then((r) => {
              if (r.ok) setCopied(true)
            })
          }
        />
        {canEdit && !draft && (
          <Button variant="ghost" size="compact" disabled={busy} onClick={() => void startEdit()}>
            Edit
          </Button>
        )}
      </div>
      {editError && <p className="diff-edit-error">{editError}</p>}
      {draft ? (
        <div className="diff-edit">
          <textarea
            className="diff-edit-textarea"
            aria-label={`Edit ${path}`}
            spellCheck={false}
            autoFocus
            value={draft.text}
            rows={Math.min(40, Math.max(6, draft.text.split('\n').length + 1))}
            onChange={(e) => changeDraft({ ...draft, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void save()
              }
            }}
          />
          <div className="diff-edit-actions">
            <span className="diff-edit-hint">Saves to the session&apos;s worktree</span>
            <Button
              variant="ghost"
              size="compact"
              disabled={busy}
              onClick={() => changeDraft(null)}
            >
              Cancel
            </Button>
            <Button variant="outlined" size="compact" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
              <kbd>⌘S</kbd>
            </Button>
          </div>
        </div>
      ) : (
        open &&
        (lines && lines.length > 0 ? (
          <pre
            className="diff-file-patch"
            style={{ '--diff-gutter': gutter } as React.CSSProperties}
          >
            {lines.map((line, i) => (
              <div key={i} className={lineClass(line.text)}>
                <span className="diff-num" aria-hidden="true">
                  {line.before ?? ''}
                </span>
                <span className="diff-num" aria-hidden="true">
                  {line.after ?? ''}
                </span>
                <span className="diff-text">{line.text || ' '}</span>
              </div>
            ))}
          </pre>
        ) : (
          <p className="diff-file-empty">
            {status === 'untracked' ? 'New file, not yet tracked by git.' : 'No textual changes.'}
          </p>
        ))
      )}
    </div>
  )
}

/**
 * The diff, as a window over the session rather than a strip beside it.
 *
 * It used to be one `<pre>` of the whole patch in a narrow side sheet: every
 * file run together, nothing to collapse, and lines wrapping at a width that
 * made real code unreadable. Reviewing is the point of this screen, so it gets
 * the room, and one box per file you can fold away as you clear it.
 */
export default function DiffOverlay({
  sessionId,
  projectId,
  open,
  onClose
}: Props): React.JSX.Element | null {
  const [loaded, setLoaded] = useState<{ sessionId: string; diff: SessionDiff } | null>(null)
  const [allOpen, setAllOpen] = useState<boolean | null>(null)
  // Bumped after a save or a commit, to read the diff again.
  const [version, setVersion] = useState(0)
  // Files with unsaved typing: closing would lose it, so Esc and the
  // backdrop wait until you save or cancel. A ref, so it's current the
  // moment you type.
  const dirty = useRef<Set<string>>(new Set())
  // Files saved here and not yet committed: what Commit & push sends.
  const [edited, setEdited] = useState<string[]>([])
  const [committing, setCommitting] = useState(false)
  const [message, setMessage] = useState('')
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<{ ok: boolean; text: string } | null>(null)

  const close = (): void => {
    if (dirty.current.size === 0) onClose()
  }
  useDismissible(open, 'modal', close)

  const onDirtyChange = (path: string, isDirty: boolean): void => {
    if (isDirty) dirty.current.add(path)
    else dirty.current.delete(path)
  }
  const onSaved = (path: string): void => {
    setEdited((cur) => (cur.includes(path) ? cur : [...cur, path]))
    setPushResult(null)
    setVersion((v) => v + 1)
  }

  const commitAndPush = async (): Promise<void> => {
    if (pushing || !message.trim() || edited.length === 0) return
    setPushing(true)
    setPushResult(null)
    const res = await commitAndPushSessionFiles(sessionId, edited, message)
    setPushing(false)
    if (!res.ok) {
      setPushResult({ ok: false, text: res.error ?? 'Commit and push failed.' })
      return
    }
    setPushResult({
      ok: true,
      text: `Committed and pushed ${edited.length} file${edited.length === 1 ? '' : 's'}.`
    })
    setEdited([])
    setMessage('')
    setCommitting(false)
    setVersion((v) => v + 1)
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getSessionDiff(sessionId).then((d) => {
      if (!cancelled) setLoaded({ sessionId, diff: d })
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, open, version])

  const diff = loaded?.sessionId === sessionId ? loaded.diff : null
  const byPath = useMemo(() => (diff ? splitPatchByFile(diff.patch) : new Map()), [diff])

  if (!open) return null

  const fileCount = (diff?.files.length ?? 0) + (diff?.untracked.length ?? 0)
  const added = diff?.files.reduce((n, f) => n + f.added, 0) ?? 0
  const removed = diff?.files.reduce((n, f) => n + f.removed, 0) ?? 0
  // Everything open when there is little to read, everything shut when there
  // is a lot — the useful default is different at three files and at thirty.
  const defaultOpen = allOpen ?? fileCount <= 5

  return (
    <div className="diff-overlay-backdrop" onClick={close}>
      <div
        className="diff-overlay"
        role="dialog"
        aria-label="Diff"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="diff-overlay-header">
          <div className="diff-overlay-title">
            <h2>Diff</h2>
            {diff?.base && <span className="diff-overlay-base">vs {diff.base.slice(0, 8)}</span>}
          </div>
          <div className="diff-overlay-summary">
            {fileCount > 0 && (
              <>
                <span>
                  {fileCount} file{fileCount === 1 ? '' : 's'}
                </span>
                {added > 0 && <span className="diff-stat-add">+{added}</span>}
                {removed > 0 && <span className="diff-stat-remove">−{removed}</span>}
              </>
            )}
          </div>
          <div className="diff-overlay-actions">
            {edited.length > 0 && !committing && (
              <Button variant="filled" size="compact" onClick={() => setCommitting(true)}>
                Commit &amp; push {edited.length} file{edited.length === 1 ? '' : 's'}
              </Button>
            )}
            {fileCount > 1 && (
              <Button variant="ghost" size="compact" onClick={() => setAllOpen(!defaultOpen)}>
                {defaultOpen ? 'Collapse all' : 'Expand all'}
              </Button>
            )}
            <IconButton icon="X" label="Close diff" size={28} variant="ghost" onClick={onClose} />
          </div>
        </div>

        {committing && (
          <form
            className="diff-commit-bar"
            onSubmit={(e) => {
              e.preventDefault()
              void commitAndPush()
            }}
          >
            <input
              className="diff-commit-input"
              aria-label="Commit message"
              placeholder="What did you change?"
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <span className="diff-commit-files" title={edited.join('\n')}>
              {edited.map((p) => p.slice(p.lastIndexOf('/') + 1)).join(', ')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="compact"
              disabled={pushing}
              onClick={() => setCommitting(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="filled"
              size="compact"
              disabled={pushing || !message.trim()}
            >
              {pushing ? 'Pushing…' : 'Commit & push'}
            </Button>
          </form>
        )}
        {pushResult && (
          <p
            className={
              pushResult.ok ? 'diff-commit-result' : 'diff-commit-result diff-commit-result--error'
            }
            role="status"
          >
            {pushResult.text}
          </p>
        )}

        <div className="diff-overlay-body">
          {!diff && <p className="empty-state">Loading diff…</p>}
          {diff && !diff.base && <p className="empty-state">No merge base found.</p>}
          {diff && diff.base && fileCount === 0 && <p className="empty-state">No changes.</p>}
          {diff?.truncated && (
            <p className="diff-overlay-truncated">
              This diff is too large to show in full - open the worktree in your IDE to read it all.
            </p>
          )}
          {diff?.files.map((f) => (
            <FileBox
              key={f.path}
              path={f.path}
              status={f.status}
              added={f.added}
              removed={f.removed}
              lines={byPath.get(f.path) ?? null}
              openByDefault={defaultOpen}
              projectId={projectId}
              sessionId={sessionId}
              onDirtyChange={onDirtyChange}
              onSaved={onSaved}
            />
          ))}
          {diff?.untracked.map((path) => (
            <FileBox
              key={path}
              path={path}
              status="untracked"
              added={0}
              removed={0}
              lines={null}
              openByDefault={false}
              projectId={projectId}
              sessionId={sessionId}
              onDirtyChange={onDirtyChange}
              onSaved={onSaved}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
