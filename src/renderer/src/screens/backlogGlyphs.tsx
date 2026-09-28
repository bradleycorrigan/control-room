import { Fragment } from 'react'
import { openExternal } from '../api'

/**
 * Small marks for the Backlog: where a ticket is in its workflow, how urgent
 * it is, and who has it — read at a glance, the way Linear does it. Each one
 * is a shape as well as a colour, and each carries its word as a label.
 */

import { statusKind } from './backlogStatus'

export function StatusGlyph({
  name,
  category,
  size = 14
}: {
  name: string
  category: string
  size?: number
}): React.JSX.Element {
  const kind = statusKind(name, category)
  return (
    <svg
      className={`backlog-glyph backlog-glyph--${kind}`}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      role="img"
      aria-label={name}
    >
      <title>{name}</title>
      {kind === 'done' ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.2 7.2 6.1 9 9.8 5.2"
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : kind === 'cancelled' ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.8 4.8 9.2 9.2M9.2 4.8 4.8 9.2"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={kind === 'backlog' ? '1.6 1.6' : undefined}
          />
          {kind === 'progress' && <path d="M7 7V3.5A3.5 3.5 0 0 1 7 10.5Z" fill="currentColor" />}
          {kind === 'review' && <path d="M7 7V3.5A3.5 3.5 0 1 1 3.5 7Z" fill="currentColor" />}
          {kind === 'blocked' && (
            <path
              d="M5.6 5v4M8.4 5v4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          )}
        </>
      )}
    </svg>
  )
}

/** Bars for urgency; Highest is a solid alert. No priority is a flat dash. */
export function PriorityGlyph({
  priority,
  size = 14
}: {
  priority: string | null
  size?: number
}): React.JSX.Element {
  const label = priority ? `${priority} priority` : 'No priority'
  const level = !priority
    ? -1
    : /highest|critical|blocker|urgent/i.test(priority)
      ? 4
      : /high|major/i.test(priority)
        ? 3
        : /lowest|trivial/i.test(priority)
          ? 0
          : /low|minor/i.test(priority)
            ? 1
            : 2
  return (
    <svg
      className={`backlog-glyph backlog-priority backlog-priority--${level === 4 ? 'urgent' : 'bars'}`}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {level === 4 ? (
        <>
          <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M7 3.8v4" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r="0.95" fill="var(--bg)" />
        </>
      ) : level === -1 ? (
        <path
          d="M2.5 7h1.5M6.25 7h1.5M10 7h1.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : (
        [0, 1, 2].map((i) => (
          <rect
            key={i}
            x={1.5 + i * 4}
            y={9 - i * 3}
            width="3"
            height={3 + i * 3}
            rx="0.8"
            fill="currentColor"
            opacity={i < level ? 1 : 0.28}
          />
        ))
      )}
    </svg>
  )
}

const AVATAR_TONES = [
  'var(--accent)',
  'var(--status-working)',
  'var(--status-done)',
  'var(--status-attention)',
  'var(--status-error)'
]

function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words[words.length - 1][0] ?? '') : ''))
    .toUpperCase()
    .slice(0, 2)
}

/** Initials in a circle, tinted by the name so the same person is the same colour. */
export function Avatar({
  name,
  size = 18
}: {
  name: string | null
  size?: number
}): React.JSX.Element {
  if (!name) {
    return (
      <span
        className="backlog-avatar backlog-avatar--none"
        style={{ width: size, height: size }}
        role="img"
        aria-label="Unassigned"
        title="Unassigned"
      />
    )
  }
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span
      className="backlog-avatar"
      style={
        {
          width: size,
          height: size,
          fontSize: Math.round(size * 0.45),
          '--avatar-tone': AVATAR_TONES[hash % AVATAR_TONES.length]
        } as React.CSSProperties
      }
      role="img"
      aria-label={name}
      title={name}
    >
      {initials(name)}
    </span>
  )
}

/** Slack's mark in one colour (Simple Icons, CC0), so it sits with the other icons. */
export function SlackGlyph({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  )
}

/** The epic's mark: a small accent diamond. */
export function EpicMark(): React.JSX.Element {
  return <span className="backlog-epic-mark" aria-hidden="true" />
}

// ---------------------------------------------------------------------------
// Jira wiki markup → React, for descriptions and comments. A subset: the
// headings, lists, code, quotes, tables, links and inline styles tickets
// actually use. Everything is text nodes — nothing is injected as HTML.

const INLINE =
  /(\[[^\]\n]+\])|(\{\{[^}\n]+\}\})|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s|\]]+)|(![^!\s][^!\n]*!)/g

