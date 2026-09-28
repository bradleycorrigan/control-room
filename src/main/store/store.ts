import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  appendFileSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { log } from '../log'
import { migrate } from './migrate'
import type { AppSettings, Project, StateFile } from './types'

// Built-in project (plan 7, B1) for chats that aren't about any registered
// project — home screen sessions with no project chosen land here. Not a new
// concept: it's an ordinary Project row, seeded once, whose sessions are
// always created with `investigate: true` (no worktree, no branch, runs
// directly in repoPath). repoPath is the user's home directory, which is not
// necessarily a git repo — General is seeded directly here rather than
// through projects:add/findMainCheckout, so it never goes through that
// validation.
export const GENERAL_PROJECT_ID = 'general'

function ensureGeneralProject(): void {
  const draft = getState()
  if (draft.projects.some((p) => p.id === GENERAL_PROJECT_ID)) return
  const repoPath = homedir()
  draft.projects.push({
    id: GENERAL_PROJECT_ID,
    name: 'General',
    repoPath,
    // Unused in practice — General's sessions are always investigate-mode
    // (no worktree ever gets created) — kept populated only so this Project
    // satisfies the same shape as every other one.
    worktreeRoot: `${repoPath}/.control-room-general.worktrees`,
    workspacesDir: `${repoPath}/.control-room-general.worktrees/.workspaces`,
    baseRef: 'origin/main',
    tmuxSession: 'wt',
    agentCommand: 'claude',
    addedAt: Date.now(),
    pinned: true
  })
  scheduleSave()
}

const SAVE_DEBOUNCE_MS = 200
const EVENTS_MAX_BYTES = 5 * 1024 * 1024

let dataDir: string | null = null
let statePath: string | null = null
let backupPath: string | null = null

let state: StateFile | null = null
let saveTimer: NodeJS.Timeout | null = null

function paths(): { dataDir: string; statePath: string; backupPath: string } {
  if (!dataDir || !statePath || !backupPath) {
    dataDir = app.getPath('userData')
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    statePath = join(dataDir, 'state.json')
    backupPath = join(dataDir, 'state.json.bak')
  }
  return { dataDir, statePath, backupPath }
}

function emptyState(): StateFile {
  return migrate({})
}

function tryParseFile(path: string): StateFile | null {
  if (!existsSync(path)) return null
  try {
    return migrate(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    log.error('store: failed to parse file', { path, error: String(err) })
    return null
  }
}

/** Load once at startup. Never throws — corrupt state degrades to backup, then empty. */
export function load(): StateFile {
  const { statePath, backupPath } = paths()

  let parsed: StateFile | null = null

  if (existsSync(statePath)) {
    try {
      parsed = migrate(JSON.parse(readFileSync(statePath, 'utf8')))
    } catch (err) {
      const corruptPath = `${statePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try {
        renameSync(statePath, corruptPath)
        log.error('store: state.json did not parse, quarantined', {
          corruptPath,
          error: String(err)
        })
      } catch (renameErr) {
        log.error('store: failed to quarantine corrupt state.json', { error: String(renameErr) })
      }
    }
  }

  if (!parsed) {
    parsed = tryParseFile(backupPath)
    if (parsed) log.warn('store: recovered state from state.json.bak')
  }

  if (!parsed) {
    parsed = emptyState()
    log.warn('store: starting with empty state')
  }

  state = parsed
  ensureGeneralProject()
  return state
}

function persist(): void {
  if (!state) return
  const { statePath, backupPath } = paths()

  try {
    if (existsSync(statePath)) copyFileSync(statePath, backupPath)
  } catch (err) {
    log.error('store: failed to write state.json.bak', { error: String(err) })
  }

  const tmpPath = `${statePath}.tmp-${process.pid}`
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2))
    renameSync(tmpPath, statePath)
  } catch (err) {
    log.error('store: failed to persist state.json', { error: String(err) })
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persist()
  }, SAVE_DEBOUNCE_MS)
}

/** Call on app quit so the last mutation is not lost to the debounce window. */
export function flushPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  persist()
}

export function getState(): StateFile {
  if (!state) throw new Error('store: getState() called before load()')
  return state
}

/** All mutations go through here so every write gets (debounce-)persisted. */
export function mutate<T>(fn: (draft: StateFile) => T): T {
  const result = fn(getState())
  scheduleSave()
  return result
}

export function addProject(
  input: Pick<
    Project,
    | 'name'
    | 'repoPath'
    | 'worktreeRoot'
    | 'workspacesDir'
    | 'baseRef'
    | 'tmuxSession'
    | 'agentCommand'
  >
): Project {
  const project: Project = {
    id: randomUUID(),
    addedAt: Date.now(),
    ...input
  }
  mutate((draft) => {
    draft.projects.push(project)
  })
  return project
}

export function removeProject(id: string): void {
  mutate((draft) => {
    draft.projects = draft.projects.filter((p) => p.id !== id)
  })
}

// Projects list row actions (rename, pin). Never touches anything on disk —
// this only edits Control Room's own state.json.
export function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'pinned' | 'baseRef' | 'agentCommand' | 'setupCommand'>>
): Project | null {
  return mutate((draft) => {
    const project = draft.projects.find((p) => p.id === id)
    if (!project) return null
    Object.assign(project, patch)
    return project
  })
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  return mutate((draft) => {
    draft.settings = { ...draft.settings, ...patch }
    return draft.settings
  })
}

/** Append-only hook/status event log, rotated at 5 MB. */
/**
 * Per-session read state (engine/seen.ts). Its own file rather than a field on
 * StateFile: it changes every time a session is opened, and has no business
 * going through the state file's schema versions and backups.
 */
export function readSeenFile(): unknown {
  const path = join(paths().dataDir, 'seen.json')
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch (err) {
    log.error('store: failed to read seen.json', { error: String(err) })
    return null
  }
}

export function writeSeenFile(data: unknown): void {
  try {
    writeFileSync(join(paths().dataDir, 'seen.json'), JSON.stringify(data))
  } catch (err) {
    log.error('store: failed to write seen.json', { error: String(err) })
  }
}

export function appendEvent(event: unknown): void {
  const { dataDir } = paths()
  const eventsPath = join(dataDir, 'events.jsonl')
  try {
    if (existsSync(eventsPath) && statSync(eventsPath).size > EVENTS_MAX_BYTES) {
      try {
        renameSync(eventsPath, `${eventsPath}.1`)
      } catch (err) {
        log.error('store: failed to rotate events.jsonl', { error: String(err) })
      }
    }
    appendFileSync(eventsPath, JSON.stringify(event) + '\n')
  } catch (err) {
    log.error('store: failed to append event', { error: String(err) })
  }
}
