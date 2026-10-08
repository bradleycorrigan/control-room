import { useEffect, useState } from 'react'
import {
  getAppSettings,
  getHooksStatus,
  installHooks,
  setAppSettings,
  uninstallHooks,
  type HooksStatus
} from '../api'
import type { AppSettings } from '../../../main/store/types'
import { SegmentedControl } from '../components/primitives'
import { TERMINAL_FONT_SIZES } from '../components/Terminal'
import type { ThemeController } from '../theme/ThemeProvider'
import { themes } from '../theme/themes'

interface SettingsScreenProps {
  theme: ThemeController
}

export default function SettingsScreen({ theme }: SettingsScreenProps): React.JSX.Element {
  const [status, setStatus] = useState<HooksStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    getHooksStatus().then(setStatus)
  }

  useEffect(() => {
    refresh()
    void getAppSettings().then(setSettings)
  }, [])

  // Writes through immediately — there is no Save on this screen, and a
  // setting that needs one would be the only thing here that does.
  const patchSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await setAppSettings(patch)
    setSettings(next)
  }

  const handleInstall = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await installHooks()
      if (!result.ok) setError(result.error ?? 'failed to install hooks')
    } catch {
      setError('failed to install hooks')
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const handleUninstall = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await uninstallHooks()
      if (!result.ok) setError(result.error ?? 'failed to uninstall hooks')
    } catch {
      setError('failed to uninstall hooks')
    } finally {
      setBusy(false)
      refresh()
    }
  }

  return (
    <div className="settings-screen">
      <div className="settings-screen-header">
        <h1 className="settings-screen-title">Settings</h1>
        <p className="settings-screen-caption">Theme and appearance for this window.</p>
      </div>

      {/* What a new session starts with. The composer's own picker still
          overrides it for one session; this is the value it starts from, which
          was hardcoded to Sonnet with nowhere to change it. */}
      <h2>Views</h2>
      {settings && (
        <div className="settings-defaults">
          <label className="settings-defaults-row">
            <span className="settings-defaults-label">Sessions</span>
            <SegmentedControl
              value={settings.sessionsView}
              onChange={(v) => void patchSettings({ sessionsView: v })}
              aria-label="Sessions opens as"
              options={[
                { value: 'list' as const, label: 'List' },
                { value: 'grid' as const, label: 'Grid' }
              ]}
            />
          </label>
          <label className="settings-defaults-row">
            <span className="settings-defaults-label">Tickets</span>
            <SegmentedControl
              value={settings.ticketsView}
              onChange={(v) => void patchSettings({ ticketsView: v })}
              aria-label="Tickets opens as"
              options={[
                { value: 'list' as const, label: 'List' },
                { value: 'board' as const, label: 'Board' }
              ]}
            />
          </label>
        </div>
      )}

      <h2>New sessions</h2>
      {settings && (
        <div className="settings-defaults">
          <label className="settings-defaults-row">
            <span className="settings-defaults-label">Model</span>
            <SegmentedControl
              value={settings.defaultModel}
              onChange={(v) => void patchSettings({ defaultModel: v })}
              aria-label="Default model"
              options={[
                { value: 'opus' as const, label: 'Opus' },
                { value: 'sonnet' as const, label: 'Sonnet' },
                { value: 'haiku' as const, label: 'Haiku' }
              ]}
            />
          </label>
          <label className="settings-defaults-row">
            <span className="settings-defaults-label">Thinking</span>
            <SegmentedControl
              value={settings.defaultEffort}
              onChange={(v) => void patchSettings({ defaultEffort: v })}
              aria-label="Default thinking level"
              options={[
                { value: 'low' as const, label: 'Low' },
                { value: 'medium' as const, label: 'Medium' },
                { value: 'high' as const, label: 'High' },
                { value: 'xhigh' as const, label: 'X-high' },
                { value: 'max' as const, label: 'Max' }
              ]}
            />
          </label>
        </div>
      )}

      <h2>Appearance</h2>

      {settings && (
        <div className="settings-defaults">
          <label className="settings-defaults-row">
            <span className="settings-defaults-label">Terminal text size</span>
            <SegmentedControl
              value={settings.terminalFontSize}
              onChange={(v) => void patchSettings({ terminalFontSize: v })}
              aria-label="Terminal text size"
              options={TERMINAL_FONT_SIZES.map((size) => ({
                value: size as number,
                label: `${size}px`
              }))}
            />
          </label>
          <label className="settings-defaults-row settings-gpu-row">
            <span className="settings-defaults-label">
              Draw the terminal with the GPU
              <span className="settings-note">
                Sharper block characters. Off by default: on some Macs the graphics process crashes,
                and the terminal shows a sad face until it recovers.
              </span>
            </span>
            <input
              type="checkbox"
              aria-label="Draw the terminal with the GPU"
              checked={settings.terminalGpu ?? false}
              onChange={(e) => void patchSettings({ terminalGpu: e.target.checked })}
            />
          </label>
        </div>
      )}

      <label className="settings-follow-system">
        <input
          type="checkbox"
          checked={theme.themeFollowsSystem}
          onChange={(e) => theme.setFollowsSystem(e.target.checked)}
        />
        Follow system light/dark setting
      </label>

      <div className="theme-swatch-list" role="radiogroup" aria-label="Theme">
        {themes.map((t) => {
          const selected = theme.themeId === t.id
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={theme.themeFollowsSystem}
              className={`theme-swatch-row${selected ? ' theme-swatch-row-selected' : ''}`}
              style={{
                background: t.surface,
                borderColor: selected ? t.accent : t.border,
                color: t.text
              }}
              onClick={() => theme.setTheme(t.id)}
              title={t.name}
            >
              <span className="theme-swatch-chip" style={{ background: t.bg }} />
              <span className="theme-swatch-chip" style={{ background: t.surface }} />
              <span
                className="theme-swatch-chip theme-swatch-chip-text"
                style={{ background: t.text }}
              />
              <span className="theme-swatch-chip" style={{ background: t.accent }} />
              <span className="theme-swatch-dots">
                <span className="theme-swatch-dot" style={{ background: t.status.working }} />
                <span className="theme-swatch-dot" style={{ background: t.status.attention }} />
                <span className="theme-swatch-dot" style={{ background: t.status.done }} />
                <span className="theme-swatch-dot" style={{ background: t.status.idle }} />
                <span className="theme-swatch-dot" style={{ background: t.status.error }} />
              </span>
              <span className="theme-swatch-name">{t.name}</span>
            </button>
          )
        })}
      </div>
      {theme.themeFollowsSystem && (
        <p className="settings-hint">
          Following the system setting: using a configured dark theme in dark mode and a light theme
          in light mode.
        </p>
      )}

      <h2>Hooks</h2>
      {!status ? (
        <p>Loading…</p>
      ) : (
        <>
          {/* Plain words first; the raw config is one click away for anyone
              who wants to see exactly what gets written. */}
          <p className="settings-hooks-state">
            {!status.boundPort
              ? "Control Room isn't listening for hook events right now, so statuses update from its 30-second check."
              : !status.hooksInstalled
                ? 'Off. Install hooks so statuses change the moment they happen, instead of waiting for Control Room to notice.'
                : status.missingHookEvents.length > 0
                  ? `Out of date: missing ${status.missingHookEvents.length} newer event${status.missingHookEvents.length === 1 ? '' : 's'}. Update to hear the moment a session starts, is prompted, or ends.`
                  : 'On. Claude Code tells Control Room the moment a session starts, works, finishes, asks you something, or ends.'}
          </p>
          {status.previewConfig && (
            <p className="settings-hooks-detail">
              Adds {Object.values(status.previewConfig).flat().length} hooks to
              ~/.claude/settings.json. The file is backed up first, and nothing else in it changes.
            </p>
          )}
          {status.previewConfig && (
            <details className="settings-hooks-details">
              <summary>Show exactly what gets written</summary>
              <p className="settings-hooks-detail">
                Hook server: 127.0.0.1:{status.boundPort}
                {status.hooksInstalledUrl ? ` · installed for ${status.hooksInstalledUrl}` : ''}
              </p>
              <pre className="settings-preview">
                {JSON.stringify(status.previewConfig, null, 2)}
              </pre>
            </details>
          )}

          {error && <p className="settings-error">{error}</p>}

          <div className="settings-actions">
            <button onClick={handleInstall} disabled={busy || !status.previewUrl}>
              {status.missingHookEvents.length > 0 ? 'Update hooks' : 'Install hooks'}
            </button>
            <button onClick={handleUninstall} disabled={busy || !status.hooksInstalled}>
              Uninstall hooks
            </button>
          </div>
        </>
      )}
    </div>
  )
}
