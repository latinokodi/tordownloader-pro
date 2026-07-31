import { useSearchTabsStore } from '../store/searchTabs'
import type { SearchResult } from '../store/searchTabs'
import { api } from '../hooks/useApi'
import { useT } from '../i18n'

interface Props {
  onDownloadAdded: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
}

function formatSize(size: string | null): string {
  if (!size) return '?'
  if (!/^\d+$/.test(size.trim())) {
    return size
  }
  const b = parseInt(size)
  if (isNaN(b) || b === 0) return '?'
  const gb = b / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(2)} MB`
}

function buildMagnetFromHash(infoHash: string, title: string | null): string {
  let magnet = `magnet:?xt=urn:btih:${infoHash}`
  if (title) {
    magnet += `&dn=${encodeURIComponent(title)}`
  }
  return magnet
}

async function handleDownload(r: SearchResult, onAdded: () => void, showToast: Props['showToast'], t: ReturnType<typeof useT>) {
  const link = r.link

  if (link && link.startsWith('magnet:')) {
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add', 'POST', {
        magnet: link,
        info_hash: r.info_hash,
      })
      if (res.success) { showToast(t.search.downloadAdded, 'success'); onAdded() }
      else { showToast(`${t.toasts.error}: ${(res as any).detail || (res as any).error || t.toasts.unknownError}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : t.search.downloadError, 'error')
    }
    return
  }

  if (link && link.endsWith('.torrent')) {
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add-torrent-url', 'POST', { url: link })
      if (res.success) { showToast(t.search.downloadAdded, 'success'); onAdded() }
      else { showToast(`${t.toasts.error}: ${(res as any).detail || (res as any).error || t.toasts.unknownError}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : t.search.downloadError, 'error')
    }
    return
  }

  if (r.info_hash) {
    const magnet = buildMagnetFromHash(r.info_hash, r.title)
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add', 'POST', {
        magnet,
        info_hash: r.info_hash,
      })
      if (res.success) { showToast(t.search.downloadAdded, 'success'); onAdded() }
      else { showToast(`${t.toasts.error}: ${(res as any).detail || (res as any).error || t.toasts.unknownError}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : t.search.downloadError, 'error')
    }
    return
  }

  showToast(t.search.noDirectLink, 'error')
}

export function SearchTab({ onDownloadAdded, showToast }: Props) {
  const t = useT()
  const { tabs, activeTabId } = useSearchTabsStore()
  const tab = activeTabId ? tabs[activeTabId] : null

  if (!tab) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-text-muted font-mono uppercase tracking-widest gap-4 min-h-[300px]">
        <span className="text-4xl opacity-50">🔍</span>
        <p>{t.search.emptyQuery}</p>
      </div>
    )
  }

  if (tab.loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-accent font-mono uppercase tracking-widest gap-4 min-h-[300px]">
        <div className="w-12 h-12 border-4 border-bg-deep border-t-accent rounded-full animate-spin" />
        <p>{t.search.searching} "{tab.query}"...</p>
      </div>
    )
  }

  if (tab.error) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-danger font-mono uppercase tracking-widest gap-4 min-h-[300px]">
        <span className="text-4xl">⚠️</span>
        <p>{tab.error}</p>
      </div>
    )
  }

  if (!tab.results || tab.results.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-text-muted font-mono uppercase tracking-widest gap-4 min-h-[300px]">
        <span className="text-4xl opacity-50">🏜️</span>
        <p>{t.search.noResults} "{tab.query}"</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {tab.results.map((r: SearchResult, i: number) => (
        <div key={i} className="glass-panel p-4 flex justify-between items-center transition-colors hover:border-accent">
          <div className="flex-1 overflow-hidden pr-4">
            <div className="font-bold text-text-heading truncate" title={r.title ?? ''}>{r.title}</div>
            <div className="flex gap-4 text-xs font-mono text-text-muted mt-2 uppercase tracking-wide">
              <span className="text-success">{t.downloadCard.seeds} {r.seeders}</span>
              <span className="text-text-main">PEERS {r.peers}</span>
              <span>{formatSize(r.size)}</span>
              <span className="text-accent truncate">{r.indexer}</span>
            </div>
          </div>
          <button
            className="btn btn-accent whitespace-nowrap"
            disabled={!r.link && !r.info_hash}
            onClick={() => handleDownload(r, onDownloadAdded, showToast, t)}
          >
            {(r.link || r.info_hash) ? t.search.acquire : t.search.unavailable}
          </button>
        </div>
      ))}
    </div>
  )
}
