// monitor.ts — Sonarr/Radarr-style automation loop for the watchlist.
// Every interval it asks TMDB which monitored movies/series have targets due
// (movie release date passed, or episodes aired after the item was added and
// not yet grabbed) and hands each one to the grabber. Fully serialized —
// a tick never overlaps itself; state survives restarts via settings.
import { getSettings, updateSettings, type WatchlistItem } from './db'
import { listWatchlist, updateWatchlistItem, isGrabbed, getWatchlistItem } from './watchlist'
import { grab, type GrabTarget } from './grabber'
import { tmdbDetail, tmdbSeason } from './tmdb'
import { setupSearchEnv } from './python-run'
import { eventBus } from './event-bus'

export interface MonitorStatus {
  enabled: boolean
  intervalMinutes: number
  running: boolean
  lastRun: string | null
  lastSummary: { processed: number; grabbed: number; noSource: number; errors: number } | null
}

let tickTimer: NodeJS.Timeout | null = null
let running = false
let lastRun: string | null = null
let lastSummary: MonitorStatus['lastSummary'] = null

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoDateOf(isoOrDate: string): string {
  return String(isoOrDate || '').slice(0, 10)
}

/** Format SxxEyy with an air date for the watchlist next_episode cache. */
function fmtNext(season?: number, episode?: number, airDate?: string): string {
  if (!season || !episode) return ''
  const s = String(season).padStart(2, '0')
  const e = String(episode).padStart(2, '0')
  return `S${s}E${e}${airDate ? ` — ${isoDateOf(airDate)}` : ''}`
}

export function getMonitorStatus(): MonitorStatus {
  const s = getSettings()
  return {
    enabled: Boolean(s.monitor_enabled),
    intervalMinutes: Number(s.monitor_interval_minutes) || 30,
    running,
    lastRun,
    lastSummary,
  }
}

function log(...args: any[]): void {
  console.log(`[Monitor]`, ...args)
}

interface DueTarget {
  kind: 'movie' | 'episode'
  season?: number
  episode?: number
}

/** Compute the due targets for one watchlist item (no network — cached data only). */
function targetsForDetail(item: WatchlistItem, detail: any): DueTarget[] {
  const today = todayIso()
  const addedDate = isoDateOf(item.added_at)

  if (item.media_type === 'movie') {
    const releaseDate = isoDateOf(detail?.release_date || '')
    const status = detail?.status || ''
    if (!releaseDate) return [] // no release date yet — nothing to watch for
    const released = releaseDate <= today
    const cancelled = /cancelled|rumored/i.test(status)
    if (!released || cancelled) return []
    if (isGrabbed(item.tmdb_id, 'movie', null, null)) return []
    return [{ kind: 'movie' }]
  }

  // series: only the currently-airing season can contain "new since add" eps.
  const seasons: any[] = (detail?.seasons || []).filter((s: any) => Number(s.season_number) > 0)
  if (seasons.length === 0) return []
  const airing = seasons.filter((s: any) => !s.air_date || isoDateOf(s.air_date) <= today)
  if (airing.length === 0) return []
  const current = [...airing].sort((a, b) => Number(b.season_number) - Number(a.season_number))[0]
  return [{ kind: 'episode', season: Number(current.season_number) }]
}

/** Given the current season's episode list, which episodes are due? */
function dueEpisodes(item: WatchlistItem, seasonNumber: number, episodes: any[]): Array<{ season: number; episode: number }> {
  const today = todayIso()
  const addedDate = isoDateOf(item.added_at)
  const due: Array<{ season: number; episode: number }> = []
  for (const ep of episodes || []) {
    const airDate = isoDateOf(ep?.air_date || '')
    if (!airDate) continue // no air date → cannot verify "new since add"; skip (no backfill)
    if (airDate > today) continue // future
    if (airDate < addedDate) continue // aired before the item was added → backfill, not wanted
    const epNum = Number(ep?.episode_number)
    if (!epNum) continue
    if (isGrabbed(item.tmdb_id, 'series', seasonNumber, epNum)) continue
    due.push({ season: seasonNumber, episode: epNum })
  }
  return due
}

/** Refresh cached next_episode display string on the watchlist row. */
async function refreshNextEpisode(item: WatchlistItem, detail: any): Promise<void> {
  try {
    if (item.media_type !== 'series') return // movies have no per-episode counter
    const nex = detail?.next_episode_to_air
    if (nex?.season_number && nex?.episode_number) {
      updateWatchlistItem(item.id, { next_episode: fmtNext(nex.season_number, nex.episode_number, nex.air_date) })
    }
  } catch { /* cosmetic only */ }
}

const DETAIL_TTL_MS = 12 * 60 * 60 * 1000
const detailCache = new Map<number, { at: number; detail: any }>()

