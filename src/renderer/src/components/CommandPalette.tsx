import { useEffect, useMemo, useRef, useState } from 'react'
import type { LiveSession, Project } from '../../../main/store/types'
import { themes } from '../theme/themes'
import { findTicket, listCheckoutBranches, type CheckoutBranch } from '../api-palette'
import { getJiraStatus, openExternal } from '../api'

interface Props {
  open: boolean
  onClose: () => void
  sessions: LiveSession[]
  projects: Project[]
  onSelectSession: (liveKey: string) => void
  onSelectProject: (projectId: string) => void
  currentThemeId: string
  onSelectTheme: (themeId: string) => void
  onNewSession: () => void
  onOpenInIde: () => void
  onFocusTerminal: () => void
  onInstallHooks: () => void
  onOpenSettings: () => void
  onOpenDataFolder: () => void
  onOpenKeyboardHelp: () => void
  /** Open session tabs, in strip order — listed first, as "open tab". */
  openTabKeys: string[]
  /** Present only when there's a closed tab to bring back. */
  onReopenClosedTab?: () => void
  /** A ticket found on the loaded Backlog board — opens its panel there. */
  onSelectTicket: (key: string) => void
  /** A branch, picked from any project — opens the New session composer on it. */
  onSelectBranch: (projectId: string, branch: string) => void
}

interface PaletteItem {
  id: string
  kind: 'session' | 'project' | 'command' | 'ticket' | 'branch'
  label: string
  sublabel?: string
  searchText: string
  run: () => void
}

/**
 * "DSD-101", "dsd101" or "dsd-101" — a project key and a number, nothing
 * else. A project key can itself contain a digit ("AB2-14"), so a dash or
 * run-together form is always accepted; a bare space ("tab 2", "session 12")
 * is only treated as a key when the word before the number is a project this
 * app already knows about, so a plain two-word query doesn't fire a Jira
 * request on every keystroke.
 */
function ticketKeyIn(text: string, knownProjects: Set<string>): string | null {
  const m = text.trim().match(/^([a-z][a-z0-9]{1,9})([\s-]*)(\d{1,6})$/i)
  if (!m) return null
  const [, prefix, sep, digits] = m
  if (sep.trim() === '' && sep !== '' && !knownProjects.has(prefix.toUpperCase())) {
    // A space separator with an unrecognised prefix — most likely "tab 2".
    return null
  }
  return `${prefix.toUpperCase()}-${digits}`
}

const MIN_BRANCH_QUERY = 3

// Plain substring/subsequence match — no fuzzy-matching library (plan:
// "build the palette as a plain filtered list ... no combobox library").
// A contiguous substring hit scores best; otherwise every character of the
// query must appear in order somewhere in the target.
function matchScore(query: string, target: string): number | null {
  if (query === '') return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const idx = t.indexOf(q)
  if (idx !== -1) return idx // earlier substring hits rank first
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length ? 1000 : null // subsequence hit, ranked after substring hits
}

