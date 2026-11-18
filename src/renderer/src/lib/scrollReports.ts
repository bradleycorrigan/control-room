/**
 * Scroll reports for how far the wheel moved, at one report per `linesPerReport`
 * lines. `carried` is the movement left over from earlier events, in pixels;
 * it resets when the direction changes. Negative reports are up.
 */
export function scrollReports(
  carried: number,
  deltaPx: number,
  cellPx: number,
  linesPerReport: number
): { reports: number; carried: number } {
  const start = Math.sign(deltaPx) !== Math.sign(carried) ? 0 : carried
  const total = start + deltaPx
  const per = cellPx * linesPerReport
  if (!(per > 0)) return { reports: 0, carried: 0 }
  const reports = Math.trunc(total / per)
  return { reports, carried: total - reports * per }
}

/** A clipboard write (OSC 52's `c;<base64>`) as text; null for a read or anything else. */
export function clipboardWrite(data: string): string | null {
  const semi = data.indexOf(';')
  const b64 = semi === -1 ? '' : data.slice(semi + 1)
  if (!b64 || b64 === '?') return null
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}
