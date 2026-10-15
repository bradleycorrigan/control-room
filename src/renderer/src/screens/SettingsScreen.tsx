import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  copyText,
  getAppSettings,
  getDevContainerCommandStatus,
  getHooksStatus,
  installHooks,
  setAppSettings,
  uninstallHooks,
  type HooksStatus
} from '../api'
import type { AppSettings } from '../../../main/store/types'
import {
  Button,
  Card,
  Disclosure,
  Icon,
  SegmentedControl,
  Switch,
  type IconName
} from '../components/primitives'
import { DEFAULT_DEV_CONTAINER_RUN, DEFAULT_DEV_CONTAINER_UP } from '../../../main/store/migrate'
import { TERMINAL_FONT_SIZES } from '../components/Terminal'
import { useStoredState } from '../state/useStoredState'
import type { ThemeController } from '../theme/ThemeProvider'
import { themes } from '../theme/themes'
import './settings.css'

interface SettingsScreenProps {
  theme: ThemeController
}

type SectionId = 'views' | 'sessions' | 'containers' | 'appearance' | 'hooks'

const SECTIONS: Array<{ id: SectionId; label: string; icon: IconName; blurb: string }> = [
  {
    id: 'views',
    label: 'Views',
    icon: 'LayoutGrid',
    blurb: 'How Sessions and Tickets look when you open them.'
  },
  {
    id: 'sessions',
    label: 'New sessions',
    icon: 'CirclePlay',
    blurb: 'What a new session starts with. The composer can still change it for one session.'
  },
  {
    id: 'containers',
    label: 'Dev containers',
    icon: 'Container',
    blurb: 'Run agents inside a dev container instead of on this Mac.'
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'Palette',
    blurb: 'The terminal and the colours of this window.'
  },
  {
    id: 'hooks',
    label: 'Hooks',
    icon: 'Webhook',
    blurb: 'Let Claude Code tell Control Room the moment a session changes.'
  }
]

