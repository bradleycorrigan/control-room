import { createContext, useContext } from 'react'
import { EMPTY_LAYOUT, type TabLayout } from '../lib/tabLayout'

/**
 * The session tabs' pins, colours and groups, for the places a session shows
 * up outside the tab strip (cards, list rows), so a session you've coloured
 * or grouped looks the same wherever you meet it. App provides it.
 */
export const TabLayoutContext = createContext<TabLayout>(EMPTY_LAYOUT)

export function useTabLayoutInfo(): TabLayout {
  return useContext(TabLayoutContext)
}
