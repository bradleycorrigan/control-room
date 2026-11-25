import { Fragment, useRef, useState } from 'react'
import { Icon, Popover, type IconName } from './primitives'

export interface MenuItem {
  label: string
  /** Not called for a row with a submenu: pointing at it opens the submenu. */
  onClick: () => void
  /**
   * Opens these beside the row instead of acting, so a list that grows
   * (groups, projects) keeps the menu itself short.
   */
  submenu?: MenuItem[]
  danger?: boolean
  /**
   * Why it can't be used right now. The item stays where it always is,
   * greyed, with this as its tooltip: an action that came and went with
   * conditions you couldn't see read as broken.
   */
  disabled?: string
  /** Only for the actions people reach for most; the rest keep the space so labels line up. */
  icon?: IconName
  /** Items with the same group sit together; a line separates groups. */
  group?: string
  /** The key that does the same from the keyboard, shown at the row's end. */
  shortcut?: string
}

/**
 * The rows of an actions menu, for whichever Popover hangs it: session cards,
 * the Sessions list and the session screen all render the one list through
 * this, so the same action looks the same wherever it's opened.
 */
export function MenuItems({
  items,
  onPicked,
  itemClassName
}: {
  items: MenuItem[]
  /** Closes the menu; called before the item's own action. */
  onPicked: () => void
  itemClassName?: string
}): React.JSX.Element {
  const withIcons = items.some((i) => i.icon)
  // The row whose submenu is showing, and the row it hangs off.
  const [openSub, setOpenSub] = useState<string | null>(null)
  const subAnchor = useRef<HTMLElement | null>(null)
  const subItems = items.find((i) => i.label === openSub)?.submenu ?? null
  return (
    <>
      {items.map((item, i) => (
        <Fragment key={item.label}>
          {i > 0 && item.group !== items[i - 1].group && (
            <div role="separator" className="cr-popover-separator" />
          )}
          <button
            type="button"
            role="menuitem"
            className={[
              'cr-popover-item',
              item.danger && 'cr-popover-item--danger',
              itemClassName,
              item.danger && itemClassName && `${itemClassName}-danger`
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={Boolean(item.disabled)}
            title={item.disabled}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? openSub === item.label : undefined}
            onMouseEnter={(e) => {
              if (item.submenu) {
                subAnchor.current = e.currentTarget
                setOpenSub(item.label)
              } else setOpenSub(null)
            }}
            onKeyDown={(e) => {
              if (item.submenu && e.key === 'ArrowRight') {
                e.preventDefault()
                subAnchor.current = e.currentTarget
                setOpenSub(item.label)
              }
            }}
            onClick={(e) => {
              if (item.submenu) {
                subAnchor.current = e.currentTarget
                setOpenSub(item.label)
                return
              }
              onPicked()
              item.onClick()
            }}
          >
            {withIcons && (
              <span className="cr-popover-item-icon" aria-hidden="true">
                {item.icon && <Icon name={item.icon} size={14} />}
              </span>
            )}
            {item.label}
            {item.shortcut && <kbd className="cr-popover-item-kbd">{item.shortcut}</kbd>}
            {item.submenu && (
              <span className="cr-popover-item-kbd" aria-hidden="true">
                <Icon name="ChevronRight" size={14} />
              </span>
            )}
          </button>
        </Fragment>
      ))}
      <Popover
        open={subItems !== null}
        onClose={() => setOpenSub(null)}
        anchorRef={subAnchor}
        placement="right-start"
        submenu
        aria-label={openSub ?? undefined}
      >
        {subItems && (
          <MenuItems
            items={subItems}
            itemClassName={itemClassName}
            onPicked={() => {
              setOpenSub(null)
              onPicked()
            }}
          />
        )}
      </Popover>
    </>
  )
}
