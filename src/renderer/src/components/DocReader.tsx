import { useEffect, useState } from 'react'
import type { ReadFileResult } from '../api'
import { Button, Modal } from './primitives'
import MarkdownText from './MarkdownText'
import './doc-reader.css'

/**
 * A skill or rule file, whole, to read: opened by clicking its row on the
 * project's Skills or Rules tab. Read-only; "Open in Files" goes to the
 * editor when the file is inside the project.
 */
export default function DocReader({
  title,
  location,
  load,
  onOpenInFiles,
  onClose
}: {
  title: string
  /** Where the file lives, shown under the title. */
  location: string
  load: () => Promise<ReadFileResult>
  /** Only when the file can be edited from the Files tab. */
  onOpenInFiles?: () => void
  onClose: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<ReadFileResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void load().then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
    // Once per open: the dialog is remounted for each file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Modal title={title} icon="FileText" width={760} onClose={onClose} className="doc-reader">
      <div className="doc-reader-meta">
        <span className="doc-reader-location" title={location}>
          {location}
        </span>
        {onOpenInFiles && (
          <Button variant="ghost" size="compact" onClick={onOpenInFiles}>
            Open in Files
          </Button>
        )}
      </div>
      <div className="doc-reader-body">
        {!result && <p className="doc-reader-muted">Loading…</p>}
        {result && !result.ok && (
          <p className="doc-reader-error">Couldn’t read it: {result.error}</p>
        )}
        {result?.ok &&
          (result.content.trim() ? (
            <MarkdownText text={result.content} />
          ) : (
            <p className="doc-reader-muted">This file is empty.</p>
          ))}
      </div>
    </Modal>
  )
}
