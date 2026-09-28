import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  getFileTree,
  readFile,
  searchFiles,
  writeFile,
  type FileSearchMatch,
  type FileTreeEntry
} from '../../api'
import { onRequestOpenFile } from './openFileBus'
import './FilesTab.css'

interface Props {
  projectId: string
  sessionId?: string
}

// A tree node built by splitting the flat, posix-relative paths getFileTree
// returns on "/" (plan 2.2, Files paragraph). No path is ever constructed
// here — every relPath used for readFile/writeFile/searchFiles is one the
// tree or a search result already handed back.
interface TreeDir {
  name: string
  dirs: Map<string, TreeDir>
  files: string[] // full relPath
}

function buildTree(entries: FileTreeEntry[]): TreeDir {
  const root: TreeDir = { name: '', dirs: new Map(), files: [] }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      let next = node.dirs.get(part)
      if (!next) {
        next = { name: part, dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(entry.path)
  }
  return root
}

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error'

export default function FilesTab({ projectId, sessionId }: Props): React.JSX.Element {
  // The shared `.project-detail-body` ancestor has no bounded height (it's a
  // plain padded block), so a CSS `height: 100%` two-pane layout collapses to
  // the content's own height instead of a fixed panel. Rather than touch that
  // shared file (a sequential-milestone file per CLAUDE.md), measure the
  // available viewport space ourselves and apply it as an explicit pixel
  // height, independent of whatever the ancestor chain does.
  const containerRef = useRef<HTMLDivElement>(null)
  const [panelHeight, setPanelHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const BOTTOM_MARGIN = 24
    const MIN_HEIGHT = 320

    const recompute = (): void => {
      const top = el.getBoundingClientRect().top
      const available = window.innerHeight - top - BOTTOM_MARGIN
      setPanelHeight(Math.max(MIN_HEIGHT, Math.round(available)))
    }

    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [])

  const [entries, setEntries] = useState<FileTreeEntry[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('clean')
  const [saveError, setSaveError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileSearchMatch[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // Set when a search result was clicked, so the load-content effect below
  // knows to scroll to and select that line once the content arrives.
  const [jumpLine, setJumpLine] = useState<number | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  // Mount + refresh on project/session change. setState only ever happens
  // inside a promise callback, mirroring GitTab/RulesTab's pattern
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false

    Promise.resolve().then(() => {
      if (cancelled) return
      setTreeLoading(true)
      setSelectedPath(null)
      setContent('')
      setSavedContent('')
      setSaveState('clean')
      setContentError(null)
    })

    getFileTree(projectId, sessionId)
      .then((result) => {
        if (cancelled) return
        setEntries(result)
        setTreeError(null)
      })
      .catch(() => {
        if (cancelled) return
        setTreeError('Could not load the file tree.')
        setEntries([])
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, sessionId])

  const openFile = useCallback(
    (relPath: string, line?: number): void => {
      setSelectedPath(relPath)
      setContentLoading(true)
      setContentError(null)
      setSaveState('clean')
      setSaveError(null)
      setJumpLine(line ?? null)

      readFile(projectId, relPath, sessionId)
        .then((result) => {
          if (result.ok) {
            setContent(result.content)
            setSavedContent(result.content)
            setContentError(null)
          } else {
            setContent('')
            setSavedContent('')
            setContentError(result.error)
          }
        })
        .catch(() => {
          setContent('')
          setSavedContent('')
          setContentError('Could not read this file.')
        })
        .finally(() => setContentLoading(false))
    },
    [projectId, sessionId]
  )

  // Rules/Skills cards dispatch this to open a file here as if it had been
  // clicked in the tree (plan 2.2: "Clicking a card opens its SKILL.md /
  // CLAUDE.md in the Files editor").
  useEffect(() => {
    return onRequestOpenFile((request) => {
      if (request.projectId !== projectId) return
      openFile(request.relPath)
    })
  }, [projectId, openFile])

  const handleSave = async (): Promise<void> => {
    if (!selectedPath || saveState === 'saving') return
    setSaveState('saving')
    setSaveError(null)
    try {
      const result = await writeFile(projectId, selectedPath, content, sessionId)
      if (result.ok) {
        setSavedContent(content)
        setSaveState('saved')
      } else {
        setSaveState('error')
        setSaveError(result.error ?? 'Save failed.')
      }
    } catch {
      setSaveState('error')
      setSaveError('Save failed.')
    }
  }

  const handleContentChange = (value: string): void => {
    setContent(value)
    if (saveState !== 'saving') {
      setSaveState(value === savedContent ? 'clean' : 'dirty')
    }
  }

  const toggleDir = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const tree = useMemo(() => buildTree(entries), [entries])

  const runSearch = async (q: string): Promise<void> => {
    setQuery(q)
    if (q.trim().length === 0) {
      setSearchResults([])
      setSearchError(null)
      setSearching(false)
      return
    }
    setSearching(true)
    try {
      const results = await searchFiles(projectId, q, sessionId)
      setSearchResults(results)
      setSearchError(null)
    } catch {
      setSearchResults([])
      setSearchError('Search failed.')
    } finally {
      setSearching(false)
    }
  }

  const jumpToMatch = (match: FileSearchMatch): void => {
    openFile(match.path, match.line)
  }

  // Once the matched file's content has actually loaded, select the matched
  // line and scroll it into view — "jumps to a match" (plan 2.2), not just
  // opens the file from the top.
  useEffect(() => {
    if (jumpLine == null) return
    if (contentLoading || contentError) return
    const textarea = editorRef.current
    if (!textarea) return

    const lines = content.split('\n')
    const targetIndex = Math.min(Math.max(jumpLine - 1, 0), Math.max(lines.length - 1, 0))
    let charStart = 0
    for (let i = 0; i < targetIndex; i++) {
      charStart += lines[i].length + 1
    }
    const charEnd = charStart + (lines[targetIndex]?.length ?? 0)

    textarea.focus()
    textarea.setSelectionRange(charStart, charEnd)

    const style = window.getComputedStyle(textarea)
    const lineHeight = parseFloat(style.lineHeight) || 20
    const paddingTop = parseFloat(style.paddingTop) || 0
    const targetScrollTop = paddingTop + targetIndex * lineHeight - textarea.clientHeight / 2
    textarea.scrollTop = Math.max(0, targetScrollTop)

    setJumpLine(null)
  }, [jumpLine, content, contentLoading, contentError])

  const dirty = saveState === 'dirty'

  return (
    <div
      className="files-tab"
      ref={containerRef}
      style={panelHeight != null ? { height: panelHeight } : undefined}
    >
      <div className="files-tab-tree-pane">
        <div className="files-tab-search">
          <input
            type="text"
            className="files-tab-search-input"
            placeholder="Search files…"
            value={query}
            onChange={(e) => runSearch(e.target.value)}
          />
          {searching && <span className="files-tab-muted">Searching…</span>}
          {searchError && <div className="files-tab-error">{searchError}</div>}
          {query.trim().length > 0 && !searching && !searchError && (
            <div className="files-tab-search-results">
              {searchResults.length === 0 && <div className="files-tab-empty">No matches.</div>}
              {searchResults.slice(0, 50).map((match, i) => (
                <button
                  type="button"
                  key={`${match.path}:${match.line}:${i}`}
                  className="files-tab-search-result"
                  onClick={() => jumpToMatch(match)}
                >
                  <span className="files-tab-search-result-path">
                    {match.path}:{match.line}
                  </span>
                  <span className="files-tab-search-result-text">{match.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {treeLoading && <div className="files-tab-muted">Loading files…</div>}
        {!treeLoading && treeError && <div className="files-tab-error">{treeError}</div>}
        {!treeLoading && !treeError && entries.length === 0 && (
          <div className="files-tab-empty">No files found.</div>
        )}
        {!treeLoading && !treeError && entries.length > 0 && query.trim().length === 0 && (
          <div className="files-tab-tree">
            <TreeDirView
              dir={tree}
              basePath=""
              depth={0}
              collapsed={collapsed}
              onToggleDir={toggleDir}
              selectedPath={selectedPath}
              onSelectFile={openFile}
            />
          </div>
        )}
      </div>

      <div className="files-tab-editor-pane">
        {!selectedPath && <div className="files-tab-empty-state">Pick a file from the tree.</div>}

        {selectedPath && (
          <>
            <div className="files-tab-editor-header">
              <span className="files-tab-editor-path">{selectedPath}</span>
              <span
                className={
                  'files-tab-save-word files-tab-save-word-' +
                  (saveState === 'error' ? 'error' : saveState)
                }
              >
                {saveState === 'saving' && 'Saving…'}
                {saveState === 'saved' && 'Saved'}
                {saveState === 'dirty' && 'Unsaved changes'}
                {saveState === 'clean' && 'Saved'}
                {saveState === 'error' && 'Save failed'}
              </span>
              <button
                type="button"
                className="files-tab-save-button"
                disabled={!dirty || contentLoading || Boolean(contentError)}
                onClick={handleSave}
              >
                Save
              </button>
            </div>

            {saveError && <div className="files-tab-error">{saveError}</div>}

            {contentLoading && <div className="files-tab-muted">Loading…</div>}
            {!contentLoading && contentError && (
              <div className="files-tab-error">{contentError}</div>
            )}
            {!contentLoading && !contentError && (
              <textarea
                ref={editorRef}
                className="files-tab-textarea"
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                spellCheck={false}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function TreeDirView({
  dir,
  basePath,
  depth,
  collapsed,
  onToggleDir,
  selectedPath,
  onSelectFile
}: {
  dir: TreeDir
  basePath: string
  depth: number
  collapsed: Set<string>
  onToggleDir: (path: string) => void
  selectedPath: string | null
  onSelectFile: (relPath: string) => void
}): React.JSX.Element {
  const sortedDirs = Array.from(dir.dirs.values()).sort((a, b) => a.name.localeCompare(b.name))
  const sortedFiles = [...dir.files].sort((a, b) => a.localeCompare(b))

  return (
    <>
      {sortedDirs.map((child) => {
        const childPath = basePath ? `${basePath}/${child.name}` : child.name
        const isCollapsed = collapsed.has(childPath)
        return (
          <div key={childPath} className="files-tab-tree-node">
            <button
              type="button"
              className="files-tab-tree-dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onToggleDir(childPath)}
              aria-expanded={!isCollapsed}
            >
              <span className="files-tab-tree-caret">{isCollapsed ? '▸' : '▾'}</span>
              {child.name}
            </button>
            {!isCollapsed && (
              <TreeDirView
                dir={child}
                basePath={childPath}
                depth={depth + 1}
                collapsed={collapsed}
                onToggleDir={onToggleDir}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        )
      })}
      {sortedFiles.map((relPath) => {
        const name = relPath.slice(relPath.lastIndexOf('/') + 1)
        const isSelected = relPath === selectedPath
        return (
          <button
            type="button"
            key={relPath}
            className={'files-tab-tree-file' + (isSelected ? ' files-tab-tree-file-selected' : '')}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onSelectFile(relPath)}
            aria-current={isSelected ? 'true' : undefined}
          >
            {name}
          </button>
        )
      })}
    </>
  )
}
