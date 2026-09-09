// monitor.ts — Sonarr/Radarr-style automation loop for the watchlist.
//
// Semantics (matching how Sonarr/Radarr actually work):
//  - The TMDB air/release DATE decides when a target becomes WANTED.
//    Nothing is searched before it is wanted.
//  - When a target becomes wanted the monitor attempts it once right away
//    (next tick after the date passes), then only retries on a decaying
//    backoff schedule (attempts.ts: 1h → 2h → 4h → 8h → 12h → daily),
//    persisted across restarts. Ticks are cheap dispatchers, not blanket
//    per-episode searches every cycle.
//  - A target stops being wanted once grabbed or the item is removed.
import { getSettings, updateSettings, type WatchlistItem, type BackfillScope } from './db'
import { listWatchlist, updateWatchlistItem, isGrabbed, getWatchlistItem } from './watchlist'
import { getAttempt, attemptsForTitle, recordAttempt, deleteAttempt, nextDelayMinutes, type MonitorAttempt } from './attempts'
import { grab, type GrabTarget, type GrabOutcome } from './grabber'
import { tmdbDetail, tmdbSeason } from './tmdb'
import { setupSearchEnv } from './python-run'
import { eventBus } from './event-bus'

export interface MonitorStatus {
  enabled: boolean
  intervalMinutes: number
  running: boolean
  lastRun: string | null
  lastSummary: { processed: number; grabbed: number; waiting: number; deferred: number; errors: number } | null
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
  // true = already in the attempts table (backoff state exists, retry path)
  tracked?: boolean
}

// Backfill scopes (Sonarr-style "what to download when I add this series").
const MAX_TARGETS_PER_TICK = 5 // big backfills spread across ticks, politely
const SEASON_SCAN_BUDGET = 6 // max TMDB season fetches per series per tick
const scanCursor = new Map<number, number>() // rotation cursor for 'all' scope

/**
 * Episodes of ONE season that are wanted under the item's backfill scope.
 * Rules (aired-only; future handled by later ticks):
 *   new          → air_date >= item.added_at (no backfill)
 *   last_episode → the single most recently aired episode of the current
 *                  season, plus everything airing from the add date onward
 *   last_season  → every aired episode of the current season
 *   first_season → every aired episode of season 1
 *   all          → every aired episode of every season
 */
async function seasonWantedEpisodes(
  item: WatchlistItem,
  seasonNumber: number,
  scope: BackfillScope,
  currentSeason: number,
): Promise<DueTarget[]> {
  const today = todayIso()
  const addedDate = isoDateOf(item.added_at)
  const epList = await tmdbSeason(item.tmdb_id, seasonNumber)
  const episodes: any[] = epList?.episodes || []

  let latestAired: string | null = null
  if (scope === 'last_episode' && seasonNumber === currentSeason) {
    for (const ep of episodes) {
      const airDate = isoDateOf(ep?.air_date || '')
      if (airDate && airDate <= today && (!latestAired || airDate > latestAired)) latestAired = airDate
    }
  }

  const out: DueTarget[] = []
  for (const ep of episodes) {
    const airDate = isoDateOf(ep?.air_date || '')
    if (!airDate || airDate > today) continue // unaired or no date
    const epNum = Number(ep?.episode_number)
    if (!epNum) continue
    const postAdd = airDate >= addedDate

    let allowed = false
    if (scope === 'new') allowed = postAdd
    else if (scope === 'last_episode') allowed = postAdd || airDate === latestAired
    else if (scope === 'last_season') allowed = postAdd || seasonNumber === currentSeason
    else if (scope === 'first_season') allowed = postAdd || seasonNumber === 1
    else allowed = true // 'all'
    if (!allowed) continue

    if (isGrabbed(item.tmdb_id, 'series', seasonNumber, epNum)) continue
    out.push({
      kind: 'episode',
      season: seasonNumber,
      episode: epNum,
      tracked: Boolean(getAttempt(item.tmdb_id, 'series', seasonNumber, epNum)),
    })
  }
  return out
}

