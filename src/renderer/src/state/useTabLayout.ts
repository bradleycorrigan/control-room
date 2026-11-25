import { useCallback, useEffect, useMemo } from 'react'
import type { LabelId } from '../theme/themes'
import {
  EMPTY_LAYOUT,
  arrangeTabs,
  nextGroupColour,
  pruneLayout,
  readLayout,
  type TabGroup,
  type TabLayout
} from '../lib/tabLayout'
import { useStoredState } from './useStoredState'

export interface TabLayoutActions {
  layout: TabLayout
  /** Every action takes several tabs: the ones shift-clicked together. */
  setPinned: (keys: string[], pinned: boolean) => void
  setColour: (keys: string[], colour: LabelId | null) => void
  /** Puts the tabs in a new group of their own and returns the group's id. */
  newGroup: (keys: string[]) => string
  /** null takes the tabs out of their groups. */
  moveToGroup: (keys: string[], groupId: string | null) => void
  updateGroup: (groupId: string, patch: Partial<Omit<TabGroup, 'id'>>) => void
  /** Keeps the tabs, drops the group. */
  ungroup: (groupId: string) => void
  /** Replaces the whole layout: the screenshot tool's way to set a scene. */
  replace: (layout: TabLayout) => void
}

/**
 * Pins, colours and groups for the session tabs, remembered across restarts
 * next to the tab list itself. Keeps `openTabs` in the order the strip shows
 * (pinned first, each group together), so every index-based tab action —
 * ⌘1–9, close to the right, drag — works on what you see.
 */
export function useTabLayout(
  openTabs: string[],
  setOpenTabs: (next: string[]) => void
): TabLayoutActions {
  const [stored, setStored] = useStoredState<TabLayout>('session-tab-layout', EMPTY_LAYOUT)
  const layout = useMemo(() => readLayout(stored), [stored])

  // A closed tab leaves its pin and group behind; an empty group goes.
  useEffect(() => {
    const pruned = pruneLayout(layout, openTabs)
    if (pruned !== layout) setStored(pruned)
  }, [layout, openTabs, setStored])

  useEffect(() => {
    const arranged = arrangeTabs(openTabs, layout)
    if (arranged.some((k, i) => k !== openTabs[i])) setOpenTabs(arranged)
  }, [layout, openTabs, setOpenTabs])

  const setPinned = useCallback(
    (keys: string[], pinned: boolean) => {
      const rest = layout.pinned.filter((k) => !keys.includes(k))
      const groupOf = { ...layout.groupOf }
      if (pinned) for (const k of keys) delete groupOf[k]
      setStored({ ...layout, pinned: pinned ? [...rest, ...keys] : rest, groupOf })
    },
    [layout, setStored]
  )

  const setColour = useCallback(
    (keys: string[], colour: LabelId | null) => {
      const next = { ...layout.colour }
      for (const k of keys) {
        if (colour) next[k] = colour
        else delete next[k]
      }
      setStored({ ...layout, colour: next })
    },
    [layout, setStored]
  )

  const newGroup = useCallback(
    (keys: string[]): string => {
      const id = `g-${Date.now().toString(36)}`
      // The tabs gather where the first of them sits (arrangeTabs does that);
      // the group takes the first one's colour if it has one.
      const first = openTabs.find((k) => keys.includes(k)) ?? keys[0]
      setStored({
        ...layout,
        pinned: layout.pinned.filter((k) => !keys.includes(k)),
        groups: [
          ...layout.groups,
          {
            id,
            name: '',
            colour: layout.colour[first] ?? nextGroupColour(layout),
            collapsed: false
          }
        ],
        groupOf: { ...layout.groupOf, ...Object.fromEntries(keys.map((k) => [k, id])) }
      })
      return id
    },
    [layout, openTabs, setStored]
  )

  const moveToGroup = useCallback(
    (keys: string[], groupId: string | null) => {
      const groupOf = { ...layout.groupOf }
      for (const k of keys) {
        if (groupId) groupOf[k] = groupId
        else delete groupOf[k]
      }
      const pinned = groupId ? layout.pinned.filter((k) => !keys.includes(k)) : layout.pinned
      // Joining a group: move the tabs to sit after the group's last tab, so
      // they land at the group's end rather than pulling the group to them.
      if (groupId) {
        const members = openTabs.filter((k) => !keys.includes(k) && groupOf[k] === groupId)
        const last = members[members.length - 1]
        if (last) {
          const moving = openTabs.filter((k) => keys.includes(k))
          const next = openTabs.filter((k) => !keys.includes(k))
          next.splice(next.indexOf(last) + 1, 0, ...moving)
          setOpenTabs(next)
        }
      }
      setStored({ ...layout, pinned, groupOf })
    },
    [layout, openTabs, setOpenTabs, setStored]
  )

  const updateGroup = useCallback(
    (groupId: string, patch: Partial<Omit<TabGroup, 'id'>>) =>
      setStored({
        ...layout,
        groups: layout.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g))
      }),
    [layout, setStored]
  )

  const ungroup = useCallback(
    (groupId: string) =>
      setStored({
        ...layout,
        groups: layout.groups.filter((g) => g.id !== groupId),
        groupOf: Object.fromEntries(Object.entries(layout.groupOf).filter(([, g]) => g !== groupId))
      }),
    [layout, setStored]
  )

  return {
    layout,
    setPinned,
    setColour,
    newGroup,
    moveToGroup,
    updateGroup,
    ungroup,
    replace: setStored
  }
}
