// Pragmatic media-layout helpers: turn a release name into Jellyfin-friendly
// destination folders, radarr/sonarr style (movie: <Title (Year)>/,
// series: <Title (Year)>/Season NN/), keeping the original file names.
// TMDB lookup is best-effort — falls back to the parsed release title.

import https from 'https'

export interface ParsedRelease {
  title: string
  year?: number
  season?: number
}

// NOTE: no 'g' flag — TAG_RE is used with .test() in a loop; a global regex
// keeps lastIndex state and would skip matches on alternating calls, leaking
// tags into folder/file names.
const TAG_RE = new RegExp(
  [
    '1080p', '720p', '2160p', '4k', '480p', '576p', 'hdtv', 'webrip', 'web-dl',
    'webdl', 'web', 'bluray', 'blu-ray', 'brrip', 'h264', 'h265', 'x264', 'x265',
    'hevc', 'avc', 'aac', 'ac3', 'dts', 'ddp5', 'ddp5.1', 'dd5', 'dd5.1',
    'atmos', 'truehd', 'amzn', 'atvp', 'nf', 'hbo', 'amazon', 'itunes', 'vff',
    'vostfr', 'multi', 'dual', 'lat', 'latino', 'spanish', 'english', 'dl',
    'extreme', 'weeds', 'cakes', 'megusta', 'ethel', 'grace', 'ntb', 'tgx',
    'rarbg', 'eztv', 'rartv', 'ion10', 'glhf', 'rmteam', 'playweb', 'ditr',
    'skst', 'dkv', 'dirt', 'msd', 'xvid', 'proper', 'repack', 'remux', 'internal',
    'imax', 'muxed', 'opus', 'flac', 'aac2', '2.0', '5.1', '7.1',
  ].join('|'),
  'i',
)

