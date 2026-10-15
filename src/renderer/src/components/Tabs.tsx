// Reusable underline-tabs nav (plan 2.2). Top-level navigation only — pills
// are reserved for filter controls inside a tab body, never for this.
export interface TabItem {
  id: string
  label: string
}

interface Props {
  tabs: TabItem[]
  activeId: string
  onSelect: (id: string) => void
}

export default function Tabs({ tabs, activeId, onSelect }: Props): React.JSX.Element {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => {
        const selected = tab.id === activeId
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`tab${selected ? ' tab-selected' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
