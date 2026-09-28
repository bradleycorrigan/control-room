import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { IconButton } from './primitives'
import '@xterm/xterm/css/xterm.css'
import {
  terminalAttach,
  terminalDetach,
  terminalInput,
  terminalResize,
  onTerminalOutput,
  openExternal,
  getAppSettings,
  onSettingsChanged,
  getPathForDroppedFile,
  addDroppedPaths,
  pasteAttachmentImage
} from '../api'

// A dropped file's path, escaped the way macOS Terminal and Ghostty do it —
// a backslash before anything the shell would read as special — so a
// screenshot called "Screen Shot 2026-09-24 at 12.06.png" arrives as one
// argument. Claude Code recognises a pasted image path and attaches it.
function shellEscapePath(path: string): string {
  return path.replace(/([^A-Za-z0-9_\-.,:/@+=%])/g, '\\$1')
}

// What the terminal shows until settings load, and the sizes Settings offers.
// A handful of named steps rather than a free number: the useful range is
// narrow, and every value in it has to stay readable at a pane's width.

/**
 * The font size to hand xterm so rows have no seams in the DOM renderer.
 *
 * xterm sizes a row as the font's line box (ascent + descent, measured on a
 * canvas) rounded UP to a whole device pixel. Menlo at 13px is 15.13px tall,
 * so each row came out 15.5px on a Retina screen and every block character —
 * Claude Code's banner is drawn in them — sat on a hairline gap. Nudging the
 * size down (13 → ~12.9) so the line box lands just under a whole device
 * pixel makes the row and the glyph the same height, and the blocks touch.
 * WebGL draws these itself, but it crashed this Mac's GPU process.
 */
function seamlessFontSize(size: number, fontFamily: string): number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return size
  ctx.font = `${size}px ${fontFamily}`
  const m = ctx.measureText('W')
  const line = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent
  const dpr = window.devicePixelRatio || 1
  const device = line * dpr
  if (!Number.isFinite(device) || device <= 0) return size
  const whole = Math.floor(device + 0.001)
  if (device - whole < 0.001) return size
  return (size * (whole - 0.005)) / device
}

export const DEFAULT_TERMINAL_FONT_SIZE = 13
export const TERMINAL_FONT_SIZES = [11, 13, 15, 17] as const

// Plan 7 (ok-now-i-want-rippling-starlight.md, Part 3): xterm.js driven by a
// real PTY transport in src/main/exec/tmux-pty.ts (node-pty, rebuilt against
// Electron's ABI, asar-unpacked) that attaches to a grouped `cr-view-<name>`
// tmux session, giving tmux a genuine client size instead of the clamped
// geometry tmux control mode (`tmux -C`) reported. The renderer never touches
// tmux itself — it sends only the tmux session name + pane id it was handed on
// LiveSession.tmux and lets ipc.ts own the process.

const BACKFILL_LINES = 2000
const RESIZE_DEBOUNCE_MS = 150
const ESC_ESC_WINDOW_MS = 600

/** Match highlighting for ⌘F, from the theme's own colours. xterm takes only
 * #RRGGBB here, so a token that isn't one leaves the matches unhighlighted
 * (and uncounted) rather than breaking the search. */
function searchDecorations(el: HTMLElement | null): ISearchOptions['decorations'] | undefined {
  if (!el) return undefined
  const s = getComputedStyle(el)
  const match = s.getPropertyValue('--term-ansi-3').trim()
  const active = s.getPropertyValue('--accent').trim()
  const hex = /^#[0-9a-f]{6}$/i
  if (!hex.test(match) || !hex.test(active)) return undefined
  return {
    matchBackground: match,
    matchOverviewRuler: match,
    activeMatchBackground: active,
    activeMatchColorOverviewRuler: active
  }
}

/** Reads the xterm theme from the live CSS custom properties (never a hex
 * literal here — CLAUDE.md's hex-literal grep covers this file too), so a
 * runtime theme switch (ThemeProvider stamps `data-theme` on <html>) is
 * picked up by re-reading on that attribute changing. */
