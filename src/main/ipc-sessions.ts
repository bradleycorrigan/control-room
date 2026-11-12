import { ipcMain, BrowserWindow } from 'electron'
import { log } from './log'
import { getState } from './store/store'
import type { SessionRecord } from './store/types'
import {
  pullRequestFor,
  linkedPullRequests,
  isPullRequestUrl,
  forgetPullRequestDetails
} from './exec/pullRequests'
import { listTranscriptPrLinks, listTranscriptArtifacts, listUserPrompts } from './exec/transcripts'
import { resolveClaudeBinary } from './exec/claude'
import { run } from './exec/run'
import {
  buildTicketDraftPrompt,
  parseTicketDraft,
  sanitiseChoices,
  ticketDraftArgs,
  buildSessionTitlePrompt,
  sessionTitleArgs,
  parseSessionTitle,
  type TicketDraftResult,
  type SessionTitleResult
} from './exec/ticketDraft'
import { tmpdir } from 'node:os'
import { handoffGitSummary } from './exec/sessionGit'
import { buildHandoffNote, lastAssistantMessage } from './exec/handoffNote'
import {
  commitPathsAndPush,
  pushAndCreatePr,
  pushBranch,
  markReadyForReview,
  unpushedCount
} from './exec/ship'
import { resolveProjectPath } from './exec/files'
import {
  closePullRequest,
  convertToDraft,
  mergePullRequest,
  pullRequestStatus,
  type MergeMethod
} from './exec/prActions'
import { currentBranch } from './engine/sessionBranch'
import { deliverPrompt, interruptPane } from './exec/tmux'
import { readChat } from './exec/chatTranscript'
import {
  answerPrompt,
  listPrompts,
  setPromptsListener,
  sweepAnsweredPrompts,
  type PromptAnswer
} from './engine/prompts'

/**
 * The things Control Room can ask Claude to do in a running session, in its
 * own words. The renderer names one; it never sends text of its own.
 */
