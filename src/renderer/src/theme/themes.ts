// The ten themes, ported from Brad's Cursor set (see `_wt_themes` in
// ~/.zsh/worktrees.zsh). Every colour the app renders comes from here — a
// hex literal in a component is a bug (see plan section 1.2/1.3).
//
// Anchor colours (bg, surface, text, accent, the five status colours, the 16
// ANSI terminal colours) are the theme's real, published values. Structural
// chrome the plan does not spell out — bg-sunken, surface-raised, border,
// border-strong, text-muted, text-faint, accent-soft — is derived from those
// same anchors with `mix()` so it always stays in the theme's own family
// rather than introducing an invented hex. Blend ratios were tuned against
// contrast-check.ts until every theme passes with zero failures.
import { mix, withAlpha, nudgeForContrast } from './color'

export interface StatusColors {
  working: string
  attention: string
  done: string
  idle: string
  error: string
}

export interface Ansi16 {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface Theme {
  id: string
  name: string
  isDark: boolean
  bg: string
  bgSunken: string
  surface: string
  surfaceRaised: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  textFaint: string
  accent: string
  accentFg: string
  accentSoft: string
  status: StatusColors
  termBg: string
  termFg: string
  /** The character colour showing through a block cursor (the cursor itself is termFg). */
  termCursorFg: string
  /** Selection wash. Carries alpha, so the selected text stays readable. */
  termSelection: string
  ansi: Ansi16
}

interface ThemeSeed {
  id: string
  name: string
  isDark: boolean
  bg: string
  surface: string
  text: string
  accent: string
  accentFg: string
  status: StatusColors
  ansi: Ansi16
  // Optional overrides when the theme's own published palette gives a real,
  // named value for one of the derived chrome tokens (e.g. Tokyo Night's
  // `bg_dark`, Catppuccin's `crust`) — used instead of the mathematical mix.
  bgSunken?: string
  surfaceRaised?: string
  textMuted?: string
  textFaint?: string
  border?: string
  borderStrong?: string
}

// Buffers past the plan's exact floors (4.5 / 3) so rounding in the mix math
// never lands a theme exactly on the line.
const TEXT_MIN = 4.55
const MUTED_MIN = 3.08
const DOT_MIN = 3.08

function build(seed: ThemeSeed): Theme {
  const { text, isDark } = seed
  const lightnessDirection = isDark ? 'lighten' : 'darken'

  // Surfaces — one black, three greys (plan 7, "The design rules"). Dark
  // themes shift every rung down one: the theme's published bg becomes the
  // card colour and the canvas sinks toward near-black beneath it. Light
  // themes invert the same move: the canvas goes to a warm off-white and
  // cards go *up* to pure white. seed.bgSunken / seed.surfaceRaised were
  // tuned for the old ramp and are ignored on the dark path.
  let bg: string
  let bgSunken: string
  let surface: string
  let surfaceRaised: string
  let border: string
  let borderStrong: string

  if (isDark) {
    bg = mix(seed.bg, '#000000', 0.55)
    bgSunken = mix(bg, '#000000', 0.45)
    surface = seed.bg
    surfaceRaised = seed.surface
    border = mix(surface, text, 0.12)
    borderStrong = mix(surface, text, 0.28)
  } else {
    // Light themes (github-light, solarized-light) are out of scope for
    // this pass — unchanged from the pre-A1 ramp.
    bg = seed.bg
    // Light themes sink toward the surface's own duller tone (a paper-white
    // bg has nothing darker to reuse).
    const sinkTarget = mix(seed.surface, '#000000', 0.06)
    bgSunken = seed.bgSunken ?? mix(bg, sinkTarget, 0.5)

    // Body text must hit 4.5:1 against every surface it can sit on. Where a
    // theme's own published "surface" tone is too close to its own
    // published "text" tone to clear that bar (this affects only Solarized
    // Light, whose base01-on-base2 pairing is famously borderline), nudge
    // surface's lightness — never hue — away from text until it clears the
    // floor, rather than weakening the check or inventing an unrelated
    // colour.
    surface = nudgeForContrast(seed.surface, [text], TEXT_MIN, 'lighten')
    surfaceRaised = nudgeForContrast(
      seed.surfaceRaised ?? mix(surface, '#ffffff', 0.06),
      [text],
      TEXT_MIN,
      'lighten'
    )
    border = seed.border ?? mix(surface, text, 0.14)
    borderStrong = seed.borderStrong ?? mix(surface, text, 0.3)
  }

  const mutedSeed = seed.textMuted ?? mix(text, bg, isDark ? 0.32 : 0.38)
  const textMuted = nudgeForContrast(
    mutedSeed,
    [bg, surface, surfaceRaised],
    MUTED_MIN,
    lightnessDirection
  )

  const status = Object.fromEntries(
    Object.entries(seed.status).map(([key, hex]) => [
      key,
      nudgeForContrast(hex, [surface], DOT_MIN, lightnessDirection)
    ])
  ) as unknown as StatusColors

  const accent = nudgeForContrast(seed.accent, [bg], DOT_MIN, lightnessDirection)

  return {
    id: seed.id,
    name: seed.name,
    isDark,
    bg,
    bgSunken,
    surface,
    surfaceRaised,
    border,
    borderStrong,
    text,
    textMuted,
    textFaint: seed.textFaint ?? mix(text, bg, isDark ? 0.55 : 0.6),
    accent,
    accentFg: seed.accentFg,
    accentSoft: withAlpha(accent, 0.14),
    status,
    termBg: bg,
    termFg: text,
    // Two parts of the terminal did not follow the theme. The selection
    // borrowed --term-ansi-8 — a text colour, fully opaque, which in some
    // themes sat almost on top of the background and hid what you had just
    // selected. And the glyph under a block cursor was xterm's built-in
    // black, invisible in a light theme. Both derive from colours the theme
    // already publishes, so every theme gets them and none hand-picks more hex.
    termCursorFg: bg,
    termSelection: withAlpha(accent, 0.3),
    ansi: seed.ansi
  }
}

const seeds: ThemeSeed[] = [
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    isDark: true,
    bg: '#1a1b26',
    bgSunken: '#16161e', // bg_dark
    surface: '#24283b',
    surfaceRaised: '#292e42', // bg_highlight
    text: '#c0caf5',
    textMuted: '#9aa5ce', // fg_dark
    textFaint: '#565f89', // comment
    accent: '#7aa2f7',
    accentFg: '#1a1b26',
    status: {
      working: '#7dcfff',
      attention: '#e0af68',
      done: '#9ece6a',
      idle: '#565f89',
      error: '#f7768e'
    },
    ansi: {
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    }
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    isDark: true,
    bg: '#1e1e2e', // base
    bgSunken: '#11111b', // crust
    surface: '#313244', // surface0
    surfaceRaised: '#45475a', // surface1
    border: '#45475a', // surface1
    borderStrong: '#585b70', // surface2
    text: '#cdd6f4',
    textMuted: '#a6adc8', // subtext0
    textFaint: '#6c7086', // overlay0
    accent: '#cba6f7', // mauve
    accentFg: '#1e1e2e',
    status: {
      working: '#89dceb', // sky
      attention: '#f9e2af', // yellow
      done: '#a6e3a1', // green
      idle: '#6c7086', // overlay0
      error: '#f38ba8' // red
    },
    ansi: {
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    isDark: true,
    bg: '#2e3440', // nord0
    surface: '#3b4252', // nord1
    surfaceRaised: '#434c5e', // nord2
    border: '#434c5e', // nord2
    borderStrong: '#4c566a', // nord3
    text: '#d8dee9', // nord4
    textMuted: '#4c566a', // nord3 ("comment" role in Nord ports)
    textFaint: '#434c5e', // nord2
    accent: '#88c0d0', // nord8
    accentFg: '#2e3440',
    status: {
      working: '#81a1c1', // nord9
      attention: '#ebcb8b', // nord13
      done: '#a3be8c', // nord14
      idle: '#4c566a', // nord3
      error: '#bf616a' // nord11
    },
    ansi: {
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    isDark: true,
    bg: '#282a36',
    surface: '#44475a', // current line / selection
    text: '#f8f8f2',
    textMuted: '#6272a4', // comment
    accent: '#bd93f9', // purple
    accentFg: '#282a36',
    status: {
      working: '#8be9fd', // cyan
      attention: '#ffb86c', // orange
      done: '#50fa7b', // green
      idle: '#6272a4', // comment
      error: '#ff5555' // red
    },
    ansi: {
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    isDark: true,
    bg: '#282c34',
    surface: '#21252b', // sidebar/panel — genuinely darker than editor bg in One Dark
    surfaceRaised: '#2c313a',
    text: '#abb2bf',
    textMuted: '#5c6370', // comment
    accent: '#61afef', // blue
    accentFg: '#282c34',
    status: {
      working: '#56b6c2', // cyan
      attention: '#e5c07b', // yellow
      done: '#98c379', // green
      idle: '#5c6370', // comment
      error: '#e06c75' // red
    },
    ansi: {
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'ayu-mirage',
    name: 'Ayu Mirage',
    isDark: true,
    bg: '#1f2430',
    surface: '#232834',
    text: '#cbccc6',
    textMuted: '#5c6773', // comment
    accent: '#ffcc66', // entity/constant amber
    accentFg: '#1f2430',
    status: {
      working: '#5ccfe6', // tag
      attention: '#ffa759', // keyword/orange
      done: '#bae67e', // string/green
      idle: '#5c6773', // comment
      error: '#ff3333'
    },
    ansi: {
      black: '#232834',
      red: '#ff3333',
      green: '#bae67e',
      yellow: '#ffcc66',
      blue: '#5ccfe6',
      magenta: '#d4bfff',
      cyan: '#95e6cb',
      white: '#cbccc6',
      brightBlack: '#5c6773',
      brightRed: '#ff6565',
      brightGreen: '#d5ff80',
      brightYellow: '#ffe6b3',
      brightBlue: '#73d0ff',
      brightMagenta: '#e6b3ff',
      brightCyan: '#95e6cb',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    isDark: true,
    bg: '#011627',
    surface: '#0b2942',
    text: '#d6deeb',
    textMuted: '#637777', // comment
    accent: '#82aaff', // function blue
    accentFg: '#011627',
    status: {
      working: '#7fdbca', // support/teal
      attention: '#ffcb8b', // class/tan
      done: '#addb67', // string/green
      idle: '#637777', // comment
      error: '#ef5350'
    },
    ansi: {
      black: '#011627',
      red: '#ef5350',
      green: '#addb67',
      yellow: '#ffcb8b',
      blue: '#82aaff',
      magenta: '#c792ea',
      cyan: '#7fdbca',
      white: '#d6deeb',
      brightBlack: '#637777',
      brightRed: '#ff5874',
      brightGreen: '#addb67',
      brightYellow: '#ffcb8b',
      brightBlue: '#82aaff',
      brightMagenta: '#c792ea',
      brightCyan: '#7fdbca',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    isDark: true,
    bg: '#282828',
    bgSunken: '#1d2021', // dark0_hard
    surface: '#3c3836',
    surfaceRaised: '#504945',
    border: '#504945',
    borderStrong: '#665c54',
    text: '#ebdbb2',
    textMuted: '#a89984',
    textFaint: '#928374',
    accent: '#fabd2f',
    accentFg: '#282828',
    status: {
      working: '#83a598',
      attention: '#fabd2f',
      done: '#b8bb26',
      idle: '#928374',
      error: '#fb4934'
    },
    ansi: {
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
    }
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    isDark: false,
    bg: '#ffffff',
    surface: '#f6f8fa',
    surfaceRaised: '#eaeef2',
    border: '#d0d7de',
    borderStrong: '#8c959f',
    text: '#1f2328',
    textMuted: '#59636e',
    textFaint: '#8c959f',
    accent: '#0969da',
    accentFg: '#ffffff',
    status: {
      working: '#0969da',
      attention: '#9a6700',
      done: '#1a7f37',
      idle: '#656d76',
      error: '#cf222e'
    },
    ansi: {
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#4d2d00',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#8c959f'
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    isDark: false,
    bg: '#fdf6e3', // base3
    surface: '#eee8d5', // base2
    text: '#586e75', // base01
    textMuted: '#657b83', // base00
    textFaint: '#93a1a1', // base1
    accent: '#268bd2', // blue
    accentFg: '#fdf6e3',
    status: {
      working: '#2aa198', // cyan
      attention: '#b58900', // yellow
      done: '#859900', // green
      idle: '#93a1a1', // base1
      error: '#dc322f' // red
    },
    ansi: {
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  }
]

export const themes: Theme[] = seeds.map(build)

export const themesById: Record<string, Theme> = Object.fromEntries(themes.map((t) => [t.id, t]))

export const defaultThemeId = 'tokyo-night'
export const defaultLightThemeId = 'github-light'
export const defaultDarkThemeId = 'tokyo-night'

export function getTheme(id: string): Theme {
  return themesById[id] ?? themesById[defaultThemeId]
}

// Prep for U5's per-session accent: map a Cursor `workbench.colorTheme` name
// (as written into `<worktree>.workspaces/<dirname>.code-workspace`, matching
// `_wt_themes` in ~/.zsh/worktrees.zsh) to that theme's accent hex. Not
// consumed anywhere yet.
export const accentByCursorThemeName: Record<string, string> = {
  'Tokyo Night': themesById['tokyo-night'].accent,
  'Catppuccin Mocha': themesById['catppuccin-mocha'].accent,
  Nord: themesById['nord'].accent,
  Dracula: themesById['dracula'].accent,
  'One Dark Pro': themesById['one-dark-pro'].accent,
  'Ayu Mirage': themesById['ayu-mirage'].accent,
  'Night Owl': themesById['night-owl'].accent,
  'Gruvbox Dark': themesById['gruvbox-dark'].accent,
  'GitHub Light': themesById['github-light'].accent,
  'GitHub Dark Default': '#58a6ff',
  'Solarized Light': themesById['solarized-light'].accent
}
