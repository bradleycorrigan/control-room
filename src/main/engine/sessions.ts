import {
  existsSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  cpSync,
  type Dirent
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, randomInt, randomBytes } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { run } from '../exec/run'
import {
  fetchOriginResult,
  localBranchExists,
  remoteBranchExists,
  addWorktreeNewBranchResult,
  addWorktreeExistingLocalBranchResult,
  addWorktreeExistingRemoteBranchResult,
  addWorktreeDetachedResult,
  getDefaultBranch,
  setSparseCheckout,
  hasUncommittedChanges,
  cleanWorktree,
  removeWorktree as gitRemoveWorktree,
  pruneWorktrees,
  isBranchCheckedOutElsewhere,
  branchOfWorktree,
  type GitOpResult
} from '../exec/git'
import {
  newSession,
  newWindow,
  hasSession,
  sendKeysResult,
  killWindow,
  capturePane,
  deliverPrompt as pastePrompt
} from '../exec/tmux'
import { markSessionTransition, resolveClaudeBinary } from '../exec/claude'
import { getState, mutate } from '../store/store'
import { log } from '../log'
import type { Project, SessionRecord } from '../store/types'

// Our own word lists, in the shape Xirp uses for its auto-named sessions
// (adjective-noun-suffix). 40 x 40 x 36^4 is ~2.7 billion names, and a branch
// called "session/restless-kestrel-4f2a" reads far better than "feature-3" in
// `tmux list-windows` or `git worktree list`.
const BRANCH_ADJECTIVES = [
  'amber',
  'brisk',
  'candid',
  'dappled',
  'eager',
  'fabled',
  'gilded',
  'hushed',
  'idle',
  'jaunty',
  'keen',
  'lucid',
  'mellow',
  'nimble',
  'opal',
  'placid',
  'quiet',
  'restless',
  'silver',
  'tidal',
  'umber',
  'vivid',
  'wily',
  'zesty',
  'ancient',
  'bold',
  'crisp',
  'drifting',
  'ember',
  'fleet',
  'glassy',
  'hollow',
  'inked',
  'jagged',
  'lofty',
  'muted',
  'northern',
  'patient',
  'rustic',
  'sombre'
]

const BRANCH_NOUNS = [
  'alder',
  'basin',
  'cedar',
  'delta',
  'estuary',
  'fjord',
  'grove',
  'harbour',
  'inlet',
  'juniper',
  'kestrel',
  'lantern',
  'meadow',
  'narrows',
  'orchard',
  'prairie',
  'quarry',
  'ridge',
  'summit',
  'thicket',
  'vale',
  'willow',
  'yarrow',
  'anchor',
  'beacon',
  'cove',
  'dune',
  'ferry',
  'gully',
  'heath',
  'isle',
  'lagoon',
  'marsh',
  'nettle',
  'pier',
  'reef',
  'shoal',
  'tarn',
  'wharf',
  'yonder'
]

/** A readable, collision-resistant branch name for a session nobody named. */
export function generateBranchName(): string {
  const pick = <T>(xs: T[]): T => xs[randomInt(xs.length)]
  const suffix = randomBytes(3).toString('hex').slice(0, 4)
  return `session/${pick(BRANCH_ADJECTIVES)}-${pick(BRANCH_NOUNS)}-${suffix}`
}

const PROMPT_WAIT_TIMEOUT_MS = 20_000
// 150ms, not 500ms. This poll is what decides how long after the agent is
// actually ready we notice — at 500ms a session that booted in 2.1s was still
// being waited on at 2.5s, for nothing.
const PROMPT_WAIT_POLL_MS = 150

/** When origin was last fetched per repo, so back-to-back sessions do not each pay for it. */
const lastFetchedAt = new Map<string, number>()
const FETCH_CACHE_MS = 60_000

// Wall-clock per step, so "starting a session is slow" is a measurement
// rather than a feeling. Keyed by creationId because two creations can be in
// flight at once.
const creationStartedAt = new Map<string, number>()
const lastStepAt = new Map<string, number>()

function emitProgress(creationId: string, step: string, ok: boolean, message?: string): void {
  const now = Date.now()
  if (!creationStartedAt.has(creationId)) {
    creationStartedAt.set(creationId, now)
    lastStepAt.set(creationId, now)
  }
  const sinceStart = now - (creationStartedAt.get(creationId) ?? now)
  const sinceLast = now - (lastStepAt.get(creationId) ?? now)
  lastStepAt.set(creationId, now)
  log.info('session-create step', { step, ok, ms: sinceLast, totalMs: sinceStart, message })
  if (step === 'done') {
    creationStartedAt.delete(creationId)
    lastStepAt.delete(creationId)
  }

  const event = { creationId, step, ok, message: message ?? null, at: now, sinceStart }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('session:event', event)
  }
}

