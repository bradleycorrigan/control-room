import { useEffect, useState } from 'react'
import { getJiraStatus, getSessionTicketLinks } from '../api'

/**
 * The Jira ticket a session is for: the one you linked it to, else a key from
 * one of your Jira projects in its title or branch. Null for every session
 * while Jira isn't set up.
 */
export function useTicketKeys(): (
  record: { id: string; title?: string | null; branch?: string | null } | null | undefined
) => string | null {
  const [links, setLinks] = useState<Record<string, string>>({})
  const [jiraProjects, setJiraProjects] = useState<string[]>([])

  useEffect(() => {
    let live = true
    void Promise.all([getJiraStatus(), getSessionTicketLinks()]).then(([status, l]) => {
      if (!live || !status.configured) return
      setJiraProjects(status.projects.map((p) => p.toUpperCase()))
      setLinks(l)
    })
    return () => {
      live = false
    }
  }, [])

  return (record) => {
    if (!record) return null
    if (links[record.id]) return links[record.id]
    if (jiraProjects.length === 0) return null
    return (
      `${record.title ?? ''} ${record.branch ?? ''}`
        .toUpperCase()
        .match(/\b[A-Z][A-Z0-9]+-\d+\b/g)
        ?.find((k) => jiraProjects.includes(k.split('-')[0])) ?? null
    )
  }
}
