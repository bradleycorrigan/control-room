import { Fragment } from 'react'
import './markdown-text.css'

/**
 * Markdown, read-only, for the files you read in the app: a skill's
 * SKILL.md, a CLAUDE.md. Enough of it to read comfortably (headings, lists,
 * quotes, code, bold, italics) and nothing that could run: every piece is a
 * React element built from the text, never HTML. File contents are untrusted.
 * Links show their words; a table shows as its own text, in mono.
 */
export default function MarkdownText({ text }: { text: string }): React.JSX.Element {
  return <div className="md-text">{blocks(stripFrontmatter(text))}</div>
}

/** The YAML block at the top of a SKILL.md: shown as the dialog's header, not as text. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: { depth: number; text: string }[] }
  | { kind: 'rule' }

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
      const code: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
      out.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    // A table keeps its shape as text: cells line up in mono.
    if (/^\s*\|/.test(line)) {
      flush()
      const rows: string[] = []
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i])
      i--
      out.push({ kind: 'code', text: rows.join('\n') })
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

function blocks(text: string): React.ReactNode {
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
        return (
          <pre key={i} className="md-code">
            {b.text}
          </pre>
        )
      case 'quote':
        return <blockquote key={i}>{inline(b.text)}</blockquote>
      case 'rule':
        return <hr key={i} />
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

/** `code`, **bold**, *italic* or _italic_, and [words](link) as its words. */
function inline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const re =
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\b_([^_]+)_\b|\[([^\]]+)\]\([^)]*\)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[1] !== undefined) parts.push(<code key={k++}>{m[1]}</code>)
    else if (m[2] !== undefined || m[3] !== undefined)
      parts.push(<strong key={k++}>{m[2] ?? m[3]}</strong>)
    else if (m[4] !== undefined || m[5] !== undefined) parts.push(<em key={k++}>{m[4] ?? m[5]}</em>)
    else parts.push(<Fragment key={k++}>{m[6]}</Fragment>)
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