export interface CreateSessionInput {
  creationId: string
  projectId: string
  /** A name to start with — e.g. "DSD-581 Clarify…" from a Jira issue. Kept
   * as a custom name, so the transcript's own title doesn't replace it. */
  title?: string
  // Required unless investigate is true — a session with no code changes
  // expected runs straight in the project's own checkout, no branch or
  // worktree involved.
  branch?: string
  /** 'auto': check the branch out if it exists (here or on origin), else make it. */
  basedOn?: 'new' | 'existing' | 'auto'
  prompt?: string
  investigate?: boolean
  // Home screen composer's model picker (plan 7, B1) — passed straight
  // through as `claude`'s own `--model` flag on the launch line typed into
  // the pane. Omitted keeps today's behaviour (whatever `claude` defaults
  // to / the project's own agentCommand).
  model?: 'opus' | 'sonnet' | 'haiku'
  // Home screen composer's plan mode toggle — adds --permission-mode plan
  // to the claude command line when true.
  planMode?: boolean
  // Home screen composer's thinking-level picker — passed straight through
  // as claude's own --effort flag. Verified against v2.1.274 in a throwaway
  // tmux pane (`claude --effort high` reports "high" in its status bar).
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  // Home screen composer's attachments (paperclip / paste / drag-drop) —
  // absolute paths only, already validated by exec/attachments.ts before
  // the renderer ever held them. The agent is a CLI reading a tmux pane,
  // not an API that can receive a file, so these never travel any way
  // other than folded into the prompt text itself — see withAttachments.
  attachmentPaths?: string[]
}

export interface CreateSessionResult {
  ok: boolean
  error?: string
  record?: SessionRecord
}

interface WriteWorkspaceFileResult {
  file: string | null
  error?: string
}

function writeWorkspaceFile(
  target: string,
  workspacesDir: string,
  dirName: string
): WriteWorkspaceFileResult {
  try {
    if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true })
    const workspaceFile = join(workspacesDir, `${dirName}.code-workspace`)

    const workspace: Record<string, unknown> = { folders: [{ path: target }] }

    const venvPython = join(target, '.venv', 'bin', 'python')
    if (existsSync(venvPython)) {
      workspace.settings = { 'python.defaultInterpreterPath': venvPython }
    }

    // Only add the folderOpen task if the machine actually has wt-setup.sh —
    // don't replicate the rest of `_wt_themes`, just this one hook.
    const wtSetup = join(homedir(), '.zsh', 'wt-setup.sh')
    if (existsSync(wtSetup)) {
      workspace.tasks = {
        version: '2.0.0',
        tasks: [
          {
            label: 'wt-setup',
            type: 'shell',
            command: wtSetup,
            runOptions: { runOn: 'folderOpen' }
          }
        ]
      }
    }

    writeFileSync(workspaceFile, JSON.stringify(workspace, null, 2))
    return { file: workspaceFile }
  } catch (err) {
    const error = String(err)
    log.warn('sessions:create — failed to write .code-workspace', { error })
    return { file: null, error }
  }
}

// The dbt-style per-worktree setup (mise trust, direnv allow, dbt deps, dbt
// parse) runs as a `folderOpen` task inside a Cursor window in Brad's
// terminal workflow — but a session-creation flow that opens an editor for
// every session is unusable. Run the same script headless, in the tmux pane,
// chained ahead of the agent with `&&` so a non-zero exit stops the agent
// from starting in a half-set-up worktree instead of silently swallowing it.
/**
 * Per-project setup to run before the agent. **Empty by default, deliberately.**
 *
 * This used to default to `~/.zsh/wt-setup.sh`, which is the user's Cursor
 * workflow: `dbt deps` plus `dbt parse`, one to three minutes of work that makes
 * an editor useful the moment it opens. Chaining it as `<setup> && <agent>` made
 * every session creation take that long before the agent even started, and any
 * failure in it meant no agent at all.
 *
 * An agent does not need that. It can run `dbt deps` itself, when and if it
 * needs to, and it can say so while it does. So creation starts the agent
 * immediately and a project only runs setup when it explicitly asks for one via
 * `Project.setupCommand`.
 */