const ASKS: Record<string, string> = {
  'open-pr':
    'Open a pull request for this branch: push it if it needs pushing, write a clear title and description from the changes, and give me the link.'
}

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
    const branch = record.investigation ? null : await currentBranch(record)
    // Commits a pull request doesn't have yet: what "Push" would send.
    const unpushed = branch ? await unpushedCount(record.worktreePath, branch) : null

    return { git, branch, unpushed }
  })

  // Pull requests the agent opened, in any repo: read from the transcript's
  // pr-link lines, so one opened outside this session's worktree still shows.
  const prLinksOf = (record: SessionRecord): ReturnType<typeof listTranscriptPrLinks> => {
    const ids = [record.originalClaudeSessionId, record.claudeSessionId].filter(
      (x): x is string => typeof x === 'string' && x.length > 0
    )
    const byUrl = new Map<string, ReturnType<typeof listTranscriptPrLinks>[number]>()
    for (const sid of ids) for (const l of listTranscriptPrLinks(sid)) byUrl.set(l.url, l)
    return [...byUrl.values()]
  }
  // Pages the session published with the Artifact tool, across every
  // Claude session it has had.
  ipcMain.handle('sessions:artifacts', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return []
    const ids = [record.originalClaudeSessionId, record.claudeSessionId].filter(
      (x): x is string => typeof x === 'string' && x.length > 0
    )
    const byUrl = new Map<string, ReturnType<typeof listTranscriptArtifacts>[number]>()
    for (const sid of ids) for (const a of listTranscriptArtifacts(sid)) byUrl.set(a.url, a)
    return [...byUrl.values()]
  })
  ipcMain.handle('sessions:linkedPrs', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return []
    return linkedPullRequests(prLinksOf(record))
  })
  // The same for every session at once, for the Sessions list's cards and
  // rows. Transcripts are scanned incrementally and gh answers are cached, so
  // a refresh only reads what's new.
  ipcMain.handle('sessions:linkedPrsAll', async () => {
    const out: Record<string, Awaited<ReturnType<typeof linkedPullRequests>>> = {}
    for (const record of getState().sessions) {
      const links = prLinksOf(record)
      if (links.length > 0) out[record.id] = await linkedPullRequests(links)
    }
    return out
  })

  // The claude binary for headless Haiku runs. The fixture never calls the
  // real one; CR_HAIKU_BIN points the gate at a stand-in so these paths still
  // run there.
  const haikuBin = async (): Promise<string | null> =>
    process.env.CR_HAIKU_BIN ?? (process.env.CR_SESSIONS_DIR ? null : await resolveClaudeBinary())
  const sessionIds = (record: SessionRecord): string[] =>
    [record.originalClaudeSessionId, record.claudeSessionId].filter(
      (x, i, all): x is string => typeof x === 'string' && x.length > 0 && all.indexOf(x) === i
    )

  // Suggest a title: what the session asked and its latest reply, no git or
  // gh, so it answers in a few seconds.
  ipcMain.handle('sessions:suggestTitle', async (_evt, id: string): Promise<SessionTitleResult> => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'Session not found.' }
    const bin = await haikuBin()
    if (!bin) return { ok: false, error: 'Claude Code was not found.' }
    const project = getState().projects.find((p) => p.id === record.projectId)
    const prompt = buildSessionTitlePrompt({
      title: record.title,
      projectName: project?.name ?? null,
      prompts: sessionIds(record).flatMap((sid) => listUserPrompts(sid)),
      lastReply: lastAssistantMessage(record.claudeSessionId)
    })
    const started = Date.now()
    const res = await run(bin, sessionTitleArgs(prompt), { cwd: tmpdir(), timeoutMs: 60_000 })
    const result: SessionTitleResult =
      res.code !== 0 && !res.stdout.trim()
        ? {
            ok: false,
            error: res.stderr.trim().split('\n').pop() || 'Claude stopped without an answer.'
          }
        : parseSessionTitle(res.stdout)
    log[result.ok ? 'info' : 'warn']('title suggestion', {
      ms: Date.now() - started,
      promptChars: prompt.length,
      ...(result.ok ? {} : { error: result.error })
    })
    return result
  })

  // Create ticket from a session: Haiku drafts the fields from what the
  // session asked, did and opened. Headless and quiet: no tools, no hooks
  // (so it never shows up as a session here), nothing saved.
  ipcMain.handle(
    'sessions:draftTicket',
    async (_evt, id: string, rawChoices: unknown): Promise<TicketDraftResult> => {
      const record = getState().sessions.find((s) => s.id === id)
      if (!record) return { ok: false, error: 'Session not found.' }
      const bin = await haikuBin()
      if (!bin) return { ok: false, error: 'Claude Code was not found.' }

      const choices = sanitiseChoices(rawChoices)
      const project = getState().projects.find((p) => p.id === record.projectId)
      const ids = sessionIds(record)
      const branch = record.investigation ? null : await currentBranch(record)
      const [git, branchPr, linked] = await Promise.all([
        record.investigation
          ? Promise.resolve(null)
          : handoffGitSummary(record.worktreePath, project?.baseRef ?? 'origin/main'),
        branch ? pullRequestFor(record.id, record.worktreePath, branch) : Promise.resolve(null),
        linkedPullRequests(prLinksOf(record))
      ])
      const pullRequests = [
        ...(branchPr ? [{ url: branchPr.url, title: branchPr.title ?? null }] : []),
        ...linked
          .filter((p) => p.url !== branchPr?.url)
          .map((p) => ({ url: p.url, title: p.title }))
      ]
      const prompt = buildTicketDraftPrompt(
        {
          title: record.title,
          projectName: project?.name ?? null,
          branch: branch ?? null,
          prompts: ids.flatMap((sid) => listUserPrompts(sid)),
          lastReply: lastAssistantMessage(record.claudeSessionId),
          pullRequests,
          commits: git?.commits.map((c) => c.subject) ?? []
        },
        choices
      )
      const started = Date.now()
      const res = await run(bin, ticketDraftArgs(prompt, choices), {
        cwd: tmpdir(),
        timeoutMs: 90_000
      })
      const result: TicketDraftResult =
        res.code !== 0 && !res.stdout.trim()
          ? {
              ok: false,
              error: res.stderr.trim().split('\n').pop() || 'Claude stopped without an answer.'
            }
          : parseTicketDraft(res.stdout, choices)
      log[result.ok ? 'info' : 'warn']('ticket draft', {
        ms: Date.now() - started,
        promptChars: prompt.length,
        ...(result.ok ? {} : { error: result.error })
      })
      return result
    }
  )

  // With a pull request already open: push the new commits to it.
  ipcMain.handle('sessions:push', async (_evt, id: string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'Session not found.' }
    const branch = await currentBranch(record)
    if (!branch) return { ok: false, error: "This session isn't on a branch of its own yet." }
    return pushBranch(record.worktreePath, branch)
  })

  // A small fix made in the diff view: commit the files edited there, push.
  // Every path must resolve inside the session's own worktree.
  ipcMain.handle(
    'sessions:commitPush',
    async (_evt, id: string, paths: string[], message: string) => {
      const record = getState().sessions.find((s) => s.id === id)
      if (!record) return { ok: false, error: 'Session not found.' }
      if (!Array.isArray(paths) || paths.length === 0) {
        return { ok: false, error: 'Nothing to commit.' }
      }
      if (
        paths.some((p) => typeof p !== 'string' || !resolveProjectPath([record.worktreePath], p))
      ) {
        return { ok: false, error: "A file is outside this session's worktree." }
      }
      const text = typeof message === 'string' ? message.trim() : ''
      if (!text) return { ok: false, error: 'Write a commit message first.' }
      const branch = await currentBranch(record)
      if (!branch) return { ok: false, error: "This session isn't on a branch of its own yet." }
      return commitPathsAndPush(record.worktreePath, branch, paths, text)
    }
  )

  // A draft pull request, out of draft: the branch's own by number, or one
  // in another repo by its GitHub address.
  ipcMain.handle('sessions:prReady', async (_evt, id: string, pr: number | string) => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { ok: false, error: 'Session not found.' }
    const byNumber = typeof pr === 'number' && Number.isInteger(pr) && pr > 0
    if (!byNumber && !isPullRequestUrl(pr)) return { ok: false, error: 'No pull request.' }
    const result = await markReadyForReview(record.worktreePath, pr)
    if (result.ok && typeof pr === 'string') forgetPullRequestDetails(pr)
    return result
  })

  // The rest of what the PR panel does to an open pull request. Same target
  // rules as prReady: this branch's own by number, any other by its address.
  const prTarget = (
    id: string,
    pr: unknown
  ): { cwd: string; pr: number | string } | { error: string } => {
    const record = getState().sessions.find((s) => s.id === id)
    if (!record) return { error: 'Session not found.' }
    const byNumber = typeof pr === 'number' && Number.isInteger(pr) && pr > 0
    if (!byNumber && !isPullRequestUrl(pr)) return { error: 'No pull request.' }
    return { cwd: record.worktreePath, pr: pr as number | string }
  }
  // ---- Chat view -----------------------------------------------------------
  // The conversation from the transcript, Claude's open prompts (held by the
  // hook server, engine/prompts.ts), and a message box that types into the
  // session's pane like the terminal would.
  const PANE_ID = /^%\d{1,6}$/
  const CLAUDE_ID = /^[A-Za-z0-9-]{8,64}$/
  ipcMain.handle('chat:transcript', (_evt, claudeSessionId: unknown) =>
    typeof claudeSessionId === 'string' && CLAUDE_ID.test(claudeSessionId)
      ? readChat(claudeSessionId)
      : null
  )
  ipcMain.handle('chat:send', async (_evt, paneId: unknown, text: unknown) => {
    if (typeof paneId !== 'string' || !PANE_ID.test(paneId))
      return { ok: false, error: 'No terminal.' }
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Nothing to send.' }
    return deliverPrompt(paneId, text.slice(0, 100_000))
  })
  ipcMain.handle('chat:interrupt', async (_evt, paneId: unknown) =>
    typeof paneId === 'string' && PANE_ID.test(paneId)
      ? interruptPane(paneId)
      : { ok: false, error: 'No terminal.' }
  )
  ipcMain.handle('prompts:list', () => listPrompts())
  ipcMain.handle('prompts:answer', (_evt, id: unknown, answer: unknown) => {
    const a = (answer ?? {}) as Record<string, unknown>
    if (typeof id !== 'string') return { ok: false, error: 'No prompt.' }
    let parsed: PromptAnswer | null = null
    if (a.kind === 'allow' || a.kind === 'allowAlways') parsed = { kind: a.kind }
    else if (a.kind === 'deny')
      parsed = {
        kind: 'deny',
        message: typeof a.message === 'string' ? a.message.slice(0, 2000) : undefined
      }
    else if (a.kind === 'approvePlan')
      parsed = { kind: 'approvePlan', mode: a.mode === 'acceptEdits' ? 'acceptEdits' : 'default' }
    else if (a.kind === 'answers' && a.answers && typeof a.answers === 'object')
      parsed = { kind: 'answers', answers: a.answers as Record<string, string> }
    if (!parsed) return { ok: false, error: 'Unknown answer.' }
    return answerPrompt(id, parsed)
  })
  setPromptsListener(() => {
    const prompts = listPrompts()
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send('prompts:changed', prompts)
  })
  setInterval(() => {
    if (listPrompts().length) sweepAnsweredPrompts()
  }, 1000).unref()

  // Types one of ASKS into the session's terminal, as if you had.
  ipcMain.handle('sessions:askClaude', async (_evt, id: string, ask: unknown) => {
    const prompt = typeof ask === 'string' ? ASKS[ask] : undefined
    if (!prompt) return { ok: false, error: 'nothing to ask' }
    const record = getState().sessions.find((s) => s.id === id)
    if (!record?.tmuxPaneId) return { ok: false, error: 'Claude isn’t running in this session' }
    return deliverPrompt(record.tmuxPaneId, prompt)
  })

  ipcMain.handle('sessions:prStatus', async (_evt, id: string, pr: unknown) => {
    const t = prTarget(id, pr)
    return 'error' in t ? { ok: false, error: t.error } : pullRequestStatus(t.cwd, t.pr)
  })
  ipcMain.handle('sessions:prDraft', async (_evt, id: string, pr: unknown) => {
    const t = prTarget(id, pr)
    if ('error' in t) return { ok: false, error: t.error }
    const result = await convertToDraft(t.cwd, t.pr)
    if (result.ok && typeof t.pr === 'string') forgetPullRequestDetails(t.pr)
    return result
  })
  ipcMain.handle(
    'sessions:prClose',
    async (_evt, id: string, pr: unknown, deleteBranch: boolean) => {
      const t = prTarget(id, pr)
      if ('error' in t) return { ok: false, error: t.error }
      const result = await closePullRequest(t.cwd, t.pr, deleteBranch === true)
      if (result.ok && typeof t.pr === 'string') forgetPullRequestDetails(t.pr)
      return result
    }
  )
  ipcMain.handle(
    'sessions:prMerge',
    async (_evt, id: string, pr: unknown, method: unknown, deleteBranch: boolean) => {
      const t = prTarget(id, pr)
      if ('error' in t) return { ok: false, error: t.error }
      if (method !== 'squash' && method !== 'merge' && method !== 'rebase')
        return { ok: false, error: 'No merge method.' }
      const result = await mergePullRequest(
        t.cwd,
        t.pr,
        method as MergeMethod,
        deleteBranch === true
      )
      if (result.ok && typeof t.pr === 'string') forgetPullRequestDetails(t.pr)
      return result
    }
  )

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
