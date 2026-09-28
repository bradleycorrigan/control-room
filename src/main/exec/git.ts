import { dirname } from 'node:path'
import { run } from './run'

export async function findMainCheckout(anyPathInRepo: string): Promise<string | null> {
  const res = await run('git', [
    '-C',
    anyPathInRepo,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir'
  ])
  return res.code === 0 ? dirname(res.stdout.trim()) : null
}

export interface GitWorktree {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  locked: boolean
  prunable: boolean
}

export async function listWorktrees(repoPath: string): Promise<GitWorktree[]> {
  const res = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
  if (res.code !== 0) return []

  const worktrees: GitWorktree[] = []
  let current: GitWorktree | null = null

  const push = (): void => {
    if (current) worktrees.push(current)
  }

  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      push()
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        bare: false,
        locked: false,
        prunable: false
      }
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length)
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true
    }
  }
  push()

  return worktrees
}

export async function branchOfWorktree(worktreePath: string): Promise<string | null> {
  const res = await run('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'])
  return res.code === 0 ? res.stdout.trim() : null
}

export interface GitOpResult {
  ok: boolean
  error?: string
}

// `fetchOrigin` and the `addWorktree*` family below each come in two shapes:
// a bare boolean (kept byte-for-byte, still used by `ipc.ts`'s
// `worktrees:create` handler, which only ever checks truthiness — changing
// that contract would silently turn its `if (!ok)` checks into dead code)
// and a `*Result` twin that also carries `res.stderr`. An audit found the
// session-creation path (sessions.ts) discarded that stderr and surfaced
// only a bare "git fetch origin failed" / "git worktree add failed" with no
// auth error, no "already exists", nothing — `createSession` calls the
// `*Result` versions so it can show the real reason.
export async function fetchOriginResult(repoPath: string): Promise<GitOpResult> {
  const res = await run('git', ['-C', repoPath, 'fetch', 'origin'], { timeoutMs: 60_000 })
  if (res.code === 0) return { ok: true }
  return { ok: false, error: res.stderr.trim() || `git fetch origin exited ${res.code}` }
}

export async function fetchOrigin(repoPath: string): Promise<boolean> {
  return (await fetchOriginResult(repoPath)).ok
}

export async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  const res = await run('git', [
    '-C',
    repoPath,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`
  ])
  return res.code === 0
}

export async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
  const res = await run('git', [
    '-C',
    repoPath,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`
  ])
  return res.code === 0
}

/**
 * `git worktree add` refuses to check a branch out a second time — the
 * single most common way that fails is the branch already being checked
 * out in the main checkout itself. Returns the path it's checked out at,
 * or null if it isn't checked out anywhere (a real worktree-add failure).
 */
export async function isBranchCheckedOutElsewhere(
  repoPath: string,
  branch: string
): Promise<string | null> {
  const res = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
  if (res.code !== 0) return null
  let currentPath: string | null = null
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim()
    } else if (line === `branch refs/heads/${branch}` && currentPath) {
      return currentPath
    }
  }
  return null
}

/**
 * The remote's actual default branch (plan 4 §7.2's fallback for
 * `worktreeBaseBranch` when a project doesn't set one) — never a hardcoded
 * "main". Reads `origin/HEAD`; if that symref was never set locally (common
 * on an older clone), asks origin once and sets it so the next call is
 * cheap. Falls back to "main" only if both fail.
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  const read = async (): Promise<string | null> => {
    const res = await run('git', [
      '-C',
      repoPath,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD'
    ])
    if (res.code !== 0) return null
    const ref = res.stdout.trim()
    return ref ? ref.replace(/^origin\//, '') : null
  }

  const existing = await read()
  if (existing) return existing

  const setHead = await run('git', ['-C', repoPath, 'remote', 'set-head', 'origin', '-a'])
  if (setHead.code === 0) {
    const retried = await read()
    if (retried) return retried
  }

  return 'main'
}

/**
 * `--no-track` is mandatory: without it the first `git push` from the new
 * worktree fails with an upstream mismatch. `baseBranch` is what the new
 * branch is cut from — plan 4 §7.2's `worktreeBaseBranch`, or the caller's
 * resolved default-branch fallback.
 */
