import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { run } from './run'
import { isWithinRoots } from './files'

export interface RuleInfo {
  scope: 'global' | 'project'
  path: string
  exists: boolean
  // Project-root-relative directory this file governs — Claude Code applies
  // a nested CLAUDE.md only to work under its own directory. '' for the
  // project's root CLAUDE.md (governs the whole project); undefined for
  // 'global', which is a directory concept that doesn't apply to it (it
  // governs everywhere, full stop).
  dir?: string
  // Project-root-relative path — the same shape files:read/files:write and
  // openFileBus already take — for opening this exact file in the Files
  // editor. Undefined for 'global', which sits outside every registered
  // project and has no such path.
  relPath?: string
}

// Directories a nested scan never descends into, named explicitly rather
// than only trusted to .gitignore — a registered project might not ignore
// all four, and this keeps the scan cheap regardless.
const NESTED_SCAN_SKIP_DIRS = new Set(['node_modules', '.venv', 'dbt_packages', 'target'])
// Directory components below the project root, not counting CLAUDE.md
// itself — plenty for any real nesting, and a hard stop on anything
// pathological.
const NESTED_SCAN_MAX_DEPTH = 6

/**
 * Every CLAUDE.md under `repoPath` except the root one (listRules adds that
 * separately and unconditionally, so its "not created" state survives even
 * when nothing nested exists). Uses `git ls-files` the same way
 * files.ts's listFileTree does — tracked, plus untracked-and-not-ignored so
 * a CLAUDE.md the user just created shows up before it's ever staged —
 * rather than a hand-rolled walk that would need to reimplement .gitignore
 * matching itself. Verified against data-analytics-dbt (1120 tracked
 * files, a real nested CLAUDE.md under models/v2/): ~20ms, so this stays
 * well clear of "fast enough to open a tab" even on a large dbt repo.
 * Returns project-root-relative, posix-style paths (git's own format).
 */
async function findNestedClaudeFiles(repoPath: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    run('git', ['-C', repoPath, 'ls-files', '-z', '--', '*CLAUDE.md']),
    run('git', [
      '-C',
      repoPath,
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
      '--',
      '*CLAUDE.md'
    ])
  ])

  const relPaths = new Set<string>()
  for (const res of [tracked, untracked]) {
    if (res.code !== 0) continue // not a git repo, or git isn't on PATH — degrade to "none found"
    for (const p of res.stdout.split('\0')) if (p) relPaths.add(p)
  }

  return [...relPaths]
    .filter((p) => basename(p) === 'CLAUDE.md' && p !== 'CLAUDE.md') // the glob also matches e.g. FOOCLAUDE.md
    .filter((p) => {
      const segments = p.split('/')
      return (
        segments.length - 1 <= NESTED_SCAN_MAX_DEPTH &&
        !segments.some((seg) => NESTED_SCAN_SKIP_DIRS.has(seg))
      )
    })
    .sort()
}

/**
 * Resolves a project-scope candidate the same way files.ts does everywhere
 * else (CLAUDE.md: "files:write resolves the real path and refuses
 * anything outside a registered project" — applied here too, symlinks
 * included) before it's ever shown as existing. A file that exists on disk
 * but resolves outside repoPath (a symlink escaping the project) is
 * reported as not found rather than shown with a path outside the project;
 * one that doesn't exist yet keeps its plain, intended path so the "not
 * created" card still points somewhere sensible.
 */
function resolveProjectRuleEntry(repoPath: string, relPath: string, dir: string): RuleInfo {
  const joined = join(repoPath, relPath)
  const real = existsSync(joined) ? isWithinRoots([repoPath], joined) : null
  return {
    scope: 'project',
    path: real ?? joined,
    exists: real !== null,
    dir,
    relPath
  }
}

