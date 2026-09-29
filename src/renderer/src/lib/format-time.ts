/** "just now", "42s ago", "5m ago", "3h ago", "12d ago"; "never" for no time at all. */
export function relativeTime(ts: number | null): string {
  if (ts === null) return 'never'
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}
