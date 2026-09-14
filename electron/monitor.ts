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
import { listWatchlist, updateWatchlistItem, isGrabbed, getWatchlistItem, englishGrabbedRows, markReplacePending, latestGrabFor } from './watchlist'
import { getAttempt, attemptsForTitle, recordAttempt, deleteAttempt, nextDelayMinutes, type MonitorAttempt } from './attempts'
import { grab, findLatinoForUpgrade, type GrabTarget, type GrabOutcome } from './grabber'
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
  log(`→ intento ${attemptNumber} — ${label} (perfil: ${profile})`)

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
  // El latino ya está publicado en la web (sólo descarga directa): NO es una
  // falta de fuente, es una espera deliberada a que salga el torrent latino.
  if (outcome.latinoDdl) {
    const ddl = (outcome.latinoDdl.ddl || []).slice(0, 3).join(', ')
    log(`⏳ ${label} latino ya publicado en Cinecalidad${ddl ? ` (${ddl})` : ''} — sólo descarga directa, no se baja inglés; reintento en ${delayMin} min`)
    return 'waiting'
  }
  if (outcome.status === 'error') {
    log(`✗ ${label} error: ${outcome.error} — reintento en ${delayMin} min`)
    return 'error'
  }
  if (attemptNumber === 1) {
    log(`— ${label} sin fuente latino/EN todavía — reintento en ${delayMin} min`)
  } else {
    console.debug(`[Monitor] ${label}: aún sin fuente (intento ${attemptNumber}) — próxima ventana en ${delayMin} min`)
  }
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
    const movieState = movieTargets.length
      ? (movieTargets[0].tracked ? 'reintento (backoff)' : 'estrenada — intento inmediato')
      : isGrabbed(item.tmdb_id, 'movie', null, null)
        ? 'ya descargada'
        : 'futura / no disponible'
    console.debug(`[Monitor] "${item.title}" (película) — ${movieState}`)
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

  const seasonTag = airedSeasons.length > 0 ? `S${Number([...airedSeasons].sort((a: any, b: any) => Number(b.season_number) - Number(a.season_number))[0].season_number)}` : '—'
  const targetNames = targets
    .map((t) => (t.kind === 'movie' ? 'película' : `${t.tracked ? '*' : ''}S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}`))
    .join(', ')
  if (targets.length > 0) {
    console.debug(`[Monitor] "${item.title}" [${seasonTag} · alcance ${scope}] → ${targets.length} objetivo(s): ${targetNames}`)
  } else {
    console.debug(`[Monitor] "${item.title}" [${seasonTag} · alcance ${scope}] — sin objetivos (idle)`)
  }

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

// ── Calendario de descargas programadas ──────────────────

export interface CalendarEvent {
  date: string
  itemId: number
  title: string
  tmdb_id: number
  media_type: 'movie' | 'series'
  kind: 'episode' | 'movie'
  season: number | null
  episode: number | null
  episode_name: string
  poster: string
  language_profile: string
  scope: string
  grabbed: boolean
}

export interface CalendarPayload {
  events: CalendarEvent[]
  days: number
  generated_at: string
  window: { from: string; to: string }
}

let calendarCache: { at: number; days: number; payload: CalendarPayload } | null = null
const CALENDAR_TTL_MS = 30 * 60 * 1000