function resolveSetupCommand(project: Project): string {
  return project.setupCommand ?? ''
}

export interface CarryIgnoredFilesResult {
  ok: boolean
  message?: string
}

/**
 * Plan 4 §7.1 — carries top-level gitignored entries (e.g. `.venv`, `.env`)
 * from `repo` into a freshly created `worktree`, replacing the old hardcoded
 * `.venv`/`.env` special case. `git check-ignore` alone decides what
 * counts, so there is no list to maintain and any repo works unconfigured.
 * `mode: 'none'` carries nothing. Top-level only, by design (plan): fast,
 * predictable, and covers every case seen so far.
 */
/**
 * Git-ignored entries we must never carry into a worktree.
 *
 * `carryIgnoredFiles` symlinks every ignored entry in the repo root, which
 * swept up build output as well as credentials. That breaks the tools that own
 * those directories: `dbt deps` starts by removing `dbt_packages`, hits a
 * symlink, and dies with "Cannot call rmtree on a symbolic link". Because
 * per-worktree setup runs as `<setupCommand> && <agentCommand>`, a non-zero
 * setup meant the agent never started at all — every step ticked green and the
 * session arrived stopped with no pane.
 *
 * The things worth carrying are credentials, environments and caches a new
 * worktree cannot regenerate for itself (.env, .venv, .envrc). Anything a build
 * tool generates, it should generate here too.
 */
const NEVER_CARRY = new Set([
  'dbt_packages',
  'target',
  'logs',
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  '.next'
])

export async function carryIgnoredFiles(
  repo: string,
  worktree: string,
  mode: 'symlink' | 'copy' | 'none'
): Promise<CarryIgnoredFilesResult> {
  if (mode === 'none') return { ok: true, message: 'skipped (ignoredFilesMode: none)' }

  let entries: Dirent[]
  try {
    entries = readdirSync(repo, { withFileTypes: true })
  } catch (err) {
    const message = `couldn't read ${repo}: ${String(err)}`
    log.warn('sessions:carryIgnoredFiles — failed to read repo dir', { repo, error: String(err) })
    return { ok: false, message }
  }

  const failed: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue
    if (NEVER_CARRY.has(entry.name)) continue

    const ignored = await run('git', ['check-ignore', '-q', entry.name], { cwd: repo })
    if (ignored.code !== 0) continue // not ignored -> not ours to carry

    const src = join(repo, entry.name)
    const dest = join(worktree, entry.name)
    if (existsSync(dest)) continue

    try {
      if (mode === 'symlink') {
        symlinkSync(src, dest)
      } else {
        cpSync(src, dest, { recursive: entry.isDirectory() })
      }
    } catch (err) {
      log.warn('sessions:carryIgnoredFiles — failed to carry entry', {
        name: entry.name,
        mode,
        error: String(err)
      })
      failed.push(entry.name)
    }
  }

  if (failed.length > 0) {
    return { ok: false, message: `couldn't carry: ${failed.join(', ')}` }
  }
  return { ok: true }
}

/**
 * Copies the main checkout's `.claude/settings.local.json` into a new
 * worktree. That file is where Claude Code saves "don't ask again"
 * approvals, and it saves them per folder, so without this every new
 * session starts with none and asks for everything again.
 *
 * A copy, not a symlink: Claude Code refuses to write settings through a
 * symlink, so a linked file would break the next approval made in the
 * worktree. Best-effort: a missing source or a failed copy only logs.
 */
export function carryClaudeLocalSettings(repo: string, worktree: string): void {
  const src = join(repo, '.claude', 'settings.local.json')
  const dest = join(worktree, '.claude', 'settings.local.json')
  if (!existsSync(src) || existsSync(dest)) return
  try {
    mkdirSync(join(worktree, '.claude'), { recursive: true })
    cpSync(src, dest)
  } catch (err) {
    log.warn('sessions:carryClaudeLocalSettings — copy failed', { worktree, error: String(err) })
  }
}

/** Plan 4 §7.6 — the running `claude --version`, captured at session creation. */
async function captureHarnessVersion(): Promise<string | undefined> {
  const bin = await resolveClaudeBinary()
  if (!bin) return undefined
  const res = await run(bin, ['--version'])
  if (res.code !== 0) return undefined
  const version = res.stdout.trim()
  return version || undefined
}