export default function SettingsScreen({ theme }: SettingsScreenProps): React.JSX.Element {
  const [status, setStatus] = useState<HooksStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [devStatus, setDevStatus] = useState<string | null>(null)
  const [stored, setSection] = useStoredState<SectionId>('settings-section', 'views')
  const [themesOpen, setThemesOpen] = useState(false)
  const section = SECTIONS.find((s) => s.id === stored) ?? SECTIONS[0]

  const refresh = (): void => {
    getHooksStatus().then(setStatus)
  }

  useEffect(() => {
    refresh()
    void getAppSettings().then(setSettings)
  }, [])

  // Whether the dev container button can show, judged by the CLI and command
  // only (not one project). Asked again whenever one of these settings changes.
  const settingsLoaded = settings !== null
  const devUp = settings?.devContainerUpCommand
  const devRun = settings?.devContainerRunCommand
  const devNeedsConfig = settings?.devContainerNeedsConfig
  useEffect(() => {
    if (!settingsLoaded) return
    let live = true
    getDevContainerCommandStatus()
      .then((result) => {
        if (!live) return
        setDevStatus(
          result.missing
            ? `Not available: ${result.missing} isn't installed or isn't on your PATH.`
            : `Ready. The dev container toggle shows in the composer${devNeedsConfig ? ' for projects with a devcontainer.json' : ''}.`
        )
      })
      .catch(() => {
        if (live) setDevStatus('Not available: the check failed.')
      })
    return () => {
      live = false
    }
  }, [settingsLoaded, devUp, devRun, devNeedsConfig])

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

  const current = themes.find((t) => t.id === theme.themeId)

  return (
    <div className="settings-layout">
      <Card level="floating" className="sidebar-column settings-sidebar">
        <nav className="projects-rail" aria-label="Settings sections">
          <div className="projects-rail-header">
            <h2 className="projects-rail-title">Settings</h2>
          </div>
          <div className="projects-rail-items settings-rail-items">
            {SECTIONS.map((s) => {
              const selected = s.id === section.id
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`projects-rail-item${selected ? ' projects-rail-item-selected' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => setSection(s.id)}
                >
                  <span className="projects-rail-label-wrapper">
                    <span className="backlog-sidebar-icon">
                      <Icon name={s.icon} size={16} />
                    </span>
                    <span className="projects-rail-label">{s.label}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </nav>
      </Card>

      <div className="settings-main">
        <div className="settings-page" key={section.id}>
          <header className="settings-page-header">
            <h1 className="settings-page-title">{section.label}</h1>
            <p className="settings-page-caption">{section.blurb}</p>
          </header>

          {section.id === 'views' && settings && (
            <Card className="settings-group">
              <Item label="Sessions">
                <SegmentedControl
                  value={settings.sessionsView}
                  onChange={(v) => void patchSettings({ sessionsView: v })}
                  aria-label="Sessions opens as"
                  options={[
                    { value: 'list' as const, label: 'List' },
                    { value: 'grid' as const, label: 'Grid' }
                  ]}
                />
              </Item>
              <Item label="Tickets">
                <SegmentedControl
                  value={settings.ticketsView}
                  onChange={(v) => void patchSettings({ ticketsView: v })}
                  aria-label="Tickets opens as"
                  options={[
                    { value: 'list' as const, label: 'List' },
                    { value: 'board' as const, label: 'Board' }
                  ]}
                />
              </Item>
            </Card>
          )}

          {/* What a new session starts with. The composer's own picker still
              overrides it for one session; this is the value it starts from. */}
          {section.id === 'sessions' && settings && (
            <Card className="settings-group">
              <Item label="Model">
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
              </Item>
              <Item label="Thinking">
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
              </Item>
            </Card>
          )}

          {/* Dev containers: the toggle in the composer only shows where it can
              work, so these settings are all there is to it. */}
          {section.id === 'containers' && settings && (
            <Card className="settings-group" data-settings-dev-containers>
              {devStatus && (
                <p className="settings-item settings-status" data-settings-dev-status>
                  {devStatus}
                </p>
              )}
              <Item
                as="label"
                label="Start sessions in a dev container"
                note="Turns the dev container toggle on for new sessions. You can still switch it off per session."
              >
                <Switch
                  aria-label="Start sessions in a dev container"
                  checked={settings.devContainerByDefault}
                  onChange={(e) => void patchSettings({ devContainerByDefault: e.target.checked })}
                />
              </Item>
              <CommandSetting
                label="Command that starts the agent"
                note="Runs in the session's terminal. {folder} is the session's folder. {agent} is the Claude command."
                value={settings.devContainerRunCommand}
                fallback={DEFAULT_DEV_CONTAINER_RUN}
                onSave={(v) => void patchSettings({ devContainerRunCommand: v })}
              />
              <CommandSetting
                label="Command to run first (optional)"
                note="Runs before the command above. Leave it empty if that command starts the container itself."
                value={settings.devContainerUpCommand}
                fallback={DEFAULT_DEV_CONTAINER_UP}
                allowEmpty
                onSave={(v) => void patchSettings({ devContainerUpCommand: v })}
              />
              <Item
                as="label"
                label="Only for projects with a devcontainer.json"
                note="Turn this off if you start containers with your own script."
              >
                <Switch
                  aria-label="Only for projects with a devcontainer.json"
                  checked={settings.devContainerNeedsConfig}
                  onChange={(e) =>
                    void patchSettings({ devContainerNeedsConfig: e.target.checked })
                  }
                />
              </Item>
              <CommandSetting
                label="This Mac's address from inside a container"
                note="Lets the agent in the container tell Control Room what it's doing. host.docker.internal works with Docker Desktop and OrbStack."
                value={settings.devContainerHookHost}
                fallback="host.docker.internal"
                onSave={(v) => void patchSettings({ devContainerHookHost: v })}
              />
            </Card>
          )}

          {section.id === 'appearance' && (
            <>
              {settings && (
                <Card className="settings-group">
                  <Item label="Terminal text size">
                    <SegmentedControl
                      value={settings.terminalFontSize}
                      onChange={(v) => void patchSettings({ terminalFontSize: v })}
                      aria-label="Terminal text size"
                      options={TERMINAL_FONT_SIZES.map((size) => ({
                        value: size as number,
                        label: `${size}px`
                      }))}
                    />
                  </Item>
                  <Item
                    as="label"
                    label="Draw the terminal with the GPU"
                    note="Sharper block characters. Off by default: on some Macs the graphics process crashes, and the terminal shows a sad face until it recovers."
                  >
                    <Switch
                      aria-label="Draw the terminal with the GPU"
                      checked={settings.terminalGpu ?? false}
                      onChange={(e) => void patchSettings({ terminalGpu: e.target.checked })}
                    />
                  </Item>
                  <CommandSetting
                    label="Terminal app"
                    note="Focus terminal brings this app to the front. Use the name you see in /Applications, like Terminal, iTerm or Ghostty."
                    value={settings.terminalApp}
                    fallback="Terminal"
                    onSave={(v) => void patchSettings({ terminalApp: v })}
                  />
                </Card>
              )}

              <Card className="settings-group">
                <Item
                  as="label"
                  label="Follow system light/dark setting"
                  note={
                    theme.themeFollowsSystem
                      ? 'Using a configured dark theme in dark mode and a light theme in light mode.'
                      : 'Switch between a dark and a light theme when macOS does.'
                  }
                >
                  <Switch
                    aria-label="Follow system light/dark setting"
                    checked={theme.themeFollowsSystem}
                    onChange={(e) => theme.setFollowsSystem(e.target.checked)}
                  />
                </Item>
                <div className="settings-item settings-item--disclosure">
                  <Disclosure
                    label="Theme"
                    hint={
                      current && (
                        <span className="settings-theme-hint">
                          <span
                            className="settings-theme-hint-chip"
                            style={{ background: current.surface, borderColor: current.border }}
                          >
                            <span style={{ background: current.accent }} />
                          </span>
                          {current.name}
                        </span>
                      )
                    }
                    open={themesOpen}
                    onToggle={setThemesOpen}
                  >
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
                              boxShadow: selected ? `inset 0 0 0 1px ${t.accent}` : undefined,
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
                              <span
                                className="theme-swatch-dot"
                                style={{ background: t.status.working }}
                              />
                              <span
                                className="theme-swatch-dot"
                                style={{ background: t.status.attention }}
                              />
                              <span
                                className="theme-swatch-dot"
                                style={{ background: t.status.done }}
                              />
                              <span
                                className="theme-swatch-dot"
                                style={{ background: t.status.idle }}
                              />
                              <span
                                className="theme-swatch-dot"
                                style={{ background: t.status.error }}
                              />
                            </span>
                            <span className="theme-swatch-name">{t.name}</span>
                          </button>
                        )
                      })}
                    </div>
                  </Disclosure>
                </div>
              </Card>
            </>
          )}

          {section.id === 'hooks' &&
            (!status ? (
              <p className="settings-hooks-detail">Loading…</p>
            ) : (
              <Card className="settings-group">
                {/* Plain words first; the raw config is one click away for
                    anyone who wants to see exactly what gets written. */}
                <div className="settings-item settings-item--prose">
                  <p className="settings-hooks-state">
                    {!status.boundPort
                      ? "Control Room isn't listening for hook events right now, so statuses update from its 30-second check."
                      : !status.hooksInstalled
                        ? 'Off. Install hooks so statuses change the moment they happen, instead of waiting for Control Room to notice.'
                        : status.missingHookEvents.length > 0
                          ? 'Out of date. Update so Control Room hears the moment a session starts, is prompted or ends, including agents in dev containers.'
                          : 'On. Claude Code tells Control Room the moment a session starts, works, finishes, asks you something, or ends.'}
                  </p>
                  {status.previewConfig && (
                    <p className="settings-hooks-detail">
                      Adds {Object.values(status.previewConfig).flat().length} hooks to
                      ~/.claude/settings.json. The file is backed up first, and nothing else in it
                      changes.
                    </p>
                  )}
                  {status.previewConfig && (
                    <details className="settings-hooks-details">
                      <summary>Show exactly what gets written</summary>
                      <p className="settings-hooks-detail">
                        Hook server: 127.0.0.1:{status.boundPort}
                        {status.hooksInstalledUrl
                          ? ` · installed for ${status.hooksInstalledUrl}`
                          : ''}
                      </p>
                      <pre className="settings-preview">
                        {JSON.stringify(status.previewConfig, null, 2)}
                      </pre>
                    </details>
                  )}
                  {error && <p className="settings-error">{error}</p>}
                  <div className="settings-actions">
                    <Button onClick={handleInstall} disabled={busy || !status.previewUrl}>
                      {status.missingHookEvents.length > 0 ? 'Update hooks' : 'Install hooks'}
                    </Button>
                    <Button onClick={handleUninstall} disabled={busy || !status.hooksInstalled}>
                      Uninstall hooks
                    </Button>
                  </div>
                </div>

                <div className="settings-item settings-item--prose">
                  <p className="settings-hooks-detail" data-settings-container-hooks>
                    Hooks are optional. Without them, statuses still update, from a check every 30
                    seconds. Agents in a dev container that shares this Mac&rsquo;s ~/.claude get
                    the hooks from here too. For a container with its own ~/.claude, copy the dev
                    container hooks into its settings.json.
                  </p>
                  {notice && <p className="settings-hooks-detail">{notice}</p>}
                  <div className="settings-actions">
                    <Button
                      onClick={() => {
                        void copyText(
                          JSON.stringify({ hooks: status.containerConfig }, null, 2)
                        ).then((r) =>
                          setNotice(
                            r.ok
                              ? 'Copied. Paste it into the container’s ~/.claude/settings.json.'
                              : (r.error ?? 'Could not copy.')
                          )
                        )
                      }}
                    >
                      Copy dev container hooks
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One setting in a group: label and note on the left, the control on the
 * right. Rows are told apart by a hairline, so a group is one card, not many.
 * A switch row is a `<label>`, which makes the whole row the click target.
 */
function Item({
  label,
  note,
  as: Tag = 'div',
  children
}: {
  label: string
  note?: string
  as?: 'div' | 'label'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tag className="settings-item">
      <span className="settings-item-text">
        <span className="settings-item-label">{label}</span>
        {note && <span className="settings-item-note">{note}</span>}
      </span>
      <span className="settings-item-control">{children}</span>
    </Tag>
  )
}

/**
 * One line of text, saved when you leave the box (this screen has no Save).
 * Empty goes back to the default, unless `allowEmpty`; Reset shows only once
 * the value differs from the default.
 */
function CommandSetting({
  label,
  note,
  value,
  fallback,
  allowEmpty = false,
  onSave
}: {
  label: string
  note: string
  value: string
  fallback: string
  allowEmpty?: boolean
  onSave: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  // A save from elsewhere (Reset, another window) replaces what's shown.
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setDraft(value)
  }
  const save = (): void => {
    const next = draft.trim() || (allowEmpty ? '' : fallback)
    setDraft(next)
    if (next !== value) onSave(next)
  }
  // The box grows to show the whole command, wrapped, instead of hiding its end.
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el) return
    el.style.height = 'auto'
    // scrollHeight leaves out the border, so add back the border's height.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [draft])
  return (
    <div className="settings-item settings-item--stack">
      <span className="settings-item-text">
        <span className="settings-item-label">{label}</span>
        <span className="settings-item-note">{note}</span>
      </span>
      <span className="settings-command-field">
        <textarea
          ref={fieldRef}
          aria-label={label}
          className="cr-textarea settings-command-input"
          rows={1}
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            // A command is one line: Enter saves, and never adds a newline.
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
        />
        {value !== fallback && (
          <Button variant="ghost" size="compact" onClick={() => onSave(fallback)}>
            Reset
          </Button>
        )}
      </span>
    </div>
  )
}
