/**
 * Una sola versión por episodio: cuando llega una copia mejor, la anterior se va.
 *
 * Antes esto se hacía a mano (borrar el HDTV cuando llegaba el WEB-DL, o el
 * playWEB cuando llegaba el AMZN), y Jellyfin acababa con dos o tres versiones
 * del mismo episodio ocupando disco. La regla de cuál gana está aquí, aislada y
 * sin IO, para poder probarla:
 *
 *   1. Idioma primero: si solo una de las versiones trae audio en español, gana
 *      esa aunque el bitrate sea menor. El usuario prefiere latino; cambiar una
 *      copia latina por otra inglesa «de más bitrate» sería empeorarle el visionado.
 *   2. Escalón de resolución (`resolutionTier`): 2160 y 1080 no son el mismo
 *      escalón, pero 1080 y 960 sí (muchos WEB-DL 2:1 se etiquetan 1080p y miden
 *      1920x960; compararlos por altura estricta elegía la copia peor).
 *   3. Bitrate efectivo dentro del escalón: el bitrate total multiplicado por
 *      1,5 si el vídeo es HEVC/x265, que necesita menos para la misma calidad.
 *   4. A igualdad, el archivo más nuevo (el que se acaba de bajar).
 */

export interface VersionInfo {
  path: string
  /** Altura del vídeo en píxeles (0 si no se pudo leer). */
  height: number
  /** Bitrate total del archivo en bits/s. */
  bitrate: number
  /** Codec de vídeo tal como lo da ffprobe (`h264`, `hevc`, …). */
  vcodec: string
  /** ¿Tiene alguna pista de audio en español? */
  hasSpanish: boolean
  /** mtime en ms, para desempatar. */
  mtime: number
}

/** Escalón de resolución: 2160 / 1080 / 720 / menor. Tolerante a 960 y 800. */
export function resolutionTier(height: number): number {
  const h = Number(height) || 0
  if (h >= 1800) return 2160
  if (h >= 900) return 1080
  if (h >= 600) return 720
  return 0
}

/** Bitrate comparable: HEVC/x265 rinde ~1,5x con el mismo número. */
export function effectiveBitrate(v: Pick<VersionInfo, 'bitrate' | 'vcodec'>): number {
  const codec = String(v.vcodec || '').toLowerCase()
  const factor = codec === 'hevc' || codec === 'h265' ? 1.5 : 1
  return (Number(v.bitrate) || 0) * factor
}

/** ¿`a` es mejor que `b`? (misma regla que `pickKeeper`, unaria para ordenar) */
export function compareVersions(a: VersionInfo, b: VersionInfo): number {
  if (a.hasSpanish !== b.hasSpanish) return a.hasSpanish ? 1 : -1
  const ta = resolutionTier(a.height)
  const tb = resolutionTier(b.height)
  if (ta !== tb) return ta - tb
  const ea = effectiveBitrate(a)
  const eb = effectiveBitrate(b)
  if (ea !== eb) return ea - eb
  return (Number(a.mtime) || 0) - (Number(b.mtime) || 0)
}

/** La versión que se queda. Con lista vacía devuelve null. */
export function pickKeeper(versions: VersionInfo[]): VersionInfo | null {
  if (!versions || versions.length === 0) return null
  return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best))
}

/**
 * Las versiones que se pueden borrar: todas menos la que gana. Nunca devuelve la
 * ganadora, y con una sola versión devuelve lista vacía.
 */
export function planRemoval(versions: VersionInfo[]): VersionInfo[] {
  const keeper = pickKeeper(versions)
  if (!keeper) return []
  return versions.filter((v) => v.path !== keeper.path)
}

/** ¿El nombre corresponde al mismo episodio? Se compara SxxEyy, sin importar el resto. */
export function episodeTag(fileName: string): string | null {
  const m = String(fileName || '').match(/[Ss](\d{1,2})[ ._-]?[Ee](\d{1,3})/)
  if (!m) return null
  return `S${String(Number(m[1])).padStart(2, '0')}E${String(Number(m[2])).padStart(2, '0')}`
}

/** Filtra, de una lista de rutas, las que son el mismo episodio que `file`. */
export function siblingEpisodes(file: string, all: string[]): string[] {
  const tag = episodeTag(file)
  if (!tag) return []
  return all.filter((p) => p !== file && episodeTag(p) === tag)
}

// ── Parte con IO (ffprobe + borrado), usada por el worker ──────────────────

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'

const VIDEO_EXT = ['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.ts']

function runProbe(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve) => {
    execFile('ffprobe', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      resolve(String(stdout || ''))
    })
  })
}

/** Lee resolución, bitrate, codec y si tiene audio en español. */
export async function probeVersion(file: string): Promise<VersionInfo | null> {
  try {
    if (!fs.existsSync(file)) return null
    const st = fs.statSync(file)
    const out = await runProbe(['-v', 'error', '-show_entries',
      'format=bit_rate:stream=codec_type,codec_name,height:stream_tags=language',
      '-of', 'json', file])
    let parsed: any = {}
    try { parsed = JSON.parse(out || '{}') } catch { parsed = {} }
    const streams: any[] = parsed.streams || []
    const video = streams.find((s) => s.codec_type === 'video') || {}
    const langs = streams.filter((s) => s.codec_type === 'audio')
      .map((s) => String((s.tags || {}).language || '').toLowerCase())
    return {
      path: file,
      height: Number(video.height) || 0,
      bitrate: Number((parsed.format || {}).bit_rate) || Math.round((st.size * 8) / 60),
      vcodec: String(video.codec_name || ''),
      hasSpanish: langs.some((l) => l === 'spa' || l === 'es' || l === 'esp' || l === 'spl'),
      mtime: st.mtimeMs,
    }
  } catch {
    return null
  }
}

/**
 * Deja una sola versión del episodio: borra las copias peores que la recibida.
 * Devuelve las rutas borradas. No toca el archivo recién llegado si es el peor
 * (en ese caso no borra nada y avisa), para no destruir una descarga recién hecha
 * por una heurística.
 */
export async function removeLesserVersions(file: string): Promise<string[]> {
  const dir = path.dirname(file)
  let hermanos: string[] = []
  try {
    hermanos = fs.readdirSync(dir)
      .filter((f) => VIDEO_EXT.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
  const candidatos = siblingEpisodes(file, hermanos)
  if (candidatos.length === 0) return []
  const infos = (await Promise.all([file, ...candidatos].map(probeVersion)))
    .filter((v): v is VersionInfo => Boolean(v))
  if (infos.length < 2) return []
  const keeper = pickKeeper(infos)
  if (!keeper) return []
  if (keeper.path !== file) {
    console.log(`[Worker] ${path.basename(file)} es peor que ${path.basename(keeper.path)}; se conserva la existente`)
    return []
  }
  const borrar = planRemoval(infos)
  const borrados: string[] = []
  for (const v of borrar) {
    try {
      fs.unlinkSync(v.path)
      borrados.push(v.path)
      console.log(`[Worker] versión peor borrada: ${path.basename(v.path)} (${v.height}p, ${Math.round(v.bitrate / 1e6)} Mbps)`)
    } catch (e: any) {
      console.warn(`[Worker] no se pudo borrar ${path.basename(v.path)}: ${e?.message || e}`)
    }
  }
  return borrados
}