export async function addWorktreeNewBranchResult(
  repoPath: string,
  dir: string,
  branch: string,
  baseBranch = 'origin/main'
): Promise<GitOpResult> {
  const res = await run(
    'git',
    ['-C', repoPath, 'worktree', 'add', dir, '-b', branch, '--no-track', baseBranch],
    {
      timeoutMs: 30_000
    }
  )
  if (res.code === 0) return { ok: true }
  return { ok: false, error: res.stderr.trim() || `git worktree add exited ${res.code}` }
}

export async function addWorktreeNewBranch(
  repoPath: string,
  dir: string,
  branch: string,
  baseBranch = 'origin/main'
): Promise<boolean> {
  return (await addWorktreeNewBranchResult(repoPath, dir, branch, baseBranch)).ok
}

export async function addWorktreeExistingLocalBranchResult(
  repoPath: string,
  dir: string,
  branch: string
): Promise<GitOpResult> {
  const res = await run('git', ['-C', repoPath, 'worktree', 'add', dir, branch], {
    timeoutMs: 30_000
  })
  if (res.code === 0) return { ok: true }
  return { ok: false, error: res.stderr.trim() || `git worktree add exited ${res.code}` }
}

export async function addWorktreeExistingLocalBranch(
  repoPath: string,
  dir: string,
  branch: string
): Promise<boolean> {
  return (await addWorktreeExistingLocalBranchResult(repoPath, dir, branch)).ok
}

export async function addWorktreeExistingRemoteBranchResult(
  repoPath: string,
  dir: string,
  branch: string
): Promise<GitOpResult> {
  const res = await run(
    'git',
    ['-C', repoPath, 'worktree', 'add', dir, '--track', '-b', branch, `origin/${branch}`],
    { timeoutMs: 30_000 }
  )
  if (res.code === 0) return { ok: true }
  return { ok: false, error: res.stderr.trim() || `git worktree add exited ${res.code}` }
}

export async function addWorktreeExistingRemoteBranch(
  repoPath: string,
  dir: string,
  branch: string
): Promise<boolean> {
  return (await addWorktreeExistingRemoteBranchResult(repoPath, dir, branch)).ok
}

export async function mergeBase(
  worktreePath: string,
  baseRef = 'origin/main'
): Promise<string | null> {
  const res = await run('git', ['-C', worktreePath, 'merge-base', 'HEAD', baseRef])
  return res.code === 0 ? res.stdout.trim() : null
}

export async function diffNumstat(worktreePath: string, base: string): Promise<string> {
  const res = await run('git', ['-C', worktreePath, 'diff', '--numstat', base])
  return res.code === 0 ? res.stdout : ''
}

export async function diffPatch(worktreePath: string, base: string): Promise<string> {
  const res = await run('git', ['-C', worktreePath, 'diff', '--no-color', base], {
    timeoutMs: 30_000
  })
  return res.code === 0 ? res.stdout : ''
}

export async function untrackedFiles(worktreePath: string): Promise<string[]> {
  const res = await run('git', [
    '-C',
    worktreePath,
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z'
  ])
  if (res.code !== 0) return []
  return res.stdout.split('\0').filter(Boolean)
}

/** dbt leaves target/ behind; `git worktree remove` refuses a dirty worktree otherwise. */
export async function cleanWorktree(worktreePath: string): Promise<boolean> {
  const res = await run('git', ['-C', worktreePath, 'clean', '-xdff'])
  return res.code === 0
}

export async function removeWorktree(repoPath: string, dir: string): Promise<boolean> {
  const res = await run('git', ['-C', repoPath, 'worktree', 'remove', '--force', dir])
  return res.code === 0
}

// The "Clean up worktrees" dialog (plan 7 step 2) never forces a removal —
// a dirty or in-use worktree should fail loudly and stay put, not get
// discarded. Unlike `removeWorktree` above (used by the existing single
// "remove this worktree" action, which is a deliberate, already-confirmed
// per-worktree action), this is driven by a bulk selection the user may not
// have looked at as closely.
export async function removeWorktreeClean(repoPath: string, dir: string): Promise<GitOpResult> {
  const res = await run('git', ['-C', repoPath, 'worktree', 'remove', dir])
  if (res.code === 0) return { ok: true }
  return { ok: false, error: res.stderr.trim() || `git worktree remove exited ${res.code}` }
}

/** Branch names (short form) already merged into `defaultBranch`, local heads only. */
export async function mergedBranches(
  repoPath: string,
  defaultBranch: string
): Promise<Set<string>> {
  const res = await run('git', [
    '-C',
    repoPath,
    'branch',
    '--format=%(refname:short)',
    `--merged=${defaultBranch}`
  ])
  if (res.code !== 0) return new Set()
  return new Set(
    res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  )
}

