/**
 * Pure helpers for cycle planning: parsing Jira's estimate shorthand into
 * hours, working out a cycle's default capacity from its dates, and the
 * carry-over banner's own "should we show it" rule. Kept dependency-free so
 * they're each unit-testable straight from pagesCheck without a rendered
 * screen.
 */

/** Jira shorthand: 1w = 5d, 1d = 8h. Matches "1d 4h", "30m", "2w", etc. */
export function parseEstimateHours(text: string | null | undefined): number {
  if (!text) return 0
  const scale: Record<string, number> = { w: 40, d: 8, h: 1, m: 1 / 60 }
  let hours = 0
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m)/gi)) {
    hours += Number(m[1]) * scale[m[2].toLowerCase()]
  }
  return hours
}

export function hoursToDays(hours: number): number {
  return hours / 8
}

/** "3.5d" — one decimal, no trailing ".0d". */
export function formatDays(days: number): string {
  const rounded = Math.round(days * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}d`
}

/** Weekdays between two dates, inclusive of both ends. No dates: 10 (two weeks). */
export function workingDays(startDate?: string | null, endDate?: string | null): number {
  if (!startDate || !endDate) return 10
  const start = new Date(startDate)
  const end = new Date(endDate)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 10
  let days = 0
  const cursor = new Date(start)
  cursor.setHours(0, 0, 0, 0)
  const last = new Date(end)
  last.setHours(0, 0, 0, 0)
  while (cursor <= last) {
    const day = cursor.getDay()
    if (day !== 0 && day !== 6) days++
    cursor.setDate(cursor.getDate() + 1)
  }
  return days || 10
}
