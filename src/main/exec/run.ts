import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'

// Launched from Finder, process.env.PATH is roughly /usr/bin:/bin:/usr/sbin:/sbin —
// tmux, claude and cursor are all "not found" without this.
const EXTRA_PATH = [
  `${homedir()}/.local/bin`,
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

/**
 * tmux runs everything it prints back through `utf8_sanitize()` unless the
 * client looks UTF-8 capable, which it decides from LC_ALL / LC_CTYPE / LANG.
 * That replaces every byte <= 0x1f with "_" — including the 0x1f we use as the
 * field separator in every `-F` format string. A Finder- or Dock-launched app
 * inherits no locale at all, so `new-window -P -F '#{window_id}\x1f#{pane_id}'`
 * came back as "@172_%172", the split produced no pane id, and every session
 * the app created failed to launch and was saved with no pane. Verified on
 * tmux 3.7c: `env -u LANG -u LC_ALL -u LC_CTYPE tmux display-message -p` turns
 * 0x1f into "_", and keeping a UTF-8 locale (or passing `tmux -u`) does not.
 *
 * Keep whatever UTF-8 locale the user already has; only supply one when there
 * isn't one, and never override LC_ALL if it is already set.
 */
const hasUtf8Locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].some((v) =>
  /utf-?8/i.test(v ?? '')
)

export const ENV = {
  ...process.env,
  ...(hasUtf8Locale ? {} : { LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' }),
  PATH: [...new Set([...EXTRA_PATH, ...(process.env.PATH ?? '').split(':')])]
    .filter(Boolean)
    .join(':')
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

const REQUIRED_BINARIES = ['tmux', 'git', 'claude', 'cursor'] as const

export interface BinaryCheckResult {
  name: (typeof REQUIRED_BINARIES)[number]
  found: boolean
  path: string | null
}

/**
 * Startup self-check: resolves every binary the app shells out to, using the
 * same ENV (and therefore the same PATH fix) as `run()` itself. A packaged,
 * Finder-launched app is the scenario this exists to catch.
 */
export function checkRequiredBinaries(): Promise<BinaryCheckResult[]> {
  return Promise.all(
    REQUIRED_BINARIES.map(async (name) => {
      const res = await run('which', [name])
      const path = res.code === 0 ? res.stdout.trim() : null
      return { name, found: path !== null, path }
    })
  )
}

/** The only place that spawns anything. Never rejects — callers branch on `code`. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: ENV,
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 16 * 1024 * 1024,
        shell: false
      },
      (err, stdout, stderr) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errCode = err ? (err as any).code : undefined
        resolve({
          code: typeof errCode === 'number' ? errCode : err ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      }
    )
  })
}

/**
 * The other spawn path — for a long-lived subprocess with a streaming
 * protocol (tmux control mode), where `run()`'s "resolve once on exit"
 * shape doesn't fit. Still argv-only, still `shell: false`, still through
 * this file (CLAUDE.md: "run.ts is the only place anything is spawned").
 * Never rejects synchronously — an ENOENT surfaces as an `error` event on
 * the returned process, same as any other spawn failure a caller must
 * listen for.
 */
export function spawnStream(
  file: string,
  args: string[],
  opts: { cwd?: string } = {}
): ChildProcessWithoutNullStreams {
  return spawn(file, args, { cwd: opts.cwd, env: ENV, shell: false })
}

/**
 * Every tmux invocation goes through here. `-u` tells tmux the client is
 * UTF-8 capable regardless of the environment, which stops it sanitizing the
 * 0x1f field separator out of `-F` format output (see the ENV note above).
 * Belt and braces with the locale: either alone fixes it, and the app has no
 * business depending on which one survived.
 */
export function runTmux(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<RunResult> {
  return run('tmux', ['-u', ...args], opts)
}