/**
 * Folds attachment paths into the literal prompt text `deliverPrompt` types
 * into the pane. `deliverPrompt` (exec/tmux.ts) pastes it, then presses Enter —
 * argv element followed by a separate Enter — reliable for an ordinary
 * prompt, but with two known rough edges: a very long literal can be typed
 * unreliably, and a string that ends in `;` can confuse it. Attachments make
 * both more likely, since each one adds a full absolute path — so this stays
 * short and one line per file (the composer also caps how many files can be
 * attached at once, keeping the total bounded), and always ends in a plain
 * sentence, never a bare path, so a trailing `;` in this block never happens
 * regardless of what an individual filename ends with.
 */
function withAttachments(
  prompt: string | undefined,
  attachmentPaths: string[] | undefined
): string {
  const text = prompt ?? ''
  if (!attachmentPaths || attachmentPaths.length === 0) return text
  const list = attachmentPaths.map((p) => `- ${p}`).join('\n')
  const block = `Attached files - read these from disk before you start:\n${list}\n\nLook at each one above before continuing.`
  return text ? `${text}\n\n${block}` : block
}

/**
 * Does the git/tmux work itself in Node rather than shelling out to
 * `zsh -ic wta` — `-i` sources the whole interactive rc (mise, direnv, fzf,
 * prompt) and inherits the GUI app's broken PATH, with unreliable exit codes.
 */
