// grabber.ts — automated grab engine: given a concrete target (movie or a
// single episode), search latino providers first, fall back to English
// (Jackett) per the item's language profile, rank the candidates, then add
// the winner to the debrid service and snapshot the exact destination folder
// on the download row so the worker routes it without re-parsing.
import path from 'path'
import { getSettings, addDownload, getDownloadByTorboxId, updateDownload, getBadReleaseHashes, getBadReleaseTitles, normalizeReleaseTitle, type Settings, type DebridService, type LanguageProfile } from './db'
import { recordGrab } from './watchlist'
import { runPythonLines, setupSearchEnv } from './python-run'
import { computeDestination, safeSegment, seriesNameMatches, releaseYear } from './media-layout'
import { TorboxAPI } from './torbox'
import { RealDebridAPI } from './realdebrid'
import { eventBus } from './event-bus'
import { tmdbDetail } from './tmdb'

export type GrabLanguage = 'latino' | 'english'

export interface GrabTarget {
  watchlist_id: number
  tmdb_id: number
  media_type: 'movie' | 'series'
  imdb_id?: string
  title: string
  original_title?: string
  year?: string
  kind: 'movie' | 'episode'
  season?: number
  episode?: number
  language_profile: LanguageProfile
  /** 'upgrade' = solo fase latino, para reemplazo manual EN → latino. */
  mode?: 'upgrade'
}

export interface GrabResultItem {
  title: string
  size: string
  seeders: number
  peers: number
  link: string
  indexer: string
  info_hash: string | null
  latino: boolean
}

export interface GrabOutcome {
  ok: boolean
  status: 'grabbed' | 'no_source' | 'error'
  language?: 'latino' | 'english'
  source?: string
  service?: DebridService
  torbox_id?: string
  title?: string
  error?: string
  latinoResults: number
  englishResults: number
  profile: LanguageProfile
  /** El latino ya está publicado en la web (sólo descarga directa) → no se baja inglés. */
  latinoDdl?: { url: string; ddl: string[] }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function numSeeders(r: GrabResultItem): number {
  const n = Number(r.seeders)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function hashFromLink(link: string): string | null {
  if (!link) return null
  const m = link.match(/btih:([a-fA-F0-9]{40})/)
  return m ? m[1].toLowerCase() : null
}

/** Normalize a size field ("5.4 GB", "1234567", "2,1GB", "0 B") to bytes. */
export function parseSizeBytes(size: unknown): number | null {
  if (size === null || size === undefined) return null
  if (typeof size === 'number') return Number.isFinite(size) && size >= 0 ? Math.round(size) : null
  const s = String(size).trim().toLowerCase().replace(/\s+/g, '').replace(',', '.')
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)(b|bytes?|kb|mb|gb|tb)?$/)
  if (!m) return null
  const val = parseFloat(m[1])
  if (!Number.isFinite(val)) return null
  const unit = m[2]
  if (!unit) {
    const raw = Number(s)
    return Number.isFinite(raw) ? Math.round(raw) : null
  }
  const mult: Record<string, number> = { b: 1, bytes: 1, byte: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }
  return Math.round(val * (mult[unit] ?? 1))
}

export function exceedsMaxBytes(result: GrabResultItem, maxBytes: number | null): boolean {
  if (!maxBytes) return false
  const bytes = parseSizeBytes(result.size)
  if (bytes === null || bytes <= 0) return false // unknown size — never block on it
  return bytes > maxBytes
}

/** Collect every SxxExx pair mentioned in a release title. */
function epMarkers(title: string): Array<{ s: number; e: number }> {
  const out: Array<{ s: number; e: number }> = []
  const re = /\bs(\d{1,2})\s*e(\d{1,2})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(title))) out.push({ s: parseInt(m[1], 10), e: parseInt(m[2], 10) })
  return out
}

function hasSeasonPackToken(title: string): boolean {
  return /(season|temporada|serie completa|complete series|full season|complete season)\s*\d*|(^|\W)(s\d{1,2})\s*(completa|completo|full|complete)(\W|$)/i.test(title)
}

