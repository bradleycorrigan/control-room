/**
 * Preconditions for session actions (Part 5 of plan 4).
 * Every disabled control in the renderer references one of these constants,
 * never a literal true/false or TODO string.
 *
 * Part 4 actions and their preconditions:
 * - Open in IDE: WORKTREE_EXISTS
 * - Focus terminal: TERMINAL_REACHABLE
 * - Resume: LIFECYCLE_ACTIVE + ATTACH_LOCK_FREE
 * - Diff: WORKTREE_EXISTS
 * - Rename: (always available)
 * - Copy worktree path: WORKTREE_EXISTS
 * - Copy attach command: TERMINAL_REACHABLE
 * - Archive: NOT_LIVE
 * - Delete: (always available)
 */

export const SESSION_EXISTS = 'session-exists' as const
export const WORKTREE_EXISTS = 'worktree-exists' as const
export const TERMINAL_REACHABLE = 'terminal-reachable' as const
export const LIFECYCLE_ACTIVE = 'lifecycle-active' as const
export const ATTACH_LOCK_FREE = 'attach-lock-free' as const
export const NOT_LIVE = 'not-live' as const
export const WORKTREE_NOT_DIRTY = 'worktree-not-dirty' as const
