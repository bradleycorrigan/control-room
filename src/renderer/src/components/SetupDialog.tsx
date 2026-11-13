import { useEffect, useState } from 'react'
import {
  checkSetupTools,
  copyText,
  getAppSettings,
  getHooksStatus,
  installHooks,
  setAppSettings,
  type HooksStatus,
  type ToolCheck
} from '../api'
import type { AppSettings } from '../../../main/store/types'
import { EditorPicker } from './EditorPicker'
import { Button, IconButton, Modal, Row, StatusDot, Step, Steps } from './primitives'
import './setup-dialog.css'

/** How to install each tool sessions need, as one line to paste in a terminal. */
const INSTALL: Record<string, { why: string; command: string }> = {
  tmux: { why: 'Every session runs in a tmux window.', command: 'brew install tmux' },
  git: { why: 'Each session gets its own worktree and branch.', command: 'xcode-select --install' },
  claude: {
    why: 'The agent itself.',
    command: 'curl -fsSL https://claude.ai/install.sh | bash'
  }
}

/**
 * First launch, and "Set up Control Room" in the ⋯ menu: the three things a
 * new Mac needs before sessions work well. Closing it, by Done or the ×,
 * counts as set up: it doesn't come back on its own, and everything in it is
 * also in Settings.
 */
export function SetupDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [tools, setTools] = useState<ToolCheck[] | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [hooks, setHooks] = useState<HooksStatus | null>(null)
  const [hooksBusy, setHooksBusy] = useState(false)
  const [hooksError, setHooksError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const checkTools = (): void => {
    void checkSetupTools().then((all) => setTools(all.filter((t) => !t.optional)))
  }
  useEffect(() => {
    checkTools()
    void getAppSettings().then(setSettings)
    void getHooksStatus().then(setHooks)
  }, [])

  const finish = (): void => {
    void setAppSettings({ setupCompletedAt: Date.now() })
    onClose()
  }

  const missing = tools?.filter((t) => !t.found) ?? []
  const hooksOn = hooks?.hooksInstalled && hooks.missingHookEvents.length === 0

  return (
    <Modal title="Set up Control Room" icon="Settings2" width={760} onClose={finish}>
      <div className="setup-dialog">
        <Steps>
          <Step
            number={1}
            title="Tools"
            note="Control Room runs each session with these. Install anything missing, then check again."
          >
            {!tools ? (
              <p className="setup-dialog-note">Checking…</p>
            ) : (
              <ul className="setup-tools" aria-label="Tools">
                {tools.map((t) => (
                  <li key={t.name} className="setup-tool">
                    <Row gap={8} align="center">
                      <span className="setup-tool-name">{t.name}</span>
                      <ToolState found={t.found} />
                    </Row>
                    {!t.found && INSTALL[t.name] && (
                      <>
                        <span className="setup-dialog-note">{INSTALL[t.name].why}</span>
                        <Row gap={4} align="center" className="setup-tool-command">
                          <code>{INSTALL[t.name].command}</code>
                          <IconButton
                            icon={copied === t.name ? 'Check' : 'Copy'}
                            label="Copy command"
                            size={28}
                            variant="ghost"
                            onClick={() =>
                              void copyText(INSTALL[t.name].command).then((r) => {
                                if (r.ok) setCopied(t.name)
                              })
                            }
                          />
                        </Row>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {missing.length > 0 && (
              <div>
                <Button variant="outlined" size="compact" onClick={checkTools}>
                  Check again
                </Button>
              </div>
            )}
          </Step>

          <Step
            number={2}
            title="Editor"
            note="Where “Open in …” opens a session’s worktree. You can change it in Settings."
          >
            {settings && (
              <EditorPicker
                editor={settings.editor}
                editorCommand={settings.editorCommand}
                onChange={(patch) => void setAppSettings(patch).then(setSettings)}
              />
            )}
          </Step>

          <Step
            number={3}
            title="Claude hooks"
            note="Let Claude Code tell Control Room the moment a session needs you. Without them, statuses update every 30 seconds."
          >
            {!hooks ? (
              <p className="setup-dialog-note">Checking…</p>
            ) : hooksOn ? (
              <ToolState found />
            ) : (
              <>
                <p className="setup-dialog-note">
                  Adds hooks to ~/.claude/settings.json. The file is backed up first, and nothing
                  else in it changes.
                </p>
                {hooksError && <p className="settings-error">{hooksError}</p>}
                <div>
                  <Button
                    variant="outlined"
                    size="compact"
                    disabled={hooksBusy || !hooks.previewUrl}
                    onClick={() => {
                      setHooksBusy(true)
                      setHooksError(null)
                      void installHooks()
                        .then((r) => {
                          if (!r.ok) setHooksError(r.error ?? 'Couldn’t install hooks.')
                        })
                        .finally(() => {
                          setHooksBusy(false)
                          void getHooksStatus().then(setHooks)
                        })
                    }}
                  >
                    {hooksBusy
                      ? 'Installing…'
                      : hooks.hooksInstalled
                        ? 'Update hooks'
                        : 'Install hooks'}
                  </Button>
                </div>
              </>
            )}
          </Step>
        </Steps>

        <Row gap={8} justify="flex-end">
          <Button variant="filled" onClick={finish}>
            Done
          </Button>
        </Row>
      </div>
    </Modal>
  )
}

/** Installed or not: a dot and a word, never colour alone. */
function ToolState({ found }: { found: boolean }): React.JSX.Element {
  return (
    <span className="setup-tool-state">
      <StatusDot status={found ? 'done' : 'errored'} size={8} />
      {found ? 'Installed' : 'Not found'}
    </span>
  )
}
