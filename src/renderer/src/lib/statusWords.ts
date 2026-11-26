import type { SessionStatus } from '../../../main/store/types'

// Short human words, not the raw enum values — this is the one place every
// SessionStatus in src/main/store/types.ts gets mapped to what a person reads.
export const STATUS_WORDS: Record<SessionStatus, string> = {
  working: 'working',
  // The pair people could not tell apart. "needs you" and "ready for you"
  // both said "you"; the difference is that one is blocked on an answer and
  // the other has simply finished and stopped.
  needs_attention: 'needs an answer',
  ready: 'your turn',
  // See status.ts rule 9. Claude Code reports `idle` for a session sitting at
  // its prompt, which is every session that has finished its turn — including
  // one that just asked you a question. "Idle" is its word for the process,
  // not a description of what you are looking at.
  done: 'done',
  idle: 'your turn',
  shell: 'shell',
  errored: 'errored',
  stopped: 'stopped',
  missing: 'missing',
  unknown: 'unknown',
  external: 'another terminal'
}

/** The word a person reads for a status: "needs an answer", "your turn". */
export function statusWord(status: SessionStatus): string {
  return STATUS_WORDS[status]
}
