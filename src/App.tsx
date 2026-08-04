import { useState, useCallback, useEffect } from 'react'
import { SearchTabsBar } from './components/SearchTabsBar'
import { SearchTab } from './components/SearchTab'
import { DownloadCard } from './components/DownloadCard'
import { SettingsModal } from './components/SettingsModal'
import { LogPanel } from './components/LogPanel'
import { useSearchTabsStore } from './store/searchTabs'
import { useWebSocket } from './hooks/useWebSocket'
import { api } from './hooks/useApi'
import { useT, useTranslateError } from './i18n'
import { LangToggle } from './i18n/LangToggle'
import { Settings, DownloadCloud, Search, Magnet, ScrollText, FolderOpen, Compass } from 'lucide-react'
import { DiscoverView } from './components/DiscoverView'

function App() {
  const t = useT()
  const trErr = useTranslateError()
  const [query, setQuery] = useState('')
  const [magnetUrl, setMagnetUrl] = useState('')
  const [addingMagnet, setAddingMagnet] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [activeNav, setActiveNav] = useState('search')
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [downloads, setDownloads] = useState<any[]>([])
  const [destFolder, setDestFolder] = useState('')
  const [flaresolverrStatus, setFlareSolverrStatus] = useState<'ready' | 'starting' | 'failed' | 'off'>('starting')
  const [downloadService, setDownloadService] = useState<'torbox' | 'realdebrid'>('torbox')
  const [hasTorbox, setHasTorbox] = useState(false)
  const [hasRealdebrid, setHasRealdebrid] = useState(false)

  // ── Auto-update state ──
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [updateDownloaded, setUpdateDownloaded] = useState(false)
  const [updatePercent, setUpdatePercent] = useState(0)
  const [updateError, setUpdateError] = useState<string | null>(null)

  const { addTab, setTabResult, setTabError, appendResults, setCurrentEngine, markSearchDone } = useSearchTabsStore()

  useEffect(() => {
    if (!toast) return
    const tt = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(tt)
  }, [toast])

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
  }, [])

  const isServiceAvailable = useCallback((): boolean => {
    if (downloadService === 'torbox') return hasTorbox
    if (downloadService === 'realdebrid') return hasRealdebrid
    return false
  }, [downloadService, hasTorbox, hasRealdebrid])

  const refreshDownloads = useCallback(async () => {
    const res = await api<any>('/downloads')
    const dlArray = Array.isArray(res) ? res : res?.data ?? []
    setDownloads(dlArray)
  }, [])

  useWebSocket('/api/ws', (data: any) => {
    if (data.type === 'status' && data.downloads) {
      setDownloads(data.downloads)
    }
  })

  useEffect(() => {
    refreshDownloads().catch(console.error)
    const timer = window.setInterval(() => {
      refreshDownloads().catch(console.error)
    }, 12000)
    
    // Load destination folder from settings
    api<any>('/settings').then((settings: any) => {
      if (settings?.destination_folder) setDestFolder(settings.destination_folder)
      const tb = !!settings?.torbox_token
      const rd = !!settings?.realdebrid_token
      setHasTorbox(tb)
      setHasRealdebrid(rd)
      // Auto-select the only available service when just one is configured
      if (tb && !rd) setDownloadService('torbox')
      else if (!tb && rd) setDownloadService('realdebrid')
    }).catch(() => {})
    
    if ((window as any).electronAPI?.onDownloadsUpdated) {
      (window as any).electronAPI.onDownloadsUpdated(() => {
        refreshDownloads().catch(console.error)
      })
    }
    if ((window as any).electronAPI?.onFlareSolverrReady) {
      (window as any).electronAPI.onFlareSolverrReady(() => {
        setFlareSolverrStatus('ready')
      })
    }
    // Query initial FlareSolverr status
    if ((window as any).electronAPI?.flaresolverrStatus) {
      (window as any).electronAPI.flaresolverrStatus().then((res: any) => {
        if (res?.status) setFlareSolverrStatus(res.status)
      }).catch(() => {})
    }

    // Streaming search progress listener
    const cleanupSearchProgress = (window as any).electronAPI?.onSearchProgress?.((progress: any) => {
      const store = useSearchTabsStore.getState()
      const activeTabId = store.activeTabId
      if (!activeTabId) return

      if (progress.type === 'engine_start') {
        store.setCurrentEngine(activeTabId, progress.engine)
      } else if (progress.type === 'engine_results' && progress.results?.length > 0) {
        store.appendResults(activeTabId, progress.results)
      }
    })

    const cleanupSearchError = (window as any).electronAPI?.onSearchError?.((error: string) => {
      const store = useSearchTabsStore.getState()
      const activeTabId = store.activeTabId
      if (activeTabId) {
        store.setTabError(activeTabId, error)
      }
    })

    // ── Auto-update listeners ──
    const ea = (window as any).electronAPI
    const cleanupUpdateAvailable = ea?.onUpdateAvailable?.((version: string) => {
      setUpdateVersion(version)
    })
    const cleanupUpdateNotAvailable = ea?.onUpdateNotAvailable?.(() => {
      // Called on manual check — no UI change needed here
    })
    const cleanupUpdateProgress = ea?.onUpdateDownloadProgress?.((percent: number) => {
      setUpdatePercent(Math.round(percent))
    })
    const cleanupUpdateDownloaded = ea?.onUpdateDownloaded?.(() => {
      setUpdateDownloading(false)
      setUpdateDownloaded(true)
    })
    const cleanupUpdateError = ea?.onUpdateError?.((message: string) => {
      setUpdateDownloading(false)
      setUpdateError(message)
      showToast(message, 'error')
    })

    return () => {
      window.clearInterval(timer)
      cleanupSearchProgress?.()
      cleanupSearchError?.()
      cleanupUpdateAvailable?.()
      cleanupUpdateNotAvailable?.()
      cleanupUpdateProgress?.()
      cleanupUpdateDownloaded?.()
      cleanupUpdateError?.()
    }
  }, [refreshDownloads])

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return

    const tabId = addTab(query)
    const currentQuery = query
    setQuery('')

    try {
      const res = await api<any>('/search', 'POST', { query: currentQuery })
      // Streaming results already arrived via IPC — just mark done
      // But if no results came through streaming, use the final batch
      const store = useSearchTabsStore.getState()
      const tab = store.tabs[tabId]
      if (tab && (!tab.results || tab.results.length === 0)) {
        store.setTabResult(tabId, res.data ?? res.results ?? [])
      } else {
        store.markSearchDone(tabId)
      }
    } catch (err: any) {
      setTabError(tabId, err.message || t.toasts.searchFailed)
    }
  }

  const handleMagnetSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const raw = magnetUrl.trim()
    if (!raw) return

    if (!isServiceAvailable()) {
      showToast(t.magnetBar.noService, 'error')
      return
    }

    setAddingMagnet(true)
    setMagnetUrl('')

    try {
      let res: any

      if (raw.startsWith('magnet:?')) {
        res = await api<any>('/downloads/add', 'POST', { magnet: raw, service: downloadService })
      } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
        res = await api<any>('/downloads/add-torrent-url', 'POST', { url: raw, service: downloadService })
      } else {
        showToast(t.toasts.invalidInput, 'error')
        setAddingMagnet(false)
        return
      }

      if (res.success) {
        const label = raw.startsWith('magnet:?') ? t.toasts.magnetAdded : t.toasts.torrentAdded
        showToast(label, 'success')
        await refreshDownloads()
      } else {
        showToast(`${t.toasts.error}: ${trErr(res.error || res.detail || t.toasts.unknownError)}`, 'error')
      }
    } catch (err: any) {
      showToast(err.message || t.toasts.failedAdd, 'error')
    } finally {
      setAddingMagnet(false)
    }
  }

  const handleDeleteDownload = async (id: string, isCompleted: boolean) => {
    try {
      void isCompleted
      await api(`/downloads/${id}`, 'DELETE')
      await refreshDownloads()
    } catch (err: any) {
      showToast(err.message || t.toasts.failedDelete, 'error')
    }
  }

  const handleCancelDownload = async (id: string) => {
    try {
      await api(`/downloads/cancel/${id}`, 'POST')
      await refreshDownloads()
      showToast(t.toasts.downloadCancelled, 'success')
    } catch (err: any) {
      showToast(err.message || t.toasts.failedCancel, 'error')
    }
  }

  const handleOpenFolder = async () => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.openFolder) return
    if (!destFolder) {
      showToast(t.toasts.noDestFolder, 'error')
      return
    }
    const result = await electronAPI.openFolder(destFolder)
    if (!result.success) {
      showToast(`${t.toasts.failedOpenFolder}: ${result.error}`, 'error')
    }
  }

  const handleSettingsClose = async () => {
    setShowSettings(false)
    // Re-fetch settings to refresh service availability
    try {
      const settings: any = await api<any>('/settings')
      if (settings?.destination_folder) setDestFolder(settings.destination_folder)
      const tb = !!settings?.torbox_token
      const rd = !!settings?.realdebrid_token
      setHasTorbox(tb)
      setHasRealdebrid(rd)
      // Auto-select the only available service when just one is configured
      if (tb && !rd) setDownloadService('torbox')
      else if (!tb && rd) setDownloadService('realdebrid')
    } catch (_) {}
  }

  // RD uses 'downloaded', TorBox uses 'completed'/'cached'/'finished'
  const activeCloud = downloads.filter((d) => !['completed', 'cached', 'finished', 'downloaded'].includes((d.status || '').toLowerCase())).length
  const activeLocal = downloads.filter((d) => (d.local_status || '').toLowerCase().startsWith('downloading')).length

  return (
    <div className="flex h-screen w-full bg-bg-deep text-text-main font-display overflow-hidden relative">
      
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-bg-panel flex flex-col z-10">
        <div className="p-6 border-b border-border flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 bg-accent flex items-center justify-center text-bg-deep font-black font-mono">TB</div>
            {/* FlareSolverr status indicator */}
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg-panel ${
                flaresolverrStatus === 'ready' ? 'bg-green-500'
                : flaresolverrStatus === 'starting' ? 'bg-yellow-500 animate-pulse'
                : flaresolverrStatus === 'failed' ? 'bg-red-500'
                : 'bg-gray-600'
              }`}
              title={
                flaresolverrStatus === 'ready' ? 'FlareSolverr — ready'
                : flaresolverrStatus === 'starting' ? 'FlareSolverr — starting...'
                : flaresolverrStatus === 'failed' ? 'FlareSolverr — failed (max restarts)'
                : 'FlareSolverr — not installed'
              }
            />
          </div>
          <span className="font-bold uppercase tracking-wider text-sm">TorDownloader</span>
        </div>
        
        <nav className="flex-1 p-4 space-y-2">
          <button
            className={`w-full text-left px-4 py-3 font-mono text-sm tracking-wide uppercase transition-colors ${activeNav === 'search' ? 'bg-accent/10 text-accent border-l-2 border-accent' : 'text-text-muted hover:text-text-main'}`}
            onClick={() => setActiveNav('search')}
          >
            <div className="flex items-center gap-2"><Search size={16}/> {t.nav.search}</div>
          </button>
          <button
            className={`w-full text-left px-4 py-3 font-mono text-sm tracking-wide uppercase transition-colors ${activeNav === 'downloads' ? 'bg-accent/10 text-accent border-l-2 border-accent' : 'text-text-muted hover:text-text-main'}`}
            onClick={() => setActiveNav('downloads')}
          >
             <div className="flex items-center gap-2">
                <DownloadCloud size={16}/> {t.nav.transfers}
                {downloads.length > 0 && <span className="ml-auto bg-accent text-bg-deep px-2 py-0.5 text-xs font-bold">{downloads.length}</span>}
             </div>
          </button>
          <button
            className={`w-full text-left px-4 py-3 font-mono text-sm tracking-wide uppercase transition-colors ${activeNav === 'discover' ? 'bg-accent/10 text-accent border-l-2 border-accent' : 'text-text-muted hover:text-text-main'}`}
            onClick={() => setActiveNav('discover')}
          >
            <div className="flex items-center gap-2"><Compass size={16}/> Discover</div>
          </button>
          <button
            className={`w-full text-left px-4 py-3 font-mono text-sm tracking-wide uppercase transition-colors ${activeNav === 'logs' ? 'bg-accent/10 text-accent border-l-2 border-accent' : 'text-text-muted hover:text-text-main'}`}
            onClick={() => setActiveNav('logs')}
          >
            <div className="flex items-center gap-2"><ScrollText size={16}/> {t.nav.logs}</div>
          </button>
        </nav>

        {/* FlareSolverr status */}
        <div className="px-4 py-3 border-t border-border space-y-2">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                flaresolverrStatus === 'ready' ? 'bg-green-500'
                : flaresolverrStatus === 'starting' ? 'bg-yellow-500 animate-pulse'
                : flaresolverrStatus === 'failed' ? 'bg-red-500'
                : 'bg-gray-600'
              }`}
            />
            <span className={`text-xs font-mono uppercase ${
              flaresolverrStatus === 'ready' ? 'text-success'
              : flaresolverrStatus === 'starting' ? 'text-yellow-500'
              : flaresolverrStatus === 'failed' ? 'text-danger'
              : 'text-text-muted'
            }`}>
              {flaresolverrStatus === 'ready' ? 'FlareSolverr Ready'
                : flaresolverrStatus === 'starting' ? 'FlareSolverr Starting...'
                : flaresolverrStatus === 'failed' ? 'FlareSolverr Failed'
                : 'FlareSolverr Off'}
            </span>
          </div>
          <button
            className="w-full btn border border-border text-text-main hover:border-accent text-xs font-mono"
            onClick={async () => {
              setFlareSolverrStatus('starting')
              try {
                const ea = (window as any).electronAPI
                const res = await ea?.flaresolverrRestart()
                if (res?.success) {
                  setFlareSolverrStatus('ready')
                } else {
                  setFlareSolverrStatus('failed')
                }
              } catch {
                setFlareSolverrStatus('failed')
              }
            }}
          >
            {flaresolverrStatus === 'starting' ? 'Restarting...' : 'Restart FlareSolverr'}
          </button>
        </div>

        <div className="p-4 border-t border-border space-y-2">
          <LangToggle />
          <button className="w-full btn btn-accent" onClick={() => setShowSettings(true)}>
            <Settings size={14}/> {t.nav.settings}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative z-10 h-full overflow-hidden">
        
        <header className="border-b border-border p-6 bg-bg-card flex justify-between items-end">
          <div>
            <h1 className="text-2xl font-black uppercase tracking-tight text-text-heading">{t.header.title}</h1>
            <p className="text-text-muted text-sm mt-1 font-mono">{t.header.subtitle}</p>
          </div>
          <div className="flex gap-6 font-mono text-xs uppercase tracking-widest text-text-muted">
            <div className="text-right">
              <div className="text-accent text-xl font-bold">{activeCloud}</div>
              <div>{t.header.cloudActive}</div>
            </div>
            <div className="text-right">
              <div className="text-success text-xl font-bold">{activeLocal}</div>
              <div>{t.header.localActive}</div>
            </div>
          </div>
        </header>

        {/* Magnet Link Bar — only visible on Search */}
        {activeNav === 'search' && (
        <form className="magnet-bar px-6 py-3 bg-bg-deep border-b border-border flex gap-3 items-center" onSubmit={handleMagnetSubmit}>
          <Magnet size={18} className="text-accent shrink-0" />
          <input
            type="text"
            className="input-field flex-1 text-sm font-mono"
            placeholder={t.magnetBar.placeholder}
            value={magnetUrl}
            onChange={(e) => setMagnetUrl(e.target.value)}
            disabled={addingMagnet}
          />
          <button
            type="submit"
            className="btn btn-accent whitespace-nowrap font-mono text-xs"
            disabled={addingMagnet || !magnetUrl.trim() || !isServiceAvailable()}
            title={!isServiceAvailable() ? t.magnetBar.noService : undefined}
          >
            {addingMagnet ? t.magnetBar.adding : t.magnetBar.addLink}
          </button>
          {(hasTorbox && hasRealdebrid) && (
            <select
              className="btn border border-border text-xs px-2 bg-bg-deep font-mono text-text-main"
              value={downloadService}
              onChange={(e) => setDownloadService(e.target.value as 'torbox' | 'realdebrid')}
              disabled={addingMagnet}
            >
              <option value="torbox">TorBox</option>
              <option value="realdebrid">Real-Debrid</option>
            </select>
          )}
        </form>
        )}

        <div className="flex-1 overflow-auto p-6">
          {activeNav === 'search' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <form className="flex gap-4" onSubmit={handleSearch}>
                <input
                  type="text"
                  className="input-field flex-1"
                  placeholder={t.search.placeholder}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button type="submit" className="btn btn-accent">{t.search.initSearch}</button>
                {(hasTorbox && hasRealdebrid) && (
                  <select
                    className="btn border border-border text-xs px-2 bg-bg-deep font-mono text-text-main"
                    value={downloadService}
                    onChange={(e) => setDownloadService(e.target.value as 'torbox' | 'realdebrid')}
                  >
                    <option value="torbox">TorBox</option>
                    <option value="realdebrid">Real-Debrid</option>
                  </select>
                )}
              </form>

              <SearchTabsBar />
              
              <div className="flex-1 overflow-auto glass-panel p-4">
                <SearchTab onDownloadAdded={refreshDownloads} showToast={showToast} service={downloadService} serviceAvailable={isServiceAvailable()} />
              </div>
            </div>
          )}

          {activeNav === 'downloads' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <div className="glass-panel flex-1 overflow-auto p-4 space-y-4">
                <div className="flex justify-between items-center pb-2 border-b border-border/50">
                  <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider">{t.transfers.activeQueue}</h3>
                  <div className="flex gap-2">
                    <button 
                      onClick={handleOpenFolder}
                      className="btn border border-border text-xs px-3 hover:border-accent hover:text-accent font-mono"
                      disabled={!destFolder}
                      title={destFolder || t.toasts.noDestFolder}
                    >
                      <FolderOpen size={14} className="inline mr-1" />{t.transfers.openDest}
                    </button>
                    <button 
                      onClick={async () => {
                        try {
                          await api('/downloads/clear-completed', 'POST')
                          await refreshDownloads()
                          showToast(t.transfers.completedCleared, 'success')
                        } catch(e: any) {
                          showToast(e.message || t.transfers.clearFailed, 'error')
                        }
                      }} 
                      className="btn border border-border text-xs px-3 hover:border-danger hover:text-danger"
                    >
                      {t.transfers.clearCompleted}
                    </button>
                  </div>
                </div>
                {downloads.length === 0 && (
                  <div className="h-full flex items-center justify-center text-text-muted font-mono uppercase tracking-widest">
                    {t.transfers.noActive}
                  </div>
                )}
                {downloads.map(dl => (
                  <DownloadCard 
                    key={dl.id} 
                    download={dl} 
                    onDelete={handleDeleteDownload}
                    onCancel={handleCancelDownload}
                  />
                ))}
              </div>
            </div>
          )}

          {activeNav === 'logs' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <div className="glass-panel flex-1 overflow-auto p-4">
                <LogPanel />
              </div>
            </div>
          )}

          {activeNav === 'discover' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <div className="glass-panel flex-1 overflow-auto p-4">
                <DiscoverView
                  onDownloadAdded={refreshDownloads}
                  showToast={showToast}
                  service={downloadService}
                  hasTorbox={hasTorbox}
                  hasRealdebrid={hasRealdebrid}
                />
              </div>
            </div>
          )}
        </div>
      </main>

      {showSettings && (
        <SettingsModal
          onClose={handleSettingsClose}
          showToast={showToast}
        />
      )}

      {/* ── Update dialog ── */}
      {updateVersion && !updateDownloading && !updateDownloaded && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in">
          <div className="glass-panel w-full max-w-md bg-bg-panel border border-border shadow-2xl p-8 text-center space-y-6">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest">{t.update.available}</h3>
            <p className="text-2xl font-black text-text-heading">v{updateVersion}</p>
            <p className="text-text-muted font-mono text-sm">{t.update.currentVersion} 1.0.12</p>
            <div className="flex gap-4 justify-center">
              <button
                className="btn border border-border text-text-muted hover:text-text-main"
                onClick={() => {
                  setUpdateVersion(null)
                  ;(window as any).electronAPI?.dismissUpdate()
                }}
              >
                {t.update.notNow}
              </button>
              <button
                className="btn btn-accent"
                onClick={() => {
                  setUpdateDownloading(true)
                  ;(window as any).electronAPI?.downloadUpdate()
                }}
              >
                {t.update.download}
              </button>
            </div>
          </div>
        </div>
      )}

      {updateDownloading && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in">
          <div className="glass-panel w-full max-w-md bg-bg-panel border border-border shadow-2xl p-8 text-center space-y-4">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest">{t.update.downloading}</h3>
            <div className="w-full bg-bg-deep border border-border h-3">
              <div className="h-full bg-accent transition-all duration-300" style={{ width: `${updatePercent}%` }} />
            </div>
            <p className="text-text-muted font-mono text-sm">{updatePercent}%</p>
          </div>
        </div>
      )}

      {updateDownloaded && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in">
          <div className="glass-panel w-full max-w-md bg-bg-panel border border-border shadow-2xl p-8 text-center space-y-6">
            <h3 className="text-success font-mono text-sm uppercase tracking-widest">{t.update.ready}</h3>
            <div className="flex gap-4 justify-center">
              <button
                className="btn border border-border text-text-muted hover:text-text-main"
                onClick={() => {
                  setUpdateDownloaded(false)
                  setUpdateVersion(null)
                }}
              >
                {t.update.later}
              </button>
              <button
                className="btn btn-accent"
                onClick={() => {
                  ;(window as any).electronAPI?.installUpdate()
                }}
              >
                {t.update.restartNow}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 glass-panel p-4 px-6 border-l-4 font-mono text-sm uppercase animate-slide-up ${toast.type === 'error' ? 'border-l-danger text-danger' : 'border-l-success text-success'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

export default App
