import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatEntry } from '../../../main/exec/chatTranscript'
import type { PendingPrompt, PromptAnswer } from '../../../main/engine/prompts'
import MarkdownText from './MarkdownText'
import { Button } from './primitives'
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

  useEffect(() => {
    if (!claudeSessionId) return
    let alive = true
    const load = (): void => {
      void window.api
        .invoke<ChatEntry[] | null>('chat:transcript', claudeSessionId)
        .then((e) => alive && setEntries(e))
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

  // Follow the conversation while you're at the bottom; leave you be when
  // you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items, mine])

  return (
    <div className="cr-chat" data-chat-view>
      <div
        className="cr-chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="cr-chat-column">
          {entries === undefined ? null : items.length === 0 ? (
            <p className="cr-chat-empty">
              {claudeSessionId
                ? 'Nothing said yet. Send Claude a message below.'
                : 'This session has no conversation to show yet.'}
            </p>
          ) : (
            items.map((item) =>
              item.kind === 'user' ? (
                <div key={item.id} className="cr-chat-you" data-chat-you>
                  {item.text}
                </div>
              ) : item.kind === 'assistant' ? (
                <div key={item.id} className="cr-chat-claude" data-chat-claude>
                  <MarkdownText text={item.text} />
                </div>
              ) : (
                <ToolGroup key={item.id} tools={item.tools} />
              )
            )
          )}
          {mine.map((p) => (
            <PromptCard key={p.id} prompt={p} />
          ))}
        </div>
      </div>
      <Composer paneId={paneId} working={working} />
    </div>
  )
}

function ToolGroup({ tools }: { tools: ToolEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hidden = open ? 0 : Math.max(0, tools.length - TOOLS_SHOWN)
  return (
    <div className="cr-chat-tools" data-chat-tools>
      {hidden > 0 && (
        <button type="button" className="cr-chat-tools-more" onClick={() => setOpen(true)}>
          {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
        </button>
      )}
      {tools.slice(hidden).map((t) => (
        <div key={t.id} className="cr-chat-tool" data-failed={t.failed || undefined}>
          <span className="cr-chat-tool-label">{t.label}</span>
          {t.detail && (
            <span className="cr-chat-tool-detail" title={t.detail}>
              {t.detail}
            </span>
          )}
          {t.added !== null && t.added > 0 && (
            <span className="cr-chat-tool-added">+{t.added}</span>
          )}
          {t.removed !== null && t.removed > 0 && (
            <span className="cr-chat-tool-removed">−{t.removed}</span>
          )}
          {t.failed && <span className="cr-chat-tool-failed">failed</span>}
        </div>
      ))}
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

function Composer({
  paneId,
  working
}: {
  paneId: string | null
  working: boolean
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = (): void => {
    if (!paneId || !text.trim() || sending) return
    setSending(true)
    setError(null)
    void window.api
      .invoke<{ ok: boolean; error: string | null }>('chat:send', paneId, text)
      .then((r) => {
        setSending(false)
        if (r.ok) setText('')
        else setError(r.error)
      })
  }
  const interrupt = (): void => {
    if (paneId) void window.api.invoke('chat:interrupt', paneId)
  }
  return (
    <div className="cr-chat-composer-row">
      <div className="cr-chat-composer">
        <textarea
          className="cr-chat-input"
          aria-label="Message Claude"
          placeholder={paneId ? 'Message Claude…' : 'Claude isn’t running in a terminal'}
          disabled={!paneId}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape' && working) {
              e.preventDefault()
              interrupt()
            }
          }}
        />
        <div className="cr-chat-composer-foot">
          {error ? (
            <span className="cr-chat-prompt-error" role="alert">
              {error}
            </span>
          ) : (
            <span className="cr-chat-hint">
              <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
              {working && (
                <>
                  {' '}
                  · <kbd>Esc</kbd> to stop
                </>
              )}
            </span>
          )}
          {working && (
            <Button variant="outlined" size="compact" disabled={!paneId} onClick={interrupt}>
              Stop
            </Button>
          )}
          <Button
            variant="filled"
            size="compact"
            disabled={!paneId || !text.trim() || sending}
            onClick={send}
          >
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}