function openLink(url: string): void {
  if (/^https?:\/\//.test(url)) void openExternal(url)
}

function inline(
  text: string,
  keyBase: string,
  people: Record<string, string> = {}
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0
    // * and _ only style when they sit at word edges ("a*b*c" stays as typed).
    const token = m[0]
    const before = text[start - 1]
    const after = text[start + token.length]
    const edgeStyled =
      (m[3] || m[4]) && ((before && /\w/.test(before)) || (after && /\w/.test(after)))
    if (edgeStyled) continue
    if (start > last) out.push(text.slice(last, start))
    const key = `${keyBase}-${n++}`
    if (m[1]) {
      const body = token.slice(1, -1)
      if (body.startsWith('~')) {
        const id = body.replace(/^~(accountid:)?/, '').split('|')[0]
        out.push(
          <span key={key} className="backlog-wiki-mention">
            @{people[id] ?? body.split('|')[1] ?? 'someone'}
          </span>
        )
      } else {
        const [label, url] = body.includes('|') ? body.split('|', 2) : [body, body]
        out.push(
          /^https?:\/\//.test(url) ? (
            <button
              key={key}
              type="button"
              className="backlog-link"
              onClick={(e) => {
                e.stopPropagation()
                openLink(url)
              }}
            >
              {label}
            </button>
          ) : (
            token
          )
        )
      }
    } else if (m[2]) out.push(<code key={key}>{token.slice(2, -2)}</code>)
    else if (m[3]) out.push(<strong key={key}>{token.slice(1, -1)}</strong>)
    else if (m[4]) out.push(<em key={key}>{token.slice(1, -1)}</em>)
    else if (m[5]) {
      out.push(
        <button key={key} type="button" className="backlog-link" onClick={() => openLink(token)}>
          {token.replace(/^https?:\/\//, '').slice(0, 60)}
        </button>
      )
    } else if (m[6]) {
      out.push(
        <span key={key} className="backlog-wiki-attachment">
          {token.slice(1, -1).split('|')[0]}
        </span>
      )
    }
    last = start + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: { depth: number; text: string }[] }
  | { kind: 'pre'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; rows: { header: boolean; cells: string[] }[] }
  | { kind: 'hr' }

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    const fence = trimmed.match(/^\{(code|noformat|quote)(:[^}]*)?\}(.*)$/)
    if (fence) {
      const tag = fence[1]
      const close = `{${tag}}`
      const body: string[] = []
      let rest = fence[3]
      i++
      for (;;) {
        const at = rest.indexOf(close)
        if (at !== -1) {
          body.push(rest.slice(0, at))
          break
        }
        body.push(rest)
        if (i >= lines.length) break
        rest = lines[i++]
      }
      const text = body.join('\n').replace(/^\n+|\n+$/g, '')
      blocks.push(tag === 'quote' ? { kind: 'quote', text: text.trim() } : { kind: 'pre', text })
      continue
    }
    if (!trimmed) {
      i++
      continue
    }
    const heading = trimmed.match(/^h([1-6])\.\s*(.*)$/)
    if (heading) {
      blocks.push({ kind: 'h', level: Number(heading[1]), text: heading[2] })
      i++
      continue
    }
    if (/^-{4,}$/.test(trimmed)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    if (trimmed.startsWith('bq. ')) {
      blocks.push({ kind: 'quote', text: trimmed.slice(4) })
      i++
      continue
    }
    if (/^\|/.test(trimmed)) {
      const rows: { header: boolean; cells: string[] }[] = []
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        const row = lines[i].trim()
        const header = row.startsWith('||')
        const cells = row
          .replace(/^\|\|?|\|\|?$/g, '')
          .split(header ? '||' : '|')
          .map((c) => c.trim())
        rows.push({ header, cells })
        i++
      }
      blocks.push({ kind: 'table', rows })
      continue
    }
    const bullet = trimmed.match(/^([*#-]+)\s+(.*)$/)
    if (bullet) {
      const ordered = bullet[1].endsWith('#')
      const items: { depth: number; text: string }[] = []
      while (i < lines.length) {
        const m = lines[i].trim().match(/^([*#-]+)\s+(.*)$/)
        if (!m) break
        items.push({ depth: m[1].length - 1, text: m[2] })
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(h[1-6]\.|[*#-]+\s|\||\{(code|noformat|quote)|bq\. |-{4,}$)/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim())
      i++
    }
    if (para.length) blocks.push({ kind: 'p', lines: para })
    else i++
  }
  return blocks
}

/** A ticket's description or a comment, formatted rather than raw markup. */
export function WikiText({
  source,
  people
}: {
  source: string
  /** Names for tagged account ids. */
  people?: Record<string, string>
}): React.JSX.Element {
  const blocks = parse(source)
  return (
    <div className="backlog-wiki">
      {blocks.map((b, bi) => {
        const k = `b${bi}`
        switch (b.kind) {
          case 'h':
            return (
              <p key={k} className={`backlog-wiki-h backlog-wiki-h${Math.min(b.level, 3)}`}>
                {inline(b.text, k, people)}
              </p>
            )
          case 'hr':
            return <hr key={k} />
          case 'pre':
            return <pre key={k}>{b.text}</pre>
          case 'quote':
            return <blockquote key={k}>{inline(b.text, k, people)}</blockquote>
          case 'table':
            return (
              <div key={k} className="backlog-wiki-table">
                <table>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.cells.map((c, ci) =>
                          r.header ? (
                            <th key={ci}>{inline(c, `${k}-${ri}-${ci}`, people)}</th>
                          ) : (
                            <td key={ci}>{inline(c, `${k}-${ri}-${ci}`, people)}</td>
                          )
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return (
              <Tag key={k}>
                {b.items.map((it, ii) => (
                  <li key={ii} style={{ marginLeft: it.depth * 16 }}>
                    {inline(it.text, `${k}-${ii}`, people)}
                  </li>
                ))}
              </Tag>
            )
          }
          default:
            return (
              <p key={k}>
                {b.lines.map((l, li) => (
                  <Fragment key={li}>
                    {li > 0 && <br />}
                    {inline(l, `${k}-${li}`, people)}
                  </Fragment>
                ))}
              </p>
            )
        }
      })}
    </div>
  )
}