function readXtermTheme(el: HTMLElement): ITheme {
  const s = getComputedStyle(el)
  const get = (name: string): string => s.getPropertyValue(name).trim()
  return {
    background: get('--term-bg'),
    foreground: get('--term-fg'),
    cursor: get('--term-fg'),
    // The glyph showing through a block cursor. xterm defaults this to black,
    // which disappears into a dark-on-light theme's cursor.
    cursorAccent: get('--term-cursor-fg'),
    selectionBackground: get('--term-selection'),
    black: get('--term-ansi-0'),
    red: get('--term-ansi-1'),
    green: get('--term-ansi-2'),
    yellow: get('--term-ansi-3'),
    blue: get('--term-ansi-4'),
    magenta: get('--term-ansi-5'),
    cyan: get('--term-ansi-6'),
    white: get('--term-ansi-7'),
    brightBlack: get('--term-ansi-8'),
    brightRed: get('--term-ansi-9'),
    brightGreen: get('--term-ansi-10'),
    brightYellow: get('--term-ansi-11'),
    brightBlue: get('--term-ansi-12'),
    brightMagenta: get('--term-ansi-13'),
    brightCyan: get('--term-ansi-14'),
    brightWhite: get('--term-ansi-15')
  }
}

export interface TerminalHandle {
  scrollToBottom: () => void
  focus: () => void
}

interface Props {
  tmuxSessionName: string
  paneId: string
  onFallback: (reason: string) => void
  onReady?: () => void
  onFocusChange?: (focused: boolean) => void
  onAtBottomChange?: (atBottom: boolean) => void
}

