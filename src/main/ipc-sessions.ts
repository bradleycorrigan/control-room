import { ipcMain } from 'electron'
import { getState } from './store/store'
import type { SessionRecord } from './store/types'
import { pullRequestFor } from './exec/pullRequests'
import { handoffGitSummary } from './exec/sessionGit'
import { buildHandoffNote, lastAssistantMessage } from './exec/handoffNote'
import { pushAndCreatePr } from './exec/ship'
import { branchOfWorktree } from './exec/git'

/**
 * IPC handlers added in the sessions round. Registered from registerIpcHandlers
 * (ipc.ts) so that file only needs the one call.
 */
export function registerSessionsIpc(): void {
  // Hand-off note (plan 7 step 2): everything on this channel comes straight
  // off disk — no LLM call. The renderer sends only the session id; every
  // path (worktree, transcript) is resolved here, never handed across IPC.
  ipcMain.handle('sessions:handoffNote', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return null

    const project = getState().projects.find((p) => p.id === record.projectId)
    const baseRef = project?.baseRef ?? 'origin/main'

    const branch = await currentBranch(record)
    const [git, pr] = await Promise.all([
      record.investigation
        ? Promise.resolve(null)
        : handoffGitSummary(record.worktreePath, baseRef),
      branch ? pullRequestFor(record.id, record.worktreePath, branch) : Promise.resolve(null)
    ])

    const note = buildHandoffNote({
      title: record.title,
      branch: branch ?? `no branch yet (started from ${record.branch})`,
      git,
      prUrl: pr?.url ?? null,
      lastMessage: lastAssistantMessage(record.claudeSessionId),
      investigation: record.investigation
    })

    return { note, branch: branch ?? record.branch }
  })

  // Ship flow (plan 7 step 3), step 1 — commits + diffstat since the base
  // branch, the same summary the hand-off note builds from. The renderer
  // uses `git === null || git.commits.length === 0` to decide the Ship
  // control shouldn't be shown at all rather than shown and disabled
  // (CLAUDE.md: a control exists only if it works).
  ipcMain.handle('sessions:shipInfo', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return null

    const project = getState().projects.find((p) => p.id === record.projectId)
    const baseRef = project?.baseRef ?? 'origin/main'
    const git = record.investigation ? null : await handoffGitSummary(record.worktreePath, baseRef)

    return { git }
  })

  // Ship flow, step 2 — push the branch and open the pull request. Title and
  // body are built in the renderer (it already has the hand-off note and the
  // linked ticket) and sent as plain strings; this only resolves the
  // worktree and branch, same as every other session action here.
  ipcMain.handle(
    'sessions:ship',
    async (_evt, id: string, title: string, body: string, draft: boolean) => {
      const record = getState().sessions.find((s) => s.id === id)
      if (!record) return { ok: false, error: 'Session not found.' }
      const branch = await currentBranch(record)
      if (!branch) {
        return {
          ok: false,
          error: `This session isn't on a branch of its own yet. Ask the agent to make one (git switch -c <name>), then ship.`
        }
      }
      return pushAndCreatePr(record.worktreePath, branch, title, body, draft)
    }
  )
}

/**
 * The branch a session's work is on. A detached session started from a
 * branch someone else had checked out (usually main): it has one only once
 * the agent makes it, and it's never the branch it started from, so Ship
 * can't push main.
 */
async function currentBranch(record: SessionRecord): Promise<string | null> {
  if (!record.detached) return record.branch
  const live = await branchOfWorktree(record.worktreePath)
  return live && live !== 'HEAD' && live !== record.branch ? live : null
}
