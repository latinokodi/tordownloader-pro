import { useState } from 'react'
import { useDiscoverStore, type DiscoverResult } from '../store/discoverTabs'
import { api } from '../hooks/useApi'

function buildMagnetFromHash(infoHash: string, title: string | null): string {
  let magnet = `magnet:?xt=urn:btih:${infoHash}`
  if (title) magnet += `&dn=${encodeURIComponent(title)}`
  return magnet
}

async function handleDownload(
  r: DiscoverResult,
  onAdded: () => void,
  showToast: (msg: string, type?: 'success' | 'error') => void,
  service: string,
  type: string = '',
) {
  const link = r.link
  const trErr = (msg: string) => {
    if (/infringing.file/i.test(msg)) return 'Eliminado por Copyright'
    return msg
  }

  if (link && link.startsWith('magnet:')) {
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add', 'POST', {
        magnet: link,
        info_hash: r.info_hash,
        service,
        type,
      })
      if (res.success) { showToast('Descarga agregada', 'success'); onAdded() }
      else { showToast(`Error: ${trErr((res as any).detail || (res as any).error || 'Unknown')}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Error al descargar', 'error')
    }
    return
  }

  if (link && link.endsWith('.torrent')) {
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add-torrent-url', 'POST', { url: link, service, type })
      if (res.success) { showToast('Descarga agregada', 'success'); onAdded() }
      else { showToast(`Error: ${trErr((res as any).detail || (res as any).error || 'Unknown')}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Error al descargar', 'error')
    }
    return
  }

  if (r.info_hash) {
    const magnet = buildMagnetFromHash(r.info_hash, r.title)
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add', 'POST', {
        magnet,
        info_hash: r.info_hash,
        service,
        type,
      })
      if (res.success) { showToast('Descarga agregada', 'success'); onAdded() }
      else { showToast(`Error: ${trErr((res as any).detail || (res as any).error || 'Unknown')}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Error al descargar', 'error')
    }
    return
  }

  // Debrid direct URLs
  if (link && link.startsWith('http')) {
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add-torrent-url', 'POST', { url: link, service, type })
      if (res.success) { showToast('Descarga agregada', 'success'); onAdded() }
      else { showToast(`Error: ${trErr((res as any).detail || (res as any).error || 'Unknown')}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Error al descargar', 'error')
    }
    return
  }

  showToast('Sin enlace directo', 'error')
}

interface Props {
  onDownloadAdded: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
  service: string
  hasTorbox: boolean
  hasRealdebrid: boolean
  mediaType: 'movie' | 'series'
}

export function DiscoverResults({ onDownloadAdded, showToast, service: defaultService, hasTorbox, hasRealdebrid, mediaType }: Props) {
  const { providerResults, providerLoading, currentProvider } = useDiscoverStore()
  const [downloadService, setDownloadService] = useState(defaultService || (hasTorbox ? 'torbox' : 'realdebrid'))

  const showServiceSelector = hasTorbox && hasRealdebrid

  if (providerLoading && !providerResults) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 bg-bg-deep border border-accent/30 font-mono uppercase tracking-widest text-sm">
        <div className="w-4 h-4 border-2 border-bg-panel border-t-accent rounded-full animate-spin shrink-0" />
        {currentProvider ? (
          <span className="text-accent">
            Buscando en <span className="text-text-main">"{currentProvider}"</span>...
          </span>
        ) : (
          <span className="text-accent">Buscando resultados...</span>
        )}
      </div>
    )
  }

  if (!providerResults || providerResults.length === 0) {
    if (providerLoading) return null
    return (
      <div className="flex flex-col items-center justify-center text-text-muted font-mono uppercase tracking-widest gap-4 py-12">
        <span className="text-4xl opacity-50">🏜️</span>
        <p className="text-sm">Sin resultados</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {providerLoading && (
        <div className="flex items-center gap-3 px-4 py-2 bg-bg-deep border border-accent/30 font-mono uppercase tracking-widest text-xs">
          <div className="w-3 h-3 border-2 border-bg-panel border-t-accent rounded-full animate-spin shrink-0" />
          <span className="text-accent">
            {currentProvider
              ? `Buscando en "${currentProvider}"...`
              : 'Buscando...'}
          </span>
        </div>
      )}
      {providerResults.map((r, i) => (
        <div key={i} className="glass-panel p-4 flex justify-between items-center transition-colors hover:border-accent">
          <div className="flex-1 overflow-hidden pr-4">
            <div className="font-bold text-text-heading truncate" title={r.title ?? ''}>{r.title}</div>
            <div className="flex gap-3 text-xs font-mono text-text-muted mt-2 uppercase tracking-wide">
              {r.seeders >= 0 && <span className="text-success">S {r.seeders}</span>}
              {r.peers >= 0 && <span className="text-text-main">P {r.peers}</span>}
              <span>{r.size}</span>
              <span className="text-accent truncate">{r.indexer}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {showServiceSelector && (
              <select
                className="btn border border-border text-[10px] px-2 py-1 bg-bg-deep font-mono text-text-main"
                value={downloadService}
                onChange={(e) => setDownloadService(e.target.value)}
              >
                <option value="torbox">TorBox</option>
                <option value="realdebrid">RD</option>
              </select>
            )}
            <button
              className="btn btn-accent whitespace-nowrap"
              onClick={() => handleDownload(r, onDownloadAdded, showToast, downloadService, mediaType)}
            >
              Descargar
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
