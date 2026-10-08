// The themes: the first ten ported from Brad's Cursor set (see `_wt_themes`
// in ~/.zsh/worktrees.zsh), then popular editor themes from their published
// palettes. Every colour the app renders comes from here — a
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
  /**
   * xterm's `minimumContrastRatio`: any text colour below it against the
   * terminal background is darkened or lightened until it clears. 1 = off.
   */
  termMinContrast: number
  /** `-webkit-font-smoothing` for terminal text. */
  termFontSmoothing: 'auto' | 'antialiased'
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
    // Light themes: Claude Code prints some text (file paths among it) in
    // fixed 24-bit colours tuned for dark terminals, which no ANSI palette
    // here can remap, so the pale pink came out near-invisible on white.
    // xterm's contrast floor catches those as well as the palette's own
    // colours. Dark themes keep their exact colours (Claude Code's dim
    // greys there are deliberate).
    termMinContrast: isDark ? 1 : 4.5,
    // The app renders text with grayscale smoothing, which draws dark text
    // on a light ground noticeably thin. `auto` lets macOS thicken strokes
    // as it does in its own terminals; dark themes stay as they were.
    termFontSmoothing: isDark ? 'antialiased' : 'auto',
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
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    isDark: true,
    bg: '#191724', // base
    surface: '#26233a', // overlay
    text: '#e0def4', // text
    textMuted: '#908caa', // subtle
    textFaint: '#6e6a86', // muted
    accent: '#c4a7e7', // iris
    accentFg: '#191724',
    status: {
      working: '#9ccfd8', // foam
      attention: '#f6c177', // gold
      done: '#31748f', // pine
      idle: '#6e6a86', // muted
      error: '#eb6f92' // love
    },
    ansi: {
      black: '#26233a',
      red: '#eb6f92',
      green: '#31748f',
      yellow: '#f6c177',
      blue: '#9ccfd8',
      magenta: '#c4a7e7',
      cyan: '#ebbcba',
      white: '#e0def4',
      brightBlack: '#6e6a86',
      brightRed: '#eb6f92',
      brightGreen: '#31748f',
      brightYellow: '#f6c177',
      brightBlue: '#9ccfd8',
      brightMagenta: '#c4a7e7',
      brightCyan: '#ebbcba',
      brightWhite: '#e0def4'
    }
  },
  {
    id: 'monokai-pro',
    name: 'Monokai Pro',
    isDark: true,
    bg: '#2d2a2e', // background
    surface: '#403e41', // dimmed5
    text: '#fcfcfa', // text
    textMuted: '#939293', // dimmed2
    textFaint: '#727072', // dimmed3
    accent: '#ffd866', // yellow
    accentFg: '#2d2a2e',
    status: {
      working: '#78dce8', // cyan
      attention: '#fc9867', // orange
      done: '#a9dc76', // green
      idle: '#727072', // dimmed3
      error: '#ff6188' // red
    },
    ansi: {
      black: '#403e41',
      red: '#ff6188',
      green: '#a9dc76',
      yellow: '#ffd866',
      blue: '#fc9867',
      magenta: '#ab9df2',
      cyan: '#78dce8',
      white: '#fcfcfa',
      brightBlack: '#727072',
      brightRed: '#ff6188',
      brightGreen: '#a9dc76',
      brightYellow: '#ffd866',
      brightBlue: '#fc9867',
      brightMagenta: '#ab9df2',
      brightCyan: '#78dce8',
      brightWhite: '#fcfcfa'
    }
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa',
    isDark: true,
    bg: '#1f1f28', // sumiInk3
    surface: '#2a2a37', // sumiInk4
    text: '#dcd7ba', // fujiWhite
    textMuted: '#c8c093', // oldWhite
    textFaint: '#727169', // fujiGray
    accent: '#7e9cd8', // crystalBlue
    accentFg: '#1f1f28',
    status: {
      working: '#7fb4ca', // springBlue
      attention: '#e6c384', // carpYellow
      done: '#98bb6c', // springGreen
      idle: '#727169', // fujiGray
      error: '#e82424' // samuraiRed
    },
    ansi: {
      black: '#16161d',
      red: '#c34043',
      green: '#76946a',
      yellow: '#c0a36e',
      blue: '#7e9cd8',
      magenta: '#957fb8',
      cyan: '#6a9589',
      white: '#c8c093',
      brightBlack: '#727169',
      brightRed: '#e82424',
      brightGreen: '#98bb6c',
      brightYellow: '#e6c384',
      brightBlue: '#7fb4ca',
      brightMagenta: '#938aa9',
      brightCyan: '#7aa89f',
      brightWhite: '#dcd7ba'
    }
  },
  {
    id: 'everforest-dark',
    name: 'Everforest Dark',
    isDark: true,
    bg: '#2d353b', // bg0
    surface: '#3d484d', // bg2
    text: '#d3c6aa', // fg
    textMuted: '#9da9a0', // grey2
    textFaint: '#7a8478', // grey0
    accent: '#a7c080', // green
    accentFg: '#2d353b',
    status: {
      working: '#7fbbb3', // blue
      attention: '#dbbc7f', // yellow
      done: '#a7c080', // green
      idle: '#7a8478', // grey0
      error: '#e67e80' // red
    },
    ansi: {
      black: '#475258',
      red: '#e67e80',
      green: '#a7c080',
      yellow: '#dbbc7f',
      blue: '#7fbbb3',
      magenta: '#d699b6',
      cyan: '#83c092',
      white: '#d3c6aa',
      brightBlack: '#7a8478',
      brightRed: '#e67e80',
      brightGreen: '#a7c080',
      brightYellow: '#dbbc7f',
      brightBlue: '#7fbbb3',
      brightMagenta: '#d699b6',
      brightCyan: '#83c092',
      brightWhite: '#d3c6aa'
    }
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    isDark: false,
    bg: '#eff1f5', // base
    surface: '#e6e9ef', // mantle
    border: '#ccd0da', // surface0
    borderStrong: '#acb0be', // surface2
    text: '#4c4f69', // text
    textMuted: '#6c6f85', // subtext0
    textFaint: '#9ca0b0', // overlay0
    accent: '#8839ef', // mauve
    accentFg: '#eff1f5',
    status: {
      working: '#04a5e5', // sky
      attention: '#df8e1d', // yellow
      done: '#40a02b', // green
      idle: '#9ca0b0', // overlay0
      error: '#d20f39' // red
    },
    ansi: {
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#d20f39',
      brightGreen: '#40a02b',
      brightYellow: '#df8e1d',
      brightBlue: '#1e66f5',
      brightMagenta: '#ea76cb',
      brightCyan: '#179299',
      brightWhite: '#bcc0cc'
    }
  },
  {
    id: 'one-light',
    name: 'One Light',
    isDark: false,
    bg: '#fafafa',
    surface: '#f0f0f1',
    text: '#383a42',
    textMuted: '#696c77',
    textFaint: '#a0a1a7',
    accent: '#4078f2', // blue
    accentFg: '#fafafa',
    status: {
      working: '#0184bc', // cyan
      attention: '#c18401', // yellow
      done: '#50a14f', // green
      idle: '#a0a1a7',
      error: '#e45649' // red
    },
    ansi: {
      black: '#383a42',
      red: '#e45649',
      green: '#50a14f',
      yellow: '#c18401',
      blue: '#4078f2',
      magenta: '#a626a4',
      cyan: '#0184bc',
      white: '#a0a1a7',
      brightBlack: '#696c77',
      brightRed: '#e45649',
      brightGreen: '#50a14f',
      brightYellow: '#c18401',
      brightBlue: '#4078f2',
      brightMagenta: '#a626a4',
      brightCyan: '#0184bc',
      brightWhite: '#383a42'
    }
  },
  {
    id: 'tokyo-night-day',
    name: 'Tokyo Night Day',
    isDark: false,
    bg: '#e1e2e7', // bg
    surface: '#d0d5e3', // bg_dark
    text: '#3760bf', // fg
    textMuted: '#6172b0', // fg_dark
    textFaint: '#848cb5', // comment
    accent: '#2e7de9', // blue
    accentFg: '#e1e2e7',
    status: {
      working: '#007197', // cyan
      attention: '#8c6c3e', // yellow
      done: '#587539', // green
      idle: '#848cb5', // comment
      error: '#f52a65' // red
    },
    ansi: {
      black: '#e9e9ed',
      red: '#f52a65',
      green: '#587539',
      yellow: '#8c6c3e',
      blue: '#2e7de9',
      magenta: '#9854f1',
      cyan: '#007197',
      white: '#6172b0',
      brightBlack: '#a1a6c5',
      brightRed: '#f52a65',
      brightGreen: '#587539',
      brightYellow: '#8c6c3e',
      brightBlue: '#2e7de9',
      brightMagenta: '#9854f1',
      brightCyan: '#007197',
      brightWhite: '#3760bf'
    }
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    isDark: false,
    bg: '#faf4ed', // base
    surface: '#f2e9e1', // overlay
    text: '#575279', // text
    textMuted: '#797593', // subtle
    textFaint: '#9893a5', // muted
    accent: '#286983', // pine
    accentFg: '#faf4ed',
    status: {
      working: '#56949f', // foam
      attention: '#ea9d34', // gold
      done: '#286983', // pine
      idle: '#9893a5', // muted
      error: '#b4637a' // love
    },
    ansi: {
      black: '#f2e9e1',
      red: '#b4637a',
      green: '#286983',
      yellow: '#ea9d34',
      blue: '#56949f',
      magenta: '#907aa9',
      cyan: '#d7827e',
      white: '#575279',
      brightBlack: '#9893a5',
      brightRed: '#b4637a',
      brightGreen: '#286983',
      brightYellow: '#ea9d34',
      brightBlue: '#56949f',
      brightMagenta: '#907aa9',
      brightCyan: '#d7827e',
      brightWhite: '#575279'
    }
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    isDark: false,
    bg: '#fbf1c7', // bg0
    surface: '#ebdbb2', // bg1
    text: '#3c3836', // fg
    textMuted: '#7c6f64', // fg4
    textFaint: '#928374', // gray
    accent: '#076678', // faded blue
    accentFg: '#fbf1c7',
    status: {
      working: '#076678', // faded blue
      attention: '#b57614', // faded yellow
      done: '#79740e', // faded green
      idle: '#928374', // gray
      error: '#9d0006' // faded red
    },
    ansi: {
      black: '#fbf1c7',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#7c6f64',
      brightBlack: '#928374',
      brightRed: '#9d0006',
      brightGreen: '#79740e',
      brightYellow: '#b57614',
      brightBlue: '#076678',
      brightMagenta: '#8f3f71',
      brightCyan: '#427b58',
      brightWhite: '#3c3836'
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