/** Score a candidate for a specific target. Higher wins; drop below -500. */
function scoreResult(r: GrabResultItem, target: GrabTarget): number {
  const t = (r.title || '').trim()
  if (!t) return -1000
  const hash = r.info_hash || hashFromLink(r.link)
  if (!hash) return -900 // cannot add to debrid without an infohash/magnet

  let score = 0
  const lower = t.toLowerCase()

  if (target.kind === 'episode') {
    const markers = epMarkers(t)
    if (markers.length === 0) {
      // A season pack with no SxxExx at all would pull the entire season —
      // never acceptable for a single-episode grab (user policy: no backfill).
      return -800
    }
    const exact = markers.some((x) => x.s === target.season && x.e === target.episode)
    if (!exact) return -800
    const others = markers.filter((x) => !(x.s === target.season && x.e === target.episode))
    if (others.length === 0) score += 120 // single-episode release — ideal
    else if (others.every((x) => x.s === target.season && Math.abs(x.e - target.episode!) <= 2)) score += 40 // small range incl. ours
    else score -= 200 // wide/other episodes
    if (hasSeasonPackToken(t)) score -= 150
    if (/(repack|proper|real\s|v2\b)/i.test(lower)) score += 25
    // Preferencia de calidad (igual que en películas): mejor imagen primero.
    if (/(1080p|1080)/i.test(lower)) score += 60
    else if (/(2160p|4k\b|uhd)/i.test(lower)) score += 80
    else if (/(720p)/i.test(lower)) score += 30
    // ¿Es de la serie que buscamos? "Dark S02E03 720p WEBRip x264-MATTER"
    // (serie Dark, 2017) aparecía en la búsqueda de "Dark Matter" porque el
    // grupo del release parece parte del título. Los proveedores latino se
    // buscan por IMDB id, así que ahí solo se penaliza (nombres localizados).
    if (!seriesNameMatches(t, [target.title, target.original_title])) {
      if (!r.latino) return -750
      score -= 250
    } else if (target.year) {
      // Homónimas (Dark Matter 2015 vs 2024): los grupos incluyen el año de
      // estreno justo para distinguirlas — si viene, tiene que coincidir.
      const y = releaseYear(t)
      if (y === parseInt(String(target.year), 10)) score += 50
      else if (y) score -= 250
    }
  } else {
    // movie
    const yearMatch = t.match(/\b(19|20)\d{2}\b/)
    if (yearMatch && target.year) {
      if (yearMatch[0] === target.year) score += 40
      else score -= 120
    }
    if (/(camrip|cam\b|telesync|ts\b|hdcam|screener|telecine)/i.test(lower)) score -= 400
    if (/(1080p|1080)/i.test(lower)) score += 60
    else if (/(2160p|4k\b|uhd)/i.test(lower)) score += 80
    else if (/(720p)/i.test(lower)) score += 30
    if (/(web-?dl|bluray|remux|webrip)/i.test(lower)) score += 20
    if (/(repack|proper)/i.test(lower)) score += 20
  }

  // Language-specific penalties happen at the phase level, not here.
  // Seeders are the final tiebreak applied by the caller.
  // Reject releases whose title suggests non-EN/non-ES audio (cyrillic, CJK,
  // arabic scripts) — those are dubbed tracks, never what a grab wants.
  if (/[\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0600-\u06FF]/.test(lower)) score -= 350
  return score
}

export function chooseBest(results: GrabResultItem[], target: GrabTarget): GrabResultItem | null {
  let best: GrabResultItem | null = null
  let bestScore = -Infinity
  for (const r of results) {
    const s = scoreResult(r, target)
    if (s < -500) continue
    if (s > bestScore || (s === bestScore && numSeeders(r) > numSeeders(best!))) {
      best = r
      bestScore = s
    }
  }
  return best
}

function dedupeResults(results: GrabResultItem[]): GrabResultItem[] {
  const seen = new Map<string, GrabResultItem>()
  for (const r of results) {
    const key = (r.info_hash || hashFromLink(r.link) || r.link || '').toLowerCase()
    if (!key) continue
    const prev = seen.get(key)
    if (!prev || numSeeders(r) > numSeeders(prev)) seen.set(key, r)
  }
  return [...seen.values()]
}

/** Estado de la web de Cinecalidad: ¿el latino ya está publicado? */
export interface LatinoSiteCheck {
  provider: string
  published: boolean | null
  has_magnet: boolean
  ddl: string[]
  url: string
}