const SEASON_EP_RE = /\bS(\d{1,2})[Ee](\d{1,3})\b/
const TEMP_EP_RE = /\bT(\d{1,2})[Ee](\d{1,3})\b/i // latino style "T2E1"
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/g // 'g' required by matchAll()
const PAREN_YEAR_RE = /[\[\(]\s*(19\d{2}|20\d{2})\s*[\]\)]/ // only strip years actually in parens/brackets
// Trailing ALL-CAPS token = release group ("GROUP", "NTB", ...) → drop from title.
const GROUP_RE = /^[A-Z][A-Z0-9]{3,7}$/

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

  // "S02E05" standard, or latino "T2E5" — both give the season.
  const seMatch = SEASON_EP_RE.exec(raw) || TEMP_EP_RE.exec(raw)
  if (seMatch) season = parseInt(seMatch[1], 10)

  // All 19xx/20xx tokens. The release YEAR is the one after the SxxExx marker
  // (e.g. "1923.S02e01.2025.1080p" → 2025), or the last one; a leading 4-digit
  // token ("1923", "1883") is the TITLE, not a year.
  const yearMatches = [...raw.matchAll(YEAR_RE)]
  if (yearMatches.length > 0) {
    const afterEp = seMatch ? yearMatches.filter((m) => (m.index ?? 0) > (seMatch.index ?? 0)) : yearMatches
    const pool = afterEp.length > 0 ? afterEp : yearMatches
    year = parseInt(pool[pool.length - 1][0], 10)
  }

  // Title = everything before the first season/episode marker, or before the
  // first year that isn't the leading title token.
  let cutIdx = -1
  if (seMatch) {
    cutIdx = seMatch.index
  } else {
    const firstYearNotLeading = yearMatches.find((m) => (m.index ?? 0) > 0)
    if (firstYearNotLeading) cutIdx = firstYearNotLeading.index
  }
  let titlePart = cutIdx > 0 ? raw.slice(0, cutIdx) : raw

  // Drop year-in-parens ("Movie (2021)") from the title part.
  titlePart = titlePart.replace(PAREN_YEAR_RE, ' ')

  // Tokenize, strip release tags and common noise.
  const tokens = titlePart
    .split(/[._\-\[\](){} ]+/)
    .map(cleanToken)
    .filter((t) => t.length > 0)

  const startsWithNumericTitle = /^\d{4}/.test(raw.trim())

  const titleTokens: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // Drop release tags and numeric/single-char noise, but keep short title
    // words ("La", "de", "of", "the") — dropping them broke Spanish titles.
    if (TAG_RE.test(t)) continue
    // A leading 4-digit token is the show's name (e.g. "1923"), not noise.
    if (i === 0 && startsWithNumericTitle && /^\d{4}$/.test(t)) {
      titleTokens.push(t)
      continue
    }
    if (t.replace(/\d+$/, '').length <= 1) continue
    titleTokens.push(t)
  }

  // Drop trailing release-group tokens ("...WEB-DL.x264-GROUP" → "GROUP").
  while (titleTokens.length > 1 && GROUP_RE.test(titleTokens[titleTokens.length - 1])) {
    titleTokens.pop()
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
 * Results are memoized (15 min TTL) so every episode of a season resolves to
 * the same canonical folder even if TMDB is slow or rate-limited mid-batch.
 */
const tmdbCache = new Map<string, { ts: number; value: { title: string; year?: number } | null }>()
const TMDB_CACHE_TTL = 15 * 60 * 1000

export async function tmdbResolve(
  parsed: ParsedRelease,
  type: 'movie' | 'series',
  apiKey: string,
): Promise<{ title: string; year?: number } | null> {
  if (!apiKey) return null
  const key = `${type}|${parsed.title.toLowerCase()}`
  const cached = tmdbCache.get(key)
  if (cached && Date.now() - cached.ts < TMDB_CACHE_TTL) return cached.value

  const kind = type === 'movie' ? 'movie' : 'tv'
  const q = encodeURIComponent(parsed.title)
  const data = await tmdbGet(
    `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(apiKey)}&query=${q}&language=es-ES&include_adult=false`,
  )
  let value: { title: string; year?: number } | null = null
  if (data && Array.isArray(data.results) && data.results.length > 0) {
    const first = data.results[0]
    const title = first.title || first.name || parsed.title
    const year = first.release_date || first.first_air_date
    value = { title, year: year ? parseInt(String(year).slice(0, 4), 10) || undefined : undefined }
  }
  // Keep the cache bounded: drop stale entries when it grows large.
  if (tmdbCache.size > 500) {
    const now = Date.now()
    for (const [k, v] of tmdbCache) if (now - v.ts > TMDB_CACHE_TTL) tmdbCache.delete(k)
  }
  tmdbCache.set(key, { ts: Date.now(), value })
  return value
}

/**
 * Compute the per-download destination root + relative folder for a release.
 * movie  -> <movies_root>/<Title (Year)>/
 * series -> <series_root>/<Title (Year)>/Season NN/
 * Falls back to the legacy `destination_folder` when the per-type root is unset.
 *
 * `seasonOverride` (the season stored in the DB when the transfer was added)
 * wins over the season parsed from the torrent name, so every episode of a
 * season lands in the same "Season NN" folder even when release names vary
 * (e.g. "T1E1", "Temporada 1", or no season marker at all).
 */
export async function computeDestination(
  settings: { destination_folder: string; movies_folder: string; series_folder: string; tmdb_api_key: string },
  torrentName: string,
  type: 'movie' | 'series' | '',
  seasonOverride?: number | null,
): Promise<{ root: string; folder: string; season: number | undefined }> {
  const kind = type === 'series' ? 'series' : 'movie'
  const parsed = parseReleaseName(torrentName)

  let meta: { title: string; year?: number } | null = null
  try {
    meta = await tmdbResolve(parsed, kind, settings.tmdb_api_key)
  } catch {
    meta = null
  }

  const title = meta?.title || parsed.title
  const year = meta?.year || parsed.year
  const titleFolder = year ? `${title} (${year})` : title

  const root =
    kind === 'series'
      ? settings.series_folder || settings.destination_folder
      : settings.movies_folder || settings.destination_folder

  if (!root) {
    throw new Error('No destination folder configured (set movies/series folders in Settings)')
  }

  let folder = titleFolder
  if (kind === 'series') {
    // Season from the DB record > Sxx marker > bare "S01" marker > default 01.
    const seasonOnly = (() => {
      const m = /\bS(\d{1,2})\b/.exec(torrentName)
      return m ? parseInt(m[1], 10) : undefined
    })()
    const season = seasonOverride ?? parsed.season ?? seasonOnly ?? 1
    folder = `${titleFolder}/Season ${String(season).padStart(2, '0')}`
    return { root, folder, season }
  }
  return { root, folder, season: undefined }
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
