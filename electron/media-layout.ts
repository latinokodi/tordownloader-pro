// Pragmatic media-layout helpers: turn a release name into Jellyfin-friendly
// destination folders, radarr/sonarr style (movie: <Title (Year)>/,
// series: <Title (Year)>/Season NN/), keeping the original file names.
// TMDB lookup is best-effort — falls back to the parsed release title.

import fs from 'fs'
import path from 'path'
import https from 'https'
import { getMediaFolder, setMediaFolder } from './db'
import { tmdbAltTitles } from './tmdb'

export interface ParsedRelease {
  title: string
  year?: number
  season?: number
}

const TAG_RE = new RegExp(
  [
    '1080p', '720p', '2160p', '4k', '480p', '576p', 'hdtv', 'webrip', 'web-dl',
    'webdl', 'bluray', 'blu-ray', 'brrip', 'h264', 'h265', 'x264', 'x265',
    'hevc', 'avc', 'aac', 'ac3', 'dts', 'ddp5', 'ddp5.1', 'dd5', 'dd5.1',
    'atmos', 'truehd', 'amzn', 'atvp', 'nf', 'hbo', 'amazon', 'itunes', 'vff',
    'vostfr', 'multi', 'dual', 'lat', 'latino', 'spanish', 'english',
    'extreme', 'weeds', 'cakes', 'megusta', 'ethel', 'grace', 'ntb', 'tgx',
    'rarbg', 'eztv', 'rartv', 'ion10', 'glhf', 'rmteam', 'playweb', 'ditr',
    'skst', 'dkv', 'dirt', 'msd', 'xvid', 'proper', 'repack', 'remux', 'internal',
    'imax', 'muxed', 'opus', 'flac', 'aac2', '2.0', '5.1', '7.1',
  ].join('|'),
  'gi',
)

const SEASON_EP_RE = /\bS(\d{1,2})[Ee](\d{1,3})\b/
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/
const PAREN_YEAR_RE = /[\[\(]?\s*(19\d{2}|20\d{2})\s*[\]\)]?/

function cleanToken(token: string): string {
  return token
    .replace(/[._\-\[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseReleaseName(name: string): ParsedRelease {
  const raw = name || ''
  let season: number | undefined
  let year: number | undefined

  const seMatch = SEASON_EP_RE.exec(raw)
  if (seMatch) season = parseInt(seMatch[1], 10)

  const yearMatch = YEAR_RE.exec(raw)
  if (yearMatch) year = parseInt(yearMatch[1], 10)

  // Title = everything before the first season/episode marker or year token.
  const cutIdx = seMatch
    ? raw.search(SEASON_EP_RE)
    : yearMatch
      ? raw.search(YEAR_RE)
      : -1
  let titlePart = cutIdx > 0 ? raw.slice(0, cutIdx) : raw

  // Drop year-in-parens ("Movie (2021)") from the title part.
  titlePart = titlePart.replace(PAREN_YEAR_RE, ' ')

  // Tokenize, strip release tags and common noise.
  const tokens = titlePart
    .split(/[._\-\[\](){} ]+/)
    .map(cleanToken)
    .filter((t) => t.length > 0)

  const stop = new Set([
    'the', 'a', 'an', 'and', 'of', 'for', 'with', 'in', 'on', 'at', 'by',
  ])
  const titleTokens: string[] = []
  for (const t of tokens) {
    if (t.length <= 2 && !stop.has(t)) continue
    if (TAG_RE.test(t) || t.replace(/\d+$/, '').length <= 1) continue
    titleTokens.push(t)
  }

  const title = titleTokens.join(' ') || cleanToken(raw).slice(0, 60) || 'Unknown'
  return { title, year, season }
}

function tmdbGet(url: string): Promise<any> {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TorDownloader-PRO/1.0' } }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(6000, () => {
      req.destroy()
      resolve(null)
    })
  })
}

/**
 * Best-effort TMDB lookup: canonical title + year for a parsed release title.
 * Returns null when no API key / no match, so callers fall back to the parser.
 */
export async function tmdbResolve(
  parsed: ParsedRelease,
  type: 'movie' | 'series',
  apiKey: string,
): Promise<{ title: string; original?: string; id?: number; year?: number } | null> {
  if (!apiKey) return null
  const kind = type === 'movie' ? 'movie' : 'tv'
  const q = encodeURIComponent(parsed.title)
  const data = await tmdbGet(
    `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(apiKey)}&query=${q}&language=es-ES&include_adult=false`,
  )
  if (!data || !Array.isArray(data.results) || data.results.length === 0) return null
  const first = data.results[0]
  const title = first.title || first.name || parsed.title
  const original = first.original_title || first.original_name || undefined
  const year = first.release_date || first.first_air_date
  return {
    title,
    original,
    id: Number(first.id) || undefined,
    year: year ? parseInt(String(year).slice(0, 4), 10) || undefined : undefined,
  }
}

/** Normaliza un nombre para comparar carpetas (acentos, mayúsculas y puntuación). */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Busca una carpeta de título existente que corresponda a cualquiera de los
 * candidatos: coincidencia exacta (case-insensitive) con "Título (Año)" o
 * "Título", y si no, coincidencia NORMALIZADA (ignora acentos/puntuación, así
 * "Star Trek: Strange New Worlds" == "Star Trek_ Strange New Worlds").
 * Nunca crea una carpeta nueva si el título ya vive en la biblioteca.
 */