/**
 * `gh pr list --state all` for the branches a worktree cleanup dialog cares
 * about. `gh` may not be installed or authenticated — every caller treats an
 * empty map as "unknown", never as "no PR", which keeps a merged-but-gh-less
 * machine from mislabeling a branch as never opened.
 */
export async function prStatesForBranches(
  repoPath: string
): Promise<Map<string, 'OPEN' | 'MERGED' | 'CLOSED'>> {
  const res = await run(
    'gh',
    ['pr', 'list', '--state', 'all', '--json', 'headRefName,state', '--limit', '500'],
    { cwd: repoPath, timeoutMs: 15_000 }
  )
  if (res.code !== 0) return new Map()
  try {
    const list = JSON.parse(res.stdout) as Array<{ headRefName: string; state: string }>
    const byBranch = new Map<string, 'OPEN' | 'MERGED' | 'CLOSED'>()
    for (const pr of list) {
      if (pr.state === 'OPEN' || pr.state === 'MERGED' || pr.state === 'CLOSED') {
        // A branch can have more than one PR over its life; the most recent
        // (gh lists newest first) wins.
        if (!byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, pr.state)
      }
    }
    return byBranch
  } catch {
    return new Map()
  }
}

/** `git branch -d` — never `-D`. Refuses (exit 1, "not fully merged") rather than losing work. */
export async function deleteLocalBranch(repoPath: string, branch: string): Promise<GitOpResult> {
  const res = await run('git', ['-C', repoPath, 'branch', '-d', branch])
  if (res.code === 0) return { ok: true }
  return { ok: false, error: res.stderr.trim() || `git branch -d exited ${res.code}` }
}

/** Plan 4 §7.2's `worktreeSparseDirectories` — applied right after worktree creation. */
export async function setSparseCheckout(worktreePath: string, dirs: string[]): Promise<boolean> {
  if (dirs.length === 0) return true
  const res = await run('git', ['-C', worktreePath, 'sparse-checkout', 'set', ...dirs], {
    timeoutMs: 30_000
  })
  return res.code === 0
}

export async function pruneWorktrees(repoPath: string): Promise<boolean> {
  const res = await run('git', ['-C', repoPath, 'worktree', 'prune'])
  return res.code === 0
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const res = await run('git', ['-C', worktreePath, 'status', '--porcelain'])
  return res.code === 0 && res.stdout.trim().length > 0
}

// ---------------------------------------------------------------------------
// U7 Git tab (plan 2.2) — status/stage/commit/log added to the existing exec
// module rather than a new file, per CLAUDE.md ("do not restructure
// main/{engine,exec,store}, add to it").

export interface GitStatusFile {
  path: string
  renamedFrom: string | null
  index: string // status code in the index/staging area (' ' when unstaged)
  worktree: string // status code in the worktree (' ' when nothing unstaged)
  staged: boolean
}

export interface GitStatusResult {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitStatusFile[]
}

// `--porcelain=v2 -z -b` is machine-readable and NUL-delimited (branch/file
// names are untrusted — see CLAUDE.md — so no line-based parsing of names).
export async function gitStatus(worktreePath: string): Promise<GitStatusResult> {
  const res = await run('git', ['-C', worktreePath, 'status', '--porcelain=v2', '-z', '-b'])
  const result: GitStatusResult = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  if (res.code !== 0) return result

  const records = res.stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue

    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length)
      result.branch = head === '(detached)' ? null : head
    } else if (record.startsWith('# branch.upstream ')) {
      result.upstream = record.slice('# branch.upstream '.length)
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      if (match) {
        result.ahead = Number(match[1])
        result.behind = Number(match[2])
      }
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      // Ordinary (1, 8 leading fields) or renamed/copied (2, 9 leading
      // fields — the extra one is the rename score) changed entry. Filenames
      // may contain spaces but never NUL, so `-z` is what keeps the path
      // itself intact; splitting the fixed leading fields off by ' ' and
      // rejoining the rest reconstructs a spaced path exactly. Renamed
      // entries carry an extra NUL-separated "origPath" record right after.
      const isRename = record.startsWith('2 ')
      const fields = record.split(' ')
      const xy = fields[1] ?? '..'
      const filePath = fields.slice(isRename ? 9 : 8).join(' ')
      const renamedFrom = isRename ? (records[++i] ?? null) : null
      result.files.push({
        path: filePath,
        renamedFrom,
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
        staged: xy[0] !== '.'
      })
    } else if (record.startsWith('u ')) {
      // Unmerged (conflict) entry: 10 leading fields, then the path.
      const fields = record.split(' ')
      const xy = fields[1] ?? '..'
      const filePath = fields.slice(10).join(' ')
      result.files.push({
        path: filePath,
        renamedFrom: null,
        index: xy[0] ?? 'U',
        worktree: xy[1] ?? 'U',
        staged: false
      })
    } else if (record.startsWith('? ')) {
      result.files.push({
        path: record.slice(2),
        renamedFrom: null,
        index: '?',
        worktree: '?',
        staged: false
      })
    }
  }

  return result
}