export default function CommandPalette({
  open,
  onClose,
  sessions,
  projects,
  onSelectSession,
  onSelectProject,
  currentThemeId,
  onSelectTheme,
  onNewSession,
  onOpenInIde,
  onFocusTerminal,
  onInstallHooks,
  onOpenSettings,
  onOpenDataFolder,
  onOpenKeyboardHelp,
  openTabKeys,
  onReopenClosedTab,
  onSelectTicket,
  onSelectBranch
}: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Branches across every project, refilled each time the dialog opens (see
  // the effect below) — declared up here so the open-transition reset can
  // clear it too.
  const [branchCache, setBranchCache] = useState<
    { projectId: string; projectName: string; branch: CheckoutBranch }[]
  >([])
  // Whether this open has started fetching branches yet — set the first time
  // the query reaches MIN_BRANCH_QUERY, not on open, so switching sessions
  // (the common case) never pays for a `git fetch --prune` per project.
  const branchFetchStarted = useRef(false)
  // Jira project keys this app knows about (e.g. "DSD"), so "tab 2" isn't
  // mistaken for a ticket key — only a recognised prefix is.
  const [knownProjects, setKnownProjects] = useState<Set<string>>(new Set())
  // Typing a ticket key: looked up on every settle of the key (debounced —
  // a fetch per keystroke while it's still "DSD-10" is wasted work), from
  // the loaded board first, else Jira itself. Declared up here so the
  // open-transition reset below can clear a stale result too.
  const [ticketLookup, setTicketLookup] = useState<{
    key: string
    result: Awaited<ReturnType<typeof findTicket>> | null
  } | null>(null)

  // Reset to a clean slate every time the dialog transitions from closed to
  // open — adjusting state during render (React's own pattern for "reset
  // state when a prop changes") rather than in an effect, so it can't
  // cascade an extra render.
  const [wasOpen, setWasOpen] = useState(open)
  const [focusAsk, setFocusAsk] = useState(0)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQuery('')
      setHighlighted(0)
      setFocusAsk((n) => n + 1)
      setBranchCache([])
      setTicketLookup(null)
    }
  }

  // Focus once the dialog has rendered. Not requestAnimationFrame: that never
  // fires while the window is in the background, and typing after ⌘K went
  // nowhere (same bug and fix as the terminal find bar's searchAsk).
  useEffect(() => {
    if (focusAsk) inputRef.current?.focus()
  }, [focusAsk])

  // A ref, not state reset during render — refs are only ever read/written
  // outside render (React's own rule), so this clears in an effect keyed to
  // the same "just opened" signal as the focus effect above.
  useEffect(() => {
    if (focusAsk) branchFetchStarted.current = false
  }, [focusAsk])

  const commandsOnly = query.startsWith('>')
  const searchTerm = commandsOnly ? query.slice(1).trim() : query.trim()
  const ticketKey = !commandsOnly ? ticketKeyIn(searchTerm, knownProjects) : null

  // Fetched once when the dialog opens — the project keys Jira is configured
  // with, so ticketKeyIn can tell "dsd 101" from "tab 2".
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getJiraStatus()
      .then((status) => {
        if (!cancelled) setKnownProjects(new Set(status.projects.map((p) => p.toUpperCase())))
      })
      .catch(() => {
        /* no Jira connection — no known projects, so only dash/joined keys resolve */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!ticketKey) return
    // `live` guards against a slower, earlier request (e.g. "DSD-10") landing
    // after a faster, later one ("DSD-101") and overwriting its result — the
    // effect's own cleanup, run when ticketKey changes or the dialog closes,
    // is what keeps this accurate rather than a ref checked after the fact.
    let live = true
    const timer = setTimeout(() => {
      void findTicket(ticketKey).then((result) => {
        if (live) setTicketLookup({ key: ticketKey, result })
      })
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [ticketKey])

  const ticketItem = useMemo<PaletteItem | null>(() => {
    if (!ticketKey || ticketLookup?.key !== ticketKey || !ticketLookup.result) return null
    const res = ticketLookup.result
    if (!res.ok) return null
    const { key, summary, url, onBoard } = res.value
    return {
      id: `ticket:${key}`,
      kind: 'ticket',
      label: `${key} · ${summary}`,
      sublabel: onBoard ? undefined : 'Opens in Jira',
      searchText: key,
      run: () => {
        if (onBoard) onSelectTicket(key)
        else void openExternal(url)
      }
    }
  }, [ticketKey, ticketLookup, onSelectTicket])

  // Fetched at most once per palette open (each project's listing does its
  // own `git fetch`, so this is not free) — and only once the query is long
  // enough that branch results would actually show, not on every open. Most
  // opens are "switch to a session", and paid for a `git fetch --prune` per
  // project, plus a gh lookup, that nothing on screen ever used.
  const startBranchFetch = searchTerm.length >= MIN_BRANCH_QUERY && !commandsOnly
  useEffect(() => {
    if (!open || !startBranchFetch || branchFetchStarted.current) return
    branchFetchStarted.current = true
    let cancelled = false
    for (const project of projects) {
      if (project.id === 'general') continue
      void listCheckoutBranches(project.id)
        .then((list) => {
          if (cancelled) return
          setBranchCache((prev) => [
            ...prev,
            ...list.map((branch) => ({ projectId: project.id, projectName: project.name, branch }))
          ])
        })
        .catch(() => {
          /* a project this palette can't fetch branches for just contributes none */
        })
    }
    return () => {
      cancelled = true
    }
    // Starts once per open, the first time startBranchFetch turns true — not
    // on every project edit or keystroke after that (branchFetchStarted.current
    // guards re-entry once it has).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startBranchFetch])

  const branchItems = useMemo<PaletteItem[]>(() => {
    if (commandsOnly || searchTerm.length < MIN_BRANCH_QUERY) return []
    return branchCache
      .map((entry) => ({ entry, score: matchScore(searchTerm, entry.branch.name) }))
      .filter((s): s is { entry: (typeof branchCache)[number]; score: number } => s.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 6)
      .map(({ entry }) => ({
        id: `branch:${entry.projectId}:${entry.branch.name}`,
        kind: 'branch' as const,
        label: entry.branch.name,
        sublabel: entry.projectName,
        searchText: entry.branch.name,
        run: () => onSelectBranch(entry.projectId, entry.branch.name)
      }))
  }, [commandsOnly, searchTerm, branchCache, onSelectBranch])

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = []

    if (!commandsOnly) {
      // Your open tabs first, in strip order: typing a name to jump to a tab
      // is the common case, and they're the sessions you're working in.
      const tabRank = (key: string): number => {
        const i = openTabKeys.indexOf(key)
        return i === -1 ? Number.MAX_SAFE_INTEGER : i
      }
      const ordered = [...sessions].sort((a, b) => tabRank(a.key) - tabRank(b.key))
      for (const session of ordered) {
        const label = session.record?.title ?? session.agentName ?? session.cwd
        const branch = session.record?.branch ?? ''
        const isTab = openTabKeys.includes(session.key)
        list.push({
          id: `session:${session.key}`,
          kind: 'session',
          label,
          sublabel: [isTab ? 'open tab' : '', branch].filter(Boolean).join(' · ') || undefined,
          searchText: `${label} ${branch}`,
          run: () => onSelectSession(session.key)
        })
      }

      for (const project of projects) {
        list.push({
          id: `project:${project.id}`,
          kind: 'project',
          label: project.name,
          sublabel: project.repoPath,
          searchText: project.name,
          run: () => onSelectProject(project.id)
        })
      }
    }

    if (onReopenClosedTab) {
      list.push({
        id: 'cmd:reopen-tab',
        kind: 'command',
        label: 'Reopen closed tab',
        searchText: 'reopen closed tab undo',
        run: onReopenClosedTab
      })
    }
    list.push(
      {
        id: 'cmd:new-session',
        kind: 'command',
        label: 'New session',
        searchText: 'new session',
        run: onNewSession
      },
      {
        id: 'cmd:open-ide',
        kind: 'command',
        label: 'Open in IDE',
        searchText: 'open in ide cursor',
        run: onOpenInIde
      },
      {
        id: 'cmd:focus-terminal',
        kind: 'command',
        label: 'Focus terminal',
        searchText: 'focus terminal tmux',
        run: onFocusTerminal
      },
      {
        id: 'cmd:install-hooks',
        kind: 'command',
        label: 'Install hooks',
        searchText: 'install hooks',
        run: onInstallHooks
      },
      {
        id: 'cmd:settings',
        kind: 'command',
        label: 'Settings',
        searchText: 'settings preferences',
        run: onOpenSettings
      },
      {
        id: 'cmd:open-data-folder',
        kind: 'command',
        label: 'Open data folder',
        searchText: 'open data folder finder',
        run: onOpenDataFolder
      },
      {
        id: 'cmd:keyboard-help',
        kind: 'command',
        label: 'Keyboard help',
        searchText: 'keyboard help shortcuts',
        run: onOpenKeyboardHelp
      }
    )

    for (const theme of themes) {
      list.push({
        id: `cmd:theme:${theme.id}`,
        kind: 'command',
        label: `Change theme: ${theme.name}${theme.id === currentThemeId ? ' (current)' : ''}`,
        searchText: `change theme ${theme.name}`,
        run: () => onSelectTheme(theme.id)
      })
    }

    return list
  }, [
    commandsOnly,
    sessions,
    projects,
    currentThemeId,
    onSelectSession,
    onSelectProject,
    onNewSession,
    onOpenInIde,
    onFocusTerminal,
    onInstallHooks,
    onOpenSettings,
    onOpenDataFolder,
    onOpenKeyboardHelp,
    onSelectTheme,
    openTabKeys,
    onReopenClosedTab
  ])

  const filtered = useMemo(() => {
    if (searchTerm === '') return items
    const scored = items
      .map((item) => ({ item, score: matchScore(searchTerm, item.searchText) }))
      .filter((s): s is { item: PaletteItem; score: number } => s.score !== null)
    scored.sort((a, b) => a.score - b.score)
    return scored.map((s) => s.item)
  }, [items, searchTerm])

  // A resolved ticket is the most deliberate match there is — first. Branches
  // need 3+ characters on purpose (see MIN_BRANCH_QUERY), so they trail the
  // ordinary matches rather than crowd them out.
  const results = useMemo(
    () => [...(ticketItem ? [ticketItem] : []), ...filtered, ...branchItems],
    [ticketItem, filtered, branchItems]
  )

  const [prevQuery, setPrevQuery] = useState(query)
  if (query !== prevQuery) {
    setPrevQuery(query)
    setHighlighted(0)
  }

  if (!open) return null

  const runItem = (item: PaletteItem): void => {
    item.run()
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((i) => Math.min(i + 1, results.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[highlighted]
      if (item) runItem(item)
    }
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            commandsOnly ? 'Commands…' : 'Search sessions and projects, or type > for commands'
          }
        />
        <div className="command-palette-list" role="listbox">
          {results.length === 0 && <div className="command-palette-empty">No matches.</div>}
          {results.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              className={`command-palette-item${index === highlighted ? ' command-palette-item-highlighted' : ''}`}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => runItem(item)}
            >
              <span className={`command-palette-item-kind command-palette-item-kind-${item.kind}`}>
                {item.kind === 'session'
                  ? 'Session'
                  : item.kind === 'project'
                    ? 'Project'
                    : item.kind === 'ticket'
                      ? 'Ticket'
                      : item.kind === 'branch'
                        ? 'Branch'
                        : 'Command'}
              </span>
              <span className="command-palette-item-label">{item.label}</span>
              {item.sublabel && (
                <span className="command-palette-item-sublabel">{item.sublabel}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
