import { create } from 'zustand'

export interface TMDBItem {
  id: number
  title: string
  overview: string
  poster: string | null
  backdrop: string | null
  year: string
  rating: number
  media_type: string
  imdb_id?: string
  runtime?: number
  genres?: string[]
  seasons?: SeasonInfo[]
}

export interface SeasonInfo {
  season_number: number
  name: string
  episode_count: number
  poster: string | null
}

export interface EpisodeInfo {
  episode_number: number
  name: string
  overview: string
  still: string | null
  air_date: string
}

export interface TMDBLists {
  movies: Record<string, TMDBItem[]>
  tv: Record<string, TMDBItem[]>
}

export interface DiscoverResult {
  title: string
  size: string
  seeders: number
  peers: number
  link: string
  indexer: string
  info_hash: string | null
}

interface DiscoverState {
  // TMDB lists
  lists: TMDBLists | null
  listsLoading: boolean
  listsError: string | null

  // Browse state
  listType: 'trending' | 'popular' | 'top_rated'
  mediaTab: 'movies' | 'tv'

  // Detail view
  detailItem: TMDBItem | null
  detailLoading: boolean

  // Series picker
  selectedSeason: SeasonInfo | null
  episodes: EpisodeInfo[] | null
  episodesLoading: boolean
  selectedEpisode: EpisodeInfo | null

  // Provider search
  providerResults: DiscoverResult[] | null
  providerLoading: boolean
  currentProvider: string | null

  // Has TMDB key configured
  hasKey: boolean

  // Actions
  setLists: (lists: TMDBLists) => void
  setListsError: (error: string) => void
  setListType: (type: 'trending' | 'popular' | 'top_rated') => void
  setMediaTab: (tab: 'movies' | 'tv') => void
  setDetailItem: (item: TMDBItem | null) => void
  setDetailLoading: (loading: boolean) => void
  setSelectedSeason: (season: SeasonInfo | null) => void
  setEpisodes: (episodes: EpisodeInfo[] | null) => void
  setSelectedEpisode: (ep: EpisodeInfo | null) => void
  appendProviderResults: (results: DiscoverResult[]) => void
  setCurrentProvider: (provider: string | null) => void
  setProviderLoading: (loading: boolean) => void
  clearProviderSearch: () => void
  setHasKey: (has: boolean) => void
  reset: () => void
}

// Latino-first ordering: Cinecalidad (CC) → TCL → Comet, stable within provider.
const LATINO_PRIORITY: Record<string, number> = { CC: 0, TCL: 1, Comet: 2 }

export const useDiscoverStore = create<DiscoverState>((set, get) => ({
  lists: null,
  listsLoading: false,
  listsError: null,
  listType: 'trending',
  mediaTab: 'movies',
  detailItem: null,
  detailLoading: false,
  selectedSeason: null,
  episodes: null,
  episodesLoading: false,
  selectedEpisode: null,
  providerResults: null,
  providerLoading: false,
  currentProvider: null,
  hasKey: false,

  setLists: (lists) => set({ lists, listsLoading: false, listsError: null }),
  setListsError: (error) => set({ listsError: error, listsLoading: false }),
  setListType: (listType) => set({ listType }),
  setMediaTab: (mediaTab) => set({ mediaTab }),
  setDetailItem: (item) => set({ detailItem: item, detailLoading: false }),
  setDetailLoading: (loading) => set({ detailLoading: loading }),
  setSelectedSeason: (season) => set({
    selectedSeason: season,
    episodes: null,
    selectedEpisode: null,
    providerResults: null,
    episodesLoading: !!season,
  }),
  setEpisodes: (episodes) => set({ episodes, episodesLoading: false }),
  setSelectedEpisode: (ep) => set({ selectedEpisode: ep, providerResults: null, providerLoading: false }),

  appendProviderResults: (newResults) => {
    const existing = get().providerResults ?? []
    const seen = new Map<string, DiscoverResult>()
    for (const r of existing) {
      const key = r.info_hash || r.link || ''
      if (key) seen.set(key, r)
    }
    for (const r of newResults) {
      const key = r.info_hash || r.link || ''
      if (!key) continue
      const old = seen.get(key)
      if (!old || r.seeders > old.seeders) {
        seen.set(key, r)
      }
    }
    set({
      providerResults: [...seen.values()].sort((a, b) => {
        const pa = LATINO_PRIORITY[a.indexer] ?? 99
        const pb = LATINO_PRIORITY[b.indexer] ?? 99
        return pa - pb
      })
    })
  },

  setCurrentProvider: (provider) => set({ currentProvider: provider }),
  setProviderLoading: (loading) => set({ providerLoading: loading }),
  clearProviderSearch: () => set({
    detailItem: null,
    selectedSeason: null,
    episodes: null,
    selectedEpisode: null,
    providerResults: null,
    providerLoading: false,
    currentProvider: null,
  }),
  setHasKey: (has) => set({ hasKey: has }),
  reset: () => set({
    detailItem: null,
    selectedSeason: null,
    episodes: null,
    selectedEpisode: null,
    providerResults: null,
    providerLoading: false,
    currentProvider: null,
  }),
}))
