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
]

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
