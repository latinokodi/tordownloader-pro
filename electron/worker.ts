import { TorboxAPI } from './torbox';
import { RealDebridAPI } from './realdebrid';
import { getSettings, getDownloads, addDownload, updateDownload, deleteDownload, getDownloadByTorboxId } from './db';
import { Downloader, DownloadProgress, isDebridCDN } from './downloader';
import path from 'path';
import fs from 'fs';
import { BrowserWindow } from 'electron';

let workerInterval: NodeJS.Timeout | null = null;
const activeLocalDownloads = new Map<string, boolean>();
const activeDownloaders = new Map<string, Downloader>();

/** Cancel an in-progress local download by its TorBox ID. Returns true if something was aborted. */
export function cancelLocalDownload(tid: string): boolean {
  const dl = activeDownloaders.get(tid);
  if (dl) {
    dl.abort();
    activeDownloaders.delete(tid);
    activeLocalDownloads.delete(tid);
    return true;
  }
  // Mark as cancelled even if Downloader not created yet (queued)
  if (activeLocalDownloads.has(tid)) {
    activeLocalDownloads.delete(tid);
    return true;
  }
  return false;
}

function getSafePathPart(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/^\.+|\.+$/g, '');
  return cleaned || 'Unknown';
}

function getSafeRelativePath(value: string, fallback: string): string {
  const rawParts = (value || fallback).split(/[/\\]+/);
  const parts = rawParts.map(getSafePathPart).filter(p => p && p !== '.' && p !== '..');
  return parts.length > 0 ? path.join(...parts) : getSafePathPart(fallback);
}

function getFileSize(fileInfo: any): number {
  for (const key of ['size', 'bytes', 'filesize']) {
    const val = parseInt(fileInfo[key], 10);
    if (!isNaN(val)) return val;
  }
  return 0;
}

function formatETA(remainingBytes: number, speed: number): string {
  if (speed <= 0 || remainingBytes <= 0) return ''
  const seconds = Math.ceil(remainingBytes / speed)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function safeMkdirSync(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (e: any) {
      // Ignore EPERM for root drives, or EEXIST if it was created concurrently
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') {
        throw e;
      }
    }
  }
}

export function startWorker(mainWindow: BrowserWindow | null) {
  if (workerInterval) clearInterval(workerInterval);

  // ── Resume interrupted downloads on startup ──────────
  try {
    const allDownloads = getDownloads()
    const completedStates = ['completed', 'cached', 'finished']
    for (const dl of allDownloads) {
      const cloudDone = completedStates.includes((dl.status || '').toLowerCase())
      const localState = (dl.local_status || '').toLowerCase()
      const wasInterrupted = localState.startsWith('downloading') || localState === 'pending'
      if (cloudDone && wasInterrupted) {
        console.log(`[Worker] Resuming interrupted download: ${dl.name}`)
        updateDownload(dl.torbox_id, { local_status: 'pending' })
      }
    }
  } catch (err) {
    console.error('[Worker] Resume scan failed:', err)
  }

  workerInterval = setInterval(async () => {
    try {
      const settings = getSettings();
      if (!settings) return;

      // ── Poll TorBox ──────────────────────────
      if (settings.torbox_token) {
        await pollTorBox(settings, mainWindow);
      }

      // ── Poll Real-Debrid ─────────────────────
      if (settings.realdebrid_token) {
        await pollRealDebrid(settings, mainWindow);
      }

      if (mainWindow) {
        mainWindow.webContents.send('downloads-updated');
      }
    } catch (err) {
      console.error('Worker polling loop failed', err);
    }
  }, 10000);
}

// ── TorBox polling ────────────────────────────────────

