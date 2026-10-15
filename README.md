# Control Room

A Mac app for running many Claude Code agents at once, and keeping track of them.

Each **session** is one agent working on its own git worktree and branch, in its own tmux window.
Control Room shows you every session, tells you which ones are waiting on you, and lets you answer
them without hunting through terminal tabs.

It runs entirely on your Mac. No account, no cloud, no login.

## What it does

- **Home**: type a prompt, pick a project and branch, and start an agent. Attach files, turn on plan
  mode, or start it in the background.
- **Sessions**: every agent and its status (working, waiting on you, done, errored, stopped), in a
  list or a grid. Waiting sessions come first, and you get a macOS notification when one needs you.
- **Session view**: a live terminal attached to the agent's tmux pane, the diff it has made, and a
  ship flow that commits, pushes and opens a pull request.
- **Projects**: your git repos, their worktrees, and Git, Files, Skills and Rules (`CLAUDE.md` /
  `AGENTS.md`) tabs for each one.
- **Tickets**: your Jira tickets as a list or board. Change status, priority, epic, cycle, labels and
  estimates in place, plan a cycle, and start a session straight from a ticket.
- **History**: past sessions, including ones you started yourself in a terminal, ready to resume.
- **Dev containers** (optional): start an agent inside your project's dev container.
- **Themes**: light and dark themes, or follow the system setting.

## What you need

A Mac with Apple silicon (arm64). Then:

