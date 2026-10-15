import type { JiraIssue, JiraResult } from '../../main/exec/jira'

// New renderer wrappers for the backlog round. Existing Jira calls live in
// api.ts; only what's added here goes in this file (see CLAUDE.md).

/** Creates a sub-task under `parentKey`, in the given project. */
export function createJiraSubtask(
  project: string,
  parentKey: string,
  summary: string
): Promise<JiraResult<JiraIssue>> {
  return window.api.invoke<JiraResult<JiraIssue>>(
    'backlog:createSubtask',
    project,
    parentKey,
    summary
  )
}