const Terminal = forwardRef<TerminalHandle, Props>(function Terminal(
  { tmuxSessionName, paneId, onFallback, onReady, onFocusChange, onAtBottomChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastEscRef = useRef(0)
  const terminalLiveRef = useRef(true)
  // Something is being dragged over the terminal — shows the drop target.
  const [dropping, setDropping] = useState(false)
  // A drop that couldn't be used says so for a moment, rather than nothing.
  const [dropNote, setDropNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashNote = (text: string): void => {
    setDropNote(text)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setDropNote(null), 4000)
  }
  // ⌘F: find in this terminal's scrollback.
  const searchRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  // Read once on mount and applied to the live terminal below, rather than
  // being a dep of the effect that builds it — rebuilding the terminal to
  // change its text size would drop the scrollback and the tmux attachment.
  const [fontSize, setFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE)
  // WebGL only when Settings asks for it (see the renderer notes below).
  const gpuRef = useRef(false)
  const webglControl = useRef<{ attach: () => void; release: () => void } | null>(null)
  useEffect(() => {
    let cancelled = false
    const applyGpu = (on: boolean): void => {
      gpuRef.current = on
      if (on) webglControl.current?.attach()
      else webglControl.current?.release()
    }
    void getAppSettings().then((settings) => {
      if (cancelled) return
      setFontSize(settings.terminalFontSize)
      applyGpu(Boolean(settings.terminalGpu))
    })
    // And again whenever it changes, or the size you pick in Settings does
    // nothing until you close the session and open it again.
    const unsubscribe = onSettingsChanged((settings) => {
      setFontSize(settings.terminalFontSize)
      applyGpu(Boolean(settings.terminalGpu))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // ⌘F opens the find bar for the terminal on screen. Only the active tab's
  // terminal is mounted, so there's only ever one listening.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setSearchAsk((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Focus once the bar has rendered. Not requestAnimationFrame: that never
  // fires while the window is in the background, and typing went nowhere.
  const [searchAsk, setSearchAsk] = useState(0)
  useEffect(() => {
    if (searchAsk) searchInputRef.current?.select()
  }, [searchAsk])

  const find = (direction: 'next' | 'previous', text = query, incremental = false): void => {
    const search = searchRef.current
    if (!search) return
    if (!text) {
      search.clearDecorations()
      setResults(null)
      return
    }
    const options: ISearchOptions = {
      incremental,
      decorations: searchDecorations(containerRef.current)
    }
    if (direction === 'next') search.findNext(text, options)
    else search.findPrevious(text, options)
  }

  const closeSearch = (): void => {
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setResults(null)
    termRef.current?.focus()
  }

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => termRef.current?.scrollToBottom(),
    focus: () => termRef.current?.focus()
  }))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let unsubscribeOutput: (() => void) | null = null

    // Our cell-filling block/box glyphs first (they cover U+2500–259F only),
    // then the app's monospace font for everything else.
    const fontFamily = `'CR Terminal Blocks', ${
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      'monospace'
    }`

    const term = new XTerm({
      fontFamily,
      // Match Xirp: 13px by default, at xterm's own default line height. lineHeight was 1.5,
      // which is fine for prose and wrong for a terminal — block-drawing glyphs
      // are painted to fill their cell, so a cell 50% taller than the glyph
      // leaves a gap between every row and any box-drawn UI comes apart. Claude
      // Code's own banner is drawn that way, which is where it showed.
      fontSize: seamlessFontSize(fontSize, fontFamily),
      lineHeight: 1,
      // OSC 8 hyperlinks — the escape sequence Claude Code actually emits for
      // a clickable link. These never reach WebLinksAddon below, which only
      // finds bare URLs by regex; xterm core handles them itself and its
      // built-in handler is the one that put up "WARNING: This link could
      // potentially be dangerous" and then called window.open, which Electron
      // refuses. Fixing the addon alone left this path untouched, which is why
      // links still did nothing.
      linkHandler: {
        activate: (event, uri) => {
          event.preventDefault()
          void openExternal(uri)
        }
      },
      scrollback: 5000,
      allowProposedApi: true,
      cursorBlink: true,
      theme: readXtermTheme(container)
      // esc-esc (2.5) releases focus back to the app; a single Escape still
      // reaches the agent normally, so this only swallows the *second* one.
      // App-shortcut suppression while unfocused is App.tsx's call — that
      // file is out of this milestone's lane (CLAUDE.md parallel-work rule).
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // The other kind of link: a bare URL printed as plain text, found by
    // regex. Same destination, same rules — main decides what is openable.
    // (OSC 8 links are handled by `linkHandler` in the options above.)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        void openExternal(uri)
      })
    )

    // Off by default now (Settings → Draw the terminal with the GPU): this
    // Mac's GPU process kept crashing — a Chromium CHECK on its main thread,
    // many times a day — and every crash put a sad face where the terminal
    // was until it came back. The DOM renderer never touches WebGL.
    //
    // WebGL renderer. The DOM renderer positions each cell independently and
    // rounds to fractional pixels, so block-drawing glyphs that should tile into
    // a solid shape get hairline seams between columns — visible straight
    // through Claude Code's banner. WebGL draws the grid as one texture and the
    // seams go. It can fail to initialise (no GPU context, a lost context after
    // sleep), so the failure path falls back to the DOM renderer rather than
    // leaving a dead terminal.
    //
    // macOS can take a WebGL context away while the window is minimised or
    // hidden. The addon then waits up to ~3s for it to come back, and until
    // then the canvas shows Chromium's lost-context placeholder — a sad face
    // where the terminal should be. So the context is let go while the window
    // is hidden and made fresh on the way back, leaving nothing to lose; and
    // if one is lost anyway, it is rebuilt rather than dropped to the DOM
    // renderer for good.
    //
    // Switching screens mounts a fresh terminal each time, and the addon's
    // dispose() never gives its context back — it lingers until garbage
    // collection. Enough switches and Chromium hits its cap (16), starts
    // dropping contexts, and the terminal flashed the sad face while it
    // rebuilt; if every rebuild evicted another, it churned. So a release
    // hands the context back explicitly, and rebuilding after a loss is
    // capped: past that, the DOM renderer carries on until the next mount.
    let webgl: WebglAddon | null = null
    // The canvases the addon added — the only ones with a WebGL context.
    let webglCanvases: HTMLCanvasElement[] = []
    let recentLosses: number[] = []
    const attachWebgl = (): void => {
      if (webgl || disposed || !gpuRef.current) return
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          releaseWebgl()
          const now = Date.now()
          recentLosses = [...recentLosses.filter((t) => now - t < 30_000), now]
          if (document.visibilityState === 'visible' && recentLosses.length < 3) {
            setTimeout(attachWebgl, 250)
          }
        })
        const before = new Set(container.querySelectorAll('canvas'))
        term.loadAddon(addon)
        webgl = addon
        webglCanvases = [...container.querySelectorAll('canvas')].filter((c) => !before.has(c))
      } catch {
        /* DOM renderer stays in place — seams, but a working terminal */
      }
    }
    const releaseWebgl = (): void => {
      if (!webgl) return
      // Hand the GPU context back now rather than whenever the canvas is
      // collected. getContext returns the canvas's existing context.
      for (const canvas of webglCanvases) {
        const gl = canvas.getContext('webgl2')
        if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
      webglCanvases = []
      try {
        webgl.dispose()
      } catch {
        /* already torn down */
      }
      webgl = null
    }
    const handleVisibility = (): void => {
      if (document.visibilityState === 'hidden') releaseWebgl()
      else {
        attachWebgl()
        term.refresh(0, term.rows - 1)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    webglControl.current = { attach: attachWebgl, release: releaseWebgl }
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount })
    )
    term.open(container)
    if (document.visibilityState === 'visible') attachWebgl()
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    const themeObserver = new MutationObserver(() => {
      if (!disposed) term.options.theme = readXtermTheme(container)
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const sendResize = async (): Promise<void> => {
      // Before the attach lands there's no PTY to resize, and main says so —
      // which used to read as "terminal lost connection" and drop a healthy
      // terminal to read-only whenever the attach took longer than the first
      // resize's 150ms debounce. The attach sends its own resize once live.
      if (!attached) return
      const ok = await terminalResize(tmuxSessionName, term.cols, term.rows)
      if (!ok && terminalLiveRef.current) {
        terminalLiveRef.current = false
        onFallback('terminal lost connection')
      }
    }
    const resizeObserver = new ResizeObserver(() => {
      if (disposed || !terminalLiveRef.current) return
      fit.fit()
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(sendResize, RESIZE_DEBOUNCE_MS)
    })
    resizeObserver.observe(container)

    const dataDisposable = term.onData((data) => {
      if (!terminalLiveRef.current) return
      void (async () => {
        const ok = await terminalInput(tmuxSessionName, paneId, data)
        if (!ok && terminalLiveRef.current) {
          terminalLiveRef.current = false
          onFallback('terminal lost connection')
        }
      })()
    })

    const scrollDisposable = term.onScroll(() => {
      const buf = term.buffer.active
      const atBottom = buf.viewportY >= buf.length - term.rows - 1
      onAtBottomChange?.(atBottom)
    })

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Escape') {
        const now = Date.now()
        if (now - lastEscRef.current < ESC_ESC_WINDOW_MS) {
          term.blur()
          lastEscRef.current = 0
          return false
        }
        lastEscRef.current = now
      }
      return true
    })

    const handleFocusIn = (): void => onFocusChange?.(true)
    const handleFocusOut = (): void => onFocusChange?.(false)
    term.textarea?.addEventListener('focus', handleFocusIn)
    term.textarea?.addEventListener('blur', handleFocusOut)

    // One detach per successful attach, and only per successful attach: the main
    // process refcounts attaches as a multiset, so an unmatched detach would tear
    // down a PTY another mount is still using, and a missing one leaks it. Before
    // this, nothing in the renderer ever called terminalDetach at all, so every
    // session switch orphaned a PTY.
    let attached = false

    ;(async () => {
      const result = await terminalAttach(tmuxSessionName, paneId, BACKFILL_LINES)
      if (disposed) return
      if (!result.ok || result.fallback) {
        onFallback(result.reason ?? 'tmux control mode is unavailable')
        return
      }
      attached = true
      if (result.backfill) term.write(result.backfill)
      sendResize()
      onAtBottomChange?.(true)
      unsubscribeOutput = onTerminalOutput((payload) => {
        if (disposed) return
        if (payload.tmuxSessionName !== tmuxSessionName || payload.paneId !== paneId) return
        term.write(payload.data)
      })
      onReady?.()
    })()

    return () => {
      disposed = true
      if (attached) void terminalDetach(tmuxSessionName, paneId)
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      themeObserver.disconnect()
      unsubscribeOutput?.()
      dataDisposable.dispose()
      scrollDisposable.dispose()
      term.textarea?.removeEventListener('focus', handleFocusIn)
      term.textarea?.removeEventListener('blur', handleFocusOut)
      document.removeEventListener('visibilitychange', handleVisibility)
      releaseWebgl()
      webglControl.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // tmuxSessionName/paneId identify the terminal instance; a change means
    // a different pane, so the whole xterm instance is torn down and rebuilt
    // rather than re-pointed.

    // fontSize is deliberately not a dep: it is applied to the live terminal
    // by the effect below instead, so changing it in Settings does not tear
    // down the pane. eslint cannot know that, hence the disable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmuxSessionName, paneId])

  // Size changes reach the terminal that is already running. A refit is what
  // turns the new cell size into new cols/rows, and tmux has to be told, or
  // the pane keeps drawing to the old geometry.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    const next = seamlessFontSize(fontSize, term.options.fontFamily ?? 'monospace')
    if (term.options.fontSize === next) return
    term.options.fontSize = next
    fit.fit()
    void terminalResize(tmuxSessionName, term.cols, term.rows)
  }, [fontSize, tmuxSessionName])

  return (
    <div
      className={dropping ? 'terminal-surface terminal-surface--dropping' : 'terminal-surface'}
      // Every drag is accepted: macOS offers some (a screenshot dragged
      // from its preview thumbnail) with types we don't list, and refusing
      // them meant the drop silently did nothing.
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropping) setDropping(true)
      }}
      onDragLeave={(e) => {
        // Leaving for a child (xterm's own layers) isn't leaving the terminal.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        // Read it all now: the browser empties dataTransfer the moment this
        // handler returns, and the work below is async.
        const files = [...e.dataTransfer.files]
        const uriList = e.dataTransfer.getData('text/uri-list')
        const plain = e.dataTransfer.getData('text/plain')
        // Start keeping the files now, before any await: a screenshot fresh
        // from its preview thumbnail sits in a temp folder macOS empties
        // moments after the drop. Main copies those out; for anything with
        // no path, the bytes are read here while the File still has them.
        const withPath = files.map((file) => ({ file, path: getPathForDroppedFile(file) }))
        const kept = addDroppedPaths(withPath.filter((f) => f.path).map((f) => f.path))
        const bytes = withPath.map(({ file, path }) =>
          !path && file.type.startsWith('image/')
            ? file.arrayBuffer().catch(() => null)
            : Promise.resolve(null)
        )
        void (async () => {
          const term = termRef.current
          if (!term) return
          if (!terminalLiveRef.current) {
            flashNote("This terminal is read-only right now, so the drop can't be typed in.")
            return
          }
          const paths: string[] = []
          const unusable: string[] = []
          for (const result of await kept) {
            if (result.ok) paths.push(result.path)
            else unusable.push(`${result.name} (${result.error})`)
          }
          for (const [i, { file, path }] of withPath.entries()) {
            if (path) continue
            // No path at all — a file an app promised but hasn't written. An
            // image's bytes are still here: save them, as a pasted image is.
            const data = await bytes[i]
            if (data) {
              const saved = await pasteAttachmentImage(new Uint8Array(data), file.type)
              if (saved.ok) paths.push(saved.path)
              else unusable.push(`${saved.name} (${saved.error})`)
            } else {
              unusable.push(file.name || 'a file')
            }
          }
          // Some drags carry file links rather than files.
          if (files.length === 0 && uriList) {
            for (const line of uriList.split(/\r?\n/)) {
              const uri = line.trim()
              if (!uri.startsWith('file://')) continue
              try {
                paths.push(decodeURIComponent(new URL(uri).pathname))
              } catch {
                unusable.push(uri)
              }
            }
          }
          const text = paths.length
            ? paths.map(shellEscapePath).join(' ') + ' '
            : files.length === 0
              ? plain
              : ''
          if (text.trim()) {
            // paste(), not a raw write: it goes through the same input path
            // as typing and honours bracketed paste, which is how the agent
            // can tell a pasted path from keystrokes.
            term.paste(text)
            term.focus()
          }
          if (unusable.length) flashNote(`Couldn't use ${unusable.join(', ')}.`)
          else if (!text.trim()) flashNote('Nothing in that drop could be typed in.')
        })()
      }}
    >
      {/* xterm lives in its own box, so the find bar can sit over it. */}
      <div className="terminal-xterm" ref={containerRef} />
      {dropNote && (
        <div className="terminal-drop-note" role="status">
          {dropNote}
        </div>
      )}
      {searchOpen && (
        <div className="terminal-search" role="search">
          <input
            ref={searchInputRef}
            className="terminal-search-input"
            placeholder="Find"
            aria-label="Find in terminal"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              find('next', e.target.value, true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                find(e.shiftKey ? 'previous' : 'next')
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                closeSearch()
              }
            }}
          />
          <span className="terminal-search-count" aria-live="polite">
            {!query
              ? ''
              : results && results.count > 0
                ? `${results.index + 1} of ${results.count}`
                : 'No results'}
          </span>
          <IconButton
            icon="ChevronUp"
            label="Previous match (Shift+Enter)"
            size={28}
            variant="ghost"
            onClick={() => find('previous')}
          />
          <IconButton
            icon="ChevronDown"
            label="Next match (Enter)"
            size={28}
            variant="ghost"
            onClick={() => find('next')}
          />
          <IconButton
            icon="X"
            label="Close find (Escape)"
            size={28}
            variant="ghost"
            onClick={closeSearch}
          />
        </div>
      )}
    </div>
  )
})

export default Terminal