| Tool                   | Why                               | How to get it                                                                |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| Node.js 22.12 or later | Builds and runs the app           | `brew install node`                                                          |
| git                    | A worktree and branch per session | `xcode-select --install` (the Command Line Tools; you don't need full Xcode) |
| tmux                   | Every agent runs in a tmux window | `brew install tmux`                                                          |
| Claude Code (`claude`) | The agent itself                  | [Claude Code setup guide](https://docs.claude.com/en/docs/claude-code/setup) |

Optional. Everything else works without them:

| Tool                                                                        | What it adds                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Cursor](https://cursor.com) (`cursor` on your `PATH`)                      | "Open in IDE" for a session's worktree                           |
| [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login` | Pull request status, and opening pull requests from Ship         |
| A Jira Cloud site and an API token                                          | The Tickets screen                                               |
| The [Dev Containers CLI](https://github.com/devcontainers/cli) and Docker   | "Start in dev container" (see [Dev containers](#dev-containers)) |
| `mise` / `direnv`                                                           | New worktrees get `mise trust` / `direnv allow` run for you      |

When the app starts, it tells you if `tmux`, `git`, `claude` or `cursor` is missing.

## Install

```bash
git clone https://github.com/bradleycorrigan/control-room.git
cd control-room
npm install
npm run install-app
```

`npm run install-app` builds the app, copies it to `/Applications/Control Room.app` and opens it.
If an older copy is running, it quits that copy first. Run it again whenever you pull new changes.

The app isn't signed with an Apple Developer ID. If macOS blocks it the first time, right-click
**Control Room** in `/Applications`, choose **Open**, then confirm.

To run it from the source instead, with changes showing as you save:

```bash
npm run dev
```

`npm run dev` keeps its own data, apart from the installed app, so the two never mix.

## First run

1. **Add a project.** Pick a git repo on your Mac. Each session gets its own worktree, in a folder
   next to the repo: `<repo>.worktrees/`.
2. **Install hooks** (Settings → Hooks, optional). Claude Code then tells Control Room the moment
   an agent finishes, fails or asks you something. See [Hooks](#hooks) for what you get with and
   without them.
3. **Connect Jira** (Tickets, optional). Enter your site (`yourcompany.atlassian.net`), the email you
   sign in with, an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) and
   your project keys (like `PROJ, TEAM`).

## Where things live

| What                   | Where                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| The app's data         | `~/Library/Application Support/Control Room/` (`Control Room Dev` for `npm run dev`) |
| A session's worktree   | `<repo>.worktrees/<branch>`                                                          |
| Editor workspace files | `<repo>.worktrees/.workspaces/`                                                      |
| Agents' tmux windows   | A tmux session called `wt` (`tmux attach -t wt` to see them yourself)                |
| Your Jira token        | `jira.json` in the data folder, encrypted with a key kept in your Keychain           |

Control Room reads Claude Code's own files in `~/.claude/` to find sessions, and listens for hooks
on `127.0.0.1:47821`.

## Settings worth knowing

- **New sessions**: the model and thinking level every new session starts with.
- **Terminal app**: the app that "Focus terminal" brings to the front. Terminal by default; set it
  to iTerm, Ghostty or whatever you use.
- **Setup command** (a project's page → Worktree settings): runs in a new worktree's terminal before
  the agent starts, like `npm install`. Empty by default.
- **`~/.zsh/wt-setup.sh`** (optional): if this file exists, the workspace file Control Room writes
  for each worktree asks the editor to run it when you open the worktree. If you don't have one,
  nothing happens.

## Dev containers

Control Room can start an agent inside a [dev container](https://containers.dev), so it works in
the project's own tools and can't touch the rest of your Mac.

**You don't use dev containers.** Nothing to do. Everything works, and the button never shows.

**You use them the standard way.** Your project has `.devcontainer/devcontainer.json` (or
`.devcontainer.json`), Docker is running, and the Dev Containers CLI is installed:

```bash
npm install -g @devcontainers/cli
```

Then a **Start in dev container** button shows next to Start, in that project only. It types this
into the session's terminal:

```bash
devcontainer up --workspace-folder <worktree> && devcontainer exec --workspace-folder <worktree> claude …
```

The first start builds the container, which can take a few minutes. You see the build in the
session's terminal.

To use the container every time, turn on **Settings → Dev containers → Start new sessions in a dev
container by default**. Start then uses the container, and the second button reads **Start without
dev container**.

**You use them some other way.** For example, a launcher script that keeps one container setup
outside your projects and points it at any folder. In **Settings → Dev containers**:

- **Start the container**: the command that runs first. Leave it empty to skip it.
- **Run the agent in it**: the command that runs the agent. `{folder}` is the session's folder
  (quoted for you), and `{agent}` is the agent command, like `claude --model opus`.
- **Only in projects with a devcontainer.json**: turn this off if your setup lives outside the
  project.

For a launcher script at `~/tools/dev-launcher/bin/exec.sh` that takes a folder and a command, you
would empty the first box, set the second to `~/tools/dev-launcher/bin/exec.sh {folder} -- {agent}`,
and turn off the devcontainer.json check. The button shows whenever the first word of each command
is a program the app can find.

Things to know:

- Setup commands run on your Mac, before the container starts.
- Control Room can't see inside a container, so an agent's status there comes from its hooks
  alone. Without them it shows as "unknown", and its terminal works as usual. See
  [Hooks in a dev container](#hooks-in-a-dev-container).
- Git inside the container needs the main repo too, because a worktree points back to it. The
  Dev Containers CLI's `--mount-git-worktree-common-dir` flag does this, for worktrees made with
  relative paths.

## Hooks

Hooks are Claude Code's way of telling other programs what an agent is doing. With them, Claude
Code tells Control Room the moment an agent starts, finishes a turn, fails, asks you something or
ends.

**Hooks are optional.** Without them, Control Room works out each status from the files Claude Code
keeps in `~/.claude/sessions/`. It notices when those files change, and checks again every 30
seconds. You still see working, waiting on you and stopped. What you lose:

- **Done** and **Errored**. A finished turn shows as your turn, and a failed one doesn't stand
  out.
- Some questions, like a permission prompt, can show a little later.
- Any status at all for an agent in a dev container.

### Install them on your Mac

Settings → Hooks → **Install hooks**. Control Room adds its hooks to the `hooks` key of
`~/.claude/settings.json`, backs the file up first, and changes nothing else. **Show exactly what
gets written** shows them before you press it. **Uninstall hooks** takes them out again.

Each event gets two hooks:

- An `http` hook to `http://127.0.0.1:47821/hook`, for agents on your Mac. The port moves up by one
  if 47821 is busy, and Control Room updates the hook to match.
- A `command` hook for agents in a dev container. It does nothing unless `CR_HOOK_URL` is set,
  which only happens inside a container Control Room started.

If Settings says your hooks are out of date, press **Update hooks**.

### Hooks in a dev container

Inside a container, `127.0.0.1` is the container, not your Mac. So when Control Room starts an
agent in a dev container, it starts it as:

```bash
env CR_HOOK_URL='http://host.docker.internal:47821/hook/container/<session>?token=<token>' claude …
```

The container's `command` hook posts each event to that address. `<session>` tells Control Room
which session the event belongs to, so the folder the container mounts the worktree at doesn't
matter. `<token>` is a secret Control Room makes on first start, so nothing else that can reach the
port can post events. Control Room still only listens on `127.0.0.1`: Docker Desktop and OrbStack
pass `host.docker.internal` through to it.

For this to work, the container needs:

1. **The hook.** If the container shares your Mac's `~/.claude`, it already has it from Install
   hooks. If it keeps its own, press **Copy dev container hooks** in Settings → Hooks and paste the
   result into the container's `~/.claude/settings.json`.
2. **`curl`**, which the hook uses.
3. **A way to reach your Mac.** Docker Desktop and OrbStack give you `host.docker.internal`. If
   your setup uses another name, set **Settings → Dev containers → Address of this Mac from a
   container**. If the container blocks outgoing traffic, allow TCP ports 47821 to 47830 to that
   address.

A standard `devcontainer.json` that shares your hooks with the container:

```json
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "mounts": ["source=${localEnv:HOME}/.claude,target=/home/vscode/.claude,type=bind"],
  "containerEnv": { "CLAUDE_CONFIG_DIR": "/home/vscode/.claude" },
  "runArgs": ["--add-host=host.docker.internal:host-gateway"]
}
```

`runArgs` is only needed outside Docker Desktop and OrbStack, where `host.docker.internal` isn't
there by itself. To keep the container's `~/.claude` separate instead, leave out the mount and
`CLAUDE_CONFIG_DIR`, and paste the copied hooks into the container's own settings file.

**With a launcher script of your own**: nothing changes. Control Room puts `env CR_HOOK_URL=…`
in front of `{agent}`, so it reaches the container through any launcher that runs the command
it's given. The container still needs the hook, `curl` and a way out to your Mac.

## Jira

Control Room talks to Jira Cloud's REST APIs with your API token. It reads the standard Sprint
field (`customfield_10020`) for cycles, and Jira Service Management's Request Type
(`customfield_10010`). The ticket panel's "Why it matters" line reads `customfield_10327`, a custom
field from the site Control Room was built against. On your site it's most likely empty, and the
line just doesn't show.

## Troubleshooting

**"Not found on PATH" when the app starts.** An app opened from Finder or the Dock doesn't get your
shell's `PATH`. Control Room adds `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If a
tool lives somewhere else (nvm, Volta, asdf), link it into one of those, for example
`ln -s "$(which claude)" ~/.local/bin/claude`.

**Every new session fails to start.** Check that tmux works in your terminal (`tmux -V`). An app
opened from Finder also gets no language setting, which breaks how tmux reports back. Control Room
sets a UTF-8 one for itself, so this should only happen if something overrides `LC_ALL` with a
non-UTF-8 value.

**Jira asks you to connect again, or says it can't encrypt the token.** The token's key lives in
your Keychain, as **Control Room Safe Storage**. If you open the app from something other than
Finder, the Dock or your own terminal, macOS can refuse it access. Quit, open the app from
`/Applications`, choose **Always Allow** if the Keychain asks, and connect again.

**No notifications.** Check System Settings → Notifications → Control Room. Focus modes hide
banners too.

**A session shows as "unknown".** Session discovery reads files in `~/.claude/` that aren't a
public API, and a Claude Code update can change them. The rest of the list keeps working.

## Develop

```bash
npm run dev        # run from source
npm run gate       # every check: typecheck, lint, build, contrast, and real-input
                   # checks against a seeded fixture
npm run fixture    # rebuild the fixture: a fake project, sessions and tmux panes
npm run shot -- <screen> <theme-id> [width]   # screenshot one screen to .dev/shots/
```

Run `npm run gate` before every commit. It prints one PASS or FAIL. `CLAUDE.md` has the build
rules. The fixture uses its own tmux session, `cr-fixture`, and never touches `wt`.

- `src/main/`: the only part with access to your Mac. It runs tmux, git and claude, owns the data
  files and listens for hooks. Every command goes through `src/main/exec/run.ts`.
- `src/renderer/`: the interface, in React. It asks the main process to do things.
- `src/preload/`: the bridge between the two.

## Known limits

- macOS only, built and tested on Apple silicon.
- Session discovery depends on Claude Code's own files, which can change between versions.
