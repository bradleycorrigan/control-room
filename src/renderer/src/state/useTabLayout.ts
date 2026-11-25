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
  setPinned: (key: string, pinned: boolean) => void
  setColour: (key: string, colour: LabelId | null) => void
  /** Puts the tab in a new group of its own and returns the group's id. */
  newGroup: (key: string) => string
  /** null takes the tab out of its group. */
  moveToGroup: (key: string, groupId: string | null) => void
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
    (key: string, pinned: boolean) => {
      const rest = layout.pinned.filter((k) => k !== key)
      const groupOf = { ...layout.groupOf }
      if (pinned) delete groupOf[key]
      setStored({ ...layout, pinned: pinned ? [...rest, key] : rest, groupOf })
    },
    [layout, setStored]
  )

  const setColour = useCallback(
    (key: string, colour: LabelId | null) => {
      const next = { ...layout.colour }
      if (colour) next[key] = colour
      else delete next[key]
      setStored({ ...layout, colour: next })
    },
    [layout, setStored]
  )

  const newGroup = useCallback(
    (key: string): string => {
      const id = `g-${Date.now().toString(36)}`
      setStored({
        ...layout,
        pinned: layout.pinned.filter((k) => k !== key),
        groups: [
          ...layout.groups,
          { id, name: '', colour: layout.colour[key] ?? nextGroupColour(layout), collapsed: false }
        ],
        groupOf: { ...layout.groupOf, [key]: id }
      })
      return id
    },
    [layout, setStored]
  )

  const moveToGroup = useCallback(
    (key: string, groupId: string | null) => {
      const groupOf = { ...layout.groupOf }
      if (groupId) groupOf[key] = groupId
      else delete groupOf[key]
      const pinned = groupId ? layout.pinned.filter((k) => k !== key) : layout.pinned
      // Joining a group: move the tab to sit after the group's last tab, so it
      // lands at the group's end rather than pulling the group to it.
      if (groupId) {
        const members = openTabs.filter((k) => k !== key && groupOf[k] === groupId)
        const last = members[members.length - 1]
        if (last) {
          const next = openTabs.filter((k) => k !== key)
          next.splice(next.indexOf(last) + 1, 0, key)
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
