import { useLayoutEffect, useRef, useState } from 'react'

/**
 * A row of tabs that fits one line: as many as fit, in order, and the rest
 * folded behind a "+N more" button. The ones in `keep` (the selected ones,
 * say) never fold, so what's switched on is always in view.
 *
 * Widths come from a hidden copy of every item (`measureRef`, each child
 * marked `data-fold-id`), so a folded tab can come back as soon as there's
 * room for it again. Re-measured whenever the row or the items change size.
 */
export function useFold(
  ids: string[],
  keep: ReadonlySet<string>,
  /**
   * Room held back for the "+N more" button, when the measure row has no
   * copy of it (`data-fold-id="more"`) to measure.
   */
  reserve = 120
): {
  containerRef: React.RefObject<HTMLDivElement | null>
  measureRef: React.RefObject<HTMLDivElement | null>
  folded: string[]
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [folded, setFolded] = useState<string[]>([])
  const key = ids.join('|') + '#' + [...keep].join('|')

  useLayoutEffect(() => {
    const container = containerRef.current
    const measure = measureRef.current
    if (!container || !measure) return
    const fit = (): void => {
      const widths = new Map<string, number>()
      for (const el of measure.querySelectorAll<HTMLElement>('[data-fold-id]'))
        widths.set(el.dataset.foldId ?? '', el.getBoundingClientRect().width)
      const gap = parseFloat(getComputedStyle(container).columnGap) || 0
      const width = (id: string): number => (widths.get(id) ?? 0) + gap
      const room = container.clientWidth
      const all = ids.reduce((sum, id) => sum + width(id), 0)
      if (all <= room) {
        setFolded((prev) => (prev.length === 0 ? prev : []))
        return
      }
      const more = widths.has('more') ? width('more') : reserve
      let used = more + ids.filter((id) => keep.has(id)).reduce((s, id) => s + width(id), 0)
      const out: string[] = []
      for (const id of ids) {
        if (keep.has(id)) continue
        if (out.length === 0 && used + width(id) <= room) used += width(id)
        else out.push(id)
      }
      setFolded((prev) => (prev.join('|') === out.join('|') ? prev : out))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    observer.observe(measure)
    return () => observer.disconnect()
    // `key` stands for ids and keep, which are new arrays every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reserve])

  return { containerRef, measureRef, folded }
}
