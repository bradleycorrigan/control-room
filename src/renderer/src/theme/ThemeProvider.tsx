import { useCallback, useEffect, useRef, useState } from 'react'
import { getAppSettings, setAppSettings, type AppSettingsPatch } from '../api'
import { themes, getTheme, defaultDarkThemeId, defaultLightThemeId } from './themes'

// Applies the theme by stamping `data-theme` on <html> and redefining tokens
// under :root[data-theme="…"] in tokens.css — never per-component
// conditionals (plan 1.4). Also persists the choice and follows the OS light/
// dark setting when themeFollowsSystem is on.
//
// A plain hook rather than a Context provider: App.tsx is the only consumer
// today (it feeds the Settings screen's Appearance section), so a context
// would just add indirection. Revisit if a second consumer appears.

function applyTheme(id: string): void {
  document.documentElement.setAttribute('data-theme', getTheme(id).id)
}

export interface ThemeController {
  themeId: string
  themeFollowsSystem: boolean
  setTheme: (id: string) => void
  setFollowsSystem: (on: boolean) => void
}

export function useThemeProvider(): ThemeController {
  const [themeId, setThemeId] = useState<string>(defaultDarkThemeId)
  const [themeFollowsSystem, setThemeFollowsSystem] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // True once the caller has explicitly picked a theme (a click in Settings,
  // or the dev shot tool). Guards against the async settings load — which
  // can resolve after an explicit pick made in the same tick as mount —
  // clobbering it back to the persisted value.
  const overridden = useRef(false)

  // Load persisted settings once at startup.
  useEffect(() => {
    let cancelled = false
    getAppSettings().then((settings) => {
      if (cancelled) return
      if (!overridden.current) {
        setThemeId(settings.theme)
        setThemeFollowsSystem(settings.themeFollowsSystem)
      }
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Apply immediately whenever the resolved theme changes, and whenever the
  // OS light/dark setting flips while follow-system is on.
  useEffect(() => {
    if (!loaded) return

    const resolve = (): string => {
      if (!themeFollowsSystem) return themeId
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      return prefersDark ? defaultDarkThemeId : defaultLightThemeId
    }

    applyTheme(resolve())

    if (!themeFollowsSystem) return undefined

    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme(resolve())
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [themeId, themeFollowsSystem, loaded])

  const setTheme = useCallback((id: string) => {
    if (!themes.some((t) => t.id === id)) return
    overridden.current = true
    setThemeId(id)
    const patch: AppSettingsPatch = { theme: id }
    setAppSettings(patch)
  }, [])

  const setFollowsSystem = useCallback((on: boolean) => {
    overridden.current = true
    setThemeFollowsSystem(on)
    const patch: AppSettingsPatch = { themeFollowsSystem: on }
    setAppSettings(patch)
  }, [])

  return { themeId, themeFollowsSystem, setTheme, setFollowsSystem }
}
