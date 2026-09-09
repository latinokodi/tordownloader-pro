import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, Plus, Play, Pause, RefreshCw, Trash2, MonitorCheck, Search } from 'lucide-react'
import { useT } from '../i18n'

interface WatchItem {
  id: number
  tmdb_id: number
  media_type: 'movie' | 'series'
  title: string
  year: string
  overview: string
  poster: string
  backdrop: string
  imdb_id: string
  language_profile: 'latino_first' | 'latino_only' | 'english_first'
  monitored: boolean
  added_at: string
  last_checked: string
  next_episode: string
}

interface TmdbHit {
  id: number
  title: string
  media_type: 'movie' | 'tv'
  year: string
  poster: string | null
  overview: string
}

interface MonitorInfo {
  enabled: boolean
  intervalMinutes: number
  running: boolean
  lastRun: string | null
}

async function http<T = any>(path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return (await res.json().catch(() => ({}))) as T
}

const PROFILE_ORDER = ['latino_first', 'latino_only', 'english_first'] as const

export function WatchlistView({ showToast, onActivity }: { showToast: (msg: string, type?: 'success' | 'error') => void; onActivity: () => void }) {
  const t = useT()
  const [items, setItems] = useState<WatchItem[]>([])
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<TmdbHit[]>([])
  const [pendingProfile, setPendingProfile] = useState('latino_first')

  const refresh = useCallback(async () => {
    try {
      const [wl, ms] = await Promise.all([http<any>('/api/watchlist'), http<any>('/api/monitor/status')])
      if (wl?.success) setItems((wl.data || []) as WatchItem[])
      if (ms?.success) setMonitor(ms.data as MonitorInfo)
    } catch { /* transient */ }
  }, [])

  useEffect(() => {
    refresh().catch(() => {})
    const timer = window.setInterval(() => refresh().catch(() => {}), 12000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const monitoredCount = useMemo(() => items.filter((i) => i.monitored).length, [items])

  const doSearch = useCallback(async () => {
    if (!q.trim()) return
    setSearching(true)
    setHits([])
    try {
      const res = await http<any>(`/api/tmdb/search?q=${encodeURIComponent(q.trim())}`)
      if (res?.success) {
        const list: TmdbHit[] = ((res.data || []) as any[])
          .filter((x) => x && x.media_type && x.id)
          .map((x) => ({
            id: Number(x.id),
            title: x.title || x.name || '',
            media_type: x.media_type === 'movie' ? 'movie' : 'tv',
            year: x.year ? String(x.year) : '',
            poster: x.poster || null,
            overview: x.overview || '',
          }))
        setHits(list)
        if (list.length === 0) showToast(t.watchlist.noResults, 'error')
      } else {
        showToast(res?.error || t.watchlist.noResults, 'error')
      }
    } catch (e: any) {
      showToast(e?.message || t.watchlist.noResults, 'error')
    } finally {
      setSearching(false)
    }
  }, [q, showToast, t])

  const addItem = useCallback(async (hit: TmdbHit) => {
    setBusy(true)
    try {
      const res = await http<any>('/api/watchlist', 'POST', {
        tmdb_id: hit.id,
        media_type: hit.media_type === 'movie' ? 'movie' : 'series',
        title: hit.title,
        year: hit.year,
        overview: hit.overview,
        poster: hit.poster,
        language_profile: pendingProfile,
      })
      if (res?.success) {
        showToast(res.created ? t.watchlist.addedToast : t.watchlist.alreadyAdded)
        await refresh()
        setShowAdd(false)
        setQ('')
        setHits([])
      } else {
        showToast(res?.error || t.toasts.error, 'error')
      }
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    } finally {
      setBusy(false)
    }
  }, [pendingProfile, refresh, showToast, t])

  const removeItem = useCallback(async (item: WatchItem) => {
    if (!window.confirm(`${t.watchlist.remove} — ${item.title}?`)) return
    try {
      const res = await http<any>(`/api/watchlist/${item.id}`, 'DELETE')
      if (res?.success) {
        showToast(t.watchlist.removedToast)
        await refresh()
      } else showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
  }, [refresh, showToast, t])

  const setProfile = useCallback(async (item: WatchItem, profile: string) => {
    try {
      const res = await http<any>(`/api/watchlist/${item.id}`, 'PATCH', { language_profile: profile })
      if (res?.success) await refresh()
      else showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
  }, [refresh, showToast, t])

  const toggleMonitored = useCallback(async (item: WatchItem) => {
    try {
      const res = await http<any>(`/api/watchlist/${item.id}`, 'PATCH', { monitored: !item.monitored })
      if (res?.success) await refresh()
      else showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
  }, [refresh, showToast, t])

  const checkItem = useCallback(async (id: number) => {
    try {
      const res = await http<any>(`/api/watchlist/${id}/check`, 'POST')
      if (!res?.success) showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
    window.setTimeout(() => { refresh().catch(() => {}); onActivity() }, 3500)
  }, [onActivity, refresh, showToast, t])

  const runAll = useCallback(async () => {
    setBusy(true)
    try {
      await http<any>('/api/monitor/run', 'POST')
      showToast(t.watchlist.runAllStarted)
    } finally {
      window.setTimeout(() => { setBusy(false); refresh().catch(() => {}) }, 2000)
    }
  }, [refresh, showToast, t])

  const profileLabel = (p: string) =>
    p === 'latino_only' ? t.watchlist.latinoOnly : p === 'english_first' ? t.watchlist.englishFirst : t.watchlist.latinoFirst

  return (
    <div className="h-full flex flex-col space-y-6 animate-fade-in">
      {/* Automation status bar */}
      <div className="glass-panel p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <MonitorCheck size={18} className={monitor?.enabled ? 'text-accent' : 'text-text-muted'} />
          <span className="font-mono text-sm uppercase tracking-wider">
            {monitor?.enabled ? t.watchlist.statusEnabled : t.watchlist.statusDisabled}
          </span>
          {monitor && (
            <span className="text-xs text-text-muted font-mono">
              · {t.watchlist.intervalMin.replace('{min}', String(monitor.intervalMinutes))}
            </span>
          )}
        </div>
        <div className="text-xs text-text-muted font-mono">
          {t.watchlist.monitored} <span className="text-accent font-bold">{monitoredCount}</span>
        </div>
        <div className="text-xs text-text-muted font-mono">
          {t.watchlist.lastRun}: {monitor?.lastRun ? new Date(monitor.lastRun).toLocaleTimeString() : t.watchlist.never}
          {monitor?.running ? ` — ${t.watchlist.checking}` : ''}
        </div>
        <div className="ml-auto flex gap-2">
          <button className="btn border border-border text-xs px-3 hover:border-accent hover:text-accent" onClick={runAll} disabled={busy}>
            <RefreshCw size={13} className={`inline mr-1 ${busy ? 'animate-spin' : ''}`} />
            {t.watchlist.checkAll}
          </button>
          <button className="btn btn-accent text-xs px-3" onClick={() => { setShowAdd((v) => !v); if (showAdd) { setQ(''); setHits([]) } }}>
            <Plus size={14} className="inline mr-1" />
            {t.watchlist.add}
          </button>
        </div>
      </div>

      {/* Add panel */}
      {showAdd && (
        <div className="glass-panel p-4 space-y-4">
          <div className="flex gap-3">
            <input
              className="input-field flex-1"
              placeholder={t.watchlist.searchPlaceholder}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
              autoFocus
            />
            <button className="btn btn-accent" onClick={doSearch} disabled={searching || !q.trim()}>
              <Search size={14} className="inline mr-1" />
              {searching ? t.watchlist.searching : t.watchlist.searchBtn}
            </button>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-text-muted font-mono uppercase tracking-wider">{t.watchlist.profile}</span>
            <select className="input-field w-auto py-1 text-xs" value={pendingProfile} onChange={(e) => setPendingProfile(e.target.value)}>
              {PROFILE_ORDER.map((p) => (
                <option key={p} value={p}>{profileLabel(p)}</option>
              ))}
            </select>
          </div>
          {hits.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 max-h-80 overflow-auto pr-1">
              {hits.map((hit) => (
                <div key={`${hit.media_type}-${hit.id}`} className="border border-border rounded p-2 flex gap-2 items-center hover:border-accent/60">
                  {hit.poster ? (
                    <img src={hit.poster} alt="" className="w-10 h-14 object-cover rounded" loading="lazy" />
                  ) : (
                    <div className="w-10 h-14 bg-bg-deep rounded flex items-center justify-center text-text-muted"><BookMarked size={16} /></div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold truncate">{hit.title}</div>
                    <div className="text-[10px] text-text-muted font-mono">
                      {hit.media_type === 'movie' ? t.watchlist.movie : t.watchlist.series}{hit.year ? ` · ${hit.year}` : ''}
                    </div>
                  </div>
                  <button className="btn border border-accent/50 text-accent px-2 py-1 text-[10px]" onClick={() => addItem(hit)} disabled={busy}>
                    <Plus size={12} className="inline mr-0.5" />{t.watchlist.addItem}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Watchlist rows */}
      <div className="flex-1 overflow-auto space-y-3 pr-1">
        {items.length === 0 && !showAdd && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-text-muted">
            <BookMarked size={40} strokeWidth={1.2} />
            <div className="font-mono uppercase tracking-widest text-sm text-center px-8">{t.watchlist.empty}</div>
          </div>
        )}
        {items.map((item) => (
          <div key={item.id} className={`glass-panel p-3 flex items-center gap-4 ${!item.monitored ? 'opacity-60' : ''}`}>
            {item.poster ? (
              <img src={item.poster} alt="" className="w-12 h-16 object-cover rounded" loading="lazy" />
            ) : (
              <div className="w-12 h-16 bg-bg-deep rounded flex items-center justify-center text-text-muted"><BookMarked size={18} /></div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-sm truncate">{item.title}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 border border-border rounded text-text-muted">
                  {item.media_type === 'movie' ? t.watchlist.movie : t.watchlist.series}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30">
                  {profileLabel(item.language_profile)}
                </span>
                {item.monitored && <span className="text-[10px] font-mono text-emerald-400/90">● {t.watchlist.monitoring}</span>}
                {!item.monitored && <span className="text-[10px] font-mono text-text-muted">○ {t.watchlist.paused}</span>}
              </div>
              <div className="text-[11px] text-text-muted font-mono mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                {item.next_episode && item.media_type === 'series' && (
                  <span className="text-accent/90">{t.watchlist.nextEpisode}: {item.next_episode}</span>
                )}
                <span>{t.watchlist.lastChecked}: {item.last_checked ? new Date(item.last_checked).toLocaleString() : t.watchlist.never}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <select
                className="input-field w-auto py-1 text-[11px] font-mono"
                value={item.language_profile}
                onChange={(e) => setProfile(item, e.target.value)}
                title={t.watchlist.profile}
              >
                {PROFILE_ORDER.map((p) => (
                  <option key={p} value={p}>{profileLabel(p)}</option>
                ))}
              </select>
              <button
                className="btn border border-border text-xs px-2.5 py-1.5 hover:border-accent hover:text-accent"
                title={item.monitored ? t.watchlist.pause : t.watchlist.resume}
                onClick={() => toggleMonitored(item)}
              >
                {item.monitored ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <button
                className="btn border border-border text-xs px-2.5 py-1.5 hover:border-accent hover:text-accent"
                title={t.watchlist.checkNow}
                onClick={() => checkItem(item.id)}
              >
                <RefreshCw size={13} />
              </button>
              <button
                className="btn border border-border text-xs px-2.5 py-1.5 hover:border-danger hover:text-danger"
                title={t.watchlist.remove}
                onClick={() => removeItem(item)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
