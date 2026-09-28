// Display-only path formatting. Never used for anything the app acts on —
// the renderer still sends ids/paths it got from main, it just formats them
// for reading.

/**
 * Swaps a leading home-directory prefix for "~", the way a shell would.
 * `homeDir` is optional because it comes over IPC — callers get the plain
 * path back before it resolves.
 */
export function formatHomePath(path: string, homeDir: string | null): string {
  if (!homeDir) return path
  if (path === homeDir) return '~'
  if (path.startsWith(`${homeDir}/`)) return `~${path.slice(homeDir.length)}`
  return path
}
