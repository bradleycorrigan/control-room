# Control Room — build conventions

A local Electron app that manages Claude Code agent sessions: projects are git repos, a session is
a worktree + branch + an agent running in a tmux window. It shows which sessions need attention,
notifies, shows diffs, and opens a worktree in Cursor.

**The plan is the spec.** `~/.claude/plans/ok-now-i-want-rippling-starlight.md` (plan 7, current) —
read the relevant section before working on a milestone rather than relying on context you were
handed. `~/.claude/plans/control-room-design-revision.md` (plan 3) and
`~/.claude/plans/control-room-ui-and-themes.md` (plan 2) are prior art for the token contract and
theme list, which plan 7 keeps.

## Checks — all must pass before a milestone is done

```bash
npm run gate            # ONE command: typecheck, lint, build, contrast-check, hex-literal grep,
                         # native-module grep, and two interaction checks with real input against
                         # the fixture: tabs (strip, shortcuts, closing, J/K) and pages (Backlog,
                         # Home, Sessions rows, Settings, session header, terminal find). ~50s;
                         # builds the fixture if it's missing. A new page or behaviour gets its
                         # checks added to src/renderer/src/dev/pagesCheck.ts. Prints a
                         # single PASS/FAIL summary. Builders run this themselves before calling a
                         # milestone done; verifiers do not re-run it.
npm run gate -- --only=pages   # while iterating on one area: static checks + the pages run.
                         # The full gate still runs before every commit — check its exit
                         # code, never pipe it through tail/grep in a && chain.
npm run install-app      # build, quit the installed app, swap it into /Applications, reopen
npm run fixture          # (re)builds the seeded project/worktrees/sessions fixture AND spins up
                         # real tmux panes in a dedicated "cr-fixture" session for terminal testing
npm run shot -- <screen> <theme-id> [width]   # writes a PNG; LOOK at it, in 2+ themes, one light
```

`npm run gate` already treats the electron-builder → `@electron/rebuild` → `node-gyp` devDependency
hit as known-and-non-blocking — do not re-investigate that finding, it is not a real regression.

Commit at the end of every milestone attempt, passing or not — see Verification rule below.

## Branches: every change, however small

The repo is public on GitHub (`bradleycorrigan/control-room`), so `main` only ever holds work
that passed the gate.

1. Start every piece of work on a new branch cut from an up-to-date `main`:
   `git switch -c <short-descriptive-name>`. Never commit straight onto `main`.
2. Commit on the branch. Leave out `release/` and `*.tsbuildinfo`: both are build output and
   gitignored.
3. Merge into `main` only once `npm run gate` prints PASS on the branch. Fast-forward
   (`git merge --ff-only`), then delete the branch.
4. Before anything goes to GitHub, check the diff for secrets and real company details (Jira
   site, Slack links, internal hostnames). Use example values instead.

Pushing: local history and GitHub's don't match (six old local commits hold a 166 MB build that
GitHub rejects), so a plain `git push` is refused. Push a snapshot of `main` on top of GitHub's
current tip, which is an ordinary fast-forward:

```bash
git ls-remote origin main                                     # GitHub's tip
git commit-tree "main^{tree}" -p <tip> -m "<what changed>"    # prints the new commit
git push origin "<new commit>:refs/heads/main"
```

Write the commit out in full. In zsh, `"$c:refs/..."` reads `:r` as a filename modifier and
mangles the target.

## Verification rule — the one that has cost us most

**A check runs against the real app, or it is reported unrunnable.** Do not build a private
harness, and do not render a component standalone to "verify" it — those verdicts are worthless in
both directions: they fail working code and pass broken code.

Use the one seeded fixture (`npm run fixture`): a fake project with worktrees, plus synthetic
`~/.claude/sessions/*.json` covering `working`, `waiting` + `waitingFor`, `done`, `errored` and
`stopped`, pointed at by an env var, plus real tmux panes for terminal work. If a fixture for some
check does not exist yet, build it there, once, for everyone.

If a check still cannot run — it needs nine live agents, or asks you to read Activity Monitor —
mark it **"unrunnable, deferred to the user"** with the reason and move on. Never fail a milestone
on an assertion the fixture cannot produce. Never revert passing code to satisfy one.

**One verify round, then fix forward (plan 3 protocol — supersedes any older 3-round rule).** The
builder owns correctness and must not report done until `npm run gate` prints PASS, pasted into its
result. The verifier does not re-run the gate — it reads the diff, looks at the screenshots the
milestone calls for, and checks the plan's acceptance points; target under 3 minutes. If it fails,
the same builder fixes exactly the named failures and re-verifies once. If that still fails, commit
the work as-is, log what's outstanding, and move on — never a third round, never rewrite working
code to satisfy a check.

## Parallel work