/** One grab attempt for a concrete wanted target, with backoff bookkeeping. */
async function attemptTarget(item: WatchlistItem, detail: any, target: DueTarget): Promise<'grabbed' | 'waiting' | 'error'> {
  const isMovie = target.kind === 'movie'
  const season = isMovie ? null : (target.season ?? null)
  const episode = isMovie ? null : (target.episode ?? null)

  const profile = item.language_profile
  const attemptNumber = (getAttempt(item.tmdb_id, item.media_type, season, episode)?.attempts || 0) + 1
  const label = isMovie
    ? `"${item.title}"`
    : `"${item.title}" S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`

  const targetForGrab: GrabTarget = {
    watchlist_id: item.id,
    tmdb_id: item.tmdb_id,
    media_type: item.media_type,
    imdb_id: item.imdb_id || detail?.imdb_id || undefined,
    title: detail?.original_title || item.title,
    year: detail?.year || undefined,
    kind: isMovie ? 'movie' : 'episode',
    season: season ?? undefined,
    episode: episode ?? undefined,
    language_profile: profile,
  }

  let outcome: GrabOutcome
  try {
    outcome = await grab(targetForGrab)
  } catch (e: any) {
    outcome = { ok: false, status: 'error', error: e?.message || String(e), latinoResults: 0, englishResults: 0, profile }
  }

  if (outcome.status === 'grabbed') {
    deleteAttempt(item.tmdb_id, item.media_type, season, episode)
    log(`✓ ${label} → ${outcome.language} (${outcome.source}) [${outcome.service}]`)
    return 'grabbed'
  }

  // Missed (no source) or failed — schedule the next attempt with backoff.
  const delayMin = nextDelayMinutes(attemptNumber)
  recordAttempt(item.tmdb_id, item.media_type, season, episode, isMovie ? 'movie' : 'episode', profile, delayMin)
  if (outcome.status === 'error') {
    log(`✗ ${label} error: ${outcome.error} — reintento en ${delayMin} min`)
    return 'error'
  }
  if (attemptNumber === 1) log(`— ${label} sin fuente latino/EN todavía — reintento en ${delayMin} min`)
  return 'waiting'
}