/** Stages (`git add`) or unstages (`git reset`) the given paths, argv only. */
export async function gitStage(
  worktreePath: string,
  paths: string[],
  stage: boolean
): Promise<boolean> {
  if (paths.length === 0) return true
  const args = stage ? ['add', '--', ...paths] : ['reset', '--', ...paths]
  const res = await run('git', ['-C', worktreePath, ...args])
  return res.code === 0
}

export interface GitCommitResult {
  ok: boolean
  sha?: string
  error?: string
}

// The message is untrusted user input but is passed as its own argv element
// (`-m`, message) — never interpolated into a shell string.
export async function gitCommit(worktreePath: string, message: string): Promise<GitCommitResult> {
  if (!message.trim()) return { ok: false, error: 'commit message is empty' }
  const res = await run('git', ['-C', worktreePath, 'commit', '-m', message])
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'git commit failed' }
  const sha = await run('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])
  return { ok: true, sha: sha.code === 0 ? sha.stdout.trim() : undefined }
}

export interface GitLogCommit {
  sha: string
  parents: string[]
  subject: string
  authorName: string
  authoredAt: number // ms epoch
}

export interface GitLogResult {
  commits: GitLogCommit[]
  hasMore: boolean
}

// 0x1f (unit separator) as the field delimiter — it practically never
// appears in a commit subject/author, unlike ',' or '|'. Commit subjects and
// author names are untrusted (CLAUDE.md) and rendered as plain data here,
// never interpolated into anything executable.
const GIT_LOG_FORMAT = '%H\x1f%P\x1f%an\x1f%at\x1f%s'

export async function gitLog(
  worktreePath: string,
  opts: { skip?: number; limit?: number } = {}
): Promise<GitLogResult> {
  const limit = opts.limit ?? 100
  const skip = opts.skip ?? 0
  const res = await run('git', [
    '-C',
    worktreePath,
    'log',
    `--format=${GIT_LOG_FORMAT}`,
    `--skip=${skip}`,
    `--max-count=${limit + 1}`
  ])
  if (res.code !== 0) return { commits: [], hasMore: false }

  const lines = res.stdout.split('\n').filter(Boolean)
  const hasMore = lines.length > limit
  const commits: GitLogCommit[] = lines.slice(0, limit).map((line) => {
    const [sha, parents, authorName, ts, subject] = line.split('\x1f')
    return {
      sha: sha ?? '',
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      subject: subject ?? '',
      authorName: authorName ?? '',
      authoredAt: Number(ts) * 1000
    }
  })
  return { commits, hasMore }
}

export interface CheckoutBranch {
  name: string
  /** Where it lives: on origin (GitHub), or only in this clone. */
  where: 'remote' | 'local'
  /** Committer date, ISO. */
  updated: string
  /**
   * default: the repo's main branch. open: has an open pull request.
   * active: unmerged, with commits in the last 30 days. closed: merged, or
   * its pull request was closed or merged. stale: unmerged and quiet for a
   * month. The picker lists the first three; the rest turn up in a search.
   */
  status: 'default' | 'open' | 'active' | 'closed' | 'stale'
  /** The open pull request for this branch, when there is one. */
  pr?: { number: number; title: string; author: string }
}

const ACTIVE_DAYS = 30

/**
 * Branches a new session can start on, each with a status: the default
 * branch, open pull requests (from GitHub's CLI, when it's there), branches
 * still in progress, then merged / closed / stale ones. Fetches origin first,
 * so a branch pushed a minute ago is in the list.
 */
