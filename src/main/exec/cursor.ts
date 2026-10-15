import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './run'
import { log } from '../log'

export interface OpenInIdeResult {
  ok: boolean
  error?: string
}

let cachedBin: string | null | undefined

/**
 * Cursor's CLI, resolved rather than assumed.
 *
 * This used to hardcode `/usr/local/bin/cursor`. That is where Cursor's own
 * "install shell command" puts it, but it is not the only place — a user who
 * installed it differently has it under ~/.local/bin, and the app's own startup
 * binary check resolves it through PATH precisely because of that.
 */
async function resolveCursorBinary(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin
  for (const candidate of ['/usr/local/bin/cursor', join(homedir(), '.local', 'bin', 'cursor')]) {
    if (existsSync(candidate)) {
      cachedBin = candidate
      return cachedBin
    }
  }
  const which = await run('which', ['cursor'])
  cachedBin = which.code === 0 && which.stdout.trim() ? which.stdout.trim() : null
  return cachedBin
}

/**
 * Open a worktree or workspace file in Cursor.
 *
 * `cursor -n <path>` exits 0 even when the path does not exist, so the old
 * "did it exit cleanly?" check could never fail — "Failed to open in IDE" was
 * unreachable and a no-op looked identical to success. The target is checked
 * first, and Cursor is brought to the front afterwards: it launches behind the
 * window you triggered it from, which is its own way of looking like nothing
 * happened.
 */
export async function openInCursor(target: string): Promise<OpenInIdeResult> {
  if (!existsSync(target)) {
    return { ok: false, error: `nothing to open: ${target} no longer exists` }
  }

  const bin = await resolveCursorBinary()
  if (bin) {
    const direct = await run(bin, ['-n', target])
    if (direct.code === 0) {
      await run('open', ['-a', 'Cursor'])
      return { ok: true }
    }
    log.warn('cursor: CLI failed, falling back to open -a', {
      bin,
      code: direct.code,
      stderr: direct.stderr.trim().slice(0, 200)
    })
  }

  const fallback = await run('open', ['-a', 'Cursor', target])
  if (fallback.code === 0) return { ok: true }
  return {
    ok: false,
    error: fallback.stderr.trim() || 'could not launch Cursor - is it installed?'
  }
}