function addDaysIso(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Descargas programadas: episodios (temporada actual y siguiente) y películas
 * con fecha de estreno dentro de la ventana. Marca las ya descargadas.
 */
export async function getCalendar(days = 60, force = false): Promise<CalendarPayload> {
  if (!force && calendarCache && calendarCache.days === days && Date.now() - calendarCache.at < CALENDAR_TTL_MS) {
    return calendarCache.payload
  }
  const today = todayIso()
  const to = addDaysIso(today, days)
  const items = listWatchlist().filter((i) => i.monitored)
  const events: CalendarEvent[] = []

  const processItem = async (item: WatchlistItem) => {
    const detail = await fetchDetailCached(item)
    if (!detail) return
    const poster = item.poster || detail?.poster || ''

    if (item.media_type === 'movie') {
      const rel = isoDateOf(detail?.release_date || '')
      if (!rel || rel < today || rel > to) return
      events.push({
        date: rel, itemId: item.id, title: item.title, tmdb_id: item.tmdb_id,
        media_type: 'movie', kind: 'movie', season: null, episode: null, episode_name: '',
        poster, language_profile: item.language_profile, scope: '',
        grabbed: isGrabbed(item.tmdb_id, 'movie', null, null),
      })
      return
    }

    const seasons: any[] = (detail?.seasons || []).filter((s: any) => Number(s.season_number) > 0)
    if (seasons.length === 0) return
    const aired = seasons.filter((s: any) => !s.air_date || isoDateOf(s.air_date) <= today)
    const currentNum = aired.length
      ? Math.max(...aired.map((s: any) => Number(s.season_number)))
      : Math.min(...seasons.map((s: any) => Number(s.season_number)))

    for (const sn of new Set<number>([currentNum, currentNum + 1])) {
      if (!seasons.some((s: any) => Number(s.season_number) === sn)) continue
      let season: any = null
      try { season = await tmdbSeason(item.tmdb_id, sn) } catch { continue }
      for (const ep of season?.episodes || []) {
        const date = isoDateOf(ep?.air_date || '')
        if (!date || date < today || date > to) continue
        const epNum = Number(ep.episode_number)
        events.push({
          date, itemId: item.id, title: item.title, tmdb_id: item.tmdb_id,
          media_type: 'series', kind: 'episode', season: sn, episode: epNum,
          episode_name: ep.name || '', poster, language_profile: item.language_profile,
          scope: item.backfill || 'new',
          grabbed: isGrabbed(item.tmdb_id, 'series', sn, epNum),
        })
      }
    }
  }

  // Pool pequeño: cada título cuesta 1-2 llamadas a TMDB.
  const queue = [...items]
  const workers = Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, async () => {
    while (queue.length > 0) {
      const it = queue.shift()
      if (it) await processItem(it)
    }
  })
  await Promise.all(workers)

  events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
  const payload: CalendarPayload = { events, days, generated_at: new Date().toISOString(), window: { from: today, to } }
  calendarCache = { at: Date.now(), days, payload }
  console.log(`[calendar] ${events.length} descarga(s) programada(s) entre ${today} y ${to}`)
  return payload
}

// Keep the detail cache bounded.
setInterval(() => {
  if (detailCache.size > 200) detailCache.clear()
}, 60 * 60 * 1000).unref?.()

// ── Escáner manual de reemplazo EN → latino ──────────────
// El usuario prefiere decidir: Verificar busca de nuevo y, si hay versión
// latina de algo ya descargado EN, el programa le PREGUNTA antes de
// reemplazar. El monitor NUNCA hace upgrades solo.

export interface UpgradeOffer {
  season: number | null
  episode: number | null
  kind: 'movie' | 'episode'
  release: string
  size: string
  indexer: string
  current: string // título EN actual (history)
}

interface ScanState {
  state: 'idle' | 'scanning' | 'done'
  hadEnglish: boolean
  offers: UpgradeOffer[]
  startedAt: string
  finishedAt?: string
}

const upgradeScans = new Map<number, ScanState>()

export function getUpgradeScan(itemId: number): ScanState {
  return upgradeScans.get(itemId) || { state: 'idle', hadEnglish: false, offers: [], startedAt: '' }
}

export function startUpgradeScan(itemId: number): boolean {
  const current = getUpgradeScan(itemId)
  if (current.state === 'scanning') return true
  const item = getWatchlistItem(itemId)
  if (!item) return false
  upgradeScans.set(itemId, { state: 'scanning', hadEnglish: false, offers: [], startedAt: new Date().toISOString() })
  runUpgradeScan(item).catch((e) => console.error('[upgrade] scan error:', e.message))
  return true
}

