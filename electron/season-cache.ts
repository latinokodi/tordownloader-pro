// Season resolution cache (in-memory, session-only): stores per-episode search
// results for a (series imdbId + season) so re-opening the season download
// within the same app session doesn't re-run the latino providers / metasearch
// (which hit the streaming sites). The cache lives in the main process and is
// cleared automatically when the app closes or is reopened.

interface SeasonCacheEntry {
  ts: number
  episodes: Record<string, unknown[]>
}

const cache = new Map<string, SeasonCacheEntry>()
const MAX_ENTRIES = 100

/** Cached per-episode results for a series season, or null. */
export function getSeasonCache(imdbId: string, season: number): SeasonCacheEntry | null {
  const entry = cache.get(`${imdbId}:${season}`)
  if (!entry || typeof entry.episodes !== 'object' || entry.episodes === null) return null
  return entry
}

/** Save resolved per-episode results for a series season (bounded). */
export function saveSeasonCache(imdbId: string, season: number, episodes: Record<string, unknown[]>): void {
  if (cache.size >= MAX_ENTRIES) {
    // Evict the oldest entry to keep memory bounded.
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts
        oldestKey = k
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }
  cache.set(`${imdbId}:${season}`, { ts: Date.now(), episodes: episodes || {} })
}
