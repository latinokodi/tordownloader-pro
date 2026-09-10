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
  const items = rows.map(rowToItem)
  if (items.length === 0) return items
  // Enriquecer cada ítem con su grab más reciente (para mostrarlo en la tarjeta).
  const placeholders = items.map(() => '?').join(',')
  const lastRows = db.prepare(
    `SELECT g.* FROM grab_history g
     INNER JOIN (SELECT watchlist_id, MAX(id) AS mid FROM grab_history GROUP BY watchlist_id) m
       ON g.id = m.mid
     WHERE g.watchlist_id IN (${placeholders})`,
  ).all(...items.map((i) => i.id)) as GrabHistoryRow[]
  const byWl = new Map(lastRows.map((r) => [r.watchlist_id, r]))
  return items.map((i) => ({ ...(i as any), lastGrab: byWl.get(i.id) ?? null })) as WatchlistItem[]
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
  dest_folder?: string
}): void {
  const db = getDB()
  db.prepare(
    `INSERT INTO grab_history (watchlist_id, tmdb_id, media_type, season, episode, kind, title, language, source, status, torbox_id, info_hash, error, dest_folder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    String(row.dest_folder || '').slice(0, 1000),
  )
}

/** Grab history rows that are in English and could be upgraded to latino. */
export function englishGrabbedRows(watchlistId: number, limit = 4): GrabHistoryRow[] {
  const db = getDB()
  return db.prepare(
    `SELECT * FROM grab_history
     WHERE watchlist_id = ? AND language = 'english' AND status = 'grabbed'
     ORDER BY grabbed_at DESC LIMIT ?`,
  ).all(watchlistId, limit) as GrabHistoryRow[]
}

/** The most recent row for a concrete target (grabbed or pending). */
export function latestGrabFor(tmdbId: number, mediaType: string, season: number | null, episode: number | null): GrabHistoryRow | undefined {
  const db = getDB()
  return db.prepare(
    `SELECT * FROM grab_history
     WHERE tmdb_id = ? AND media_type = ? AND season IS ? AND episode IS ? AND status IN ('grabbed','replace_pending')
     ORDER BY id DESC LIMIT 1`,
  ).get(tmdbId, mediaType, season ?? null, episode ?? null) as GrabHistoryRow | undefined
}

/** Mark old EN rows as waiting to be replaced by the new latino grab. */
export function markReplacePending(tmdbId: number, mediaType: string, season: number | null, episode: number | null, keepId: number): number {
  const db = getDB()
  const res = db.prepare(
    `UPDATE grab_history SET status = 'replace_pending'
     WHERE tmdb_id = ? AND media_type = ? AND season IS ? AND episode IS ? AND language = 'english' AND status = 'grabbed' AND id != ?`,
  ).run(tmdbId, mediaType, season ?? null, episode ?? null, keepId)
  return res.changes
}

/** Worker hook: record the locally-downloaded video file for a grab row. */
export function appendDownloadedFile(torboxId: string, filePath: string): void {
  if (!torboxId || !filePath) return
  const db = getDB()
  const row = db.prepare('SELECT id, dest_folder, file_name FROM grab_history WHERE torbox_id = ? ORDER BY id DESC LIMIT 1').get(torboxId) as any
  if (!row) return
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  const base = filePath.replace(/^.*[/\\]/, '')
  const names = (row.file_name || '').split(',').filter(Boolean)
  if (!names.includes(base)) names.push(base)
  db.prepare('UPDATE grab_history SET dest_folder = ?, file_name = ? WHERE id = ?').run(dir, names.join(','), row.id)
}

function removeWithSidecars(filePath: string): boolean {
  try {
    const fs = require('fs') as typeof import('fs')
    const pathMod = require('path') as typeof import('path')
    if (!fs.existsSync(filePath)) return false
    const base = filePath.replace(/\.[^./\\]+$/, '')
    fs.rmSync(filePath, { force: true })
    const dir = pathMod.dirname(filePath)
    const stem = pathMod.basename(base)
    let entries: string[] = []
    try { entries = fs.readdirSync(dir) } catch { /* ignore */ }
    for (const entry of entries) {
      if (/\.(srt|vtt|ass|ssa|sub)$/i.test(entry) && entry.startsWith(stem + '.')) {
        try { fs.rmSync(pathMod.join(dir, entry), { force: true }) } catch { /* ignore */ }
      }
    }
    return true
  } catch { return false }
}

/** Worker hook: a grab whose local download failed must not count as done. */
export function markGrabFailed(torboxId: string, reason: string): void {
  if (!torboxId) return
  try {
    const res = getDB().prepare(
      `UPDATE grab_history SET status = 'failed', error = ? WHERE torbox_id = ? AND status = 'grabbed'`,
    ).run(String(reason || '').slice(0, 500), torboxId)
    if (res.changes > 0) console.warn(`[Worker] grab marcado como fallido (se reintentará): ${String(reason).slice(0, 120)}`)
  } catch { /* ignore */ }
}

/** Delete old EN artifacts once the replacing latino download is complete locally. */
export function finalizeReplacement(torboxId: string): void {
  const fs = require('fs') as typeof import('fs')
  const pathMod = require('path') as typeof import('path')
  const db = getDB()
  const fresh = db.prepare(`SELECT * FROM grab_history WHERE torbox_id = ? ORDER BY id DESC LIMIT 1`).get(torboxId) as GrabHistoryRow | undefined
  if (!fresh || fresh.language !== 'latino' || fresh.status !== 'grabbed') return
  const siblings = db.prepare(
    `SELECT * FROM grab_history
     WHERE tmdb_id = ? AND media_type = ? AND season IS ? AND episode IS ? AND language = 'english' AND status = 'replace_pending'`,
  ).all(fresh.tmdb_id, fresh.media_type, fresh.season ?? null, fresh.episode ?? null) as GrabHistoryRow[]
  if (siblings.length === 0) return
  const newNames = new Set((fresh.file_name || '').split(',').filter(Boolean))
  const seasonFolder = fresh.dest_folder || ''
  const epMarker = fresh.kind === 'episode' && fresh.season && fresh.episode
    ? new RegExp(`\\b[Ss]${String(fresh.season).padStart(2, '0')}[Ee]${String(fresh.episode).padStart(2, '0')}\\b|\\b${fresh.season}[xX]${String(fresh.episode).padStart(2, '0')}\\b`)
    : null
  for (const old of siblings) {
    const explicit = (old.file_name || '').split(',').filter(Boolean)
    const targets: string[] = []
    if (explicit.length > 0 && old.dest_folder) {
      for (const f of explicit) targets.push(pathMod.join(old.dest_folder, f))
    } else if (seasonFolder && epMarker) {
      // Fallback para filas antiguas sin tracking: borrar vídeos del episodio
      // en la carpeta del grab nuevo, excluyendo los archivos nuevos.
      try {
        for (const entry of fs.readdirSync(seasonFolder)) {
          if (newNames.has(entry)) continue
          const full = pathMod.join(seasonFolder, entry)
          if (!fs.statSync(full).isFile()) continue
          if (epMarker.test(entry) && /\.(mkv|mp4|avi|m4v|mov|ts)$/i.test(entry)) targets.push(full)
        }
      } catch { /* ignore */ }
    }
    let removed = 0
    for (const t of targets) if (removeWithSidecars(t)) removed += 1
    if (removed > 0) console.log(`[Worker] Reemplazo: ${removed} archivo(s) EN eliminado(s) (${fresh.season ? `S${String(fresh.season).padStart(2, '0')}E${String(fresh.episode).padStart(2, '0')}` : 'película'})`)
    else console.warn(`[Worker] Reemplazo: no se pudo localizar el archivo EN (${old.title || 'sin nombre'}) — revisar carpeta a mano`)
    db.prepare('DELETE FROM grab_history WHERE id = ?').run(old.id)
  }
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
