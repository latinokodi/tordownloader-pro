/**
 * useApi — typed IPC wrapper for Electron main process.
 */
export async function api<T = unknown>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: any,
): Promise<T> {
  const electronAPI = (window as any).electronAPI
  if (!electronAPI) {
    throw new Error('electronAPI not found. Are you running in Electron?')
  }
  
  try {
    if (path.startsWith('/settings') && method === 'GET') return await electronAPI.getSettings() as T
    if (path.startsWith('/settings') && method === 'POST') return await electronAPI.setSettings(body) as T
    if (path.startsWith('/downloads/add-torrent-url')) return await electronAPI.addTorrentUrl(body.url) as T
    if (path.startsWith('/downloads/add')) return await electronAPI.addMagnet(body.magnet) as T
    if (path.startsWith('/downloads') && method === 'GET') return await electronAPI.getDownloads() as T
    if (path === '/downloads/clear-completed' && method === 'POST') return await electronAPI.clearCompleted() as T
    if (path.startsWith('/downloads/') && method === 'DELETE') {
      const id = path.split('/')[2]
      return await electronAPI.controlTorrent(id, 'delete') as T
    }
    if (path.startsWith('/downloads/cancel/') && method === 'POST') {
      const id = path.split('/')[3]
      return await electronAPI.cancelDownload(id) as T
    }
    if (path.startsWith('/search')) return await electronAPI.searchMetaSearch(body.query) as T
    if (path.startsWith('/select-folder')) return { path: await electronAPI.selectFolder() } as T
    
    if (path === '/auth/start') return await electronAPI.authStart() as T
    if (path === '/auth/user') return await electronAPI.getUserInfo() as T
    if (path.startsWith('/auth/poll/')) {
      const deviceCode = path.split('/')[3]
      return await electronAPI.authPoll(deviceCode) as T
    }
    if (path === '/settings/test-metasearch') return await electronAPI.testMetaSearch() as T
    
    if (path === '/plugins/check') return await electronAPI.checkPlugins() as T
    if (path === '/plugins/update') return await electronAPI.updatePlugins() as T
    
    // Fallback
    return { success: true } as T
  } catch (err: any) {
    throw new Error(err.message || 'Request failed')
  }
}
