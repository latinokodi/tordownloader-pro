import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { initDB, getSettings, updateSettings, getDownloads, addDownload, updateDownload, deleteDownload, getDownloadByTorboxId, Settings } from './db'
import { initMetaSearch, getMetaSearch, type SearchProgress } from './metasearch'
import { startFlareSolverr, getFlareSolverrUrl, stopFlareSolverr } from './flaresolverr'
import { startCFServer, getCFServerPort, stopCFServer } from './cf-fetcher'
import { checkPluginsForUpdates, updatePlugins } from './plugin-updater'
import { TorboxAPI } from './torbox'
import { startWorker, cancelLocalDownload } from './worker'

// ── Single instance lock ──────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

let mainWindow: BrowserWindow | null = null

// ── Log collector ──────────────────────────────────────
const logBuffer: Array<{ ts: string; text: string; level: string }> = []
const LOG_MAX = 500

function sendLog(level: string, ...args: any[]) {
  const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  const entry = { ts: new Date().toISOString().slice(11, 19), text, level }
  logBuffer.push(entry)
  if (logBuffer.length > LOG_MAX) logBuffer.shift()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-log', entry)
  }
}

// Intercept console.* globally
const _origLog = console.log
const _origWarn = console.warn
const _origError = console.error
console.log = (...args: any[]) => { _origLog(...args); sendLog('info', ...args) }
console.warn = (...args: any[]) => { _origWarn(...args); sendLog('warn', ...args) }
console.error = (...args: any[]) => { _origError(...args); sendLog('error', ...args) }

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'TORDOWNLOADER',
    backgroundColor: '#0a0a0a',
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(async () => {
  try {
    initDB()
  } catch (err: any) {
    console.error('[App] Database init failed:', err.message)
    // Retry after a delay (DB might be locked by another instance)
    setTimeout(() => {
      try { initDB() } catch (e: any) { console.error('[App] DB retry also failed:', e.message) }
    }, 2000)
  }
  initMetaSearch()  // starts Python runner dependency check
  createWindow()

  // Start local HTTP bridge for Python plugins to fetch CF-protected pages
  // through Electron's native Chromium (handles Cloudflare natively)
  startCFServer()

  // Start FlareSolverr for Cloudflare bypass (bundled, no Docker)
  startFlareSolverr().then(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('flaresolverr-ready')
    }
  }).catch(err =>
    console.warn('[FlareSolverr] Start failed (non-fatal):', err)
  )
  
  // Start the background worker for Torbox & local downloads
  startWorker(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopFlareSolverr()
  stopCFServer()
  app.quit()
})

// ─── IPC Handlers ───────────────────────────

ipcMain.handle('get-settings', () => getSettings())

ipcMain.handle('set-settings', (_e, settings: Partial<Settings>) => {
  updateSettings(settings)
  return { success: true }
})

ipcMain.handle('search-metasearch', async (e, query: string) => {
  try {
    const ms = getMetaSearch()
    const sender = e.sender
    let allResults: import('./metasearch').MetaResult[] = []

    await ms.searchStream(query, {
      onProgress: (progress: SearchProgress) => {
        if (sender.isDestroyed()) return
        sender.send('search-progress', { tabId: null, ...progress })
      },
      onDone: (results) => {
        allResults = results
      },
      onError: (err) => {
        if (!sender.isDestroyed()) {
          sender.send('search-error', err.message)
        }
      },
    })

    return { success: true, data: allResults }
  } catch (error: any) {
    return { success: false, error: error.message || 'Search failed' }
  }
})

ipcMain.handle('get-downloads', () => getDownloads());

