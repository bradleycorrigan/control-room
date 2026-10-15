import Icon, { type IconName } from './Icon'

export interface MetaProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Flex gap between items: 12px per plan */
  gap?: number
}

export interface MetaItemProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: IconName
  /** The label/content — size and style from --text-meta tokens */
  children: React.ReactNode
}

/**
 * Meta component pair (plan 7, stage A2).
 *
 * Meta is a container for metadata rows (timestamps, branches, counts).
 * Gap between items is 12px.
 * Each MetaItem has an optional icon (16px) with 6px gap to the label.
 *
 * Example:
 * ```tsx
 * <Meta>
 *   <MetaItem icon="Clock">Yesterday</MetaItem>
 *   <MetaItem icon="GitBranch">main</MetaItem>
 * </Meta>
 * ```
 */
export function Meta({ gap = 12, className = '', ...rest }: MetaProps): React.JSX.Element {
  return <div className={`cr-meta ${className}`} style={{ gap }} {...rest} />
}

export function MetaItem({
  icon,
  children,
  className = '',
  ...rest
}: MetaItemProps): React.JSX.Element {
  return (
    <div className={`cr-meta-item ${className}`} {...rest}>
      {icon && <Icon name={icon} size={14} />}
      <span className="cr-meta-item-label">{children}</span>
    </div>
  )
}
