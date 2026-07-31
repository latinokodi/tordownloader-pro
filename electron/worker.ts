import { TorboxAPI } from './torbox';
import { getSettings, getDownloads, addDownload, updateDownload, deleteDownload, getDownloadByTorboxId } from './db';
import { Downloader, DownloadProgress, isTorboxCDN } from './downloader';
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
      if (!settings || !settings.torbox_token) return;

      const tb = new TorboxAPI(settings.torbox_token);
      const res = await tb.getTorrents();

      if (res.success && res.data) {
        for (const rawDlData of res.data) {
          const dlData = TorboxAPI.normalizeTorrent(rawDlData);
          const { id: tid, hash: torrentHash } = TorboxAPI.torrentIdentity(dlData);
          const name = dlData.name || 'Unknown';
          const state = dlData.download_state || 'unknown';
          const progress = TorboxAPI.normalizeProgress(dlData.progress, state);

          if (!tid) continue;

          let record = getDownloadByTorboxId(tid);
          if (!record) {
            continue;
          }

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
              runLocalDownload(tid, dlData, settings.destination_folder, settings.torbox_token, mainWindow).catch(err => {
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

        if (mainWindow) {
          mainWindow.webContents.send('downloads-updated');
        }
      }
    } catch (err) {
      console.error('Worker polling loop failed', err);
    }
  }, 10000);
}

async function runLocalDownload(tid: string, dlData: any, destRoot: string, token: string, mainWindow: BrowserWindow | null) {
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

      // HARD GUARD: verify the URL is from TorBox CDN before passing to Downloader.
      // This app is debrid-only — never torrents/seeds/P2P.
      if (!isTorboxCDN(downloadUrl)) {
        throw new Error(
          `Security: Download URL ${downloadUrl} is not from TorBox CDN. ` +
          `This app only downloads via the TorBox debrid service.`
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
