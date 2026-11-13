import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatEntry } from '../../../main/exec/chatTranscript'
import type { PendingPrompt, PromptAnswer } from '../../../main/engine/prompts'
import MarkdownText from './MarkdownText'
import { Button, EmptyState, Icon, IconButton, Modal } from './primitives'
import CopyButton from './CopyButton'
import AttachmentChips from './AttachmentChips'
import { useAttachments } from './useAttachments'
import './chat-view.css'

/**
 * A session as a conversation: the transcript, Claude's open prompts as cards
 * you can answer here, and a message box. The agent still runs in its tmux
 * pane; the Terminal view is one switch away and answers the same prompts.
 */
interface Props {
  claudeSessionId: string | null
  paneId: string | null
  working: boolean
}

type ToolEntry = Extract<ChatEntry, { kind: 'tool' }>
type Item = Exclude<ChatEntry, ToolEntry> | { kind: 'tools'; id: string; tools: ToolEntry[] }

const TOOLS_SHOWN = 5

type Row = Item | { kind: 'day'; id: string; label: string }

/** "Today", "Yesterday", or "Tuesday 11 November". */
function dayLabel(d: Date): string {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

/** A divider wherever the day changes, so a long-running session reads in order. */
function withDays(items: Item[]): Row[] {
  const out: Row[] = []
  let last: string | null = null
  for (const item of items) {
    const at = item.kind === 'user' || item.kind === 'assistant' ? item.at : null
    const d = at ? new Date(at) : null
    if (d && !Number.isNaN(d.getTime())) {
      const day = d.toDateString()
      if (day !== last) {
        if (last !== null) out.push({ kind: 'day', id: `day-${day}`, label: dayLabel(d) })
        last = day
      }
    }
    out.push(item)
  }
  return out
}

function group(entries: ChatEntry[]): Item[] {
  const out: Item[] = []
  for (const e of entries) {
    const last = out[out.length - 1]
    if (e.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(e)
      else out.push({ kind: 'tools', id: `t-${e.id}`, tools: [e] })
    } else out.push(e)
  }
  return out
}

export default function ChatView({ claudeSessionId, paneId, working }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<ChatEntry[] | null | undefined>(undefined)
  const [prompts, setPrompts] = useState<PendingPrompt[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  // What you sent that the transcript hasn't caught up with yet: shown at
  // once, faded, so a message never seems to vanish for a second or two.
  const [sent, setSent] = useState<{ id: string; text: string }[]>([])
  // Messages there on first load appear as they are; later ones ease in.
  const [firstIds, setFirstIds] = useState<Set<string> | null>(null)
  const isNew = (id: string): true | undefined => (firstIds && !firstIds.has(id) ? true : undefined)

  useEffect(() => {
    if (!claudeSessionId) return
    let alive = true
    // The version of the transcript last shown: main sends no entries, and
    // nothing here redraws, until it changes.
    let version: string | undefined
    const load = (): void => {
      void window.api
        .invoke<{ version: string; entries?: ChatEntry[] } | null>(
          'chat:transcript',
          claudeSessionId,
          version
        )
        .then((r) => {
          if (!alive) return
          if (!r) {
            setEntries(null)
            return
          }
          version = r.version
          const e = r.entries
          if (!e) return
          setEntries(e)
          setFirstIds((f) => f ?? new Set(e.map((x) => x.id)))
        })
    }
    load()
    const t = setInterval(load, 1500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [claudeSessionId])

  useEffect(() => {
    void window.api.invoke<PendingPrompt[]>('prompts:list').then(setPrompts)
    return window.api.on('prompts:changed', (p) => setPrompts(p as PendingPrompt[]))
  }, [])

  const mine = useMemo(
    () => prompts.filter((p) => !!claudeSessionId && p.claudeSessionId === claudeSessionId),
    [prompts, claudeSessionId]
  )
  const items = useMemo(() => group(entries ?? []), [entries])
  const rows = useMemo(() => withDays(items), [items])
  const yours = useMemo(
    () => (entries ?? []).filter((e) => e.kind === 'user').map((e) => e.text),
    [entries]
  )
  const waiting = sent.filter((m) => !yours.some((t) => t.includes(m.text.trim().slice(0, 80))))
  const scrollToEnd = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // Follow the conversation while you're at the bottom; leave you be when
  // you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items, mine, waiting.length])

  return (
    <div className="cr-chat" data-chat-view>
      <FindBar scrollRef={scrollRef} />
      <div
        className="cr-chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          setAtBottom(stickRef.current)
        }}
      >
        <div className="cr-chat-column">
          {entries === undefined ? null : items.length === 0 ? (
            <EmptyState
              className="cr-chat-empty"
              icon="MessageSquare"
              title="No messages yet"
              body="Ask Claude something below. What you send goes to the session's terminal, as if you'd typed it there."
            />
          ) : (
            rows.map((item) =>
              item.kind === 'day' ? (
                <div key={item.id} className="cr-chat-day" role="separator">
                  <span>{item.label}</span>
                </div>
              ) : item.kind === 'user' ? (
                <YouMessage
                  key={item.id}
                  text={item.text}
                  at={item.at}
                  images={item.images}
                  claudeSessionId={claudeSessionId}
                  isNew={isNew(item.id)}
                />
              ) : item.kind === 'assistant' ? (
                <ClaudeMessage key={item.id} text={item.text} at={item.at} isNew={isNew(item.id)} />
              ) : (
                <ToolGroup key={item.id} tools={item.tools} isNew={isNew(item.id)} />
              )
            )
          )}
          {waiting.map((m) => (
            <div key={m.id} className="cr-chat-you-wrap" data-sending>
              <div className="cr-chat-you">{m.text}</div>
            </div>
          ))}
          {mine.map((p) => (
            <PromptCard key={p.id} prompt={p} />
          ))}
          {working && mine.length === 0 && <Working paneId={paneId} />}
        </div>
      </div>
      {!atBottom && items.length > 0 && (
        <button type="button" className="cr-chat-jump" onClick={scrollToEnd}>
          <Icon name="ArrowDown" size={14} />
          Latest
        </button>
      )}
      <Composer
        paneId={paneId}
        working={working}
        lastSent={yours[yours.length - 1] ?? null}
        onSent={(text) => {
          setSent((s) => [...s, { id: crypto.randomUUID(), text }])
          scrollToEnd()
        }}
      />
    </div>
  )
}

/**
 * Claude at work: a turning sparkle in the working colour and the words
 * Claude Code itself is showing ("Blanching… 1m 22s"), read off its pane
 * every second. Before that line appears, "Working…" and a timer of its own.
 */
function Working({ paneId }: { paneId: string | null }): React.JSX.Element {
  const [activity, setActivity] = useState<{ verb: string; elapsed: string | null } | null>(null)
  const [since] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      setNow(Date.now())
      if (paneId)
        void window.api
          .invoke<{ verb: string; elapsed: string | null } | null>('chat:activity', paneId)
          .then((a) => alive && setActivity(a))
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [paneId])
  const secs = Math.max(0, Math.round((now - since) / 1000))
  const ownTime = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
  return (
    <div className="cr-chat-working" role="status" data-chat-working>
      <svg className="cr-chat-working-mark" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13" />
      </svg>
      <span className="cr-chat-working-verb">{activity?.verb ?? 'Working…'}</span>
      <span className="cr-chat-working-time">{activity ? (activity.elapsed ?? '') : ownTime}</span>
    </div>
  )
}

/**
 * ⌘F: find in the conversation. Every match is highlighted where it sits
 * (the CSS highlight API, so nothing in the messages is rewritten), the
 * current one stronger, with Enter and Shift+Enter to step through them.
 */
function FindBar({
  scrollRef
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const ranges = useRef<Range[]>([])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setOpen(true)
        setTimeout(() => inputRef.current?.select(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Find every match in the messages' text, and paint them.
  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const clear = (): void => {
      highlights?.delete('cr-find')
      highlights?.delete('cr-find-current')
    }
    const root = scrollRef.current
    const q = query.trim().toLowerCase()
    if (!open || !root || !q) {
      ranges.current = []
      setCount(0)
      clear()
      return clear
    }
    const found: Range[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').toLowerCase()
      for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
        const r = new Range()
        r.setStart(node, at)
        r.setEnd(node, at + q.length)
        found.push(r)
      }
    }
    ranges.current = found
    setCount(found.length)
    setCurrent(found.length ? found.length - 1 : 0)
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (highlights && H) highlights.set('cr-find', new H(...found))
    return clear
  }, [open, query, scrollRef])

  // The current match: painted stronger and scrolled into view.
  useEffect(() => {
    const r = ranges.current[current]
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!r) {
      highlights?.delete('cr-find-current')
      return
    }
    if (highlights && H) highlights.set('cr-find-current', new H(r))
    r.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [current, count])

  if (!open) return null
  const step = (by: number): void => {
    if (count) setCurrent((c) => (c + by + count) % count)
  }
  const close = (): void => {
    setOpen(false)
    setQuery('')
  }
  return (
    <div className="cr-chat-find" role="search">
      <Icon name="Search" size={14} />
      <input
        ref={inputRef}
        className="cr-chat-find-input"
        aria-label="Find in this conversation"
        placeholder="Find in conversation"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? 1 : -1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      />
      <span className="cr-chat-find-count" aria-live="polite">
        {query.trim() ? (count ? `${count - current} of ${count}` : 'No matches') : ''}
      </span>
      <IconButton
        icon="ChevronUp"
        label="Previous match (Enter)"
        size={28}
        variant="ghost"
        disabled={!count}
        onClick={() => step(-1)}
      />
      <IconButton
        icon="ChevronDown"
        label="Next match (Shift+Enter)"
        size={28}
        variant="ghost"
        disabled={!count}
        onClick={() => step(1)}
      />
      <IconButton icon="X" label="Close find (Esc)" size={28} variant="ghost" onClick={close} />
    </div>
  )
}

/** "14:32" today, "12 Nov, 14:32" before; the full date on hover. */
function MessageTime({ at }: { at: string }): React.JSX.Element | null {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return null
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const today = d.toDateString() === new Date().toDateString()
  const label = today
    ? time
    : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
  return (
    <time className="cr-chat-time" dateTime={at} title={d.toLocaleString()}>
      {label}
    </time>
  )
}

// The block Home and Chat add after a message with files on it
// (withAttachments, engine/sessions.ts): shown as the files, not the words.
const ATTACHED =
  /\n*Attached files - read these from disk before you start:\n((?:- .+\n?)+)\nLook at each one above before continuing\.\s*$/
const LONG_LINES = 10
const LONG_CHARS = 700

/**
 * What you said: your words in a bubble, files as chips under them, and a
 * long paste cut to its first lines with a way to see the rest.
 */
// Pasted images, fetched once each and kept for the life of the window.
const imageCache = new Map<string, string>()

/** An image you pasted, as a thumbnail that opens full size. */
function ChatImage({
  claudeSessionId,
  imageKey
}: {
  claudeSessionId: string | null
  imageKey: string
}): React.JSX.Element {
  const cacheKey = `${claudeSessionId}/${imageKey}`
  const [src, setSrc] = useState<string | null>(() => imageCache.get(cacheKey) ?? null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (src || !claudeSessionId) return
    let alive = true
    void window.api.invoke<string | null>('chat:image', claudeSessionId, imageKey).then((url) => {
      if (!url || !alive) return
      imageCache.set(cacheKey, url)
      setSrc(url)
    })
    return () => {
      alive = false
    }
  }, [src, claudeSessionId, imageKey, cacheKey])
  return (
    <>
      <button
        type="button"
        className="cr-chat-image"
        aria-label="Open pasted image"
        disabled={!src}
        onClick={() => setOpen(true)}
      >
        {src ? <img src={src} alt="Pasted image" /> : <Icon name="Image" size={20} />}
      </button>
      {open && src && (
        <Modal title="Pasted image" icon="Image" width={960} onClose={() => setOpen(false)}>
          <img className="cr-chat-image-full" src={src} alt="Pasted image, full size" />
        </Modal>
      )}
    </>
  )
}

