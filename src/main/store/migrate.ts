import type { StateFile, SchemaVersion } from './types'

const CURRENT_VERSION: SchemaVersion = 1

/**
 * Only schema version 1 has ever existed. When a future milestone bumps
 * SchemaVersion, add a case here rather than mutating StateFile in place.
 */
export function migrate(raw: unknown): StateFile {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<StateFile>

  // `ready` split out of `needs_attention` — a session finishing its turn used
  // to be reported as needing attention, and the two were notified as one. A
  // stored notifyOn predates the split, so anyone who had notifications on for
  // needs_attention keeps getting told when a session finishes, rather than
  // silently losing the notification they already asked for.
  const settings = obj.settings
  if (
    settings?.notifyOn &&
    settings.notifyOn.includes('needs_attention') &&
    !settings.notifyOn.includes('ready')
  ) {
    settings.notifyOn = [...settings.notifyOn, 'ready']
  }

  return {
    version: CURRENT_VERSION,
    projects: Array.isArray(obj.projects) ? obj.projects : [],
    sessions: Array.isArray(obj.sessions) ? obj.sessions : [],
    dismissedBackgroundAgentIds: Array.isArray(obj.dismissedBackgroundAgentIds)
      ? obj.dismissedBackgroundAgentIds
      : [],
    settings: {
      hookPort: 47821,
      pollIntervalMs: 2000,
      terminalApp: 'Ghostty',
      notifyOn: ['needs_attention', 'ready', 'done', 'errored'],
      hooksInstalled: false,
      hooksInstalledUrl: null,
      defaultModel: 'opus' as const,
      defaultEffort: 'medium' as const,
      terminalFontSize: 13,
      terminalGpu: false,
      theme: 'tokyo-night',
      themeFollowsSystem: false,
      sessionsView: 'list' as const,
      ticketsView: 'list' as const,
      ...(obj.settings ?? {})
    }
  }
}
