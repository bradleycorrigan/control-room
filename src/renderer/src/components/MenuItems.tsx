import { Fragment } from 'react'
import { Icon, type IconName } from './primitives'

export interface MenuItem {
  label: string
  onClick: () => void
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
            onClick={() => {
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
          </button>
        </Fragment>
      ))}
    </>
  )
}