function findExistingTitleFolder(root: string, candidates: string[], year?: number): string | null {
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch { return null }
  const uniq = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))]
  for (const c of uniq) {
    for (const name of year ? [`${c} (${year})`, c] : [c]) {
      const t = safeSegment(name).toLowerCase()
      const hit = dirs.find((d) => d.toLowerCase() === t)
      if (hit) return hit
    }
  }
  const norms = new Set<string>()
  for (const c of uniq) {
    norms.add(normalizeName(c))
    if (year) norms.add(normalizeName(`${c} (${year})`))
  }
  const hit2 = dirs.find((d) => norms.has(normalizeName(d)))
  return hit2 || null
}

/** Reutiliza la carpeta de temporada existente (Season 4 == Season 04). */
export function resolveSeasonFolder(seriesDir: string, season: number): string {
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(seriesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch { return `Season ${season}` }
  const parseNum = (name: string): number | null => {
    const m = name.match(/^(?:season|temporada|t)\s*0*(\d{1,3})$/i)
    return m ? Number(m[1]) : null
  }
  const same = dirs.find((d) => parseNum(d) === season)
  if (same) return same
  if (dirs.length === 0) return `Season ${season}`
  // Mimic the padding style already used by this show's other seasons.
  const padded = dirs.find((d) => /^(?:season|temporada)\s+0\d/i.test(d))
  if (padded) {
    const word = padded.replace(/\s*0?\d+$/i, '').trim()
    return `${word} ${String(season).padStart(2, '0')}`
  }
  const unpadded = dirs.find((d) => /^(?:season|temporada)\s+\d/i.test(d))
  const word = unpadded ? unpadded.replace(/\s*\d+$/i, '').trim() : 'Season'
  return `${word} ${season}`
}

/**
 * Reuse an existing directory whose name only differs in case.
 * ext4 is case-sensitive but SMB/Windows/Jellyfin are not, so a change in the
 * TMDB localized title casing ("La Captura" -> "La captura") would otherwise
 * fork one movie into two folders that look identical to the user.
 * Compares against the sanitized segment because that is what lands on disk
 * (worker.ts maps every segment through safeSegment before joining).
 */
function reuseExistingSegment(parentDir: string, segment: string): string {
  const target = safeSegment(segment).toLowerCase()
  try {
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.toLowerCase() === target) return entry.name
    }
  } catch {
    // parent dir not created yet or unreadable -> keep the computed segment
  }
  return segment
}

/**
 * Compute the per-download destination root + relative folder for a release.
 * movie  -> <movies_root>/<Title (Year)>/
 * series -> <series_root>/<Title (Year)>/Season NN/
 * Falls back to the legacy `destination_folder` when the per-type root is unset.
 */
export async function computeDestination(
  settings: { destination_folder: string; movies_folder: string; series_folder: string; tmdb_api_key: string },
  torrentName: string,
  type: 'movie' | 'series' | '',
  opts: { tmdbId?: number; extraTitles?: string[]; titleOverride?: string } = {},
): Promise<{ root: string; folder: string; season: number | undefined }> {
  const kind = type === 'series' ? 'series' : 'movie'
  const parsed = parseReleaseName(torrentName)

  let meta: { title: string; original?: string; id?: number; year?: number } | null = null
  try {
    meta = await tmdbResolve(parsed, kind, settings.tmdb_api_key)
  } catch {
    meta = null
  }

  const year = meta?.year || parsed.year
  const tmdbId = opts.tmdbId || meta?.id

  const root =
    kind === 'series'
      ? settings.series_folder || settings.destination_folder
      : settings.movies_folder || settings.destination_folder

  if (!root) {
    throw new Error('No destination folder configured (set movies/series folders in Settings)')
  }

  const saved = tmdbId ? getMediaFolder(tmdbId, kind) : ''

  // 1) Carpeta ya memorizada para este título → reutilizarla tal cual.
  if (saved) {
    const hit = findExistingTitleFolder(root, [saved])
    if (hit) return finish(root, hit, kind, parsed, tmdbId, saved)
  }

  // 2) Candidatos: título localizado (es-ES), título original, títulos extra
  //    que vengan del caller (release/watchers) y, si hace falta, títulos
  //    alternativos de TMDB (ES/MX/US…). Nunca crear carpeta nueva si ya vive.
  const candidates = [
    ...(opts.titleOverride ? [opts.titleOverride] : []),
    ...(opts.extraTitles || []),
    meta?.title,
    meta?.original,
    parsed.title,
  ].filter(Boolean) as string[]

  let titleFolder = findExistingTitleFolder(root, candidates, year)
  if (!titleFolder && tmdbId) {
    const alts = await tmdbAltTitles(tmdbId, kind)
    if (alts.length) titleFolder = findExistingTitleFolder(root, alts, year)
  }
  if (!titleFolder) {
    const base = candidates[0] || parsed.title || torrentName
    titleFolder = safeSegment(year ? `${base} (${year})` : base)
  }
  return finish(root, titleFolder, kind, parsed, tmdbId, saved ? undefined : titleFolder)
}

/** Resuelve la temporada y memoriza la carpeta elegida para el título. */
function finish(
  root: string,
  titleFolder: string,
  kind: 'movie' | 'series',
  parsed: ParsedRelease,
  tmdbId: number | undefined,
  remember?: string,
): { root: string; folder: string; season: number | undefined } {
  if (tmdbId && remember) setMediaFolder(tmdbId, kind, remember)
  if (kind === 'series') {
    const season = parsed.season ?? 1
    const seriesDir = path.join(root, safeSegment(titleFolder))
    const seasonFolder = resolveSeasonFolder(seriesDir, season)
    return { root, folder: `${titleFolder}/${seasonFolder}`, season }
  }
  return { root, folder: titleFolder, season: undefined }
}

/** Sanitize a path segment for filesystem use (safe chars only). */
export function safeSegment(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim()
      .replace(/^\.+/, '')
      .replace(/\.+$/, '') || 'Unknown'
  )
}
