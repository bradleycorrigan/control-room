// How the session tabs are laid out beyond their order: which are pinned,
// which colour each has, and which sit together in a group. Pure functions
// over plain data, so scripts/verify-pure-logic.ts can check them without
// the app.

import { LABEL_IDS, type LabelId } from '../theme/themes'

export interface TabGroup {
  id: string
  /** Can be empty: a group shows its colour alone until you name it. */
  name: string
  colour: LabelId
  collapsed: boolean
}

export interface TabLayout {
  /** Session keys, in the order they were pinned. */
  pinned: string[]
  /** A tab's own colour. Kept after the tab closes, so reopening it keeps it. */
  colour: Record<string, LabelId>
  groups: TabGroup[]
  /** Session key → group id. */
  groupOf: Record<string, string>
}

export const EMPTY_LAYOUT: TabLayout = { pinned: [], colour: {}, groups: [], groupOf: {} }

/** A stored layout from an older or hand-edited copy: anything missing is empty. */
export function readLayout(raw: Partial<TabLayout> | null | undefined): TabLayout {
  const groups = Array.isArray(raw?.groups)
    ? raw.groups.filter((g) => g && typeof g.id === 'string' && LABEL_IDS.includes(g.colour))
    : []
  return {
    pinned: Array.isArray(raw?.pinned) ? raw.pinned : [],
    colour: raw?.colour && typeof raw.colour === 'object' ? raw.colour : {},
    groups,
    groupOf: raw?.groupOf && typeof raw.groupOf === 'object' ? raw.groupOf : {}
  }
}

/**
 * The order the strip shows: pinned tabs first, then the rest, with each
 * group's tabs pulled together where its first tab sits. Every key in `order`
 * comes back exactly once.
 */
export function arrangeTabs(order: string[], layout: TabLayout): string[] {
  const pinned = order.filter((k) => layout.pinned.includes(k))
  const rest = order.filter((k) => !layout.pinned.includes(k))
  const out: string[] = []
  const placed = new Set<string>()
  for (const key of rest) {
    if (placed.has(key)) continue
    const group = layout.groupOf[key]
    const members = group ? rest.filter((k) => layout.groupOf[k] === group) : [key]
    for (const m of members) {
      out.push(m)
      placed.add(m)
    }
  }
  return [...pinned, ...out]
}

/**
 * Drops what no longer applies once `open` are the only open tabs: pins and
 * group places of closed tabs, and groups left with no tabs. A pinned tab
 * can't be in a group. Colours stay.
 */
export function pruneLayout(layout: TabLayout, open: string[]): TabLayout {
  const pinned = layout.pinned.filter((k) => open.includes(k))
  const groupOf = Object.fromEntries(
    Object.entries(layout.groupOf).filter(
      ([k, g]) => open.includes(k) && !pinned.includes(k) && layout.groups.some((x) => x.id === g)
    )
  )
  const used = new Set(Object.values(groupOf))
  const groups = layout.groups.filter((g) => used.has(g.id))
  const same =
    pinned.length === layout.pinned.length &&
    groups.length === layout.groups.length &&
    Object.keys(groupOf).length === Object.keys(layout.groupOf).length
  return same ? layout : { ...layout, pinned, groupOf, groups }
}

/** The next colour for a new group: the first no group has yet, else round again. */
export function nextGroupColour(layout: TabLayout): LabelId {
  const taken = layout.groups.map((g) => g.colour)
  return (
    LABEL_IDS.find((c) => !taken.includes(c)) ?? LABEL_IDS[layout.groups.length % LABEL_IDS.length]
  )
}

/**
 * Tabs the strip hides: those in a collapsed group, except the one you're
 * on, so the screen you're looking at always has its tab.
 */
export function hiddenTabs(
  order: string[],
  layout: TabLayout,
  activeKey: string | null
): Set<string> {
  const collapsed = new Set(layout.groups.filter((g) => g.collapsed).map((g) => g.id))
  return new Set(order.filter((k) => k !== activeKey && collapsed.has(layout.groupOf[k] ?? '')))
}

/** The colour a tab shows: its group's, else its own. */
export function tabColour(key: string, layout: TabLayout): LabelId | null {
  const group = layout.groups.find((g) => g.id === layout.groupOf[key])
  return group?.colour ?? layout.colour[key] ?? null
}

export const LABEL_NAMES: Record<LabelId, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  cyan: 'Cyan',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink'
}

/** A group's name, or its colour when it has none: "Red group". */
export function groupLabel(group: TabGroup): string {
  return group.name.trim() || `${LABEL_NAMES[group.colour]} group`
}