async function runUpgradeScan(item: WatchlistItem): Promise<void> {
  const rows = englishGrabbedRows(item.id, 4)
  const state = upgradeScans.get(item.id)!
  state.hadEnglish = rows.length > 0
  if (rows.length === 0) {
    state.state = 'done'
    state.finishedAt = new Date().toISOString()
    return
  }
  const detail = await fetchDetailCached(item)
  for (const row of rows) {
    const target: GrabTarget = {
      watchlist_id: item.id,
      tmdb_id: item.tmdb_id,
      media_type: item.media_type,
      imdb_id: item.imdb_id || detail?.imdb_id || undefined,
      title: detail?.original_title || item.title,
      year: detail?.year || item.year || undefined,
      kind: row.kind === 'movie' ? 'movie' : 'episode',
      season: row.season ?? undefined,
      episode: row.episode ?? undefined,
      language_profile: 'latino_only',
      mode: 'upgrade',
    }
    const best = await findLatinoForUpgrade(target)
    const st = upgradeScans.get(item.id)!
    if (best) {
      st.offers.push({
        season: row.season,
        episode: row.episode,
        kind: row.kind === 'movie' ? 'movie' : 'episode',
        release: best.title,
        size: best.size,
        indexer: best.indexer,
        current: row.title || 'descarga EN',
      })
    }
  }
  const st = upgradeScans.get(item.id)!
  st.state = 'done'
  st.finishedAt = new Date().toISOString()
  console.log(`[upgrade] "${item.title}": ${st.hadEnglish ? `escaneo terminado — ${st.offers.length} versión(es) latina(s) disponible(s)` : 'sin descargas EN que reemplazar'}`)
}

export interface UpgradeResult {
  ok: boolean
  error?: string
  grabbed?: boolean
}

export async function applyUpgrade(itemId: number, season: number | null, episode: number | null): Promise<UpgradeResult> {
  const item = getWatchlistItem(itemId)
  if (!item) return { ok: false, error: 'Watchlist item not found' }
  const isMovie = season === null || season === undefined
  const detail = await fetchDetailCached(item)
  const target: GrabTarget = {
    watchlist_id: item.id,
    tmdb_id: item.tmdb_id,
    media_type: item.media_type,
    imdb_id: item.imdb_id || detail?.imdb_id || undefined,
    title: detail?.original_title || item.title,
    year: detail?.year || item.year || undefined,
    kind: isMovie ? 'movie' : 'episode',
    season: isMovie ? undefined : (season as number),
    episode: isMovie ? undefined : (episode as number),
    language_profile: 'latino_only',
    mode: 'upgrade',
  }
  const outcome = await grab(target)
  if (outcome.status !== 'grabbed') {
    const why = outcome.status === 'no_source'
      ? 'No hay versión latina todavía — reintenta más tarde'
      : outcome.error || 'Fallo desconocido'
    return { ok: false, error: why }
  }
  // Marca la(s) fila(s) EN antigua(s) como reemplazo pendiente; el worker
  // borra el archivo EN cuando el latino termine de descargarse local.
  const fresh = latestGrabFor(item.tmdb_id, item.media_type, isMovie ? null : (season as number), isMovie ? null : (episode as number))
  if (fresh && fresh.id) {
    try {
      markReplacePending(item.tmdb_id, item.media_type, isMovie ? null : (season as number), isMovie ? null : (episode as number), fresh.id)
    } catch (e: any) {
      console.error('[upgrade] markReplacePending failed:', e.message)
    }
  }
  // Quita de las ofertas lo ya resuelto.
  const st = upgradeScans.get(item.id)
  if (st) {
    st.offers = st.offers.filter((o) => o.season !== (isMovie ? null : season) || o.episode !== (isMovie ? null : episode))
    if (st.offers.length === 0) st.state = 'done'
  }
  console.log(`[upgrade] ✓ "${item.title}"${isMovie ? '' : ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`} → latino (${outcome.source}) — EN será reemplazado al completar`)
  return { ok: true, grabbed: true }
}
