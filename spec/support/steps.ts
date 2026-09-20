// Definiciones de pasos: cada paso llama a las funciones REALES de la app
// (integración, sin dobles de las funciones de dominio).
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  seriesNameMatches,
  computeDestination,
} from '../../electron/media-layout'
import { durationMatches, durationToleranceMin } from '../../electron/preflight'
import { healLibrary } from '../../electron/library-heal'
import { orderTargetsForQueue, type QueueTarget } from '../../electron/monitor'
import {
  planReconcile,
  adoptionDestination,
  type DebridTorrent,
  type ReconcilePlan,
  type WatchedTitle,
} from '../../electron/debrid-reconcile'

export interface World {
  titles?: string[]
  altTitles?: string[]
  namingResult?: boolean
  expectedMin?: number
  kind?: 'movie' | 'episode'
  actualMin?: number
  durationOk?: boolean
  addedAt?: string
  targets?: QueueTarget[]
  ordered?: string[]
  root?: string
  moviesRoot?: string
  seriesRoot?: string
  heal?: ReturnType<typeof healLibrary>
  dest?: { root: string; folder: string }
  watched?: WatchedTitle[]
  torrents?: DebridTorrent[]
  knownIds?: number[]
  onDisk?: Set<string>
  caps?: { series: number; movie: number }
  plan?: ReconcilePlan
}

export interface StepRun {
  world: World
  scenarioName: string
  rows: string[][]
}

type StepFn = (run: StepRun, ...args: string[]) => void | Promise<void>

