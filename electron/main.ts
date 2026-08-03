import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { initDB, getSettings, updateSettings, getDownloads, addDownload, updateDownload, deleteDownload, getDownloadByTorboxId, Settings } from './db'
import { initMetaSearch, getMetaSearch, type SearchProgress } from './metasearch'
import { startFlareSolverr, getFlareSolverrUrl, stopFlareSolverr } from './flaresolverr'
import { startCFServer, getCFServerPort, stopCFServer } from './cf-fetcher'
import { checkPluginsForUpdates, updatePlugins } from './plugin-updater'
import { TorboxAPI } from './torbox'
import { RealDebridAPI, RD_OPENSOURCE_CLIENT_ID } from './realdebrid'
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

ipcMain.handle('add-magnet', async (_e, magnet: string, service: string = 'torbox') => {
  const settings = getSettings();

  if (service === 'realdebrid') {
    if (!settings.realdebrid_token) {
      return { success: false, error: 'Real-Debrid token is not configured' };
    }
    try {
      const rd = new RealDebridAPI(settings.realdebrid_token);
      const result = await rd.addMagnet(magnet);

      if (result.success && result.data) {
        const { id } = RealDebridAPI.torrentIdentity(result.data);
        if (id) {
          const existing = getDownloadByTorboxId(id);
          if (existing) {
            updateDownload(id, { local_status: 'pending', service: 'realdebrid' });
          } else {
            addDownload({
              torbox_id: id,
              name: result.data.filename || result.data.name || 'Pending...',
              status: 'waiting_files_selection',
              progress: 0,
              service: 'realdebrid',
            });
          }
          if (mainWindow) mainWindow.webContents.send('downloads-updated');
        }
      }
      return result;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // TorBox
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
          updateDownload(id, { local_status: 'pending', service: 'torbox' });
        } else {
          addDownload({
            torbox_id: id,
            name: result.data.name || 'Pending...',
            status: 'pending',
            progress: 0,
            service: 'torbox',
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

ipcMain.handle('add-torrent-url', async (_e, torrentUrl: string, service: string = 'torbox') => {
  const settings = getSettings();

  if (service === 'realdebrid') {
    if (!settings.realdebrid_token) {
      return { success: false, error: 'Real-Debrid token is not configured' };
    }
    try {
      const rd = new RealDebridAPI(settings.realdebrid_token);
      const result = await rd.addTorrentFromUrl(torrentUrl);

      if (result.success && result.data) {
        const { id } = RealDebridAPI.torrentIdentity(result.data);
        if (id) {
          const existing = getDownloadByTorboxId(id);
          if (existing) {
            updateDownload(id, { local_status: 'pending', service: 'realdebrid' });
          } else {
            addDownload({
              torbox_id: id,
              name: result.data.filename || result.data.name || 'Pending...',
              status: 'waiting_files_selection',
              progress: 0,
              service: 'realdebrid',
            });
          }
          if (mainWindow) mainWindow.webContents.send('downloads-updated');
        }
      }
      return result;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // TorBox
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
          updateDownload(id, { local_status: 'pending', service: 'torbox' });
        } else {
          addDownload({
            torbox_id: id,
            name: result.data.name || 'Pending...',
            status: 'pending',
            progress: 0,
            service: 'torbox',
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
  const download = getDownloadByTorboxId(torrentId);

  // 1) Abort any running local download
  cancelLocalDownload(torrentId);

  // 2) Delete from the appropriate service
  if (download?.service === 'realdebrid' && settings.realdebrid_token) {
    try {
      const rd = new RealDebridAPI(settings.realdebrid_token);
      await rd.deleteTorrent(torrentId);
    } catch (err) {
      console.warn(`RD delete for ${torrentId} failed:`, err);
    }
  } else if (settings.torbox_token) {
    try {
      const tb = new TorboxAPI(settings.torbox_token);
      await tb.controlTorrent(torrentId, 'Delete');
    } catch (err) {
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
  const downloads = getDownloads();
  const completed = downloads.filter(d =>
    (d.status || '').toLowerCase() === 'completed' || 
    (d.status || '').toLowerCase() === 'downloaded' ||
    (d.status || '').toLowerCase() === 'cached' ||
    (d.status || '').toLowerCase() === 'finished'
  ).filter(d =>
    (d.local_status || '').toLowerCase() === 'completed'
  );

  for (const d of completed) {
    if (d.service === 'realdebrid' && settings.realdebrid_token) {
      try {
        const rd = new RealDebridAPI(settings.realdebrid_token);
        await rd.deleteTorrent(d.torbox_id);
      } catch(e) {}
    } else if (settings.torbox_token) {
      try {
        const tb = new TorboxAPI(settings.torbox_token);
        await tb.controlTorrent(d.torbox_id, 'Delete');
      } catch(e) {}
    }
    deleteDownload(d.torbox_id);
  }
  if (mainWindow) mainWindow.webContents.send('downloads-updated');
  return { success: true };
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

// ── Real-Debrid IPC ──────────────────────────

ipcMain.handle('rd-auth-start', async () => {
  try {
    const res = await RealDebridAPI.getDeviceCode();
    return res;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rd-auth-poll', async (_e, deviceCode: string) => {
  try {
    // Step 1: Get per-user credentials (client_id + client_secret)
    const credRes = await RealDebridAPI.getCredentials(RD_OPENSOURCE_CLIENT_ID, deviceCode);
    if (!credRes.success) {
      // pending → not authorized yet
      return credRes;
    }

    const { client_id, client_secret } = credRes.data;
    if (!client_id || !client_secret) {
      return { success: false, error: 'Invalid credentials response' };
    }

    // Step 2: Exchange for access_token + refresh_token
    const tokenRes = await RealDebridAPI.getToken(client_id, client_secret, deviceCode);
    if (!tokenRes.success || !tokenRes.data) {
      return { success: false, error: tokenRes.error || 'Failed to get token' };
    }

    const { access_token, refresh_token } = tokenRes.data;
    if (!access_token) {
      return { success: false, error: 'No access token in response' };
    }

    // Save everything
    updateSettings({
      realdebrid_token: access_token,
      realdebrid_refresh_token: refresh_token || '',
      realdebrid_client_id: client_id,
      realdebrid_client_secret: client_secret,
    });

    return { success: true, data: { access_token } };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rd-user-info', async () => {
  const settings = getSettings();
  if (!settings.realdebrid_token) return { success: false, error: 'No token' };
  try {
    const rd = new RealDebridAPI(settings.realdebrid_token);
    return await rd.getUserInfo();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rd-traffic', async () => {
  const settings = getSettings();
  if (!settings.realdebrid_token) return { success: false, error: 'No token' };
  try {
    const rd = new RealDebridAPI(settings.realdebrid_token);
    return await rd.getTraffic();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rd-select-files', async (_e, torrentId: string) => {
  const settings = getSettings();
  if (!settings.realdebrid_token) return { success: false, error: 'No token' };
  try {
    const rd = new RealDebridAPI(settings.realdebrid_token);

    const infoRes = await rd.getTorrentInfo(torrentId);
    if (!infoRes.success || !infoRes.data) {
      return { success: false, error: 'Failed to get torrent info' };
    }

    const files = infoRes.data.files || [];
    if (files.length === 0) {
      return { success: false, error: 'No files in torrent' };
    }

    const fileIds = files.map((f: any) => String(f.id));
    const selectRes = await rd.selectFiles(torrentId, fileIds);

    if (selectRes.success) {
      updateDownload(torrentId, { status: 'downloading' });
      if (mainWindow) mainWindow.webContents.send('downloads-updated');
    }

    return selectRes;
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