async function pollTorBox(settings: any, mainWindow: BrowserWindow | null) {
  const tb = new TorboxAPI(settings.torbox_token);
  const res = await tb.getTorrents();

  if (res.success && res.data) {
    for (const rawDlData of res.data) {
      const dlData = TorboxAPI.normalizeTorrent(rawDlData);
      const { id: tid } = TorboxAPI.torrentIdentity(dlData);
      const name = dlData.name || 'Unknown';
      const state = dlData.download_state || 'unknown';
      const progress = TorboxAPI.normalizeProgress(dlData.progress, state);

      if (!tid) continue;

      let record = getDownloadByTorboxId(tid);
      if (!record) continue;

      updateDownload(tid, {
        status: state,
        progress: progress,
        ...(record.name === 'Pending...' && name !== 'Unknown' ? { name } : {})
      });

      record = getDownloadByTorboxId(tid)!;

      const completedStates = ['completed', 'cached', 'finished'];

      if (completedStates.includes(state.toLowerCase()) && ['pending', 'queued'].includes(record.local_status)) {
        if (!activeLocalDownloads.has(tid)) {
          updateDownload(tid, { local_status: 'queued' });
          activeLocalDownloads.set(tid, true);
          runTorboxDownload(tid, dlData, settings.destination_folder, settings.torbox_token, mainWindow).catch(err => {
            console.error(`Local download failed for ${tid}:`, err);
            updateDownload(tid, { local_status: `failed: ${err.message}` });
            activeLocalDownloads.delete(tid);
            if (mainWindow) mainWindow.webContents.send('downloads-updated');
          });
        }
      }

      if (settings.auto_remove_completed && completedStates.includes(state.toLowerCase()) && record.local_status === 'completed') {
        await tb.controlTorrent(dlData.id, 'Delete');
        deleteDownload(tid);
      }
    }
  }
}

// ── Real-Debrid polling ────────────────────────────────

async function pollRealDebrid(settings: any, mainWindow: BrowserWindow | null) {
  const rd = new RealDebridAPI(settings.realdebrid_token);
  const res = await rd.getTorrents();

  if (res.success && Array.isArray(res.data)) {
    for (const rawDlData of res.data) {
      const dlData = RealDebridAPI.normalizeTorrent(rawDlData);
      const { id: tid } = RealDebridAPI.torrentIdentity(dlData);
      const name = dlData.filename || dlData.name || 'Unknown';
      const state = dlData.status || 'unknown';
      const progress = RealDebridAPI.normalizeProgress(dlData.progress, state);

      if (!tid) continue;

      let record = getDownloadByTorboxId(tid);
      if (!record) continue;

      updateDownload(tid, {
        status: state,
        progress: progress,
        ...(record.name === 'Pending...' && name !== 'Unknown' ? { name } : {})
      });

      record = getDownloadByTorboxId(tid)!;

      // RD's /torrents list often returns "magnet_conversion" for torrents that have
      // already progressed.  Call getTorrentInfo to get the real status.
      // The browser extension does exactly this: see mshll/real-debrid-manager.
      let effectiveState = state.toLowerCase();
      if (effectiveState === 'magnet_conversion') {
        try {
          const infoRes = await rd.getTorrentInfo(tid);
          if (infoRes.success && infoRes.data) {
            const realStatus = (infoRes.data.status || '').toLowerCase();
            if (realStatus && realStatus !== 'magnet_conversion') {
              console.log(`[RD] ${name}: magnet_conversion → real status = ${realStatus}`);
              effectiveState = realStatus;
              updateDownload(tid, { status: realStatus });
              if (infoRes.data.filename && record.name === 'Pending...') {
                updateDownload(tid, { name: infoRes.data.filename || name });
              }
              record = getDownloadByTorboxId(tid)!;
            }
          }
        } catch (err) {
          // getTorrentInfo may fail during early magnet conversion — that's OK
        }
      }

      // Auto-select all files when torrent is waiting for file selection
      if (effectiveState === 'waiting_files_selection') {
        try {
          const infoRes = await rd.getTorrentInfo(tid);
          if (infoRes.success && infoRes.data) {
            const files = infoRes.data.files || [];
            if (files.length > 0) {
              const fileIds = files.map((f: any) => String(f.id));
              await rd.selectFiles(tid, fileIds);
              console.log(`[RD] Auto-selected ${fileIds.length} files for ${name}`);
            }
          }
        } catch (err) {
          console.error(`[RD] Failed to select files for ${tid}:`, err);
        }
      }

      const completedStates = ['downloaded', 'finished'];

      if (completedStates.includes(effectiveState) && ['pending', 'queued'].includes(record.local_status)) {
        if (!activeLocalDownloads.has(tid)) {
          updateDownload(tid, { local_status: 'queued' });
          activeLocalDownloads.set(tid, true);
          runRealdebridDownload(tid, dlData, settings.destination_folder, settings.realdebrid_token, mainWindow).catch(err => {
            console.error(`RD download failed for ${tid}:`, err);
            updateDownload(tid, { local_status: `failed: ${err.message}` });
            activeLocalDownloads.delete(tid);
            if (mainWindow) mainWindow.webContents.send('downloads-updated');
          });
        }
      }

      if (settings.auto_remove_completed && completedStates.includes(effectiveState) && record.local_status === 'completed') {
        await rd.deleteTorrent(dlData.id);
        deleteDownload(tid);
      }
    }
  }
}

