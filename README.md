# Control Room

A macOS desktop app for running many Claude Code agents at once, and keeping track of them.

Each **session** is one agent working on its own git worktree and branch, running in its own tmux
window. Control Room shows you every session, tells you which ones are waiting on you, and lets you
answer them without hunting through terminal tabs.

It runs entirely on your Mac. No account, no cloud, no login. Everything it stores lives in
`~/Library/Application Support/Control Room/`.

## What it does

- **Home**: type a prompt, pick a project and branch, and start an agent. Attach files, turn on plan
  mode, or start it in the background.
- **Sessions**: every agent and its status (working, waiting on you, done, errored, stopped), in a
  list or a grid. Waiting sessions come first, and you get a macOS notification when one needs you.
- **Session view**: a live terminal attached to the agent's tmux pane, the diff it has made, and a
  ship flow that commits, pushes and opens a pull request.
- **Projects**: your git repos, their worktrees, and per-project Git, Files, Skills and Rules
  (`CLAUDE.md` / `AGENTS.md`) tabs.
- **Backlog**: your Jira tickets as a list or board, grouped by status, epic or cycle. Change
  status, priority, epic, cycle, labels, estimates and blocking links in place. Plan a cycle, and
  start a session straight from a ticket.
- **History**: past sessions, including ones you started yourself in a terminal, ready to resume.
- **Themes**: light and dark themes, or follow the system setting.

## Prerequisites

Control Room is built for **macOS on Apple silicon (arm64)**. You need:

| Tool                             | Why                                          | Install                                                                      |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Node.js 22.12 or later, with npm | Builds and runs the app                      | `brew install node`                                                          |
| git                              | Worktrees and branches for each session      | Comes with Xcode Command Line Tools: `xcode-select --install`                |
| tmux                             | Every agent runs in a tmux window            | `brew install tmux`                                                          |
| Claude Code                      | The agent itself, as `claude` on your `PATH` | [Claude Code setup guide](https://docs.claude.com/en/docs/claude-code/setup) |

Optional:

| Tool                                                                                              | What it adds                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Cursor](https://cursor.com) (`cursor` on your `PATH`)                                            | "Open in IDE" for a session's worktree                            |
| [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`                       | Pull request status, and opening pull requests from the ship flow |
| A Jira Cloud site and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) | The Backlog screen                                                |
| `mise` / `direnv`                                                                                 | New worktrees get `mise trust` / `direnv allow` run for you       |

The Xcode Command Line Tools are enough. You don't need full Xcode.

If `tmux`, `git`, `claude` or `cursor` is missing, the app tells you which one when it starts.

## Install

```bash
git clone https://github.com/bradleycorrigan/control-room.git
cd control-room
npm install
npm run install-app
```

`npm run install-app` builds the app and copies it to `/Applications/Control Room.app`, then opens
it. If an older copy is running, it quits that copy first. Run the same command again whenever you
pull new changes.

The app isn't signed with an Apple Developer ID. If macOS blocks it on first launch, right-click
**Control Room** in `/Applications`, choose **Open**, then confirm.

### First run

1. **Add a project**: pick a git repo on your Mac. Its sessions get their own worktrees, in
   `.control-room-general.worktrees` inside the repo.
2. **Install hooks** (Settings): lets Claude Code tell Control Room the moment an agent needs you,
   rather than the app polling for it. This writes only the `hooks` key in
   `~/.claude/settings.json`, and backs the file up first with a timestamp.
3. **Connect Jira** (Backlog, optional): your site (`yourcompany.atlassian.net`), your email and an
   API token. The token is encrypted with a key macOS keeps in your Keychain.

## Develop

```bash
npm run dev        # run from source with hot reload
npm run gate       # every check: typecheck, lint, build, contrast, and real-input
                   # interaction checks against a seeded fixture (~4 minutes)
npm run fixture    # rebuild the fixture: a fake project, sessions and tmux panes
npm run shot -- <screen> <theme-id> [width]   # screenshot one screen to .dev/shots/
```

Run `npm run gate` before every commit. It prints one PASS or FAIL summary. `CLAUDE.md` has the
build conventions and the rules the gate enforces.

### How it's put together

- `src/main/`: the main process. The only part with access to your Mac: it runs tmux, git and
  claude, owns the data files and listens for hooks. Every command goes through
  `src/main/exec/run.ts`.
- `src/renderer/`: the interface, in React. It has no direct access to your Mac, and asks the main
  process to do things.
- `src/preload/`: the bridge that lists exactly which main-process calls the interface can make.

## Known limits

- macOS only, and built and tested on Apple silicon.
- Session discovery reads Claude Code's own files in `~/.claude/`, which aren't a public API. A
  Claude Code update can change them. When that happens, the affected session shows as "unknown"
  rather than breaking the list.
- macOS Focus modes hide notification banners. That's expected.
