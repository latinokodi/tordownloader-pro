import { useEffect, useState } from 'react'
import { getElectronAPI } from '../types/electron'
import type { DiscoverResult, EpisodeInfo } from '../store/discoverTabs'

interface EpisodeEntry {
  episode: EpisodeInfo
  result: DiscoverResult | null
  skip: boolean
}

interface Props {
  seriesTitle: string
  imdbId: string
  season: number
  episodes: EpisodeInfo[]
  service: string
  onClose: () => void
  onDownloadAdded: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
}

const pad = (n: number) => String(n).padStart(2, '0')
const buildMagnet = (infoHash: string, title: string) =>
  `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`
const isValid = (r: DiscoverResult) => !!(r.link || r.info_hash)
const pickBest = (items: DiscoverResult[]) =>
  [...items].sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1))[0]

export function SeasonDownloadModal({ seriesTitle, imdbId, season, episodes, service, onClose, onDownloadAdded, showToast }: Props) {
  const [entries, setEntries] = useState<EpisodeEntry[] | null>(null)
  const [doneCount, setDoneCount] = useState(0)
  const [adding, setAdding] = useState(false)
  const [addProgress, setAddProgress] = useState<{ done: number; total: number } | null>(null)

  // Aired-only: skip episodes with a future air_date (ISO YYYY-MM-DD string compare).
  const aired = episodes.filter((ep) => !ep.air_date || ep.air_date <= new Date().toISOString().slice(0, 10))

  useEffect(() => {
    let cancelled = false
    const ea = getElectronAPI()
    if (!ea) return

    const resolveOne = async (ep: EpisodeInfo): Promise<EpisodeEntry> => {
      let result: DiscoverResult | null = null
      // 1) Latino providers (Cinecalidad/TCL/Comet)
      try {
        const res = await ea.latinoSearchBatch(imdbId, 'series', String(season), String(ep.episode_number))
        const items = ((res?.data ?? []) as DiscoverResult[]).filter(isValid)
        if (items.length) result = pickBest(items)
      } catch { /* fall through */ }
      // 2) Keyword metasearch fallback
      if (!result) {
        try {
          const q = `${seriesTitle} S${pad(season)}E${pad(ep.episode_number)}`
          const res = await ea.searchBatch(q)
          const items = ((res?.data ?? []) as DiscoverResult[]).filter(isValid)
          if (items.length) result = pickBest(items)
        } catch { /* not found */ }
      }
      if (!cancelled) setDoneCount((c) => c + 1)
      return { episode: ep, result, skip: false }
    }

    Promise.all(aired.map(resolveOne)).then((list) => {
      if (!cancelled) setEntries(list)
    })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleSkip = (epNum: number) =>
    setEntries((list) => (list ? list.map((e) => (e.episode.episode_number === epNum ? { ...e, skip: !e.skip } : e)) : list))

  const addOne = async (e: EpisodeEntry): Promise<boolean> => {
    const r = e.result!
    const ea = getElectronAPI()
    if (!ea) return false
    try {
      if (r.link?.startsWith('magnet:')) {
        await ea.addMagnet(r.link, service, 'series', season, e.episode.episode_number)
      } else if (r.link?.startsWith('http')) {
        await ea.addTorrentUrl(r.link, service, 'series', season, e.episode.episode_number)
      } else if (r.info_hash) {
        await ea.addMagnet(buildMagnet(r.info_hash, r.title), service, 'series', season, e.episode.episode_number)
      } else {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  const handleConfirm = async () => {
    const toAdd = (entries ?? []).filter((e) => e.result && !e.skip)
    if (toAdd.length === 0) { onClose(); return }
    setAdding(true)
    setAddProgress({ done: 0, total: toAdd.length })
    let ok = 0
    for (let i = 0; i < toAdd.length; i++) {
      if (await addOne(toAdd[i])) ok++
      setAddProgress({ done: i + 1, total: toAdd.length })
      // ponytail: 800ms stagger avoids debrid rate-limit trips on bulk adds
      await new Promise((r) => setTimeout(r, 800))
    }
    onDownloadAdded()
    showToast(ok === toAdd.length ? 'Temporada agregada' : `${ok}/${toAdd.length} episodios agregados`, ok > 0 ? 'success' : 'error')
    onClose()
  }

  const selectedCount = (entries ?? []).filter((e) => e.result && !e.skip).length

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="glass-panel w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-border flex justify-between items-center">
          <h3 className="text-sm font-bold text-text-heading uppercase tracking-wider">
            Descargar Temporada {season} · {aired.length} episodios
          </h3>
          <button className="btn border border-border text-text-main !px-2 !py-1" onClick={onClose} disabled={adding}>✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {aired.length === 0 ? (
            <p className="text-center text-text-muted font-mono uppercase text-sm py-8">Sin episodios emitidos</p>
          ) : !entries ? (
            <div className="text-center text-text-muted font-mono uppercase text-sm py-8">
              <div className="w-4 h-4 border-2 border-bg-panel border-t-accent rounded-full animate-spin inline-block mr-2 align-middle" />
              Resolviendo episodios... {doneCount}/{aired.length}
            </div>
          ) : (
            entries.map((e) => (
              <div key={e.episode.episode_number} className={`glass-panel p-3 flex items-center gap-3 ${e.skip ? 'opacity-40' : ''}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-accent text-xs">E{pad(e.episode.episode_number)} · {e.episode.name}</div>
                  {e.result ? (
                    <div className="text-xs text-text-muted truncate" title={e.result.title}>
                      {e.result.title}
                      <span className="text-text-main ml-2">S{e.result.seeders >= 0 ? e.result.seeders : '?'}</span>
                      <span className="text-accent ml-2">{e.result.indexer}</span>
                    </div>
                  ) : (
                    <div className="text-xs text-danger">No encontrado</div>
                  )}
                </div>
                <button
                  className={`btn text-xs !px-2 !py-1 ${e.skip ? 'btn-accent' : 'border border-border text-text-main'}`}
                  onClick={() => toggleSkip(e.episode.episode_number)}
                  disabled={adding || !e.result}
                >
                  {e.skip ? 'Incluir' : 'Omitir'}
                </button>
              </div>
            ))
          )}
        </div>

        {entries && (
          <div className="p-4 border-t border-border flex items-center gap-3">
            <span className="text-xs text-text-muted font-mono flex-1">
              {selectedCount} de {entries.length} seleccionados
              {addProgress && ` · Agregando ${addProgress.done}/${addProgress.total}`}
            </span>
            <button className="btn border border-border flex-1" onClick={onClose} disabled={adding}>Cancelar</button>
            <button className="btn btn-accent flex-1" onClick={handleConfirm} disabled={adding || selectedCount === 0}>
              {adding ? 'Agregando...' : 'Descargar'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