async function runTorboxDownload(tid: string, dlData: any, destRoot: string, token: string, mainWindow: BrowserWindow | null) {
  try {
    if (!destRoot || !destRoot.trim()) {
      throw new Error('Destination folder is not configured');
    }

    const tb = new TorboxAPI(token);
    const destFolder = destRoot;
    safeMkdirSync(destFolder);

    let files = dlData.files || [];
    if (!files.length) {
      const infoRes = await tb.getTorrentInfo(tid);
      if (infoRes.success && infoRes.data) {
        if (Array.isArray(infoRes.data) && infoRes.data.length > 0) {
          files = infoRes.data[0].files || [];
        } else if (typeof infoRes.data === 'object') {
          files = infoRes.data.files || [];
        }
      }
    }

    files = files.filter((f: any) => f.id !== undefined && f.id !== null);
    const totalFiles = files.length;
    
    if (totalFiles === 0) {
      throw new Error('TorBox returned no downloadable files');
    }

    const totalBytes = files.reduce((acc: number, f: any) => acc + getFileSize(f), 0);
    let completedBytes = 0;

    for (let idx = 0; idx < files.length; idx++) {
      const fileInfo = files[idx];
      const fileId = fileInfo.id;
      const fileName = fileInfo.name || fileInfo.path || `file_${idx}`;
      const safeRelPath = getSafeRelativePath(fileName, `file_${idx}`);
      const filePath = path.join(destFolder, safeRelPath);
      const expectedSize = getFileSize(fileInfo);

      // Ensure subdirectory exists
      safeMkdirSync(path.dirname(filePath));

      const linkRes = await tb.getDownloadLink(tid, String(fileId));
      if (!linkRes.success || !linkRes.data) {
        throw new Error(`TorBox did not return a download link for ${fileName}`);
      }

      const downloadUrl = linkRes.data;

      // HARD GUARD: verify the URL is from a recognized debrid CDN.
      if (!isDebridCDN(downloadUrl)) {
        throw new Error(
          `Security: Download URL ${downloadUrl} is not from a recognized debrid CDN.`
        );
      }

      const downloader = new Downloader(downloadUrl, filePath, expectedSize);
      activeDownloaders.set(tid, downloader);

      updateDownload(tid, {
        local_status: `Downloading ${idx + 1}/${totalFiles}...`,
        local_progress: Math.floor((idx / totalFiles) * 100),
        local_path: destFolder,
      });
      if (mainWindow) mainWindow.webContents.send('downloads-updated');

      let lastUpdate = 0;
      const onProg = (p: DownloadProgress) => {
        const now = Date.now();
        if (now - lastUpdate > 2000) {
          lastUpdate = now;
          let overall = 0;
          if (totalBytes > 0) {
            overall = Math.floor(((completedBytes + p.bytes_done) / totalBytes) * 100);
          } else {
            overall = Math.floor(((idx / totalFiles) * 100) + (p.progress_percent / totalFiles));
          }

          const remaining = totalBytes > 0 ? totalBytes - (completedBytes + p.bytes_done) : 0;
          const eta = formatETA(remaining, p.speed);

          updateDownload(tid, {
            local_status: `Downloading ${idx + 1}/${totalFiles} (${Math.floor(p.progress_percent)}%)`,
            local_progress: Math.max(0, Math.min(99, overall)),
            local_speed: Math.floor(p.speed),
            local_eta: eta,
            local_path: destFolder,
          });
          if (mainWindow) mainWindow.webContents.send('downloads-updated');
        }
      };

      const result = await downloader.start(onProg);
      if (!result.success) {
        throw new Error(`Failed to download ${fileName}: ${result.error}`);
      }

      if (expectedSize > 0) {
        const actualSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        if (actualSize !== expectedSize) {
          throw new Error(`Failed to verify ${fileName}: expected ${expectedSize} bytes, got ${actualSize}`);
        }
      }

      completedBytes += expectedSize || result.bytes_downloaded;
    }

    updateDownload(tid, {
      local_status: 'completed',
      local_progress: 100,
      local_speed: 0,
      local_path: destFolder,
    });
    
  } catch (err: any) {
    updateDownload(tid, {
      local_status: `failed: ${err.message}`,
      local_speed: 0,
    });
  } finally {
    activeLocalDownloads.delete(tid);
    activeDownloaders.delete(tid);
    if (mainWindow) mainWindow.webContents.send('downloads-updated');
  }
}