ipcMain.handle('add-magnet', async (_e, magnet: string) => {
  const settings = getSettings();
  if (!settings.torbox_token) {
    return { success: false, error: 'TorBox token is not configured' };
  }
  
  try {
    const tb = new TorboxAPI(settings.torbox_token);
    const result = await tb.addMagnet(magnet);
    
    if (result.success && result.data) {
      const { id } = TorboxAPI.torrentIdentity(result.data);
      if (id) {
        const existing = getDownloadByTorboxId(id);
        if (existing) {
          updateDownload(id, { local_status: 'pending' });
        } else {
          addDownload({
            torbox_id: id,
            name: result.data.name || 'Pending...',
            status: 'pending',
            progress: 0,
          });
        }
        if (mainWindow) mainWindow.webContents.send('downloads-updated');
      }
    }
    return result;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('add-torrent-url', async (_e, torrentUrl: string) => {
  const settings = getSettings();
  if (!settings.torbox_token) {
    return { success: false, error: 'TorBox token is not configured' };
  }
  
  try {
    const tb = new TorboxAPI(settings.torbox_token);
    const result = await tb.addTorrentFromUrl(torrentUrl);
    
    if (result.success && result.data) {
      const { id } = TorboxAPI.torrentIdentity(result.data);
      if (id) {
        const existing = getDownloadByTorboxId(id);
        if (existing) {
          updateDownload(id, { local_status: 'pending' });
        } else {
          addDownload({
            torbox_id: id,
            name: result.data.name || 'Pending...',
            status: 'pending',
            progress: 0,
          });
        }
        if (mainWindow) mainWindow.webContents.send('downloads-updated');
      }
    }
    return result;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('control-torrent', async (_e, torrentId: string, operation: string) => {
  const settings = getSettings();
  if (!settings.torbox_token) {
    return { success: false, error: 'TorBox token is not configured' };
  }
  
  try {
    const tb = new TorboxAPI(settings.torbox_token);
    const result = await tb.controlTorrent(torrentId, operation);
    
    if (operation.toLowerCase() === 'delete') {
      deleteDownload(torrentId);
      if (mainWindow) mainWindow.webContents.send('downloads-updated');
    }
    return result;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cancel-download', async (_e, torrentId: string) => {
  const settings = getSettings();
  
  // 1) Abort any running local download
  cancelLocalDownload(torrentId);
  
  // 2) Delete from TorBox cloud
  if (settings.torbox_token) {
    try {
      const tb = new TorboxAPI(settings.torbox_token);
      await tb.controlTorrent(torrentId, 'Delete');
    } catch (err) {
      // TorBox delete may fail if already removed — continue anyway
      console.warn(`TorBox delete for ${torrentId} failed:`, err);
    }
  }
  
  // 3) Remove from local DB
  deleteDownload(torrentId);
  if (mainWindow) mainWindow.webContents.send('downloads-updated');
  
  return { success: true };
});

ipcMain.handle('clear-completed', async () => {
  const settings = getSettings();
  if (!settings.torbox_token) return { success: false };
  
  try {
    const tb = new TorboxAPI(settings.torbox_token);
    const downloads = getDownloads();
    const completed = downloads.filter(d => 
      ['completed', 'cached', 'finished'].includes((d.status || '').toLowerCase()) && 
      (d.local_status || '').toLowerCase() === 'completed'
    );
    
    for (const d of completed) {
      try { await tb.controlTorrent(d.torbox_id, 'Delete'); } catch(e) {}
      deleteDownload(d.torbox_id);
    }
    if (mainWindow) mainWindow.webContents.send('downloads-updated');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth-start', async () => {
  try {
    const tb = new TorboxAPI();
    return await tb.getDeviceCode();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth-poll', async (_e, deviceCode: string) => {
  try {
    const tb = new TorboxAPI();
    const res = await tb.getToken(deviceCode);
    if (res.success && res.data) {
      let token = res.data;
      if (typeof token === 'object') {
        token = token.access_token || token.token;
      }
      if (token) {
        updateSettings({ torbox_token: token });
      }
    }
    return res;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('torbox-user-info', async () => {
  const settings = getSettings();
  if (!settings.torbox_token) return { success: false, error: 'No token' };
  try {
    const tb = new TorboxAPI(settings.torbox_token);
    return await tb.getUserInfo();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-metasearch', async (_e, _data: { url: string; api_key: string }) => {
  try {
    const ms = getMetaSearch()
    // Run a quick search to verify Python runner and plugins work
    const results = await ms.search('ubuntu')
    return { success: true, detail: `MetaSearch ready — ${results.length} results from built-in plugins` }
  } catch (error: any) {
    return { success: false, error: error.message, detail: error.message }
  }
})

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('get-logs', () => {
  return [...logBuffer]
})

ipcMain.handle('open-folder', async (_e, folderPath: string) => {
  const result = await shell.openPath(folderPath)
  return { success: !result, error: result || null }
})

ipcMain.handle('check-plugins', async () => {
  try {
    const plugins = await checkPluginsForUpdates()
    return { success: true, data: plugins }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('update-plugins', async () => {
  try {
    const result = await updatePlugins()
    return { success: true, data: result }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})
