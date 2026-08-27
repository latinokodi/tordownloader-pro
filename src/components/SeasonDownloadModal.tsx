import { useEffect, useState } from 'react'
import { getElectronAPI, type ApiResult } from '../types/electron'
import type { DiscoverResult, EpisodeInfo } from '../store/discoverTabs'

interface EpisodeEntry {
  episode: EpisodeInfo
  /** All candidate results resolved for this episode (latino providers + metasearch). */
  results: DiscoverResult[]
  /** Index into `results` of the user-selected torrent; -1 when none. */
  selectedIdx: number
  /** Convenience: results[selectedIdx] ?? null. */
  result: DiscoverResult | null
  skip: boolean
  status: 'resolving' | 'ready' | 'adding' | 'ok' | 'dup' | 'present' | 'error'
  /** True when the episode's video file was already found on disk (re-run). */
  preExisting?: boolean
  error?: string
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

/** Info-hash of a result: prefer the explicit field, else parse from a magnet link. */
const hashOf = (r: DiscoverResult): string => {
  const explicit = r.info_hash ? String(r.info_hash).toLowerCase() : ''
  if (explicit) return explicit
  if (r.link?.startsWith('magnet:')) {
    const m = /urn:btih:([a-fA-F0-9]{40})/.exec(r.link)
    return m ? m[1].toLowerCase() : ''
  }
  return ''
}

/** Index of the first candidate (debrid downloads don't depend on seeders). */
const bestIndex = (items: DiscoverResult[]): number => (items.length > 0 ? 0 : -1)

/** Order a result list starting from the user's selection, then the rest. */
const orderCandidates = (e: EpisodeEntry): DiscoverResult[] => {
  if (e.results.length <= 1) return e.results
  const start = Math.max(0, e.selectedIdx)
  const out: DiscoverResult[] = []
  for (let k = 0; k < e.results.length; k++) out.push(e.results[(start + k) % e.results.length])
  return out
}

/** Run `fn` over `items` with at most `limit` concurrent executions, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function SeasonDownloadModal({ seriesTitle, imdbId, season, episodes, service, onClose, onDownloadAdded, showToast }: Props) {
  const [entries, setEntries] = useState<EpisodeEntry[] | null>(null)
  const [doneCount, setDoneCount] = useState(0)
  const [adding, setAdding] = useState(false)
  const [addProgress, setAddProgress] = useState<{ done: number; total: number } | null>(null)

  // Aired-only: skip episodes with a future air_date (ISO YYYY-MM-DD string compare).
  const aired = episodes.filter((ep) => !ep.air_date || ep.air_date <= new Date().toISOString().slice(0, 10))

  const episodeQuery = (epNum: number) => `${seriesTitle} S${pad(season)}E${pad(epNum)}`

  useEffect(() => {
    let cancelled = false
    const ea = getElectronAPI()
    if (!ea) return

    ;(async () => {
      // Re-run detection: episodes whose video file already exists on disk in
      // the season folder are pre-marked as downloaded and skipped — no
      // re-resolution, no re-add, no re-download. Also skips episodes that
      // ALREADY have a transfer in the queue for THIS show+season (re-adding
      // would restart the download). Failed transfers stay re-addable.
      let alreadyDownloaded = new Set<number>()
      let alreadyQueued = new Set<number>()
      try {
        const res = await ea.getDownloadedEpisodes(seriesTitle, season)
        alreadyDownloaded = new Set((res?.episodes ?? []).map(Number))
        alreadyQueued = new Set((res?.queued ?? []).map(Number))
      } catch { /* detection is best-effort */ }

      // Resolved-cache: re-trying the same series + season reuses the previously
      // resolved per-episode results instead of re-running the providers.
      let cachedEpisodes: Record<string, unknown[]> | null = null
      try {
        const c = await ea.getSeasonCache(imdbId, season)
        if (c?.found) cachedEpisodes = c.episodes
      } catch { /* cache is best-effort */ }

      const resolveOne = async (ep: EpisodeInfo): Promise<EpisodeEntry> => {
        if (alreadyDownloaded.has(ep.episode_number)) {
          return { episode: ep, results: [], selectedIdx: -1, result: null, skip: false, status: 'ok', preExisting: true }
        }
        if (alreadyQueued.has(ep.episode_number)) {
          return { episode: ep, results: [], selectedIdx: -1, result: null, skip: false, status: 'dup', preExisting: true }
        }
        let candidates: DiscoverResult[] = []
        // 1) Reuse cached results for this episode when available.
        const cached = cachedEpisodes ? (cachedEpisodes[String(ep.episode_number)] as DiscoverResult[] | undefined) : undefined
        if (Array.isArray(cached) && cached.length > 0) {
          candidates = cached.filter(isValid)
        } else {
          // 2) Latino providers (Cinecalidad/TCL/Comet)
          try {
            const res = await ea.latinoSearchBatch(imdbId, 'series', String(season), String(ep.episode_number))
            candidates = ((res?.data ?? []) as DiscoverResult[]).filter(isValid)
          } catch { /* fall through */ }
          // 3) Keyword metasearch fallback when the providers found nothing
          if (candidates.length === 0) {
            try {
              const res = await ea.searchBatch(episodeQuery(ep.episode_number))
              candidates = ((res?.data ?? []) as DiscoverResult[]).filter(isValid)
            } catch { /* not found */ }
          }
        }
        const best = bestIndex(candidates)
        if (!cancelled) setDoneCount((c) => c + 1)
        return {
          episode: ep,
          results: candidates,
          selectedIdx: best,
          result: best >= 0 ? candidates[best] : null,
          skip: false,
          status: 'ready',
        }
      }

      // Resolve with limited concurrency: firing 20+ Python provider processes at
      // once trips site rate limits and most episodes end up unresolved.
      const list = await mapLimit(aired, 4, resolveOne)
      if (!cancelled) setEntries(list)

      // Persist the freshly resolved results so a re-try is instant.
      if (!cachedEpisodes && !cancelled) {
        const toSave: Record<string, unknown[]> = {}
        for (const e of list) toSave[String(e.episode.episode_number)] = e.results
        ea.saveSeasonCache(imdbId, season, toSave).catch(() => {})
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleSkip = (epNum: number) =>
    setEntries((list) => (list ? list.map((e) => (e.episode.episode_number === epNum ? { ...e, skip: !e.skip } : e)) : list))

  /** Let the user pick which candidate to download for an episode. */
  const selectResult = (epNum: number, idx: number) =>
    setEntries((list) =>
      list
        ? list.map((e) => {
            if (e.episode.episode_number !== epNum) return e
            const next = e.results[idx] ?? null
            return {
              ...e,
              selectedIdx: idx,
              result: next,
              // Re-picking a different torrent after it was added or failed marks
              // the episode as pending again so the new choice gets queued.
              status: e.status === 'ok' || e.status === 'dup' || e.status === 'present' || e.status === 'error' ? 'ready' : e.status,
              error: undefined,
            }
          })
        : list,
    )

  /**
   * Add one episode's selected torrent to the debrid service.
   * Returns the REAL outcome (the IPC result is checked — failures are not silent).
   * `okHashes` tracks torrents already added in this batch so duplicate magnets
   * (e.g. a season pack returned for several episodes) are added exactly once.
   */
  const addOne = async (e: EpisodeEntry, okHashes: Set<string>): Promise<{ ok: boolean; dup?: boolean; already?: boolean; error?: string }> => {
    const r = e.result!
    const ea = getElectronAPI()
    if (!ea) return { ok: false, error: 'API no disponible' }

    const hash = hashOf(r)
    if (hash && okHashes.has(hash)) return { ok: true, dup: true }

    try {
      let res: ApiResult
      if (r.link?.startsWith('magnet:')) {
        res = await ea.addMagnet(r.link, service, 'series', season, e.episode.episode_number)
      } else if (r.link?.startsWith('http')) {
        res = await ea.addTorrentUrl(r.link, service, 'series', season, e.episode.episode_number)
      } else if (hash) {
        res = await ea.addMagnet(buildMagnet(hash, r.title), service, 'series', season, e.episode.episode_number)
      } else {
        return { ok: false, error: 'Sin enlace ni info_hash' }
      }

      if (res?.success) {
        if (hash) okHashes.add(hash)
        return { ok: true }
      }

      // TorBox returns "DIFF_ISSUE" when the torrent's info-hash is already in the
      // account (e.g. a season pack already added for another episode) but with a
      // differing name/file set. Only count it as added when we can confirm the
      // hash actually exists in the account; otherwise surface the real error.
      if (/\bDIFF_ISSUE\b/i.test(res?.error || res?.detail || '')) {
        if (hash && service === 'torbox') {
          try {
            const chk = await ea.torboxHasHash(hash)
            if (chk?.has) {
              okHashes.add(hash)
              return { ok: true, already: true }
            }
          } catch { /* not confirmable → report the error */ }
        }
        return { ok: false, error: res?.error || res?.detail || 'DIFF_ISSUE' }
      }

      return { ok: false, error: res?.error || res?.detail || 'Error desconocido del servicio' }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  const handleConfirm = async () => {
    // Only add what's still pending: results not yet added, not skipped.
    const list = (entries ?? []).filter((e) => e.result && !e.skip && e.status !== 'ok' && e.status !== 'dup' && e.status !== 'present')
    if (list.length === 0) { onClose(); return }

    const okHashes = new Set<string>()
    setAdding(true)
    setAddProgress({ done: 0, total: list.length })
    setEntries((cur) => (cur ? cur.map((e) => (e.result && !e.skip && e.status !== 'ok' && e.status !== 'dup' && e.status !== 'present' ? { ...e, status: 'adding', error: undefined } : e)) : cur))

    // Transient failures (rate limits, timeouts, dead links) get one retry;
    // persistent ones fall through to the next candidate file.
    const isTransient = (err: string) => /rate|limit|429|timeout|ECONN|EAI_AGAIN|network|temporarily|socket/i.test(err || '')

    let ok = 0
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]
      const epNum = entry.episode.episode_number

      // Try the user-selected file first; on failure automatically try the next
      // available file for the SAME episode until one adds successfully.
      const ordered = orderCandidates(entry)
      let outcome: { ok: boolean; dup?: boolean; already?: boolean; error?: string } = { ok: false, error: '?' }
      let winIdx = entry.selectedIdx

      for (let c = 0; c < ordered.length && !outcome.ok; c++) {
        const cand = ordered[c]
        const candEntry: EpisodeEntry = { ...entry, result: cand, selectedIdx: entry.results.indexOf(cand) }

        for (let attempt = 1; attempt <= 2; attempt++) {
          outcome = await addOne(candEntry, okHashes)
          if (outcome.ok) break
          if (attempt === 1 && isTransient(outcome.error || '')) {
            await sleep(2500)
            continue
          }
          break
        }

        if (outcome.ok) {
          winIdx = entry.results.indexOf(cand)
          break
        }
        // Small pause before trying the next file for this episode.
        if (c < ordered.length - 1) await sleep(1200)
      }

      if (outcome.ok) {
        ok++
        const finalStatus = outcome.already ? 'present' : outcome.dup ? 'dup' : 'ok'
        setEntries((cur) => (cur ? cur.map((x) => (x.episode.episode_number === epNum ? { ...x, status: finalStatus, selectedIdx: winIdx, result: entry.results[winIdx] ?? x.result, error: undefined } : x)) : cur))
      } else {
        setEntries((cur) => (cur ? cur.map((x) => (x.episode.episode_number === epNum ? { ...x, status: 'error', error: outcome.error } : x)) : cur))
      }

      setAddProgress({ done: i + 1, total: list.length })
      // Stagger between bulk adds to stay under debrid rate limits.
      if (i < list.length - 1) await sleep(1500)
    }

    onDownloadAdded()
    setAdding(false)
    const failed = list.length - ok
    showToast(
      failed === 0 ? 'Temporada agregada' : `${ok}/${list.length} episodios agregados`,
      ok > 0 ? 'success' : 'error'
    )
    // Keep the modal open: per-episode ✓/✗ lets the user see what failed and retry.
  }

  const readyCount = (entries ?? []).filter((e) => e.result && !e.skip && e.status !== 'ok' && e.status !== 'dup' && e.status !== 'present').length
  const failedCount = (entries ?? []).filter((e) => e.status === 'error').length

  const statusBadge = (e: EpisodeEntry) => {
    switch (e.status) {
      case 'adding':
        return <span className="w-4 h-4 border-2 border-bg-panel border-t-accent rounded-full animate-spin inline-block" />
      case 'ok':
        return <span className="text-emerald-400 font-bold" title="Agregado">✓</span>
      case 'dup':
        return <span className="text-text-muted font-mono text-xs" title="Ya incluido en la cola de transferencias de esta temporada">⧉</span>
      case 'present':
        return <span className="text-emerald-400 font-bold" title="Ya estaba en tu cuenta de debrid">✓</span>
      case 'error':
        return <span className="text-danger font-bold" title={e.error || 'Error'}>✗</span>
      default:
        return null
    }
  }

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
              <div key={e.episode.episode_number} className={`glass-panel p-3 flex items-start gap-3 ${e.skip ? 'opacity-40' : ''}`}>
                <div className="w-5 text-center shrink-0 mt-1">{statusBadge(e)}</div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="font-mono text-accent text-xs">E{pad(e.episode.episode_number)} · {e.episode.name}</div>
                  {e.status === 'ok' && e.preExisting ? (
                    <div className="text-xs text-emerald-400">Ya descargado</div>
                  ) : e.status === 'dup' && e.preExisting ? (
                    <div className="text-xs text-text-muted">Ya en la cola de transferencias</div>
                  ) : e.results.length > 0 ? (
                    <>
                      {e.status === 'error' && (
                        <div className="text-xs text-danger">
                          <div className="truncate" title={e.error}>{e.error}</div>
                          <div className="text-text-muted mt-0.5">Elige otro resultado y toca Reintentar</div>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <select
                          className="flex-1 min-w-0 bg-bg-panel border border-border text-text-main text-xs rounded px-2 py-1"
                          value={e.selectedIdx}
                          disabled={adding}
                          onChange={(ev) => selectResult(e.episode.episode_number, Number(ev.target.value))}
                          title="Elegir qué torrent descargar para este episodio"
                        >
                          {e.results.map((r, i) => (
                            <option key={i} value={i} className="bg-bg-panel text-text-main">
                              {r.title}
                              {r.indexer ? ` · ${r.indexer}` : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          className={`btn text-xs !px-2 !py-1 shrink-0 ${e.skip ? 'btn-accent' : 'border border-border text-text-main'}`}
                          onClick={() => toggleSkip(e.episode.episode_number)}
                          disabled={adding || !e.result}
                        >
                          {e.skip ? 'Incluir' : 'Omitir'}
                        </button>
                      </div>
                      <div className="text-xs text-text-muted truncate" title={e.result?.title}>
                        {e.result?.title}
                        {e.status === 'dup' && <span className="text-text-muted ml-2">· ya en otra transferencia</span>}
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0 text-xs text-danger">{e.status === 'error' ? e.error : 'No encontrado'}</div>
                      <button
                        className={`btn text-xs !px-2 !py-1 shrink-0 ${e.skip ? 'btn-accent' : 'border border-border text-text-main'}`}
                        onClick={() => toggleSkip(e.episode.episode_number)}
                        disabled={adding || !e.result}
                      >
                        {e.skip ? 'Incluir' : 'Omitir'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {entries && (
          <div className="p-4 border-t border-border flex items-center gap-3">
            <span className="text-xs text-text-muted font-mono flex-1">
              {readyCount} de {entries.length} seleccionados
              {addProgress && ` · Agregando ${addProgress.done}/${addProgress.total}`}
            </span>
            <button className="btn border border-border flex-1" onClick={onClose} disabled={adding}>Cerrar</button>
            <button className="btn btn-accent flex-1" onClick={handleConfirm} disabled={adding || readyCount === 0}>
              {adding ? 'Agregando...' : failedCount > 0 ? `Reintentar fallidos (${failedCount})` : 'Descargar'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
