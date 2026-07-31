import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getSettings: (): Promise<any> => ipcRenderer.invoke('get-settings'),
  setSettings: (settings: any): Promise<any> => ipcRenderer.invoke('set-settings', settings),
  
  searchJackett: (query: string): Promise<any> => ipcRenderer.invoke('search-jackett', query),
  
  getDownloads: (): Promise<any[]> => ipcRenderer.invoke('get-downloads'),
  addMagnet: (magnet: string): Promise<any> => ipcRenderer.invoke('add-magnet', magnet),
  addTorrentUrl: (url: string): Promise<any> => ipcRenderer.invoke('add-torrent-url', url),
  controlTorrent: (torrentId: string, operation: string): Promise<any> => ipcRenderer.invoke('control-torrent', torrentId, operation),
  cancelDownload: (torrentId: string): Promise<any> => ipcRenderer.invoke('cancel-download', torrentId),
  
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),
  
  authStart: (): Promise<any> => ipcRenderer.invoke('auth-start'),
  authPoll: (deviceCode: string): Promise<any> => ipcRenderer.invoke('auth-poll', deviceCode),
  getUserInfo: (): Promise<any> => ipcRenderer.invoke('torbox-user-info'),
  testJackett: (data: { url: string; api_key: string }): Promise<any> => ipcRenderer.invoke('test-jackett', data),
  
  onDownloadsUpdated: (callback: () => void) => {
    ipcRenderer.on('downloads-updated', callback)
    return () => ipcRenderer.removeAllListeners('downloads-updated')
  },
  onLog: (callback: (entry: { ts: string; text: string; level: string }) => void) => {
    ipcRenderer.on('app-log', (_e, entry) => callback(entry))
    return () => ipcRenderer.removeAllListeners('app-log')
  },
  getLogs: (): Promise<Array<{ ts: string; text: string; level: string }>> =>
    ipcRenderer.invoke('get-logs'),
  openFolder: (folderPath: string): Promise<{ success: boolean; error: string | null }> =>
    ipcRenderer.invoke('open-folder', folderPath),
  clearCompleted: (): Promise<any> => ipcRenderer.invoke('clear-completed'),
}

contextBridge.exposeInMainWorld('electronAPI', api)
