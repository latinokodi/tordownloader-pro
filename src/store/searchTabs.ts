import { create } from 'zustand'

export interface SearchResult {
  title: string | null
  size: string | null
  seeders: number
  peers: number
  link: string | null
  indexer: string
  info_hash: string | null
}

export interface SearchTab {
  query: string
  results: SearchResult[] | null
  loading: boolean
  error: string | null
}

interface SearchTabsState {
  tabs: Record<string, SearchTab>
  activeTabId: string | null
  counter: number
  addTab: (query: string) => string
  setTabResult: (id: string, results: SearchResult[]) => void
  setTabError: (id: string, error: string) => void
  switchTab: (id: string) => void
  closeTab: (id: string) => void
}

export const useSearchTabsStore = create<SearchTabsState>((set, get) => ({
  tabs: {},
  activeTabId: null,
  counter: 0,

  addTab: (query) => {
    const id = String(get().counter + 1)
    set((s) => ({
      counter: s.counter + 1,
      activeTabId: id,
      tabs: {
        ...s.tabs,
        [id]: { query, results: null, loading: true, error: null },
      },
    }))
    return id
  },

  setTabResult: (id, results) =>
    set((s) => ({
      tabs: { ...s.tabs, [id]: { ...s.tabs[id], results, loading: false } },
    })),

  setTabError: (id, error) =>
    set((s) => ({
      tabs: { ...s.tabs, [id]: { ...s.tabs[id], error, loading: false } },
    })),

  switchTab: (id) => set({ activeTabId: id }),

  closeTab: (id) =>
    set((s) => {
      const { [id]: _, ...remaining } = s.tabs
      const ids = Object.keys(remaining)
      const newActive =
        s.activeTabId === id ? (ids.length > 0 ? ids[ids.length - 1] : null) : s.activeTabId
      return { tabs: remaining, activeTabId: newActive }
    }),
}))
