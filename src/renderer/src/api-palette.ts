import type { QuickIssue, JiraResult } from '../../main/exec/jira'

// The palette's own window.api calls — see api.ts for the convention this
// follows (the renderer sends ids and short strings, never paths it acts on).

export function findTicket(key: string): Promise<JiraResult<QuickIssue>> {
  return window.api.invoke<JiraResult<QuickIssue>>('palette:findTicket', key)
}

// Branches: reuses the existing `git:checkoutBranches` channel (git.ts via
// ipc.ts) rather than adding a second one — same data the New session
// composer's branch picker already fetches.
export type { CheckoutBranch } from '../../main/exec/git'

export function listCheckoutBranches(
  projectId: string
): Promise<import('../../main/exec/git').CheckoutBranch[]> {
  return window.api.invoke<import('../../main/exec/git').CheckoutBranch[]>(
    'git:checkoutBranches',
    projectId
  )
}
