import { BrowserWindow } from 'electron'
import { getState, updateSettings } from './store/store'
import { UI_SIZES } from './store/types'

/** The listed size nearest to a zoom factor. */
export function nearestUiSize(factor: number): number {
  return UI_SIZES.reduce((best, s) => (Math.abs(s - factor) < Math.abs(best - factor) ? s : best))
}

/** Apply a size to every window and tell the renderers, as settings:set does. */
export function setUiZoom(factor: number): void {
  const next = updateSettings({ uiZoom: nearestUiSize(factor) })
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.setZoomFactor(next.uiZoom ?? 1)
    win.webContents.send('settings:changed', next)
  }
}

/**
 * The interface size is a setting, not Chromium's own per-page zoom (which
 * nothing in the app showed, and which ⌘+ changed behind its back). On each
 * load the window takes the setting; the first time there isn't one, the
 * setting takes whatever zoom the window already had, so nobody's size
 * changes under them. ⌘+ and ⌘− step through the same sizes and save.
 */
export function wireUiZoom(win: BrowserWindow, adoptExisting: boolean): void {
  win.webContents.on('did-finish-load', () => {
    const saved = getState().settings.uiZoom
    if (saved) win.webContents.setZoomFactor(saved)
    else if (adoptExisting) setUiZoom(win.webContents.getZoomFactor())
    // Chromium restores a page's last zoom by itself; without a setting,
    // that's a size nobody chose (a check run's leftover, say).
    else win.webContents.setZoomFactor(1)
  })
  win.webContents.on('before-input-event', (event, input) => {
    if (!(input.meta || input.control) || input.alt) return
    const step = input.key === '=' || input.key === '+' ? 1 : input.key === '-' ? -1 : 0
    if (step === 0) return
    // Takes the menu's own zoom shortcut with it, so the two can't disagree.
    event.preventDefault()
    if (input.type !== 'keyDown') return
    const at = UI_SIZES.indexOf(nearestUiSize(getState().settings.uiZoom ?? 1))
    const to = UI_SIZES[Math.min(Math.max(at + step, 0), UI_SIZES.length - 1)]
    if (to !== UI_SIZES[at]) setUiZoom(to)
  })
}
