import { useSearchTabsStore } from '../store/searchTabs'

export function SearchTabsBar() {
  const { tabs, activeTabId, switchTab, closeTab } = useSearchTabsStore()
  const ids = Object.keys(tabs)

  if (ids.length === 0) return null

  return (
    <div className="flex gap-2 mb-4 overflow-x-auto pb-2 scrollbar-none">
      {ids.map((id) => {
        const tab = tabs[id]
        const isActive = id === activeTabId
        return (
          <div
            key={id}
            className={`flex items-center gap-3 px-4 py-2 font-mono text-xs uppercase tracking-wide cursor-pointer transition-colors border ${isActive ? 'bg-accent text-bg-deep border-accent' : 'bg-bg-panel text-text-muted border-border hover:border-accent hover:text-text-main'}`}
            onClick={() => switchTab(id)}
          >
            <span className="truncate max-w-[150px]">{tab.query}</span>
            {tab.loading && <span className="w-2 h-2 rounded-full bg-bg-deep animate-pulse" />}
            <button
              className="hover:text-danger hover:scale-110 transition-transform font-bold"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}