/**
 * Claude's words. Drawn once per message: a new message, a prompt or a
 * scroll redraws the list around it, never its markdown again.
 */
const ClaudeMessage = memo(function ClaudeMessage({
  text,
  at,
  isNew
}: {
  text: string
  at: string | null
  isNew?: true
}): React.JSX.Element {
  return (
    <div className="cr-chat-claude" data-chat-claude data-new={isNew}>
      <MarkdownText text={text} copyable />
      <div className="cr-chat-claude-tools">
        {at && <MessageTime at={at} />}
        <CopyButton text={text} label="Copy message" />
      </div>
    </div>
  )
})

const YouMessage = memo(function YouMessage({
  text,
  at,
  images,
  claudeSessionId,
  isNew
}: {
  text: string
  at: string | null
  images: string[]
  claudeSessionId: string | null
  isNew?: true
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const m = text.match(ATTACHED)
  const words = m ? text.slice(0, m.index).trimEnd() : text
  const files = m
    ? m[1]
        .split('\n')
        .map((l) => l.replace(/^- /, '').trim())
        .filter(Boolean)
    : []
  const lines = words.split('\n').length
  const long = lines > LONG_LINES || words.length > LONG_CHARS
  return (
    <div className="cr-chat-you-wrap" data-chat-you data-new={isNew}>
      {words && (
        <div className="cr-chat-you" data-clamped={(long && !open) || undefined}>
          {words}
        </div>
      )}
      {long && (
        <button type="button" className="cr-chat-you-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show all ${lines} lines`}
        </button>
      )}
      {words && (
        <div className="cr-chat-you-tools">
          {at && <MessageTime at={at} />}
          <CopyButton text={words} label="Copy message" />
        </div>
      )}
      {images.length > 0 && (
        <div className="cr-chat-you-images">
          {images.map((k) => (
            <ChatImage key={k} claudeSessionId={claudeSessionId} imageKey={k} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="cr-chat-you-files">
          {files.map((f) => (
            <span key={f} className="cr-attachment-chip cr-attachment-chip--ok" title={f}>
              <Icon name="Paperclip" size={14} />
              <span className="cr-attachment-chip-name">{f.split('/').pop()}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
})

const ToolGroup = memo(function ToolGroup({
  tools,
  isNew
}: {
  tools: ToolEntry[]
  isNew?: true
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hidden = open ? 0 : Math.max(0, tools.length - TOOLS_SHOWN)
  return (
    <div className="cr-chat-tools" data-chat-tools data-new={isNew}>
      {hidden > 0 && (
        <button type="button" className="cr-chat-tools-more" onClick={() => setOpen(true)}>
          {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
        </button>
      )}
      {tools.slice(hidden).map((t) => (
        <ToolRow key={t.id} tool={t} />
      ))}
    </div>
  )
})

/** One tool call. A long command or path opens in place to show all of it. */
function ToolRow({ tool: t }: { tool: ToolEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const long = t.detail.length > 60
  const body = (
    <>
      <span className="cr-chat-tool-label">{t.label}</span>
      {t.detail && <span className="cr-chat-tool-detail">{t.detail}</span>}
      {t.added !== null && t.added > 0 && <span className="cr-chat-tool-added">+{t.added}</span>}
      {t.removed !== null && t.removed > 0 && (
        <span className="cr-chat-tool-removed">−{t.removed}</span>
      )}
      {t.failed && <span className="cr-chat-tool-failed">failed</span>}
    </>
  )
  return long ? (
    <button
      type="button"
      className="cr-chat-tool cr-chat-tool--long"
      data-failed={t.failed || undefined}
      data-open={open || undefined}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
    >
      {body}
    </button>
  ) : (
    <div className="cr-chat-tool" data-failed={t.failed || undefined}>
      {body}
    </div>
  )
}

function useAnswer(id: string): {
  busy: boolean
  error: string | null
  send: (a: PromptAnswer) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return {
    busy,
    error,
    send: (a) => {
      setBusy(true)
      setError(null)
      void window.api
        .invoke<{ ok: boolean; error: string | null }>('prompts:answer', id, a)
        .then((r) => {
          if (!r.ok) {
            setBusy(false)
            setError(r.error)
          }
        })
    }
  }
}

function PromptCard({ prompt }: { prompt: PendingPrompt }): React.JSX.Element {
  const title =
    prompt.kind === 'plan'
      ? 'Claude has a plan'
      : prompt.kind === 'question'
        ? 'Claude is asking'
        : prompt.toolName === 'Bash'
          ? 'Claude wants to run a command'
          : `Claude wants to use ${prompt.toolName}`
  return (
    <section className="cr-chat-prompt" data-prompt={prompt.kind} aria-label={title}>
      <header className="cr-chat-prompt-head">
        <span className="cr-chat-prompt-dot" aria-hidden="true" />
        <span className="cr-chat-prompt-word">Needs an answer</span>
        <span className="cr-chat-prompt-title">{title}</span>
      </header>
      {prompt.kind === 'permission' ? (
        <PermissionBody prompt={prompt} />
      ) : prompt.kind === 'plan' ? (
        <PlanBody prompt={prompt} />
      ) : (
        <QuestionBody prompt={prompt} />
      )}
    </section>
  )
}

function Footnote({ error }: { error: string | null }): React.JSX.Element {
  return error ? (
    <span className="cr-chat-prompt-error" role="alert">
      {error}
    </span>
  ) : (
    <span className="cr-chat-prompt-note">You can also answer in the terminal</span>
  )
}

function PermissionBody({ prompt }: { prompt: PendingPrompt }): React.JSX.Element {
  const { busy, error, send } = useAnswer(prompt.id)
  return (
    <>
      <pre className="cr-chat-prompt-code">{prompt.summary}</pre>
      <div className="cr-chat-prompt-actions">
        <Button
          variant="filled"
          size="compact"
          disabled={busy}
          onClick={() => send({ kind: 'allow' })}
        >
          Allow
        </Button>
        {prompt.canAlwaysAllow && (
          <Button
            variant="outlined"
            size="compact"
            disabled={busy}
            onClick={() => send({ kind: 'allowAlways' })}
          >
            Always allow
          </Button>
        )}
        <Button
          variant="outlined"
          size="compact"
          disabled={busy}
          onClick={() => send({ kind: 'deny' })}
        >
          Deny
        </Button>
        <Footnote error={error} />
      </div>
    </>
  )
}

function PlanBody({ prompt }: { prompt: PendingPrompt }): React.JSX.Element {
  const { busy, error, send } = useAnswer(prompt.id)
  const [changing, setChanging] = useState(false)
  const [feedback, setFeedback] = useState('')
  return (
    <>
      <div className="cr-chat-prompt-plan">
        <MarkdownText text={prompt.plan ?? ''} />
      </div>
      {changing ? (
        <form
          className="cr-chat-prompt-feedback"
          onSubmit={(e) => {
            e.preventDefault()
            if (feedback.trim()) send({ kind: 'deny', message: feedback.trim() })
          }}
        >
          <textarea
            className="cr-textarea"
            aria-label="What should Claude change?"
            placeholder="What should Claude change?"
            value={feedback}
            autoFocus
            rows={2}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="cr-chat-prompt-actions">
            <Button
              variant="filled"
              size="compact"
              type="submit"
              disabled={busy || !feedback.trim()}
            >
              Send to Claude
            </Button>
            <Button variant="ghost" size="compact" type="button" onClick={() => setChanging(false)}>
              Cancel
            </Button>
            <Footnote error={error} />
          </div>
        </form>
      ) : (
        <div className="cr-chat-prompt-actions">
          <Button
            variant="filled"
            size="compact"
            disabled={busy}
            onClick={() => send({ kind: 'approvePlan', mode: 'acceptEdits' })}
          >
            Approve, accept edits
          </Button>
          <Button
            variant="outlined"
            size="compact"
            disabled={busy}
            onClick={() => send({ kind: 'approvePlan', mode: 'default' })}
          >
            Approve, ask before edits
          </Button>
          <Button
            variant="outlined"
            size="compact"
            disabled={busy}
            onClick={() => setChanging(true)}
          >
            Keep planning
          </Button>
          <Footnote error={error} />
        </div>
      )}
    </>
  )
}

function QuestionBody({ prompt }: { prompt: PendingPrompt }): React.JSX.Element {
  const { busy, error, send } = useAnswer(prompt.id)
  // Per question: the labels picked, and what you typed under "Other".
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const OTHER = '\u0000other'
  const answers = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const q of prompt.questions) {
      const labels = (picked[q.question] ?? []).map((l) =>
        l === OTHER ? (other[q.question] ?? '').trim() : l
      )
      const joined = labels.filter(Boolean).join(', ')
      if (joined) out[q.question] = joined
    }
    return out
  }
  const complete = Object.keys(answers()).length === prompt.questions.length
  const toggle = (q: string, label: string, multi: boolean): void =>
    setPicked((p) => {
      const cur = p[q] ?? []
      if (!multi) return { ...p, [q]: [label] }
      return { ...p, [q]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  return (
    <>
      {prompt.questions.map((q, qi) => (
        <fieldset key={q.question} className="cr-chat-question">
          <legend className="cr-chat-question-text">{q.question}</legend>
          {[...q.options, { label: OTHER, description: null }].map((o) => {
            const on = (picked[q.question] ?? []).includes(o.label)
            return (
              <label key={o.label} className="cr-chat-option" data-on={on || undefined}>
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`q-${prompt.id}-${qi}`}
                  checked={on}
                  onChange={() => toggle(q.question, o.label, q.multiSelect)}
                />
                {o.label === OTHER ? (
                  <input
                    type="text"
                    className="cr-chat-option-other"
                    placeholder="Something else…"
                    aria-label={`Another answer to: ${q.question}`}
                    value={other[q.question] ?? ''}
                    onFocus={() => !on && toggle(q.question, OTHER, q.multiSelect)}
                    onChange={(e) => setOther((v) => ({ ...v, [q.question]: e.target.value }))}
                  />
                ) : (
                  <span className="cr-chat-option-words">
                    <span className="cr-chat-option-label">{o.label}</span>
                    {o.description && <span className="cr-chat-option-desc">{o.description}</span>}
                  </span>
                )}
              </label>
            )
          })}
        </fieldset>
      ))}
      <div className="cr-chat-prompt-actions">
        <Button
          variant="filled"
          size="compact"
          disabled={busy || !complete}
          onClick={() => send({ kind: 'answers', answers: answers() })}
        >
          Answer
        </Button>
        <Footnote error={error} />
      </div>
    </>
  )
}

// Claude Code's own commands that answer in the conversation. Ones that open
// a picker in the terminal (/model, /agents, /mcp…) are left out: from here
// you'd never see the picker.
const COMMANDS: { name: string; description: string }[] = [
  { name: 'clear', description: 'Start a new conversation' },
  { name: 'compact', description: 'Summarise the conversation to free up context' },
  { name: 'review', description: 'Review the changes on this branch' },
  { name: 'init', description: 'Write a CLAUDE.md for this project' }
]

/** The commands and your skills that start with what you've typed after "/". */
function useSlashMenu(text: string): {
  open: boolean
  items: { name: string; description: string }[]
} {
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const typing = /^\/[\w:-]*$/.test(text)
  useEffect(() => {
    if (!typing || skills.length) return
    void window.api
      .invoke<{ name: string; description: string }[]>('skills:list')
      .then((list) => setSkills(Array.isArray(list) ? list : []))
      .catch(() => setSkills([]))
  }, [typing, skills.length])
  if (!typing) return { open: false, items: [] }
  const q = text.slice(1).toLowerCase()
  const items = [...COMMANDS, ...skills]
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .slice(0, 8)
  return { open: items.length > 0, items }
}

function Composer({
  paneId,
  working,
  lastSent,
  onSent
}: {
  paneId: string | null
  working: boolean
  lastSent: string | null
  onSent: (text: string) => void
}): React.JSX.Element {
  // A draft survives switching to the terminal and back, per session.
  const draftKey = paneId ? `cr-chat-draft:${paneId}` : null
  const [text, setTextState] = useState(() => {
    try {
      return (draftKey && sessionStorage.getItem(draftKey)) || ''
    } catch {
      return ''
    }
  })
  const setText = (v: string): void => {
    setTextState(v)
    try {
      if (draftKey) {
        if (v) sessionStorage.setItem(draftKey, v)
        else sessionStorage.removeItem(draftKey)
      }
    } catch {
      // private storage: the draft lasts as long as the view
    }
  }
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const slash = useSlashMenu(text)
  const [pick, setPick] = useState(0)
  const choose = (name: string): void => {
    setText(`/${name} `)
    setPick(0)
    inputRef.current?.focus()
  }
  // Opening the chat puts you in the box, ready to type.
  useEffect(() => {
    if (paneId) inputRef.current?.focus()
  }, [paneId])
  // The same files as Home's composer: paperclip, drop, pasted image, and a
  // long paste as a file rather than a wall of text in the box.
  const attach = useAttachments(setError)
  const ready = !!paneId && (!!text.trim() || attach.chips.length > 0) && !attach.pending
  const send = (): void => {
    if (!ready || sending) return
    setSending(true)
    setError(null)
    const words = text
    void window.api
      .invoke<{ ok: boolean; error: string | null }>(
        'chat:send',
        paneId,
        words,
        attach.readyPaths()
      )
      .then((r) => {
        setSending(false)
        if (r.ok) {
          if (words.trim()) onSent(words.trim())
          setText('')
          attach.clear()
        } else setError(r.error)
      })
  }
  const interrupt = (): void => {
    if (paneId) void window.api.invoke('chat:interrupt', paneId)
  }
  return (
    <div className="cr-chat-composer-row">
      <div
        className="cr-chat-composer"
        data-drag-over={attach.dragOver || undefined}
        {...attach.dropProps}
      >
        <textarea
          ref={inputRef}
          className="cr-chat-input"
          aria-label="Message Claude"
          placeholder={
            !paneId
              ? 'Claude isn’t running in a terminal'
              : working
                ? 'Claude is working. What you send now waits its turn.'
                : 'Message Claude…'
          }
          disabled={!paneId}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setPick(0)
          }}
          onPaste={attach.onPaste}
          aria-autocomplete="list"
          aria-expanded={slash.open}
          aria-controls={slash.open ? 'cr-chat-slash' : undefined}
          onKeyDown={(e) => {
            if (slash.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              const n = slash.items.length
              setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
              return
            }
            if (slash.open && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              e.preventDefault()
              choose(slash.items[Math.min(pick, slash.items.length - 1)].name)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape' && working) {
              e.preventDefault()
              interrupt()
            } else if (e.key === 'ArrowUp' && !text && lastSent) {
              // As in the terminal: ↑ in an empty box brings back what you last sent.
              e.preventDefault()
              setText(lastSent)
            }
          }}
        />
        {slash.open && (
          <div className="cr-chat-slash" id="cr-chat-slash" role="listbox" aria-label="Commands">
            {slash.items.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === pick}
                className="cr-chat-slash-item"
                onMouseEnter={() => setPick(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(c.name)}
              >
                <span className="cr-chat-slash-name">/{c.name}</span>
                <span className="cr-chat-slash-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        <AttachmentChips attachments={attach} />
        <div className="cr-chat-composer-foot">
          <IconButton
            icon="Paperclip"
            label="Attach files"
            size={28}
            variant="ghost"
            disabled={!paneId}
            onClick={() => void attach.pick()}
          />
          {error ? (
            <span className="cr-chat-prompt-error" role="alert">
              {error}
            </span>
          ) : (
            <span className="cr-chat-hint">
              {working ? (
                <>
                  <kbd>Esc</kbd> to stop
                </>
              ) : !text && lastSent ? (
                <>
                  <kbd>↑</kbd> for your last message
                </>
              ) : (
                <>
                  <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
                </>
              )}
            </span>
          )}
          {/* One round button, as in chat apps: Stop while Claude works and
              the box is empty, Send otherwise (a message then waits its turn). */}
          {working && !text.trim() && attach.chips.length === 0 ? (
            <IconButton
              icon="Square"
              label="Stop Claude (Esc)"
              size={28}
              variant="filled"
              className="cr-chat-send cr-chat-stop"
              disabled={!paneId}
              onClick={interrupt}
            />
          ) : (
            <IconButton
              icon={sending ? 'Loader2' : 'ArrowUp'}
              label="Send (Enter)"
              size={28}
              variant="filled"
              className="cr-chat-send"
              data-sending={sending || undefined}
              disabled={!ready || sending}
              onClick={send}
            />
          )}
        </div>
      </div>
    </div>
  )
}