File ownership only applies while agents genuinely run concurrently. Declare disjoint file sets up
front; shared files (`src/main/ipc.ts`, `src/main/store/types.ts`, `src/renderer/src/App.tsx`
routing, `src/renderer/src/theme/*`) change only in sequential stages. **Once a milestone is
committed, its files are no longer locked** — a later sequential milestone may edit them.

For the Git/Files/Skills/Rules milestone: land every new IPC handler in one agent working alone,
then fan out the four tabs.

## Traps that have already cost us a day each

**tmux sanitizes control characters unless the client looks UTF-8 capable.** It
decides from `LC_ALL` / `LC_CTYPE` / `LANG`, and replaces every byte `<= 0x1f`
with `_`. A Finder- or Dock-launched app inherits no locale, so `-F` format
output came back as `@172_%172` instead of `@172\x1f%172`, the split produced no
pane id, and every session the app created failed to launch. Every tmux call
goes through `runTmux()` in `exec/run.ts` (which passes `-u`), and `ENV` supplies
a UTF-8 locale when the environment has none. Keep both. Never call
`run('tmux', ...)` directly.

**Anything gated on `CR_SESSIONS_DIR` is invisible to every check we have.** The
fixture, `npm run shot:fixture` and every verifier run with that variable set, so
a code path that early-returns on it is never executed by any green tick. That is
how the pid-reuse check shipped broken and stayed broken. If you gate on it, add
an opt-in override (see `CR_PID_CROSSCHECK`) and a test that uses it.

**`ps -o lstart=` is not `procStart`.** Claude Code writes `procStart` in ctime
order in UTC; `ps` prints day-first in local time. They are the same instant in
two renderings and never compare equal as strings. Use `startedAt`, which is
epoch milliseconds.

## Non-negotiables

- **A control exists only if it works.** Do not ship a disabled menu item, a greyed button or a
  tooltip explaining that something is out of scope. If an action is not implemented in this
  milestone, it does not appear in the UI. A user must never be able to see a thing they cannot do.
  Disabled state is legitimate only when the action exists and is unavailable right now for a
  reason the user can act on — "Focus terminal" on a session whose terminal is gone. If an action
  is cut for time, delete its menu entry in the same commit.
- If you notice other, concurrent edits to shared files while you work (a dirty git status you did
  not create, a commit from another agent), do NOT call `ListAgents`/`SendMessage` or otherwise try
  to reach or coordinate with whatever is making them. Just note it factually in your own result and
  let the orchestrator sort it out — a subagent pinging unrelated Claude sessions to ask "is this
  you?" is noise in someone else's conversation and has already happened once on this project.
- A hex colour literal in a component is a bug. Every colour comes from a token in
  `src/renderer/src/theme/`.
- Contrast: body text ≥ 4.5:1, muted ≥ 3:1, status dots ≥ 3:1, in every theme. Fix the theme,
  never waive the rule.
- No native modules, except `node-pty` — the terminal needs a real PTY for correct client geometry
  (cols/rows tmux actually honours); there is no pure-JS equivalent. It ships asar-unpacked and is
  rebuilt against Electron's ABI via `@electron/rebuild` (plan 4 Part 10).
- `src/main/exec/run.ts` is the only place anything is spawned, always with argv arrays, never a
  shell string.
- The renderer has no OS access. It sends ids over IPC; it never handles paths it can act on.
- tmux pane output, commit messages, branch names and file contents are untrusted. Escape on
  render; the only `dangerouslySetInnerHTML` is the ANSI converter's output with `escapeXML: true`.
- `files:write` resolves the real path and refuses anything outside a registered project.
- Never write to `~/.claude/settings.json` except the `hooks` key, after a timestamped backup, and
  only when the user presses the button.
- Status is always shown as a colour **and** a word. Colour alone is not accessible.
- Creating a session never opens Cursor. Per-worktree setup runs in the tmux pane
  (`<setupCommand> && <agentCommand>`); Cursor opens only from "Open in IDE".
- Do not restructure the existing `main/{engine,exec,store}` code. Add to it.

## Recovered work

The grid-view implementation was reverted during a failed verification round and recovered from
file history to:

```
~/Documents/claude scratch/control-room-u6-recovered/GridView.tsx
```

239 lines, with the adaptive auto-fill grid and needs-attention-first sorting. Its `GridTile`
component and grid CSS were not recoverable and need rewriting. Start from that file rather than
rebuilding the milestone.

## Environment

macOS arm64, no Xcode (Command Line Tools only). Claude Code v2.1.274 — session discovery reads
undocumented internals (`~/.claude/sessions/*.json`, the `tmux` field format, `claude agents
--json`), so all parsing lives in `src/main/exec/claude.ts`, optional-chains every field, and
degrades one session to `status: 'unknown'` rather than breaking the list.

`pane_pid` is the pane's **shell**, not Claude — Claude is its child. Join tmux to sessions via the
`tmux` field inside the session file (`"wt:@5.%5"`), never `pane_pid`.
