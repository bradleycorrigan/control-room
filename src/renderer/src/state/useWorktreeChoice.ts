import { useCallback, useEffect, useState } from 'react'

/**
 * Shared so both composers remember the same answer. They used to disagree
 * about this outright: the New session sheet defaulted to no worktree, the
 * project's own composer always made one, and neither said which it was
 * doing. Same key, same control, same wording, wherever you start from.
 */
const STORAGE_KEY = 'homescreen-worktree-mode-v2'

/**
 * Reads and writes the "start on a new worktree" preference.
 *
 * Off by default. Turning it on means a real `git fetch`, `worktree add` and
 * the project's setup command before the agent says anything, which is a slow
 * start to hand someone who just wanted to ask a question.
 */
export function useWorktreeChoice(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved !== null ? (JSON.parse(saved) as boolean) : false
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(on))
    } catch {
      // Private window or blocked site data — the preference just won't stick.
    }
  }, [on])

  return [on, useCallback((next: boolean) => setOn(next), [])]
}