export async function listBranchesForCheckout(repoPath: string): Promise<CheckoutBranch[]> {
  await run('git', ['-C', repoPath, 'fetch', 'origin', '--prune'], { timeoutMs: 30_000 })
  const defaultBranch = await getDefaultBranch(repoPath)
  const refs = await run('git', [
    '-C',
    repoPath,
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%09%(committerdate:iso-strict)',
    'refs/remotes/origin',
    'refs/heads'
  ])
  const merged = new Set(
    (
      await run('git', [
        '-C',
        repoPath,
        'for-each-ref',
        '--format=%(refname)',
        `--merged=refs/remotes/origin/${defaultBranch}`,
        'refs/remotes/origin'
      ])
    ).stdout
      .split('\n')
      .map((r) => r.replace(/^refs\/remotes\/origin\//, ''))
      .filter(Boolean)
  )
  const byName = new Map<string, CheckoutBranch>()
  const cutoff = Date.now() - ACTIVE_DAYS * 86_400_000
  for (const line of refs.stdout.split('\n')) {
    const [ref, updated = ''] = line.split('\t')
    if (!ref) continue
    const remote = ref.startsWith('refs/remotes/origin/')
    const name = ref.replace(/^refs\/remotes\/origin\/|^refs\/heads\//, '')
    if (!name || name === 'HEAD') continue
    const seen = byName.get(name)
    if (seen) {
      if (remote) seen.where = 'remote'
      continue
    }
    const status: CheckoutBranch['status'] =
      name === defaultBranch
        ? 'default'
        : merged.has(name)
          ? 'closed'
          : Date.parse(updated) >= cutoff
            ? 'active'
            : 'stale'
    byName.set(name, { name, where: remote ? 'remote' : 'local', updated, status })
  }

  // Pull requests: an open one marks its branch open; a closed or merged one
  // (squash merges included, which git's --merged can't see) marks it closed.
  const prs = await run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '300',
      '--json',
      'number,title,headRefName,author,isCrossRepository,state'
    ],
    { cwd: repoPath, timeoutMs: 20_000 }
  )
  if (prs.code === 0) {
    try {
      const list = JSON.parse(prs.stdout) as Array<{
        number: number
        title: string
        headRefName: string
        author?: { login?: string }
        isCrossRepository?: boolean
        state?: string
      }>
      for (const pr of list) {
        // A fork's branch isn't on origin, so it can't be checked out here.
        if (pr.isCrossRepository) continue
        const branch = byName.get(pr.headRefName)
        if (!branch || branch.status === 'default') continue
        if (pr.state === 'OPEN') {
          branch.pr = { number: pr.number, title: pr.title, author: pr.author?.login ?? '' }
          branch.status = 'open'
        } else if (!branch.pr) {
          branch.status = 'closed'
        }
      }
    } catch {
      /* no PR details — the branches still list */
    }
  }
  const rank: Record<CheckoutBranch['status'], number> = {
    default: 0,
    open: 1,
    active: 2,
    stale: 3,
    closed: 4
  }
  // for-each-ref already sorted newest first; a stable sort keeps that
  // order within each status.
  return [...byName.values()]
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] || (a.where === b.where ? 0 : a.where === 'remote' ? -1 : 1)
    )
    .slice(0, 500)
}

/**
 * Checks a branch name against origin (GitHub) itself, not the local copy of
 * its refs — so a branch pushed a minute ago is found, and a typo is caught
 * before a session is started on it. Accepts "origin/x" and GitHub tree / PR
 * head URLs, and says which branch it resolved.
 */
export async function resolveRemoteBranch(
  repoPath: string,
  input: string
): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
  let name = input.trim()
  const tree = name.match(/github\.com\/[^/]+\/[^/]+\/tree\/(.+?)\/?$/)
  if (tree) name = decodeURIComponent(tree[1])
  name = name.replace(/^origin\//, '').replace(/^refs\/heads\//, '')
  if (!name) return { ok: false, error: 'enter a branch name' }
  const valid = await run('git', ['check-ref-format', '--branch', name])
  if (valid.code !== 0) return { ok: false, error: `“${name}” isn’t a valid branch name` }
  const res = await run(
    'git',
    ['-C', repoPath, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${name}`],
    { timeoutMs: 15_000 }
  )
  if (res.code === 0) return { ok: true, branch: name }
  if (res.code === 2) return { ok: false, error: `there’s no branch “${name}” on GitHub` }
  return { ok: false, error: `couldn’t reach GitHub to check “${name}”` }
}
