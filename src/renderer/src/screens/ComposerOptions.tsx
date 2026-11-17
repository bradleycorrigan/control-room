import { useEffect, useRef, useState } from 'react'
import { Icon, IconButton, Pill, Popover, type IconName } from '../components/primitives'

/** One on/off setting for the session about to start. */
export interface ComposerToggle {
  key: string
  label: string
  /** What on means, for the row's tooltip. */
  hint: string
  icon: IconName
  on: boolean
  set: (on: boolean) => void
}

/** A pick-one setting, opened as a list of its own. */
export interface ComposerChoice<T extends string = string> {
  key: string
  label: string
  value: T
  options: { value: T; label: string }[]
  set: (v: T) => void
}

/**
 * The new-session box's settings in one menu: the model and its thinking
 * level, each opening its own list, then the on/off ones (plan mode, start in
 * background, dev container). Whatever is switched on also shows as a chip
 * beside the button, so a session never starts in a mode you can't see; a
 * chip's click turns it off.
 */
export function ComposerOptions({
  choices,
  toggles
}: {
  choices: ComposerChoice[]
  toggles: ComposerToggle[]
}): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // Which list is showing: the menu itself, or one choice's options.
  const [step, setStep] = useState<string | null>(null)
  const cameFrom = useRef<string | null>(null)
  const choice = choices.find((c) => c.key === step)

  // A new list takes focus: its picked option, or the row you came back to.
  useEffect(() => {
    if (!open) return
    const el = list.current
    if (!el) return
    const target = step
      ? el.querySelector<HTMLElement>('[aria-checked="true"]')
      : cameFrom.current
        ? el.querySelector<HTMLElement>(`[data-option="${cameFrom.current}"]`)
        : null
    target?.focus()
  }, [open, step])

  const close = (): void => {
    setOpen(false)
    setStep(null)
    cameFrom.current = null
  }
  const into = (key: string): void => {
    cameFrom.current = key
    setStep(key)
  }
  const summary = choices.map((c) => c.options.find((o) => o.value === c.value)?.label).join(' · ')

  return (
    <>
      <span ref={anchor} className="home-composer-menu">
        <IconButton
          icon="SlidersHorizontal"
          label={`Options: ${summary}`}
          size={28}
          variant={open ? 'filled' : 'ghost'}
          aria-haspopup="menu"
          aria-expanded={open}
          data-composer-options
          onClick={() => (open ? close() : setOpen(true))}
        />
        <Popover
          open={open}
          onClose={close}
          anchorRef={anchor}
          placement="top-start"
          gap={8}
          className="home-composer-popover"
          aria-label={choice ? choice.label : 'Options'}
        >
          <div ref={list} className="composer-options" data-composer-options-menu>
            {choice ? (
              <>
                <button
                  type="button"
                  className="home-composer-popover-back"
                  onClick={() => setStep(null)}
                  onKeyDown={(e) => e.key === 'ArrowLeft' && setStep(null)}
                >
                  <Icon name="ChevronLeft" size={14} />
                  {choice.label}
                </button>
                {choice.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={o.value === choice.value}
                    className="cr-popover-item"
                    onKeyDown={(e) => e.key === 'ArrowLeft' && setStep(null)}
                    onClick={() => {
                      choice.set(o.value)
                      setStep(null)
                    }}
                  >
                    <span className="cr-popover-item-icon" aria-hidden="true">
                      {o.value === choice.value && <Icon name="Check" size={14} />}
                    </span>
                    {o.label}
                  </button>
                ))}
              </>
            ) : (
              <>
                {choices.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    className="cr-popover-item"
                    data-option={c.key}
                    onClick={() => into(c.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight') {
                        e.preventDefault()
                        into(c.key)
                      }
                    }}
                  >
                    <span className="cr-popover-item-icon" aria-hidden="true" />
                    {c.label}
                    <span className="composer-options-value">
                      {c.options.find((o) => o.value === c.value)?.label}
                      <Icon name="ChevronRight" size={14} />
                    </span>
                  </button>
                ))}
                {toggles.length > 0 && <div role="separator" className="cr-popover-separator" />}
                {toggles.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={t.on}
                    className="cr-popover-item"
                    data-option={t.key}
                    title={t.hint}
                    onClick={() => t.set(!t.on)}
                  >
                    <span className="cr-popover-item-icon" aria-hidden="true">
                      {t.on && <Icon name="Check" size={14} />}
                    </span>
                    {t.label}
                    <span className="composer-options-value" aria-hidden="true">
                      <Icon name={t.icon} size={14} />
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </Popover>
      </span>
      {toggles
        .filter((t) => t.on)
        .map((t) => (
          <Pill
            key={t.key}
            active
            size={28}
            className="composer-options-chip"
            data-composer-chip={t.key}
            aria-label={`${t.label} is on. Turn off`}
            title={`${t.hint}. Click to turn off.`}
            onClick={() => t.set(false)}
          >
            <Icon name={t.icon} size={12} />
            {t.label}
            <Icon name="X" size={12} />
          </Pill>
        ))}
    </>
  )
}