/** Latino providers by IMDB id — mirrors the Discover-tab flow. */
async function searchLatino(
  target: GrabTarget,
  apiKey: string,
): Promise<{ items: GrabResultItem[]; site: LatinoSiteCheck | null }> {
  const args = ['--stream', target.imdb_id || '', target.media_type]
  if (target.kind === 'episode' && target.season && target.episode) {
    args.push(String(target.season), String(target.episode))
  }
  const env: Record<string, string> = {}
  if (apiKey) env.TMDB_API_KEY = apiKey
  const startedAt = Date.now()
  const events = await runPythonLines('latino-providers.py', args, env, 75_000)
  const providerCounts = new Map<string, number>()
  let site: LatinoSiteCheck | null = null
  for (const ev of events) {
    if (ev && ev.type === 'provider_results' && Array.isArray(ev.results)) {
      providerCounts.set(String(ev.provider || '?'), (providerCounts.get(String(ev.provider || '?')) || 0) + ev.results.length)
    }
    if (ev && ev.site && typeof ev.site === 'object') {
      site = {
        provider: String(ev.provider || 'web'),
        published: ev.site.published === true ? true : ev.site.published === false ? false : null,
        has_magnet: Boolean(ev.site.has_magnet),
        ddl: Array.isArray(ev.site.ddl) ? ev.site.ddl.map(String) : [],
        url: String(ev.site.url || ''),
      }
    }
  }
  const counts = [...providerCounts.entries()].map(([p, n]) => `${p}: ${n}`).join(' · ') || 'sin eventos'
  const who = target.kind === 'episode' && target.season && target.episode
    ? `${target.title} S${pad2(target.season)}E${pad2(target.episode)}`
    : `${target.title} (${target.year || '?'})`
  const siteNote = site ? ` · web: ${site.published === true ? (site.has_magnet ? 'publicado (con torrent)' : `publicado sólo DDL${site.ddl.length ? ` (${site.ddl.slice(0, 3).join('/')})` : ''}`) : 'sin publicar'}` : ''
  console.debug(`[grab] latino ▸ ${who}: ${counts}${siteNote} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
  const out: GrabResultItem[] = []
  for (const ev of events) {
    if (ev && ev.type === 'provider_results' && Array.isArray(ev.results)) {
      for (const r of ev.results) {
        out.push({
          title: r.title || '',
          size: r.size || '0 B',
          seeders: Number(r.seeders) || 0,
          peers: Number(r.peers) || 0,
          link: r.link || '',
          indexer: r.indexer || ev.provider || 'latino',
          info_hash: r.info_hash || hashFromLink(r.link),
          latino: true,
        })
      }
    }
  }
  return { items: dedupeResults(out), site }
}

/** English fallback via Jackett (meta-search.py --jackett-only). */
async function searchEnglish(target: GrabTarget): Promise<GrabResultItem[]> {
  const base = (target.original_title || target.title || '').trim()
  if (!base) return []
  let query = base
  if (target.kind === 'movie') {
    if (target.year) query = `${base} ${target.year}`
  } else if (target.season && target.episode) {
    query = `${base} S${pad2(target.season)}E${pad2(target.episode)}`
  }
  const startedAt = Date.now()
  const events = await runPythonLines('meta-search.py', ['--stream', '--jackett-only', query], {}, 70_000)
  console.debug(`[grab] jackett ▸ "${query}": ${events.length} eventos (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
  const out: GrabResultItem[] = []
  for (const ev of events) {
    if (ev && ev.type === 'engine_results' && Array.isArray(ev.results)) {
      for (const r of ev.results) {
        out.push({
          title: r.title || '',
          size: r.size || '0 B',
          seeders: Number(r.seeders) || 0,
          peers: Number(r.peers) || 0,
          link: r.link || '',
          indexer: r.indexer || ev.engine || 'Jackett',
          info_hash: r.info_hash || hashFromLink(r.link),
          latino: false,
        })
      }
    }
  }
  return dedupeResults(out)
}

/**
 * Búsqueda SOLO latino para el escáner de reemplazo manual EN → latino.
 * Respeta el tope de tamaño por tipo; devuelve el mejor candidato o null.
 */
export async function findLatinoForUpgrade(target: GrabTarget): Promise<GrabResultItem | null> {
  const settings = getSettings()
  const apiKey = settings.tmdb_api_key || ''
  setupSearchEnv(settings)
  let imdbId = target.imdb_id || ''
  if (!imdbId && apiKey) {
    try {
      const detail = await tmdbDetail(target.tmdb_id, target.media_type)
      imdbId = detail?.imdb_id || ''
    } catch { /* no key or network */ }
  }
  if (!imdbId) return null
  const capGb = target.kind === 'movie' ? settings.max_movie_size_gb : settings.max_series_size_gb
  const maxBytes = capGb > 0 ? capGb * 1024 ** 3 : null
  let results: GrabResultItem[] = []
  try {
    results = (await searchLatino({ ...target, imdb_id: imdbId }, apiKey)).items
  } catch (e: any) {
    console.warn(`[grab] upgrade scan error "${target.title}": ${e.message}`)
    return null
  }
  if (maxBytes && results.some((r) => exceedsMaxBytes(r, maxBytes))) {
    results = results.filter((r) => !exceedsMaxBytes(r, maxBytes))
  }
  return chooseBest(results, target)
}

function serviceOrder(settings: Settings): DebridService[] {
  const prefs: DebridService[] = []
  const preferred: DebridService = settings.automation_service === 'realdebrid' ? 'realdebrid' : 'torbox'
  const alt: DebridService = preferred === 'torbox' ? 'realdebrid' : 'torbox'
  if (preferred === 'torbox' ? settings.torbox_token : settings.realdebrid_token) prefs.push(preferred)
  if (settings.automation_failover && prefs.length === 0) {
    if (alt === 'torbox' ? settings.torbox_token : settings.realdebrid_token) prefs.push(alt)
  } else if (settings.automation_failover) {
    if (alt === 'torbox' ? settings.torbox_token : settings.realdebrid_token) prefs.push(alt)
  }
  return prefs
}

async function addToService(
  settings: Settings,
  service: DebridService,
  result: GrabResultItem,
  type: 'movie' | 'series',
  destFolder: string,
): Promise<{ ok: boolean; torboxId?: string; error?: string }> {
  const hash = result.info_hash || hashFromLink(result.link)
  const isMagnet = Boolean(hash && /^magnet:/.test(result.link)) || Boolean(hash && !/^https?:/i.test(result.link) && result.link.startsWith('magnet'))
  const url = result.link || (hash ? `magnet:?xt=urn:btih:${hash}` : '')
  try {
    if (service === 'torbox') {
      const tb = new TorboxAPI(settings.torbox_token)
      const res = hash && (isMagnet || !/^https?:\/\//i.test(result.link))
        ? await tb.addMagnet(url)
        : await tb.addTorrentFromUrl(result.link)
      if (!res || res.success === false) return { ok: false, error: res?.detail || res?.error || 'TorBox add failed' }
      const { id } = TorboxAPI.torrentIdentity(res.data)
      if (!id) return { ok: false, error: 'TorBox did not return a torrent id' }
      const existing = getDownloadByTorboxId(id)
      if (existing) updateDownload(id, { name: result.title.slice(0, 300), service: 'torbox', type, dest_folder: destFolder })
      else addDownload({ torbox_id: id, name: result.title.slice(0, 300), status: 'pending', progress: 0, service: 'torbox', type, dest_folder: destFolder })
      eventBus.emit('downloads-updated')
      return { ok: true, torboxId: id }
    }
    const rd = new RealDebridAPI(settings.realdebrid_token)
    const res = hash && (isMagnet || !/^https?:\/\//i.test(result.link))
      ? await rd.addMagnet(url)
      : await rd.addTorrentFromUrl(result.link)
    if (!res || res.success === false) return { ok: false, error: res?.error || 'Real-Debrid add failed' }
    const { id } = RealDebridAPI.torrentIdentity(res.data)
    if (!id) return { ok: false, error: 'Real-Debrid did not return a torrent id' }
    const existing = getDownloadByTorboxId(id)
    if (existing) updateDownload(id, { name: result.title.slice(0, 300), service: 'realdebrid', type, dest_folder: destFolder, status: 'waiting_files_selection' })
    else addDownload({ torbox_id: id, name: result.title.slice(0, 300), status: 'waiting_files_selection', progress: 0, service: 'realdebrid', type, dest_folder: destFolder })
    eventBus.emit('downloads-updated')
    return { ok: true, torboxId: id }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function computeDestFolder(settings: Settings, target: GrabTarget): Promise<string | null> {
  try {
    let releaseName = target.title
    if (target.kind === 'episode' && target.season && target.episode) {
      releaseName = `${target.title} S${pad2(target.season)}E${pad2(target.episode)}`
    } else if (target.year) {
      releaseName = `${target.title} (${target.year})`
    }
    const type: 'movie' | 'series' = target.kind === 'movie' ? 'movie' : 'series'
    const { root, folder } = await computeDestination(settings, releaseName, type, {
      tmdbId: target.tmdb_id,
      extraTitles: [target.title, target.original_title].filter(Boolean) as string[],
    })
    if (!root) return null
    return path.join(root, ...folder.split('/').map(safeSegment))
  } catch (e: any) {
    console.error(`[grab] destination failed for "${target.title}": ${e.message}`)
    return null
  }
}

/**
 * Grab one concrete target (movie or single episode) for a watchlist item.
 * Language order comes from the item's profile:
 *   latino_first  → latino, then english
 *   latino_only   → latino only
 *   english_first → english, then latino
 */
export async function grab(target: GrabTarget): Promise<GrabOutcome> {
  const base: GrabOutcome = {
    ok: false,
    status: 'no_source',
    latinoResults: 0,
    englishResults: 0,
    profile: target.language_profile,
  }
  const settings = getSettings()
  const services = serviceOrder(settings)
  if (services.length === 0) {
    base.status = 'error'
    base.error = 'No debrid account configured (TorBox/Real-Debrid token missing)'
    return base
  }
  const apiKey = settings.tmdb_api_key || ''
  setupSearchEnv(settings)

  // IMDB id is mandatory for latino providers — resolve it lazily if missing.
  let imdbId = target.imdb_id || ''
  if (!imdbId && apiKey) {
    try {
      const detail = await tmdbDetail(target.tmdb_id, target.media_type)
      imdbId = detail?.imdb_id || ''
    } catch { /* no key or network */ }
  }
  const targetWithImdb = { ...target, imdb_id: imdbId }

  const destFolder = await computeDestFolder(settings, target)
  if (!destFolder) {
    base.status = 'error'
    base.error = 'Destination folder not configured (set movies/series folders in Settings)'
    return base
  }
  // Topes de tamaño por tipo: 0 = sin límite. Solo aplican a grabs automáticos.
  const capGb = target.kind === 'movie' ? settings.max_movie_size_gb : settings.max_series_size_gb
  const maxBytes = capGb > 0 ? capGb * 1024 ** 3 : null

  const phaseOrder: Array<'latino' | 'english'> =
    target.mode === 'upgrade' ? ['latino']
      : target.language_profile === 'latino_only' ? ['latino']
        : target.language_profile === 'english_first' ? ['english', 'latino']
          : ['latino', 'english']

  // Estado de la web de Cinecalidad para esta búsqueda latina (ver searchLatino).
  let latinoSite: LatinoSiteCheck | null = null
  let latinoSiteOnlyDdl = false

  for (const phase of phaseOrder) {
    if (phase === 'latino' && !imdbId) continue
    if (phase === 'english' && !process.env.JACKETT_API_KEY) {
      console.warn('[grab] English phase skipped — no Jackett API key available')
      continue
    }
    // Sin torrent latino pero con el episodio YA publicado en la web de
    // Cinecalidad (sólo descarga directa): el latino existe, así que no se baja
    // el inglés. Se deja el objetivo en backoff para reintentar y avisar.
    if (phase === 'english' && latinoSiteOnlyDdl && target.language_profile !== 'english_first') {
      const ddl = latinoSite!.ddl.slice(0, 3).join(', ')
      console.log(`[grab] latino publicado en la web sólo como descarga directa${ddl ? ` (${ddl})` : ''} — se omite el inglés y se reintenta más tarde: ${latinoSite!.url || 'sin url'}`)
      base.status = 'no_source'
      base.error = 'Latino ya publicado en Cinecalidad (sólo descarga directa) — esperando versión torrent'
      base.latinoDdl = { url: latinoSite!.url, ddl: latinoSite!.ddl }
      try {
        eventBus.emit('latino-ddl-pending', {
          title: target.title,
          media_type: target.media_type,
          season: target.season ?? null,
          episode: target.episode ?? null,
          url: latinoSite!.url,
          ddl: latinoSite!.ddl,
        })
      } catch { /* el aviso no puede romper el grab */ }
      return base
    }
    let results: GrabResultItem[] = []
    try {
      if (phase === 'latino') {
        const latino = await searchLatino(targetWithImdb, apiKey)
        results = latino.items
        latinoSite = latino.site
        latinoSiteOnlyDdl = Boolean(latino.site && latino.site.published === true && !latino.site.has_magnet)
      } else {
        results = await searchEnglish(target)
      }
    } catch (e: any) {
      console.error(`[grab] ${phase} search error for "${target.title}": ${e.message}`)
      continue
    }
    // Lista negra: releases ya descartados (p. ej. el episodio de OTRA serie con
    // el mismo título, detectado por duración al descargar). Compara por hash
    // y, si no hay hash, por título normalizado del release.
    const badHashes = getBadReleaseHashes()
    const badTitles = getBadReleaseTitles()
    if (results.length > 0 && (badHashes.size > 0 || badTitles.size > 0)) {
      const before = results.length
      results = results.filter((r) => {
        const hash = String(r.info_hash || '').toLowerCase()
        if (hash && badHashes.has(hash)) return false
        const norm = normalizeReleaseTitle(String(r.title || ''))
        if (norm && badTitles.has(norm)) return false
        return true
      })
      if (results.length !== before) {
        console.log(`[grab] ${phase}: ${before - results.length} resultado(s) descartados por lista negra`)
      }
    }
    if (phase === 'latino') base.latinoResults = results.length
    else base.englishResults = results.length
    if (results.length === 0) continue

    // Tope de tamaño por tipo (configurable): descarta releases gigantes; si
    // TODAS exceden el tope, la fase se omite y se reintenta con backoff.
    if (maxBytes && results.some((r) => exceedsMaxBytes(r, maxBytes))) {
      const kept = results.filter((r) => !exceedsMaxBytes(r, maxBytes))
      if (kept.length === 0) {
        console.log(`[grab] ${phase}: todas las releases superan el tope de ${capGb} GB (${target.kind === 'movie' ? 'película' : 'serie'}) — omitidas ("${target.title}")`)
        continue
      }
      results = kept
    }

    const best = chooseBest(results, target)
    if (best) console.log(`[grab] elegido: ${best.title} (${best.size}) [${best.indexer}]`)
    if (!best) continue
    const type: 'movie' | 'series' = target.kind === 'movie' ? 'movie' : 'series'
    for (const svc of services) {
      const added = await addToService(settings, svc, best, type, destFolder)
      if (added.ok && added.torboxId) {
        base.ok = true
        base.status = 'grabbed'
        base.language = phase === 'latino' ? 'latino' : 'english'
        base.source = best.indexer || (phase === 'latino' ? 'latino' : 'jackett')
        base.service = svc
        base.torbox_id = added.torboxId
        base.title = best.title.slice(0, 300)
        try {
          recordGrab({
            watchlist_id: target.watchlist_id,
            tmdb_id: target.tmdb_id,
            media_type: target.media_type,
            season: target.kind === 'episode' ? target.season ?? null : null,
            episode: target.kind === 'episode' ? target.episode ?? null : null,
            kind: target.kind === 'movie' ? 'movie' : 'episode',
            title: best.title,
            language: phase === 'latino' ? 'latino' : 'english',
            source: best.indexer || '',
            status: 'grabbed',
            torbox_id: added.torboxId,
            info_hash: best.info_hash || hashFromLink(best.link) || '',
            dest_folder: destFolder,
          })
        } catch (e: any) {
          console.error('[grab] history write failed:', e.message)
        }
        console.log(`[grab] ✓ ${target.media_type} "${target.title}"${target.kind === 'episode' ? ` S${target.season}E${target.episode}` : ''} → ${phase} (${best.indexer}) via ${svc} → ${destFolder}`)
        return base
      }
      base.status = 'error'
      base.error = added.error || `Failed to add via ${svc}`
    }
  }
  return base
}