export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const { creationId, projectId, basedOn, model, planMode, effort, attachmentPaths } = input
  let investigate = input.investigate
  const prompt = withAttachments(input.prompt, attachmentPaths)
  let branch = input.branch
  const project = getState().projects.find((p) => p.id === projectId)
  if (!project) {
    emitProgress(creationId, 'validate', false, 'project not found')
    return { ok: false, error: 'project not found' }
  }

  let target: string
  let dirName: string
  let winName: string
  let recordBranch: string
  // On no branch, at an existing branch's commit (see below).
  let detached = false

  // "On a branch": the branch the project's own checkout already has runs
  // right there — git can't check it out a second time, and there's no
  // need to. Any other branch gets a worktree of its own below.
  if (!investigate && basedOn === 'existing' && branch && project.id !== 'general') {
    if ((await branchOfWorktree(project.repoPath)) === branch) investigate = true
  }

  if (investigate) {
    // No code changes expected — run straight in the project's own
    // checkout rather than fail (or silently share a branch with) whatever
    // is already checked out there. No isolation: concurrent sessions here
    // share one working tree. deleteSession refuses to ever remove this
    // path (worktreePath === project.repoPath is checked there), so this
    // can never be cleaned up as if it were a disposable worktree.
    target = project.repoPath
    // Distinct per session, not a hardcoded 'investigate' — every
    // Investigate/Home session in a project shares `target`, and a hardcoded
    // name meant they all wrote (and clobbered) the same `.code-workspace`
    // file, so they all shared one `cursorTheme` too.
    dirName = `investigate-${randomUUID().slice(0, 8)}`
    winName = `investigate-${Date.now().toString(36)}`
    recordBranch = (await branchOfWorktree(project.repoPath)) ?? '(unknown)'
    emitProgress(creationId, 'validate', true, 'investigate mode: no worktree')
    emitProgress(creationId, 'fetch', true, 'skipped (investigate mode)')
    emitProgress(creationId, 'worktree', true, 'skipped (investigate mode)')
  } else {
    // No branch given (the Home composer never sends one) — name it ourselves
    // rather than refusing. A worktree session always needs a branch; which
    // branch is only the user's problem when they care.
    // A name we just invented cannot already exist, so it is always a new
    // branch — whatever the caller did or did not say about basedOn. Without
    // this, a caller that left basedOn out fell through to the existing-branch
    // path and failed with "branch 'session/…' not found locally or on origin",
    // naming a branch it had itself made up a line earlier.
    let branchIsNew = basedOn === 'new'
    let autoNamed = false
    if (!branch) {
      branch = generateBranchName()
      branchIsNew = true
      autoNamed = true
      emitProgress(creationId, 'validate', true, `named the branch ${branch}`)
    }
    dirName = branch.replaceAll('/', '-')
    winName = dirName.replace(/[:.]/g, '-')
    target = `${project.worktreeRoot}/${dirName}`
    recordBranch = branch

    // An existing branch whose worktree is already there gets a detached
    // worktree of its own below, rather than this error.
    const mayBeExisting = !branchIsNew && !autoNamed
    if (existsSync(target) && !mayBeExisting) {
      // Named in the user's own terms. This used to report the bare worktree
      // path — a filesystem location they never typed, with no hint that the
      // branch name was the thing to change, and no way to tell it apart from
      // a disk error.
      const error = `A worktree for '${branch}' already exists. Pick a different branch name, or resume that session from History.`
      emitProgress(creationId, 'validate', false, error)
      return { ok: false, error }
    }
    emitProgress(creationId, 'validate', true)

    // Plan 4 §7.2 worktreeFetchBeforeCreate — default true, today's behaviour.
    if (project.worktreeFetchBeforeCreate !== false) {
      const fetchedAt = lastFetchedAt.get(project.repoPath) ?? 0
      const age = Date.now() - fetchedAt
      if (age < FETCH_CACHE_MS) {
        // Measured at ~1.3s on a real repo, and it is the single largest
        // fixed cost of starting a session. Starting two sessions a minute
        // apart does not need origin fetched twice; the second one would be
        // paying over a second for a base ref that cannot have moved much.
        emitProgress(creationId, 'fetch', true, `skipped: fetched ${Math.round(age / 1000)}s ago`)
      } else {
        const fetchResult = await fetchOriginResult(project.repoPath)
        if (!fetchResult.ok) {
          const error = `git fetch origin failed: ${fetchResult.error}`
          emitProgress(creationId, 'fetch', false, error)
          return { ok: false, error }
        }
        lastFetchedAt.set(project.repoPath, Date.now())
        emitProgress(creationId, 'fetch', true)
      }
    } else {
      emitProgress(creationId, 'fetch', true, 'skipped (worktreeFetchBeforeCreate disabled)')
    }

    // A name typed or picked in the composer: an existing branch (here or,
    // after the fetch above, on origin) is checked out; anything else is new.
    if (basedOn === 'auto' && !autoNamed) {
      branchIsNew = !(
        (await localBranchExists(project.repoPath, branch)) ||
        (await remoteBranchExists(project.repoPath, branch))
      )
      log.info(branchIsNew ? `new branch ${branch}` : `checking out existing ${branch}`)
    }

    if (branchIsNew && existsSync(target)) {
      const error = `A worktree for '${branch}' already exists. Pick a different branch name, or resume that session from History.`
      emitProgress(creationId, 'worktree', false, error)
      return { ok: false, error }
    }

    // A branch already checked out elsewhere (main, in another session's
    // worktree, is the usual one): git won't check it out twice, so this
    // session gets its own worktree at that branch's commit, on no branch.
    // Any number of sessions can start from main this way without sharing
    // files. The agent makes a branch when it has something to commit.
    if (!branchIsNew) {
      const busyAt = existsSync(target)
        ? target
        : await isBranchCheckedOutElsewhere(project.repoPath, branch)
      if (busyAt) {
        detached = true
        dirName = `${dirName}-${randomUUID().slice(0, 6)}`
        winName = dirName.replace(/[:.]/g, '-')
        target = `${project.worktreeRoot}/${dirName}`
        log.info(`${branch} is checked out at ${busyAt}: starting a detached worktree`)
      }
    }

    let worktreeResult: GitOpResult = { ok: false }
    if (detached) {
      const ref = (await localBranchExists(project.repoPath, branch)) ? branch : `origin/${branch}`
      worktreeResult = await addWorktreeDetachedResult(project.repoPath, target, ref)
    } else if (branchIsNew) {
      // Plan 4 §7.2 worktreeBaseBranch — falls back to the remote's actual
      // default branch, never a hardcoded "main".
      const baseBranch =
        project.worktreeBaseBranch ?? `origin/${await getDefaultBranch(project.repoPath)}`
      worktreeResult = await addWorktreeNewBranchResult(
        project.repoPath,
        target,
        branch,
        baseBranch
      )
    } else if (await localBranchExists(project.repoPath, branch)) {
      worktreeResult = await addWorktreeExistingLocalBranchResult(project.repoPath, target, branch)
    } else if (await remoteBranchExists(project.repoPath, branch)) {
      worktreeResult = await addWorktreeExistingRemoteBranchResult(project.repoPath, target, branch)
    } else {
      const error = `branch '${branch}' not found locally or on origin`
      emitProgress(creationId, 'worktree', false, error)
      return { ok: false, error }
    }
    if (!worktreeResult.ok) {
      // The single most common cause: the branch is already checked out
      // somewhere else (often the main checkout itself) — git refuses to
      // check the same branch out twice. Name that explicitly instead of
      // a bare "git worktree add failed", since the fix is different
      // (pick a different branch, or use investigate mode instead of a
      // worktree at all) from a generic failure.
      const checkedOutElsewhere = await isBranchCheckedOutElsewhere(project.repoPath, branch)
      const error = checkedOutElsewhere
        ? `'${branch}' is already checked out at ${checkedOutElsewhere} - git can't check the same branch out twice. Use "Investigate" mode instead if you don't need an isolated worktree, or pick a different branch.`
        : `git worktree add failed: ${worktreeResult.error}`
      emitProgress(creationId, 'worktree', false, error)
      return { ok: false, error }
    }
    emitProgress(creationId, 'worktree', true)

    if (project.worktreeSparseDirectories && project.worktreeSparseDirectories.length > 0) {
      const sparseOk = await setSparseCheckout(target, project.worktreeSparseDirectories)
      if (sparseOk) {
        log.info(`Configured sparse checkout for: ${project.worktreeSparseDirectories.join(', ')}`)
      }
      emitProgress(
        creationId,
        'sparse',
        sparseOk,
        sparseOk ? undefined : 'git sparse-checkout set failed'
      )
    }

    const carried = await carryIgnoredFiles(
      project.repoPath,
      target,
      project.ignoredFilesMode ?? 'symlink'
    )
    emitProgress(creationId, 'symlinks', carried.ok, carried.message)
    carryClaudeLocalSettings(project.repoPath, target)

    // Best-effort, non-fatal — harmless if either tool isn't installed (a
    // missing binary or a real config problem both just show up as a
    // non-zero exit here, since `run()` never throws). Report exactly what
    // happened rather than a blanket tick; never fail the whole creation
    // over either of these.
    const miseTrust = await run('mise', ['trust', join(target, 'mise.toml')])
    const direnvAllow = await run('direnv', ['allow', target])
    const describeTrustFailure = (
      label: string,
      res: { code: number; stderr: string }
    ): string | null => {
      if (res.code === 0) return null
      const detail = res.stderr.trim()
      return detail ? `${label}: ${detail}` : `${label} exited ${res.code}`
    }
    const trustIssues = [
      describeTrustFailure('mise trust', miseTrust),
      describeTrustFailure('direnv allow', direnvAllow)
    ].filter((issue): issue is string => issue !== null)
    emitProgress(
      creationId,
      'trust',
      trustIssues.length === 0,
      trustIssues.length === 0
        ? undefined
        : `best-effort, session continues: ${trustIssues.join('; ')}`
    )
  }

  const { file: workspaceFile, error: workspaceError } = writeWorkspaceFile(
    target,
    project.workspacesDir,
    dirName
  )
  emitProgress(
    creationId,
    'workspace',
    workspaceFile !== null,
    workspaceFile !== null ? undefined : (workspaceError ?? 'failed to write .code-workspace file')
  )

  const sessionStatus = await hasSession(project.tmuxSession)
  const created = sessionStatus.exists
    ? await newWindow(project.tmuxSession, winName, target)
    : await newSession(project.tmuxSession, winName, target)

  if (!created) {
    const error = 'failed to create tmux session/window'
    emitProgress(creationId, 'tmux', false, error)
    return { ok: false, error }
  }
  emitProgress(creationId, 'tmux', true)

  // Investigate mode skips setupCommand too — it's meant for preparing a
  // fresh worktree (installing deps, etc.), and this session isn't one.
  const setupCommand = investigate ? null : resolveSetupCommand(project)
  let agentCommand = project.agentCommand
  if (model) agentCommand += ` --model ${model}`
  if (planMode) agentCommand += ` --permission-mode plan`
  if (effort) agentCommand += ` --effort ${effort}`
  const launchCommand = setupCommand ? `${setupCommand} && ${agentCommand}` : agentCommand
  // `-P -F` gives us "@<window>\x1f%<pane>"; if that ever fails to split we used
  // to carry `undefined` all the way into send-keys and into the saved record,
  // which is how sessions ended up persisted with no pane at all.
  if (!created.paneId || !/^%\d+$/.test(created.paneId)) {
    const error = `tmux did not return a usable pane id (got ${JSON.stringify(created.paneId)} from ${JSON.stringify(created.windowId)})`
    log.error('sessions: unusable pane id from tmux', {
      windowId: created.windowId,
      paneId: created.paneId,
      tmuxSession: project.tmuxSession
    })
    emitProgress(creationId, 'launch', false, error)
    return { ok: false, error }
  }

  const launched = await sendKeysResult(created.paneId, launchCommand)
  emitProgress(
    creationId,
    'launch',
    launched.ok,
    launched.ok ? undefined : `could not type the agent command into the pane: ${launched.error}`
  )
  if (!launched.ok) {
    log.error('sessions: could not type the agent command into the pane', {
      paneId: created.paneId,
      windowId: created.windowId,
      tmuxSession: project.tmuxSession,
      launchCommand,
      error: launched.error
    })
  } else {
    log.info('sessions: agent command sent', { paneId: created.paneId, launchCommand })
  }

  // Everything below this point is deliberately NOT awaited before the session
  // is returned. Waiting for the agent's prompt took up to 20 seconds and
  // captureHarnessVersion shells out again; neither is needed to hand the user a
  // working session, and blocking on them is why creation felt like it hung.
  // The record is persisted first, then the prompt is delivered in the
  // background — the session is already visible and usable while that happens.
  const deliverPrompt = async (recordId: string): Promise<void> => {
    if (!prompt) return
    const promptReady = await waitForPrompt(created.paneId)
    if (promptReady) {
      const delivered = await pastePrompt(created.paneId, prompt)
      if (!delivered.ok) log.warn('sessions: prompt not taken', { error: delivered.error })
      emitProgress(creationId, 'prompt', delivered.ok, delivered.error ?? undefined)
      return
    }
    {
      // The agent never got as far as a prompt. Overwhelmingly this means the
      // setup command failed, because it is chained as `<setup> && <agent>` —
      // so the shell is sitting at its own prompt with the error above it and
      // no agent was ever started. Showing the tail of the pane turns a silent
      // dead session into something the user can act on; it is the only place
      // that error exists.
      const tail = (await capturePane(created.paneId, 40))
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(-4)
        .join(' · ')
      emitProgress(
        creationId,
        'prompt',
        false,
        tail
          ? `the agent never started - setup likely failed. Last output: ${tail}`
          : 'timed out waiting for the agent to start - open the session and check its terminal'
      )
      log.warn('sessions: agent never reached a prompt', { recordId, paneId: created.paneId })
    }
  }

  const record: SessionRecord = {
    id: randomUUID(),
    projectId,
    // Named after where it runs, not after the internal flag. "Investigate"
    // was a mode name that appeared nowhere else in the UI, so a list of them
    // told you nothing about what any one of them was.
    title: input.title?.trim() || (investigate ? 'Project checkout' : dirName),
    ...(input.title?.trim() ? { isCustomName: true } : {}),
    branch: recordBranch,
    dirName,
    worktreePath: target,
    investigation: Boolean(investigate),
    ...(detached ? { detached: true } : {}),
    workspaceFile,
    tmuxSessionName: project.tmuxSession,
    tmuxWindowName: winName,
    tmuxWindowId: created.windowId,
    tmuxPaneId: created.paneId,
    claudeSessionId: null, // backfilled by discovery once the pid shows up
    origin: 'app',
    createdAt: Date.now(),
    archivedAt: null,
    lastPrompt: prompt || null,
    originalClaudeSessionId: null,
    startKind: 'create',
    waitingReason: null,
    isCustomName: false, // plan 4 §7.3 — the rename IPC handler flips this true
    // plan 4 §7.5 — no fork UI/logic exists yet, so this session is never
    // created as a fork today; left unset, ready for that path to set it.
    parentSessionId: null,
    harnessVersion: undefined // backfilled below, best-effort
  }

  markSessionTransition(record.id) // guards a resume racing this creation

  mutate((draft) => {
    draft.sessions.push(record)
  })

  if (!launched.ok) {
    // The worktree, the window and the record all exist and are usable — the pane
    // is a working shell in the right directory. Report the failure rather than
    // rolling any of it back, so the session is visible and can be retried.
    emitProgress(creationId, 'done', false, 'session created, but the agent never started')
    return {
      ok: false,
      error: `the agent never started: ${launched.error}. The worktree and its terminal are ready - open the session and start it yourself, or delete it.`,
      record
    }
  }

  // Hand the session back now. The prompt and the harness version arrive on
  // their own; the user already has a live agent in a real worktree.
  emitProgress(creationId, 'done', true)

  void deliverPrompt(record.id).catch((err) =>
    log.warn('sessions: prompt delivery failed', { recordId: record.id, error: String(err) })
  )
  void captureHarnessVersion()
    .then((harnessVersion) => {
      if (!harnessVersion) return
      mutate((draft) => {
        const target = draft.sessions.find((x) => x.id === record.id)
        if (target) target.harnessVersion = harnessVersion
      })
    })
    .catch(() => {
      /* best-effort — a missing version never blocks a session */
    })

  return { ok: true, record }
}

