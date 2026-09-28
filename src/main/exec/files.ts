import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { run } from './run'

const MAX_READ_BYTES = 5 * 1024 * 1024

export interface FileTreeEntry {
  path: string // relative, posix-style (as git prints it)
  type: 'file'
}

/**
 * Walks up from `p` until it finds a component that already exists on disk,
 * resolves symlinks on that existing part, and re-joins whatever doesn't
 * exist yet (e.g. a brand-new file's own basename) onto the result. Plain
 * `fs.realpathSync` throws on a path whose leaf doesn't exist yet, which
 * would make every new-file write fail closed for the wrong reason; this
 * still catches a symlink *inside* an allowed root that points outside it,
 * which is the actual attack this guards against.
 */
function resolveRealDestination(candidate: string): string {
  const notYetExisting: string[] = []
  let current = candidate
  for (;;) {
    try {
      const real = fsSync.realpathSync(current)
      return notYetExisting.length ? path.join(real, ...notYetExisting.reverse()) : real
    } catch {
      notYetExisting.push(path.basename(current))
      const parent = path.dirname(current)
      if (parent === current) return candidate // hit the filesystem root; give up cleanly
      current = parent
    }
  }
}

/**
 * The one path-safety choke point behind files:read/files:write/files:tree/
 * files:search (CLAUDE.md non-negotiable: "files:write resolves the real
 * path and refuses anything outside a registered project"). Refuses an
 * absolute `relPath` outright — the renderer only ever sends relative paths
 * it read back from files:tree, never one it constructed itself — then
 * refuses anything that resolves (after symlinks) outside every root in
 * `roots`. Returns the resolved, real absolute path, or null.
 */
export function resolveProjectPath(roots: string[], relPath: string): string | null {
  if (!relPath || path.isAbsolute(relPath)) return null

  for (const root of roots) {
    let rootReal: string
    try {
      rootReal = fsSync.realpathSync(root)
    } catch {
      continue // this root doesn't exist on disk
    }

    const candidate = path.resolve(rootReal, relPath)
    if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) continue

    const real = resolveRealDestination(candidate)
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue

    return real
  }
  return null
}

/**
 * Validates that an absolute path some earlier IPC call already handed the
 * renderer (a worktree path from projects:worktrees, sessions:list, etc.) is
 * still one of `roots` or inside one of them, resolving symlinks the same
 * way resolveProjectPath does. Used to turn a session's worktreePath into a
 * files/git root before any relPath is resolved against it — the renderer
 * never constructs this path itself, only echoes one main already gave it.
 */
export function isWithinRoots(roots: string[], absolutePath: string): string | null {
  if (!absolutePath || !path.isAbsolute(absolutePath)) return null
  for (const root of roots) {
    let rootReal: string
    let real: string
    try {
      rootReal = fsSync.realpathSync(root)
      real = fsSync.realpathSync(absolutePath)
    } catch {
      continue
    }
    if (real === rootReal || real.startsWith(rootReal + path.sep)) return real
  }
  return null
}

/** Tracked files plus untracked-and-not-.gitignore'd ones (plan 2.2, Files tab). */
export async function listFileTree(repoPath: string): Promise<FileTreeEntry[]> {
  const [tracked, untracked] = await Promise.all([
    run('git', ['-C', repoPath, 'ls-files', '-z']),
    run('git', ['-C', repoPath, 'ls-files', '--others', '--exclude-standard', '-z'])
  ])

  const paths = new Set<string>()
  for (const res of [tracked, untracked]) {
    if (res.code !== 0) continue
    for (const p of res.stdout.split('\0')) if (p) paths.add(p)
  }
  return [...paths].sort().map((p) => ({ path: p, type: 'file' as const }))
}

export type ReadFileResult = { ok: true; content: string } | { ok: false; error: string }

// File contents are untrusted data (CLAUDE.md) — this returns raw text; it
// is the renderer's job to escape it on render, same as pane output.
export async function readProjectFile(roots: string[], relPath: string): Promise<ReadFileResult> {
  const real = resolveProjectPath(roots, relPath)
  if (!real) return { ok: false, error: 'path is outside every registered project' }
  try {
    const stat = await fs.stat(real)
    if (!stat.isFile()) return { ok: false, error: 'not a file' }
    if (stat.size > MAX_READ_BYTES) return { ok: false, error: 'file is too large to open' }
    const content = await fs.readFile(real, 'utf8')
    return { ok: true, content }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export interface WriteFileResult {
  ok: boolean
  error?: string
}

export async function writeProjectFile(
  roots: string[],
  relPath: string,
  content: string
): Promise<WriteFileResult> {
  const real = resolveProjectPath(roots, relPath)
  if (!real) return { ok: false, error: 'path is outside every registered project' }
  try {
    await fs.mkdir(path.dirname(real), { recursive: true })
    await fs.writeFile(real, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export interface FileSearchMatch {
  path: string
  line: number
  text: string
}

// `⌘⇧F` search-across-repo (plan 2.2) — `git grep` via argv (never a shell
// string), `-I` skips binary files. Untracked-and-ignored files (build
// output, etc.) are correctly excluded, same as the tree.
export async function searchProjectFiles(
  repoPath: string,
  query: string
): Promise<FileSearchMatch[]> {
  if (!query.trim()) return []
  const res = await run('git', ['-C', repoPath, 'grep', '-n', '-I', '--no-color', '-e', query])
  if (res.code !== 0) return [] // no matches, or not inside a git repo

  const matches: FileSearchMatch[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line) continue
    const match = /^(.*?):(\d+):(.*)$/.exec(line)
    if (!match) continue
    matches.push({ path: match[1], line: Number(match[2]), text: match[3] })
  }
  return matches
}
