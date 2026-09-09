// watchlist.ts — CRUD for the automated media watchlist (movies + series)
// plus grab-history bookkeeping. The monitor + grabber are the only writers;
// server.ts exposes these over HTTP.
import { getDB, getSettings, type WatchlistItem, type GrabHistoryRow, type LanguageProfile, type BackfillScope } from './db'
import { deleteAttemptsForTmdb } from './attempts'

export const LANGUAGE_PROFILES: LanguageProfile[] = ['latino_first', 'latino_only', 'english_first']

export function normalizeLanguageProfile(v: unknown): LanguageProfile {
  return LANGUAGE_PROFILES.includes(v as LanguageProfile) ? (v as LanguageProfile) : 'latino_first'
}

export function normalizeMediaType(v: unknown): 'movie' | 'series' | null {
  return v === 'movie' || v === 'series' ? v : null
}

export const BACKFILL_SCOPES: BackfillScope[] = ['new', 'last_episode', 'last_season', 'first_season', 'all']

export function normalizeBackfill(v: unknown): BackfillScope {
  return BACKFILL_SCOPES.includes(v as BackfillScope) ? (v as BackfillScope) : 'new'
}

function rowToItem(row: any): WatchlistItem {
  return {
    ...row,
    monitored: Boolean(row.monitored),
    tmdb_id: Number(row.tmdb_id),
  }
}

export function listWatchlist(): WatchlistItem[] {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM watchlist ORDER BY added_at DESC, id DESC').all() as any[]
  return rows.map(rowToItem)
}

export function getWatchlistItem(id: number): WatchlistItem | undefined {
  const db = getDB()
  const row = db.prepare('SELECT * FROM watchlist WHERE id = ?').get(id) as any
  return row ? rowToItem(row) : undefined
}

export function findWatchlistItem(tmdbId: number, mediaType: string): WatchlistItem | undefined {
  const db = getDB()
  const row = db.prepare('SELECT * FROM watchlist WHERE tmdb_id = ? AND media_type = ?').get(tmdbId, mediaType) as any
  return row ? rowToItem(row) : undefined
}

export interface AddWatchlistInput {
  tmdb_id: number
  media_type: 'movie' | 'series'
  title: string
  year?: string
  overview?: string
  poster?: string
  backdrop?: string
  imdb_id?: string
  language_profile?: string
  backfill?: string
}

export function addWatchlistItem(input: AddWatchlistInput): { item: WatchlistItem; created: boolean } {
  const db = getDB()
  const mediaType = normalizeMediaType(input.media_type)
  if (!mediaType || !Number.isFinite(input.tmdb_id) || !input.title?.trim()) {
    throw new Error('Invalid watchlist item: tmdb_id, media_type and title are required')
  }
  const tmdbId = Math.trunc(input.tmdb_id)
  const existing = findWatchlistItem(tmdbId, mediaType)
  if (existing) return { item: existing, created: false }

  const profile = normalizeLanguageProfile(input.language_profile || getSettings().language_profile)
  const backfill = input.media_type === 'series' ? normalizeBackfill(input.backfill) : 'new'
  const info = db.prepare(
    `INSERT INTO watchlist (tmdb_id, media_type, title, year, overview, poster, backdrop, imdb_id, language_profile, backfill)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tmdbId,
    mediaType,
    String(input.title).slice(0, 500),
    String(input.year || '').slice(0, 10),
    String(input.overview || '').slice(0, 2000),
    String(input.poster || '').slice(0, 1000),
    String(input.backdrop || '').slice(0, 1000),
    String(input.imdb_id || '').slice(0, 20),
    profile,
    backfill,
  )
  const item = getWatchlistItem(Number(info.lastInsertRowid))!
  return { item, created: true }
}

const UPDATEABLE_KEYS = ['monitored', 'language_profile', 'backfill', 'imdb_id', 'next_episode', 'last_checked'] as const

export function updateWatchlistItem(id: number, patch: Partial<Pick<WatchlistItem, (typeof UPDATEABLE_KEYS)[number]>>): WatchlistItem | undefined {
  const db = getDB()
  if (!getWatchlistItem(id)) return undefined
  const fields: string[] = []
  const values: any[] = []
  for (const key of UPDATEABLE_KEYS) {
    if (!(key in patch)) continue
    const value = (patch as any)[key]
    if (value === undefined) continue
    if (key === 'monitored') {
      fields.push('monitored = ?')
      values.push(value ? 1 : 0)
    } else if (key === 'language_profile') {
      fields.push('language_profile = ?')
      values.push(normalizeLanguageProfile(value))
    } else if (key === 'backfill') {
      fields.push('backfill = ?')
      values.push(normalizeBackfill(value))
    } else {
      fields.push(`${key} = ?`)
      values.push(value)
    }
  }
  if (fields.length) {
    db.prepare(`UPDATE watchlist SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
  }
  return getWatchlistItem(id)
}

export function removeWatchlistItem(id: number): boolean {
  const db = getDB()
  const item = getWatchlistItem(id)
  if (!item) return false
  db.prepare('DELETE FROM watchlist WHERE id = ?').run(id)
  db.prepare('DELETE FROM grab_history WHERE watchlist_id = ?').run(id)
  try {
    deleteAttemptsForTmdb(item.tmdb_id)
  } catch { /* attempts table may not exist on very old DBs */ }
  return true
}

// ── Grab history ──────────────────────────────────────────

export function recordGrab(row: {
  watchlist_id: number
  tmdb_id: number
  media_type: 'movie' | 'series'
  season?: number | null
  episode?: number | null
  kind: 'movie' | 'episode' | 'season_pack'
  title: string
  language?: string
  source?: string
  status: 'grabbed' | 'failed'
  torbox_id?: string
  info_hash?: string
  error?: string
}): void {
  const db = getDB()
  db.prepare(
    `INSERT INTO grab_history (watchlist_id, tmdb_id, media_type, season, episode, kind, title, language, source, status, torbox_id, info_hash, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.watchlist_id,
    row.tmdb_id,
    row.media_type,
    row.season ?? null,
    row.episode ?? null,
    row.kind,
    String(row.title).slice(0, 500),
    row.language || '',
    row.source || '',
    row.status,
    row.torbox_id || '',
    row.info_hash || '',
    String(row.error || '').slice(0, 1000),
  )
}

export function isGrabbed(tmdbId: number, mediaType: string, season: number | null, episode: number | null): boolean {
  const db = getDB()
  const row = db.prepare(
    `SELECT 1 as x FROM grab_history
     WHERE tmdb_id = ? AND media_type = ? AND season IS ? AND episode IS ? AND status = 'grabbed' LIMIT 1`,
  ).get(tmdbId, mediaType, season ?? null, episode ?? null) as any
  return Boolean(row)
}

export function grabHistoryForItem(watchlistId: number, limit = 50): GrabHistoryRow[] {
  const db = getDB()
  return db.prepare('SELECT * FROM grab_history WHERE watchlist_id = ? ORDER BY id DESC LIMIT ?').all(watchlistId, limit) as GrabHistoryRow[]
}

export function recentGrabs(limit = 20): GrabHistoryRow[] {
  const db = getDB()
  return db.prepare('SELECT * FROM grab_history ORDER BY id DESC LIMIT ?').all(limit) as GrabHistoryRow[]
}
