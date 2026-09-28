import { app } from 'electron'
import { run } from './run'
import type { PullRequestInfo } from './pullRequests'

/**
 * The ship flow's push-and-open-PR step (plan 7 step 3): `git push -u origin
 * <branch>` then `gh pr create`, both through run() (argv arrays, CLAUDE.md —
 * never a shell string). Generous timeouts: a push can be slow on a big
 * branch or a slow connection, and gh talks to the network too.
 */

export interface ShipResult {
  ok: boolean
  pr?: PullRequestInfo
  error?: string
}

export async function pushAndCreatePr(
  worktreePath: string,
  branch: string,
  title: string,
  body: string,
  draft: boolean
): Promise<ShipResult> {
  // The fixture has no GitHub remote — CR_SHIP_FIXTURE makes both steps
  // succeed with a fake PR, same convention as pullRequests.ts's
  // CR_PR_FIXTURE. Only ever honoured outside a packaged build.
  if (!app.isPackaged && process.env.CR_SHIP_FIXTURE) {
    return {
      ok: true,
      pr: {
        number: 99,
        url: 'https://github.com/example/fixture/pull/99',
        title,
        state: 'OPEN',
        isDraft: draft
      }
    }
  }

  const pushRes = await run('git', ['-C', worktreePath, 'push', '-u', 'origin', branch], {
    timeoutMs: 120_000
  })
  if (pushRes.code !== 0) {
    return { ok: false, error: pushRes.stderr.trim() || 'git push failed' }
  }

  const args = ['pr', 'create', '--title', title, '--body', body, '--head', branch]
  if (draft) args.push('--draft')
  const prRes = await run('gh', args, { cwd: worktreePath, timeoutMs: 60_000 })
  if (prRes.code !== 0) {
    return { ok: false, error: prRes.stderr.trim() || 'gh pr create failed' }
  }

  // `gh pr create` prints the new PR's URL as its last line of stdout.
  const url = prRes.stdout.trim().split('\n').filter(Boolean).pop()
  if (!url) return { ok: false, error: 'gh pr create did not report a PR URL' }
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? NaN)

  return {
    ok: true,
    pr: {
      number: Number.isFinite(number) ? number : 0,
      url,
      title,
      state: 'OPEN',
      isDraft: draft
    }
  }
}
