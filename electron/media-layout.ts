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

  const titleTokens: string[] = []
  for (const t of tokens) {
    // Drop release tags and numeric/single-char noise, but keep short title
    // words ("La", "de", "of", "the") — dropping them broke Spanish titles.
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
): Promise<{ title: string; year?: number } | null> {
  if (!apiKey) return null
  const kind = type === 'movie' ? 'movie' : 'tv'
  const q = encodeURIComponent(parsed.title)
  const data = await tmdbGet(
    `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(apiKey)}&query=${q}&language=es-ES&include_adult=false`,
  )
  if (!data || !Array.isArray(data.results) || data.results.length === 0) return null
  const first = data.results[0]
  const title = first.title || first.name || parsed.title
  const year = first.release_date || first.first_air_date
  return { title, year: year ? parseInt(String(year).slice(0, 4), 10) || undefined : undefined }
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
    const season = parsed.season ?? 1
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
