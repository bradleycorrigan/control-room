import CopyButton from './CopyButton'
import { openExternal } from '../api'
import './markdown-text.css'

/**
 * Markdown, read-only, for the files you read in the app: a skill's
 * SKILL.md, a CLAUDE.md. Enough of it to read comfortably (headings, lists,
 * quotes, code, bold, italics) and nothing that could run: every piece is a
 * React element built from the text, never HTML. File contents are untrusted.
 * Web links (http, https) open in the browser; any other link shows its
 * words only. A table with a header row draws as a table.
 */
export default function MarkdownText({
  text,
  copyable = false
}: {
  text: string
  /** A copy button in each code block's corner, for the whole block. */
  copyable?: boolean
}): React.JSX.Element {
  return <div className="md-text">{blocks(stripFrontmatter(text), copyable)}</div>
}

/** The YAML block at the top of a SKILL.md: shown as the dialog's header, not as text. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: { depth: number; text: string }[] }
  | { kind: 'rule' }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }

type Align = 'left' | 'center' | 'right' | undefined

/** `| a | b |` into its cells; `\|` stays a bar inside a cell. */
function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function parse(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length) out.push({ kind: 'para', text: para.join(' ') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush()
      const lang = /^\s*```\s*([\w+#.-]{1,20})/.exec(line)?.[1]
      const code: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
      out.push({ kind: 'code', text: code.join('\n'), lang })
      continue
    }
    // A table with a header row and a |---| line under it draws as one;
    // anything else made of bars keeps its shape as text, in mono.
    if (/^\s*\|/.test(line)) {
      flush()
      const rows: string[] = []
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i])
      i--
      if (rows.length >= 2 && SEPARATOR.test(rows[1])) {
        const head = cells(rows[0])
        const align = cells(rows[1]).map((c): Align => {
          const l = c.startsWith(':')
          const r = c.endsWith(':')
          return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined
        })
        const body = rows.slice(2).map((r) => {
          const c = cells(r)
          return head.map((_, j) => c[j] ?? '')
        })
        out.push({ kind: 'table', head, align, rows: body })
      } else {
        out.push({ kind: 'code', text: rows.join('\n') })
      }
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      out.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push({ kind: 'rule' })
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[2])
      const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2)
      const last = out[out.length - 1]
      if (last?.kind === 'list' && last.ordered === ordered) {
        last.items.push({ depth, text: item[3] })
      } else {
        out.push({ kind: 'list', ordered, items: [{ depth, text: item[3] }] })
      }
      continue
    }
    // A wrapped line under a list item belongs to that item.
    const prev = out[out.length - 1]
    if (/^\s{2,}\S/.test(line) && para.length === 0 && prev?.kind === 'list') {
      prev.items[prev.items.length - 1].text += ` ${line.trim()}`
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      if (prev?.kind === 'quote') prev.text += ` ${quote[1]}`
      else out.push({ kind: 'quote', text: quote[1] })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    para.push(line.trim())
  }
  flush()
  return out
}

function blocks(text: string, copyable: boolean): React.ReactNode {
  return parse(text).map((b, i) => {
    switch (b.kind) {
      case 'heading': {
        // h1 and h2 read as section titles; anything deeper as a label.
        const Tag = b.level <= 2 ? 'h3' : 'h4'
        return (
          <Tag key={i} className={`md-heading md-heading--${Math.min(b.level, 3)}`}>
            {inline(b.text)}
          </Tag>
        )
      }
      case 'para':
        return <p key={i}>{inline(b.text)}</p>
      case 'code':
        return copyable ? (
          <div key={i} className="md-code-wrap">
            <div className="md-code-head">
              <span className="md-code-lang">{b.lang ?? ''}</span>
              <CopyButton text={b.text} label="Copy code" className="md-code-copy" />
            </div>
            <pre className="md-code">{b.text}</pre>
          </div>
        ) : (
          <pre key={i} className="md-code">
            {b.text}
          </pre>
        )
      case 'quote':
        return <blockquote key={i}>{inline(b.text)}</blockquote>
      case 'rule':
        return <hr key={i} />
      case 'table':
        return (
          <div key={i} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={{ textAlign: b.align[j] }}>
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k} style={{ textAlign: b.align[k] }}>
                        {inline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul'
        return (
          <Tag key={i}>
            {b.items.map((it, j) => (
              <li key={j} style={{ marginLeft: `${it.depth * 16}px` }}>
                {inline(it.text)}
              </li>
            ))}
          </Tag>
        )
      }
    }
  })
}

/** A web address, ready to open, or null for anything else (file:, javascript:...). */
function webLink(href: string): string | null {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function Link({ href, children }: { href: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <a
      className="md-link"
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault()
        void openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/** A bare address ends before trailing punctuation, and before a ) it didn't open. */
function trimBare(url: string): string {
  let u = url.replace(/[.,;:!?'"]+$/, '')
  while (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) {
    u = u.slice(0, -1).replace(/[.,;:!?'"]+$/, '')
  }
  return u
}

/** `code`, **bold**, *italic* or _italic_, [words](link), and bare web addresses. */
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const re =
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\b_([^_]+)_\b|\[([^\]]+)\]\(\s*<?([^)\s>]*)>?[^)]*\)|(https?:\/\/[^\s<>`]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[1] !== undefined) parts.push(<code key={k++}>{m[1]}</code>)
    else if (m[2] !== undefined || m[3] !== undefined)
      parts.push(<strong key={k++}>{inline(m[2] ?? m[3])}</strong>)
    else if (m[4] !== undefined || m[5] !== undefined)
      parts.push(<em key={k++}>{inline(m[4] ?? m[5])}</em>)
    else if (m[6] !== undefined) {
      const href = webLink(m[7])
      parts.push(
        href ? (
          <Link key={k++} href={href}>
            {inline(m[6])}
          </Link>
        ) : (
          <span key={k++}>{inline(m[6])}</span>
        )
      )
    } else {
      const bare = trimBare(m[8])
      const href = webLink(bare)
      parts.push(
        href ? (
          <Link key={k++} href={href}>
            {bare}
          </Link>
        ) : (
          bare
        )
      )
      re.lastIndex = m.index + bare.length
    }
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