// Plan 2.2 Rules tab — "read-only cards for ~/.claude/CLAUDE.md and
// <project>/CLAUDE.md ... a 'not created' state when absent", extended so a
// nested CLAUDE.md (Claude Code applies one only to work under its own
// directory) shows up too, each card labelled with the directory it
// governs. Listing only checks existence; file content is read the same
// way any other file is, through files:read, once the Rules tab opens one
// in the editor.
export async function listRules(repoPath: string | null): Promise<RuleInfo[]> {
  const globalPath = join(homedir(), '.claude', 'CLAUDE.md')
  const rules: RuleInfo[] = [{ scope: 'global', path: globalPath, exists: existsSync(globalPath) }]

  if (repoPath) {
    // Always present, existent or not — preserves the "not created" card
    // for the common case of a project with no CLAUDE.md at all yet.
    rules.push(resolveProjectRuleEntry(repoPath, 'CLAUDE.md', ''))

    const nested = await findNestedClaudeFiles(repoPath).catch(() => [])
    for (const relPath of nested) {
      const entry = resolveProjectRuleEntry(repoPath, relPath, dirname(relPath))
      if (entry.exists) rules.push(entry) // only ever listed because it's really there
    }
  }

  return rules
}

export interface AppendRuleResult {
  ok: boolean
  error?: string
  backupPath?: string
}

// Section 2.7 "Adding a rule in one click" — the only automatic edit CLAUDE.md
// allows to one of these files: append, never rewrite or reorder. Every call
// backs the file up first with a timestamp, per CLAUDE.md's rule for
// ~/.claude/settings.json ("only after a timestamped backup") applied here to
// CLAUDE.md/AGENTS.md rule files. `scope` picks the fixed global/project path
// rather than accepting an arbitrary one from the renderer, closing off path
// traversal the way skills:create's slug sanitization does.
export function appendRule(
  scope: 'global' | 'project',
  repoPath: string | null,
  text: string
): AppendRuleResult {
  const targetPath =
    scope === 'global'
      ? join(homedir(), '.claude', 'CLAUDE.md')
      : repoPath && join(repoPath, 'CLAUDE.md')
  if (!targetPath) return { ok: false, error: 'no project selected for a project-scoped rule' }
  if (!text.trim()) return { ok: false, error: 'rule text is empty' }

  try {
    mkdirSync(dirname(targetPath), { recursive: true })

    let backupPath: string | undefined
    if (existsSync(targetPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = `${targetPath}.${stamp}.bak`
      copyFileSync(targetPath, backupPath)
    }

    const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n')
    const appended = `${existing}${needsLeadingNewline ? '\n' : ''}${existing ? '\n' : ''}${text.trim()}\n`

    writeFileSync(targetPath, appended, 'utf8')
    return { ok: true, backupPath }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export interface RestoreRuleResult {
  ok: boolean
  error?: string
}

// The Undo toast on "Add to rules" (section 2.7). `backupPath` is untrusted
// (round-tripped through the renderer from appendRule's own result), so this
// only ever restores a path that is exactly `${targetPath}.<stamp>.bak` for
// the scope's own fixed target — never an arbitrary path the renderer hands
// back, closing off the same kind of traversal skills:create's slug
// sanitization and appendRule's fixed scope path already guard against.
export function restoreRuleBackup(
  scope: 'global' | 'project',
  repoPath: string | null,
  backupPath: string
): RestoreRuleResult {
  const targetPath =
    scope === 'global'
      ? join(homedir(), '.claude', 'CLAUDE.md')
      : repoPath && join(repoPath, 'CLAUDE.md')
  if (!targetPath) return { ok: false, error: 'no project selected for a project-scoped rule' }

  const backupPattern = new RegExp(
    `^${targetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9TZ-]+\\.bak$`
  )
  if (!backupPattern.test(backupPath))
    return { ok: false, error: 'not a recognized backup for this file' }
  if (!existsSync(backupPath)) return { ok: false, error: 'backup file no longer exists' }

  try {
    copyFileSync(backupPath, targetPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