// ── Real-Debrid local download ─────────────────────────

async function runRealdebridDownload(tid: string, dlData: any, destRoot: string, token: string, mainWindow: BrowserWindow | null) {
  try {
    if (!destRoot || !destRoot.trim()) {
      throw new Error('Destination folder is not configured');
    }

    const rd = new RealDebridAPI(token);
    const destFolder = destRoot;
    safeMkdirSync(destFolder);

    // Get torrent info to obtain the links array
    const infoRes = await rd.getTorrentInfo(tid);
    if (!infoRes.success || !infoRes.data) {
      throw new Error('Failed to get torrent info from Real-Debrid');
    }

    const torrentInfo = infoRes.data;
    const links: string[] = torrentInfo.links || [];
    const totalBytes = torrentInfo.bytes || torrentInfo.original_bytes || 0;

    if (links.length === 0) {
      throw new Error('Real-Debrid returned no download links for this torrent');
    }

    const totalLinks = links.length;
    let completedBytes = 0;

    for (let idx = 0; idx < links.length; idx++) {
      const link = links[idx];

      // Unrestrict the link to get a direct download URL + filename
      const unrestrictRes = await rd.unrestrictLink(link);
      if (!unrestrictRes.success || !unrestrictRes.data) {
        // Skip dead/expired hoster links — don't fail the whole torrent
        console.warn(`[RD] Skipping link ${idx + 1}/${totalLinks}: unrestrict failed (${unrestrictRes.error || 'unknown'})`);
        continue;
      }

      const { download: directUrl, filename, filesize } = unrestrictRes.data;
      if (!directUrl) {
        throw new Error(`No download URL returned for link ${idx + 1}/${totalLinks}`);
      }

      const expectedSize = filesize || 0;

      // Use filename from unrestricted response, fall back to index
      const safeName = getSafeRelativePath(filename || `part_${idx + 1}`, `part_${idx + 1}`);
      const filePath = path.join(destFolder, safeName);

      safeMkdirSync(path.dirname(filePath));

      // HARD GUARD
      if (!isDebridCDN(directUrl)) {
        throw new Error(
          `Security: Download URL ${directUrl} is not from a recognized debrid CDN.`
        );
      }

      const downloader = new Downloader(directUrl, filePath, expectedSize);
      activeDownloaders.set(tid, downloader);

      updateDownload(tid, {
        local_status: `Downloading ${idx + 1}/${totalLinks}...`,
        local_progress: Math.floor((idx / totalLinks) * 100),
        local_path: destFolder,
      });
      if (mainWindow) mainWindow.webContents.send('downloads-updated');

      let lastUpdate = 0;
      const onProg = (p: DownloadProgress) => {
        const now = Date.now();
        if (now - lastUpdate > 1000) {
          lastUpdate = now;
          let overall = 0;
          if (totalBytes > 0) {
            overall = Math.floor(((completedBytes + p.bytes_done) / totalBytes) * 100);
          } else {
            overall = Math.floor(((idx / totalLinks) * 100) + (p.progress_percent / totalLinks));
          }

          const remaining = totalBytes > 0 ? totalBytes - (completedBytes + p.bytes_done) : 0;
          const eta = formatETA(remaining, p.speed);

          updateDownload(tid, {
            local_status: `Downloading ${idx + 1}/${totalLinks} (${Math.floor(p.progress_percent)}%)`,
            local_progress: Math.max(0, Math.min(99, overall)),
            local_speed: Math.floor(p.speed),
            local_eta: eta,
            local_path: destFolder,
          });
          if (mainWindow) mainWindow.webContents.send('downloads-updated');
        }
      };

      const result = await downloader.start(onProg);
      if (!result.success) {
        throw new Error(`Failed to download part ${idx + 1}: ${result.error}`);
      }

      completedBytes += expectedSize || result.bytes_downloaded;
    }

    // If no links were successfully downloaded, report the failure
    if (completedBytes === 0 && links.length > 0) {
      throw new Error(`All ${links.length} link(s) failed to unrestrict or download`);
    }

    updateDownload(tid, {
      local_status: 'completed',
      local_progress: 100,
      local_speed: 0,
      local_path: destFolder,
    });

  } catch (err: any) {
    updateDownload(tid, {
      local_status: `failed: ${err.message}`,
      local_speed: 0,
    });
  } finally {
    activeLocalDownloads.delete(tid);
    activeDownloaders.delete(tid);
    if (mainWindow) mainWindow.webContents.send('downloads-updated');
  }
}