async function fetchDetailCached(item: WatchlistItem): Promise<any | null> {
  const cached = detailCache.get(item.tmdb_id)
  if (cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.detail
  try {
    const detail = await tmdbDetail(item.tmdb_id, item.media_type)
    if (detail) {
      detailCache.set(item.tmdb_id, { at: Date.now(), detail })
      return detail
    }
  } catch (e: any) {
    log(`detail fetch error for "${item.title}": ${e.message}`)
  }
  return cached?.detail ?? null
}

async function checkItem(item: WatchlistItem): Promise<{ status: string; grabbed: number }> {
  const detail = await fetchDetailCached(item)
  if (!detail) {
    updateWatchlistItem(item.id, { last_checked: new Date().toISOString() })
    return { status: 'no_metadata', grabbed: 0 }
  }
  // Persist imdb id + refreshed metadata when the detail provides them.
  if (!item.imdb_id && detail.imdb_id) updateWatchlistItem(item.id, { imdb_id: detail.imdb_id })
  await refreshNextEpisode(item, detail)

  const targets = targetsForDetail(item, detail)
  let grabbed = 0

  for (const t of targets) {
    if (t.kind === 'movie') {
      const out = await grab({
        watchlist_id: item.id,
        tmdb_id: item.tmdb_id,
        media_type: 'movie',
        imdb_id: item.imdb_id || detail.imdb_id || undefined,
        title: detail.original_title || item.title,
        year: detail.year || undefined,
        kind: 'movie',
        language_profile: item.language_profile,
      })
      grabbed += out.status === 'grabbed' ? 1 : 0
    } else if (t.season) {
      const epList = await tmdbSeason(item.tmdb_id, t.season)
      const due = dueEpisodes(item, t.season, epList?.episodes || [])
      for (const ep of due) {
        const out = await grab({
          watchlist_id: item.id,
          tmdb_id: item.tmdb_id,
          media_type: 'series',
          imdb_id: item.imdb_id || detail.imdb_id || undefined,
          title: detail.original_title || item.title,
          season: ep.season,
          episode: ep.episode,
          kind: 'episode',
          language_profile: item.language_profile,
        })
        if (out.status === 'grabbed') grabbed += 1
        else if (out.status === 'error') log(`grab error ${item.title} S${ep.season}E${ep.episode}: ${out.error}`)
      }
    }
  }
  updateWatchlistItem(item.id, { last_checked: new Date().toISOString() })
  return { status: 'ok', grabbed }
}

/** One full pass over the watchlist. Never runs concurrently with itself. */
export async function runMonitorTick(force = false): Promise<MonitorStatus['lastSummary']> {
  const settings = getSettings()
  if (!force && !settings.monitor_enabled) {
    log('disabled — skipping tick')
    return lastSummary
  }
  if (running) {
    log('already running — skipping')
    return lastSummary
  }
  running = true
  const summary = { processed: 0, grabbed: 0, noSource: 0, errors: 0 }
  try {
    setupSearchEnv(settings)
    const items = listWatchlist().filter((i) => i.monitored)
    log(`tick start — ${items.length} monitored item(s)`)
    for (const item of items) {
      summary.processed += 1
      try {
        const res = await checkItem(item)
        if (res.grabbed > 0) summary.grabbed += res.grabbed
        else if (res.status === 'no_metadata') summary.errors += 1
        else summary.noSource += 1
      } catch (e: any) {
        summary.errors += 1
        log(`item "${item.title}" failed: ${e.message}`)
      }
      // Be gentle with the provider sites: small pause between items.
      await new Promise((r) => setTimeout(r, 800))
    }
    const iso = new Date().toISOString()
    lastRun = iso
    updateSettings({ last_monitor_run: iso })
    lastSummary = summary
    log(`tick done — processed=${summary.processed} grabbed=${summary.grabbed} waiting=${summary.noSource} errors=${summary.errors}`)
    eventBus.emit('monitor-updated', { ...getMonitorStatus(), lastSummary: summary })
  } catch (e: any) {
    summary.errors += 1
    log(`tick crashed: ${e.message}`)
  } finally {
    running = false
  }
  return lastSummary
}

/** Background-safe kick (fire and forget, never blocks the HTTP response). */
export function kickMonitor(force = false): void {
  runMonitorTick(force).catch((e) => log(`background tick error: ${e.message}`))
}

/** Force a single item through the monitor right now (background). */
export function forceCheckItem(itemId: number): boolean {
  const item = getWatchlistItem(itemId)
  if (!item) return false
  const run = async () => {
    if (running) return
    running = true
    try {
      log(`force check — "${item.title}"`)
      const res = await checkItem(item)
      log(`force check done — ${item.title}: grabbed=${res.grabbed}`)
      updateSettings({ last_monitor_run: new Date().toISOString() })
      eventBus.emit('monitor-updated', { ...getMonitorStatus(), lastSummary })
    } finally {
      running = false
    }
  }
  run().catch((e) => log(`force check error: ${e.message}`))
  return true
}

export function startMonitor(): void {
  stopMonitor()
  const settings = getSettings()
  const minutes = Math.max(5, Number(settings.monitor_interval_minutes) || 30)
  log(`starting — interval ${minutes} min (enabled=${Boolean(settings.monitor_enabled)})`)
  if (settings.monitor_enabled) {
    // Initial pass shortly after boot, then on the interval.
    setTimeout(() => kickMonitor(), 8_000)
  }
  tickTimer = setInterval(() => {
    const s = getSettings()
    if (s.monitor_interval_minutes !== minutes) {
      // Settings changed — restart the loop with the new interval.
      startMonitor()
      return
    }
    if (s.monitor_enabled) kickMonitor()
  }, minutes * 60 * 1000)
}

export function stopMonitor(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

export function getMonitorLastSummary(): MonitorStatus['lastSummary'] {
  return lastSummary
}

// Keep the detail cache bounded.
setInterval(() => {
  if (detailCache.size > 200) detailCache.clear()
}, 60 * 60 * 1000).unref?.()
