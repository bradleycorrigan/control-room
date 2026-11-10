import type { LinkedPullRequest } from '../../../main/exec/pullRequests'

/**
 * Which pull request panel a session opens with: `branch` is the session's own
 * branch (its PR with every option, or the form to open one); `linked` is a PR
 * the agent opened elsewhere.
 */
export type PrPanelTarget = { kind: 'branch' } | { kind: 'linked'; pr: LinkedPullRequest }