async function refreshNextEpisode(item: WatchlistItem, detail: any): Promise<void> {
  try {
    if (item.media_type !== 'series') return
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

async function checkItem(item: WatchlistItem): Promise<{ grabbed: number; waiting: number; deferred: number; errors: number }> {
  const res = { grabbed: 0, waiting: 0, deferred: 0, errors: 0 }
  const detail = await fetchDetailCached(item)
  if (!detail) {
    res.errors += 1
    updateWatchlistItem(item.id, { last_checked: new Date().toISOString() })
    return res
  }
  if (!item.imdb_id && detail.imdb_id) updateWatchlistItem(item.id, { imdb_id: detail.imdb_id })
  await refreshNextEpisode(item, detail)

  if (item.media_type === 'movie') {
    const movieTargets: DueTarget[] = []
    const trackedMovie = getAttempt(item.tmdb_id, 'movie', null, null)
    if (trackedMovie) {
      movieTargets.push({ kind: 'movie', tracked: true })
    } else {
      const releaseDate = isoDateOf(detail?.release_date || '')
      const status = detail?.status || ''
      if (releaseDate && releaseDate <= todayIso() && !/cancelled|rumored/i.test(status) && !isGrabbed(item.tmdb_id, 'movie', null, null)) {
        movieTargets.push({ kind: 'movie' }) // wanted right now — first attempt
      }
    }
    for (const t of movieTargets) {
      if (t.tracked) {
        const att = getAttempt(item.tmdb_id, 'movie', null, null)
        if (!att) continue // row vanished — nothing to retry
        if (att.next_attempt && att.next_attempt > new Date().toISOString()) {
          res.deferred += 1
          continue
        }
        if (isGrabbed(item.tmdb_id, 'movie', null, null)) {
          deleteAttempt(item.tmdb_id, 'movie', null, null)
          continue
        }
      }
      const state = await attemptTarget(item, detail, t)
      if (state === 'grabbed') res.grabbed += 1
      else if (state === 'error') res.errors += 1
      else res.waiting += 1
    }
    // Idle (not wanted yet) items simply contribute nothing to the summary.
    updateWatchlistItem(item.id, { last_checked: new Date().toISOString() })
    return res
  }

  // series — wanted episodes depend on the per-title backfill scope.
  const scope: BackfillScope = item.backfill || 'new'
  const airedSeasons: any[] = (detail?.seasons || [])
    .filter((s: any) => Number(s.season_number) > 0)
    .filter((s: any) => !s.air_date || isoDateOf(s.air_date) <= todayIso())
  const fresh: DueTarget[] = []

  if (airedSeasons.length > 0) {
    const byNumDesc = (a: any, b: any) => Number(b.season_number) - Number(a.season_number)
    const currentNum = Number([...airedSeasons].sort(byNumDesc)[0].season_number)

    // Which seasons may hold wanted episodes under this scope?
    let seasonNumbers: number[] = [currentNum]
    if (scope === 'first_season') {
      seasonNumbers = Array.from(new Set([1, currentNum]))
    } else if (scope === 'all') {
      const allNums = airedSeasons.map((s: any) => Number(s.season_number)).sort((a, b) => b - a)
      if (allNums.length > SEASON_SCAN_BUDGET) {
        const cursor = scanCursor.get(item.tmdb_id) || 0
        const window = allNums.slice(cursor, cursor + SEASON_SCAN_BUDGET)
        if (window.length < SEASON_SCAN_BUDGET) window.push(...allNums.slice(0, SEASON_SCAN_BUDGET - window.length))
        scanCursor.set(item.tmdb_id, (cursor + SEASON_SCAN_BUDGET) % allNums.length)
        seasonNumbers = Array.from(new Set([currentNum, ...window]))
      } else {
        seasonNumbers = allNums
      }
    }
    // 'new' | 'last_episode' | 'last_season' → [currentNum] only.

    for (const sn of seasonNumbers) {
      fresh.push(...(await seasonWantedEpisodes(item, sn, scope, currentNum)))
      if (fresh.length >= MAX_TARGETS_PER_TICK) break
    }
  }

  // Tracked rows from any season always keep their backoff retry schedule,
  // even when the season is outside this tick's scan window.
  for (const a of attemptsForTitle(item.tmdb_id)) {
    if (a.kind !== 'episode' || a.season === null || a.episode === null) continue
    const already = fresh.some((c) => c.season === a.season && c.episode === a.episode)
    if (!already) fresh.push({ kind: 'episode', season: a.season, episode: a.episode, tracked: true })
  }

  // Newest targets first; backfills are capped per tick.
  fresh.sort((a, b) => (b.season! - a.season!) || (b.episode! - a.episode!))
  const targets = fresh.slice(0, MAX_TARGETS_PER_TICK)

  for (const t of targets) {
    if (t.tracked) {
      const att = getAttempt(item.tmdb_id, 'series', t.season!, t.episode!)
      if (att && att.next_attempt && att.next_attempt > new Date().toISOString()) {
        res.deferred += 1
        continue
      }
      // Episode got grabbed out-of-band (manual download)? Drop the row.
      if (isGrabbed(item.tmdb_id, 'series', t.season!, t.episode!)) {
        deleteAttempt(item.tmdb_id, 'series', t.season!, t.episode!)
        continue
      }
    }
    const state = await attemptTarget(item, detail, t)
    if (state === 'grabbed') res.grabbed += 1
    else if (state === 'error') res.errors += 1
    else res.waiting += 1
  }
  // Idle series (nothing wanted under its scope) contribute nothing.
  updateWatchlistItem(item.id, { last_checked: new Date().toISOString() })
  return res
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
  const summary = { processed: 0, grabbed: 0, waiting: 0, deferred: 0, errors: 0 }
  try {
    setupSearchEnv(settings)
    const items = listWatchlist().filter((i) => i.monitored)
    log(`tick start — ${items.length} monitored item(s)`)
    for (const item of items) {
      summary.processed += 1
      try {
        const res = await checkItem(item)
        summary.grabbed += res.grabbed
        summary.waiting += res.waiting
        summary.deferred += res.deferred
        summary.errors += res.errors
      } catch (e: any) {
        summary.errors += 1
        log(`item "${item.title}" failed: ${e.message}`)
      }
      await new Promise((r) => setTimeout(r, 800))
    }
    const iso = new Date().toISOString()
    lastRun = iso
    updateSettings({ last_monitor_run: iso })
    lastSummary = summary
    log(`tick done — processed=${summary.processed} grabbed=${summary.grabbed} waiting=${summary.waiting} deferred=${summary.deferred} errors=${summary.errors}`)
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
      log(`force check done — ${item.title}: grabbed=${res.grabbed} waiting=${res.waiting} errors=${res.errors}`)
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
    setTimeout(() => kickMonitor(), 8_000)
  }
  tickTimer = setInterval(() => {
    const s = getSettings()
    if (s.monitor_interval_minutes !== minutes) {
      startMonitor() // settings changed — restart the loop with the new interval
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
