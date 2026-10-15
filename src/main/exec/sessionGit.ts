import { run } from './run'
import { mergeBase, diffNumstat } from './git'

/**
 * The git side of a hand-off note: what landed on this branch since it left
 * the base branch, and how big the diff is. No LLM call — this is exactly
 * what `git log`/`git diff --numstat` say, read through `run()` like every
 * other git call in the app (CLAUDE.md: run.ts is the only spawn path).
 */

const COMMIT_CAP = 15
// Unit separator — practically never appears in a commit subject, unlike
// ',' or '|'. Subjects are untrusted (CLAUDE.md) and only ever rendered as
// plain text, never interpolated into anything executable.
const SEP = '\x1f'

export interface HandoffCommit {
  sha: string
  subject: string
}

export interface HandoffGitSummary {
  commits: HandoffCommit[]
  /** True when there were more than COMMIT_CAP commits and the list was cut. */
  commitsCapped: boolean
  filesChanged: number
  added: number
  removed: number
}

/**
 * `git log base..HEAD` (capped) plus a diffstat summary, where `base` is the
 * merge-base with `baseRef` — the same base the Diff tab itself uses
 * (see ipc.ts's `session:diff`). Null when the worktree has no merge-base
 * with `baseRef` at all (e.g. an investigate-mode session with no worktree).
 */
export async function handoffGitSummary(
  worktreePath: string,
  baseRef: string
): Promise<HandoffGitSummary | null> {
  const base = await mergeBase(worktreePath, baseRef)
  if (!base) return null

  const logRes = await run('git', [
    '-C',
    worktreePath,
    'log',
    `--format=%h${SEP}%s`,
    `${base}..HEAD`,
    `--max-count=${COMMIT_CAP + 1}`
  ])
  const lines = logRes.code === 0 ? logRes.stdout.split('\n').filter(Boolean) : []
  const commitsCapped = lines.length > COMMIT_CAP
  const commits = lines.slice(0, COMMIT_CAP).map((line) => {
    const [sha, subject] = line.split(SEP)
    return { sha: sha ?? '', subject: subject ?? '' }
  })

  const numstat = await diffNumstat(worktreePath, base)
  let filesChanged = 0
  let added = 0
  let removed = 0
  for (const rawLine of numstat.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const [a, r] = line.split('\t')
    filesChanged++
    if (a !== '-') added += Number(a) || 0
    if (r !== '-') removed += Number(r) || 0
  }

  return { commits, commitsCapped, filesChanged, added, removed }
}
