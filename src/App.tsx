import { useState, useCallback, useEffect } from 'react'
import { SearchTabsBar } from './components/SearchTabsBar'
import { SearchTab } from './components/SearchTab'
import { DownloadCard } from './components/DownloadCard'
import { SettingsModal } from './components/SettingsModal'
import { LogPanel } from './components/LogPanel'
import { useSearchTabsStore } from './store/searchTabs'
import { useWebSocket } from './hooks/useWebSocket'
import { api } from './hooks/useApi'
import { useT } from './i18n'
import { LangToggle } from './i18n/LangToggle'
import { Settings, DownloadCloud, Search, Magnet, ScrollText, FolderOpen } from 'lucide-react'

function App() {
  const t = useT()
  const [query, setQuery] = useState('')
  const [magnetUrl, setMagnetUrl] = useState('')
  const [addingMagnet, setAddingMagnet] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [activeNav, setActiveNav] = useState('search')
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [downloads, setDownloads] = useState<any[]>([])
  const [destFolder, setDestFolder] = useState('')
  const [flaresolverrReady, setFlareSolverrReady] = useState(false)
  
  const { addTab, setTabResult, setTabError } = useSearchTabsStore()

  useEffect(() => {
    if (!toast) return
    const tt = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(tt)
  }, [toast])

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
  }, [])

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
    }).catch(() => {})
    
    if ((window as any).electronAPI?.onDownloadsUpdated) {
      (window as any).electronAPI.onDownloadsUpdated(() => {
        refreshDownloads().catch(console.error)
      })
    }
    if ((window as any).electronAPI?.onFlareSolverrReady) {
      (window as any).electronAPI.onFlareSolverrReady(() => {
        setFlareSolverrReady(true)
      })
    }
    
    return () => window.clearInterval(timer)
  }, [refreshDownloads])

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return

    const tabId = addTab(query)
    const currentQuery = query
    setQuery('')

    try {
      const res = await api<any>('/search', 'POST', { query: currentQuery })
      setTabResult(tabId, res.data ?? res.results ?? [])
    } catch (err: any) {
      setTabError(tabId, err.message || t.toasts.searchFailed)
    }
  }

  const handleMagnetSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const raw = magnetUrl.trim()
    if (!raw) return

    setAddingMagnet(true)
    setMagnetUrl('')

    try {
      let res: any

      if (raw.startsWith('magnet:?')) {
        res = await api<any>('/downloads/add', 'POST', { magnet: raw })
      } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
        res = await api<any>('/downloads/add-torrent-url', 'POST', { url: raw })
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
        showToast(`${t.toasts.error}: ${res.error || res.detail || t.toasts.unknownError}`, 'error')
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

  const activeCloud = downloads.filter((d) => !['completed', 'cached', 'finished'].includes((d.status || '').toLowerCase())).length
  const activeLocal = downloads.filter((d) => (d.local_status || '').toLowerCase().startsWith('downloading')).length

  return (
    <div className="flex h-screen w-full bg-bg-deep text-text-main font-display overflow-hidden relative">
      
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-bg-panel flex flex-col z-10">
        <div className="p-6 border-b border-border flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 bg-accent flex items-center justify-center text-bg-deep font-black font-mono">TB</div>
            {flaresolverrReady && (
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-bg-panel" title="FlareSolverr activo" />
            )}
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
            className={`w-full text-left px-4 py-3 font-mono text-sm tracking-wide uppercase transition-colors ${activeNav === 'logs' ? 'bg-accent/10 text-accent border-l-2 border-accent' : 'text-text-muted hover:text-text-main'}`}
            onClick={() => setActiveNav('logs')}
          >
            <div className="flex items-center gap-2"><ScrollText size={16}/> {t.nav.logs}</div>
          </button>
        </nav>

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
            disabled={addingMagnet || !magnetUrl.trim()}
          >
            {addingMagnet ? t.magnetBar.adding : t.magnetBar.addLink}
          </button>
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
              </form>

              <SearchTabsBar />
              
              <div className="flex-1 overflow-auto glass-panel p-4">
                <SearchTab onDownloadAdded={refreshDownloads} showToast={showToast} />
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
        </div>
      </main>

      {showSettings && (
        <SettingsModal 
          onClose={() => setShowSettings(false)} 
          showToast={showToast} 
        />
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