export const stepDefs: Array<{ pattern: RegExp; fn: StepFn }> = [
  // ── B1 · nombres de release ─────────────────────────────────────────────
  {
    pattern: /^los títulos del objetivo son "([^"]*)"$/,
    fn: ({ world }, list) => { world.titles = list.split(';').map((s) => s.trim()).filter(Boolean) },
  },
  {
    pattern: /^los títulos alternativos son "([^"]*)"$/,
    fn: ({ world }, list) => { world.altTitles = list.split(';').map((s) => s.trim()).filter(Boolean) },
  },
  {
    pattern: /^evalúo el release "([^"]*)"$/,
    fn: ({ world }, release) => {
      world.namingResult = seriesNameMatches(release, world.titles || [], world.altTitles || [])
    },
  },
  {
    pattern: /^el release se "(acepta|rechaza)"$/,
    fn: ({ world }, expected) => {
      if (world.namingResult === undefined) throw new Error('no se evaluó ningún release antes')
      const want = expected === 'acepta'
      if (world.namingResult !== want) {
        throw new Error(`se esperaba que ${want ? 'aceptara' : 'rechazara'} el release y ${world.namingResult ? 'lo aceptó' : 'lo rechazó'}`)
      }
    },
  },
  {
    pattern: /^la app no bloquea por falta de datos$/,
    fn: ({ world }) => {
      if (world.namingResult !== true) throw new Error('un release sin título reconocible debe aceptarse (no se juzga)')
    },
  },

  // ── B2 · duración ──────────────────────────────────────────────────────
  {
    pattern: /^la duración esperada es "([^"]*)" minutos para un "(episodio|película)"$/,
    fn: ({ world }, min, kind) => {
      world.expectedMin = Number(min) || 0
      world.kind = kind === 'episodio' ? 'episode' : 'movie'
    },
  },
  {
    pattern: /^la duración real del video es "([^"]*)" minutos$/,
    fn: ({ world }, min) => {
      world.actualMin = Number(min)
      world.durationOk = durationMatches(Number(world.expectedMin) || 0, world.actualMin, world.kind || 'episode')
    },
  },
  {
    pattern: /^la duración "(acepta|rechaza)"$/,
    fn: ({ world }, expected) => {
      if (world.durationOk === undefined) throw new Error('no se comparó ninguna duración antes')
      const want = expected === 'acepta'
      if (world.durationOk !== want) {
        const tol = durationToleranceMin(Number(world.expectedMin) || 0, world.kind || 'episode')
        throw new Error(`esperado ${world.expectedMin} min, real ${world.actualMin} min (tolerancia ±${tol.toFixed(1)}) → ${world.durationOk ? 'aceptó' : 'rechazó'}`)
      }
    },
  },
  {
    pattern: /^el preflight es "inconcluso"$/,
    fn: ({ world }) => {
      if (!world.expectedMin && world.durationOk !== true) {
        throw new Error('sin duración esperada el preflight debe dejar pasar (inconcluso)')
      }
    },
  },

  // ── B3 · orden de la cola ──────────────────────────────────────────────
  {
    pattern: /^una serie añadida el "([^"]*)" con estos episodios ya emitidos$/,
    fn: ({ world, rows }, date) => {
      world.addedAt = date
      world.targets = rows.map((r) => ({
        kind: 'episode' as const,
        season: Number(r[0]),
        episode: Number(r[1]),
        air_date: r[2] && r[2] !== '—' && r[2] !== '' ? r[2] : undefined,
      }))
    },
  },
  {
    pattern: /^ordeno la cola de descarga$/,
    fn: ({ world }) => {
      const ordered = orderTargetsForQueue(world.targets || [], world.addedAt || '1970-01-01')
      world.ordered = ordered.map((t) => `S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}`)
    },
  },
  {
    pattern: /^el primer objetivo es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      const first = (world.ordered || [])[0]
      if (first !== expected) throw new Error(`el primero fue ${first}, se esperaba ${expected}`)
    },
  },
  {
    pattern: /^el orden de la cola es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      const got = (world.ordered || []).join(', ')
      const want = expected.split(',').map((s) => s.trim()).filter(Boolean).join(', ')
      if (got !== want) throw new Error(`orden obtenido: ${got}\n            esperado:      ${want}`)
    },
  },

  // ── B5/B8 · biblioteca temporal ────────────────────────────────────────
  {
    pattern: /^una biblioteca temporal$/,
    fn: ({ world }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-spec-'))
      world.root = root
      world.moviesRoot = path.join(root, 'movies')
      world.seriesRoot = path.join(root, 'series')
      fs.mkdirSync(world.moviesRoot, { recursive: true })
      fs.mkdirSync(world.seriesRoot, { recursive: true })
    },
  },
  {
    pattern: /^en la serie "([^"]*)" existe el archivo "([^"]*)"$/,
    fn: ({ world }, series, rel) => { writeIn(path.join(world.seriesRoot!, series, rel)) },
  },
  {
    pattern: /^en la serie "([^"]*)" existe la carpeta "([^"]*)"$/,
    fn: ({ world }, series, rel) => { fs.mkdirSync(path.join(world.seriesRoot!, series, rel), { recursive: true }) },
  },
  {
    pattern: /^en la serie "([^"]*)" hay (\d+) episodios?$/,
    fn: ({ world }, series, count) => {
      const n = Number(count)
      for (let i = 1; i <= n; i++) writeIn(path.join(world.seriesRoot!, series, 'Season 3', `${series.replace(/\s*\(\d{4}\)$/, '')} S03E${String(i).padStart(2, '0')} 1080p WEB.mkv`))
    },
  },
  {
    pattern: /^en películas existe el archivo "([^"]*)"$/,
    fn: ({ world }, rel) => { writeIn(path.join(world.moviesRoot!, rel)) },
  },
  {
    pattern: /^en películas existe la carpeta "([^"]*)"$/,
    fn: ({ world }, rel) => { fs.mkdirSync(path.join(world.moviesRoot!, rel), { recursive: true }) },
  },
  {
    pattern: /^ejecuto la reparación de la biblioteca$/,
    fn: ({ world }) => { world.heal = healLibrary(world.moviesRoot!, world.seriesRoot!) },
  },
  {
    pattern: /^la reparación no movió ni borró nada$/,
    fn: ({ world }) => {
      if (!world.heal) throw new Error('no se ejecutó la reparación antes')
      if (world.heal.changed) {
        throw new Error(`la reparación cambió algo en una biblioteca ya correcta: ${JSON.stringify(world.heal)}`)
      }
    },
  },
  {
    pattern: /^existe "([^"]*)"$/,
    fn: ({ world }, rel) => { if (!existsInLibrary(world, rel)) throw new Error(`no existe "${rel}" (buscado en series/ y movies/)`) },
  },
  {
    pattern: /^no existe "([^"]*)"$/,
    fn: ({ world }, rel) => { if (existsInLibrary(world, rel)) throw new Error(`existe "${rel}" y no debería`) },
  },

  // ── B8 · resolución de carpeta de destino ──────────────────────────────
  {
    pattern: /^resuelvo el destino del release "([^"]*)" para el tmdb id "(\d+)" del año "(\d+)"$/,
    fn: async ({ world }, release, tmdbId, year) => {
      const isSeries = /[sS]\d{1,2}[eE]\d{1,3}/.test(release)
      const settings = {
        destination_folder: '',
        movies_folder: world.moviesRoot!,
        series_folder: world.seriesRoot!,
        tmdb_api_key: process.env.TMDB_API_KEY || '',
      }
      world.dest = await computeDestination(settings, release, isSeries ? 'series' : 'movie', {
        tmdbId: Number(tmdbId),
        year: Number(year),
      })
    },
  },
  {
    pattern: /^la carpeta de destino es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      if (!world.dest) throw new Error('no se resolvió ningún destino antes')
      if (world.dest.folder !== expected) throw new Error(`destino ${world.dest.folder} · esperado ${expected}`)
    },
  },

  // ── B9 · reconciliación del debrid ─────────────────────────────────────
  {
    pattern: /^estos títulos monitorizados$/,
    fn: ({ world, rows }) => {
      world.watched = rows.map((r) => ({
        tmdbId: Number(r[0]),
        mediaType: r[1] === 'movie' ? 'movie' : 'series',
        titles: r[2].split(';').map((s) => s.trim()).filter(Boolean),
        year: Number(r[3]) || undefined,
      }))
    },
  },
  {
    pattern: /^en el debrid hay estos torrents$/,
    fn: ({ world, rows }) => {
      world.torrents = rows.map((r) => ({
        id: Number(r[0]),
        name: r[1],
        state: r[2],
        sizeBytes: Math.round((Number(r[3]) || 0) * 1024 ** 3),
      }))
    },
  },
  {
    pattern: /^los torrents locales son "([^"]*)"$/,
    fn: ({ world }, list) => { world.knownIds = list.split(';').map((s) => Number(s.trim())).filter(Boolean) },
  },
  {
    pattern: /^el tope es de "([^"]*)" GB para series y "([^"]*)" GB para películas$/,
    fn: ({ world }, series, movie) => { world.caps = { series: Number(series) || 0, movie: Number(movie) || 0 } },
  },
  {
    pattern: /^en la biblioteca del título (\d+) existe el episodio "S(\d+)E(\d+)"$/,
    fn: ({ world }, tmdb, season, episode) => {
      world.onDisk = world.onDisk || new Set<string>()
      world.onDisk.add(`${tmdb}:S${Number(season)}E${Number(episode)}`)
    },
  },
  {
    pattern: /^reconcilio el debrid$/,
    fn: ({ world }) => {
      const caps = world.caps || { series: 0, movie: 0 }
      world.plan = planReconcile(world.torrents || [], {
        watched: world.watched || [],
        knownTorrentIds: world.knownIds || [],
        isOnDisk: (tmdbId, mediaType, season, episode) =>
          world.onDisk?.has(mediaType === 'series' ? `${tmdbId}:S${season}E${episode}` : `${tmdbId}:movie`) || false,
        maxSizeGb: (mediaType) => (mediaType === 'movie' ? caps.movie : caps.series),
      })
    },
  },
  {
    pattern: /^se adopta el torrent (\d+) como "([^"]*)" "([^"]*)"$/,
    fn: ({ world }, id, title, marker) => {
      const plan = needPlan(world)
      const hit = plan.adopt.find((d) => d.torrentId === Number(id))
      if (!hit) throw new Error(`no se adoptó el torrent ${id} (descartado: ${reasonOf(world, Number(id))})`)
      const wanted = world.watched?.find((w) => w.tmdbId === hit.tmdbId)
      if (wanted && !wanted.titles.includes(title)) throw new Error(`adoptado con título ${wanted.titles.join('/')}, esperado ${title}`)
      const got = hit.mediaType === 'movie' ? 'película' : `S${String(hit.season).padStart(2, '0')}E${String(hit.episode).padStart(2, '0')}`
      if (got !== marker) throw new Error(`adoptado como ${got}, esperado ${marker}`)
    },
  },
  {
    pattern: /^no se adopta el torrent (\d+)$/,
    fn: ({ world }, id) => {
      const plan = needPlan(world)
      if (plan.adopt.some((d) => d.torrentId === Number(id))) throw new Error(`se adoptó el torrent ${id} y no debería`)
    },
  },
  {
    pattern: /^se descarta el torrent (\d+) porque "([^"]*)"$/,
    fn: ({ world }, id, motivo) => {
      const plan = needPlan(world)
      if (plan.adopt.some((d) => d.torrentId === Number(id))) throw new Error(`se adoptó el torrent ${id} y debía descartarse`)
      const reason = reasonOf(world, Number(id))
      if (!reason) throw new Error(`el torrent ${id} no aparece ni adoptado ni descartado`)
      if (!reason.toLowerCase().includes(motivo.toLowerCase())) throw new Error(`motivo "${reason}", esperado que contuviera "${motivo}"`)
    },
  },
  {
    pattern: /^no se adopta ningún torrent$/,
    fn: ({ world }) => {
      const plan = needPlan(world)
      if (plan.adopt.length > 0) throw new Error(`se adoptaron ${plan.adopt.length}: ${plan.adopt.map((d) => d.name).join(', ')}`)
    },
  },
  {
    pattern: /^el orden de adopción es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      const got = needPlan(world).adopt.map((d) => d.torrentId).join(', ')
      const want = expected.split(',').map((s) => s.trim()).filter(Boolean).join(', ')
      if (got !== want) throw new Error(`orden de adopción: ${got}\n            esperado:          ${want}`)
    },
  },
  {
    pattern: /^el destino del torrent (\d+) es "([^"]*)"$/,
    fn: async ({ world }, id, expected) => {
      const d = needPlan(world).adopt.find((x) => x.torrentId === Number(id))
      if (!d) throw new Error(`el torrent ${id} no está entre los adoptados`)
      const watched = world.watched?.find((w) => w.tmdbId === d.tmdbId)
      if (!watched) throw new Error('no se encontró el título monitorizado del adoptado')
      const settings = {
        destination_folder: '',
        movies_folder: world.moviesRoot!,
        series_folder: world.seriesRoot!,
        tmdb_api_key: process.env.TMDB_API_KEY || '',
      }
      const dest = await adoptionDestination(settings, d, watched)
      if (dest.folder !== expected) throw new Error(`destino de adopción ${dest.folder} · esperado ${expected}`)
    },
  },
]

function needPlan(world: World): ReconcilePlan {
  if (!world.plan) throw new Error('no se reconcilió el debrid antes')
  return world.plan
}

function reasonOf(world: World, id: number): string {
  return world.plan?.skip.find((s) => s.torrentId === id)?.reason || ''
}

function writeIn(abs: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Buffer.alloc(64, 7))
}

function existsInLibrary(world: World, rel: string): boolean {
  return Boolean(
    (world.seriesRoot && fs.existsSync(path.join(world.seriesRoot, rel))) ||
    (world.moviesRoot && fs.existsSync(path.join(world.moviesRoot, rel))),
  )
}