async function waitForPrompt(paneId: string): Promise<boolean> {
  const deadline = Date.now() + PROMPT_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const pane = await capturePane(paneId, 200)
    if (/❯\s*$/.test(pane.trimEnd()) || pane.includes('Try "')) return true
    await new Promise((resolve) => setTimeout(resolve, PROMPT_WAIT_POLL_MS))
  }
  return false
}

export interface DeleteSessionInput {
  id: string
  removeWorktree: boolean
  discardChanges: boolean
}

export interface DeleteSessionResult {
  ok: boolean
  error?: string
  warning?: string
}

export async function deleteSession(input: DeleteSessionInput): Promise<DeleteSessionResult> {
  const { id, removeWorktree, discardChanges } = input
  const record = getState().sessions.find((s) => s.id === id)
  if (!record) return { ok: false, error: 'session not found' }

  const project = getState().projects.find((p) => p.id === record.projectId)
  // Only refuse the part that would actually be destructive — removing "the
  // worktree" when it's really the main checkout (an investigation session,
  // or any record that otherwise ended up pointed at it) would delete the
  // user's real repo. Ending the session itself (kill its tmux window,
  // archive the record) is always safe and must still go through.
  if (removeWorktree && project && record.worktreePath === project.repoPath) {
    return { ok: false, error: "refusing to delete the main checkout - that's not a worktree" }
  }

  if (removeWorktree && !discardChanges) {
    const dirty = await hasUncommittedChanges(record.worktreePath)
    if (dirty) {
      return {
        ok: false,
        error: 'worktree has uncommitted changes - tick "Discard uncommitted changes" to proceed'
      }
    }
  }

  if (record.tmuxWindowId) {
    await killWindow(record.tmuxWindowId)
  }

  let warning: string | undefined

  if (removeWorktree && project) {
    // Plan 4 §7.2 worktreePreDeleteCommand — a project-specific clean step
    // (e.g. a build tool's own `clean` target) that runs ahead of the
    // hardcoded `git clean -xdff` fallback, for build output `git worktree
    // remove` refuses to walk over on its own.
    if (project.worktreePreDeleteCommand) {
      const preDelete = await run('sh', ['-c', project.worktreePreDeleteCommand], {
        cwd: record.worktreePath,
        timeoutMs: 30_000
      })
      if (preDelete.code !== 0) {
        log.warn('sessions:delete — worktreePreDeleteCommand failed, continuing anyway', {
          command: project.worktreePreDeleteCommand,
          code: preDelete.code,
          stderr: preDelete.stderr.trim()
        })
      }
    }

    await cleanWorktree(record.worktreePath)
    await gitRemoveWorktree(project.repoPath, record.worktreePath)
    await pruneWorktrees(project.repoPath)

    if (existsSync(record.worktreePath)) {
      warning = `worktree directory survived removal - delete it by hand: ${record.worktreePath}`
      log.warn('sessions:delete — worktree directory survived removal', {
        worktreePath: record.worktreePath
      })
    }

    if (record.workspaceFile && existsSync(record.workspaceFile)) {
      try {
        rmSync(record.workspaceFile)
      } catch (err) {
        log.warn('sessions:delete — failed to remove .code-workspace', { error: String(err) })
      }
    }
  }

  // Never hard-delete the record — the history still matters. But mark it
  // deleted as well as archived: archived alone put it in History's Done
  // bucket next to sessions you can pick up again, offering a Resume that
  // could only fail, because the worktree it would run in has just been
  // removed. `deletedAt` is what sends it to Ended instead.
  mutate((draft) => {
    const target = draft.sessions.find((s) => s.id === id)
    if (target) {
      target.archivedAt = Date.now()
      target.deletedAt = Date.now()
    }
    // Its Claude may run on in another terminal Control Room can't close (no
    // tmux window of ours). Hidden, it stays deleted instead of coming back
    // on the next poll as a session with no record.
    if (!record.tmuxWindowId && record.claudeSessionId) {
      draft.hiddenSessionIds ??= []
      if (!draft.hiddenSessionIds.includes(record.claudeSessionId)) {
        draft.hiddenSessionIds.push(record.claudeSessionId)
      }
    }
  })

  return { ok: true, warning }
}
