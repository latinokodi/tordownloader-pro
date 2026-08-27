import { TorboxAPI } from './torbox';
import { RealDebridAPI } from './realdebrid';
import { getSettings, getDownloads, addDownload, updateDownload, deleteDownload, getDownloadByTorboxId } from './db';
import { Downloader, DownloadProgress, isDebridCDN } from './downloader';
import { computeDestination, safeSegment, parseReleaseName } from './media-layout';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { BrowserWindow, app } from 'electron';

let workerInterval: NodeJS.Timeout | null = null;
let workerMainWindow: BrowserWindow | null = null;
const activeLocalDownloads = new Map<string, boolean>();
const activeDownloaders = new Map<string, Downloader>();

// ── Local download concurrency ──────────────────────────
// All season transfers are added to the list, but only MAX_CONCURRENT_DOWNLOADS
// local downloads run at once; the rest wait in localDownloadQueue (FIFO) and
// are dispatched as slots free up.
const MAX_CONCURRENT_DOWNLOADS = 3;
interface QueuedDownload {
  tid: string;
  dlData: any;
  service: 'torbox' | 'realdebrid';
}
const localDownloadQueue: QueuedDownload[] = [];

function enqueueLocalDownload(tid: string, dlData: any, service: 'torbox' | 'realdebrid') {
  if (activeLocalDownloads.has(tid)) return;
  if (localDownloadQueue.some((q) => q.tid === tid)) return;
  localDownloadQueue.push({ tid, dlData, service });
  dispatchNextLocalDownload();
}

function dispatchNextLocalDownload() {
  while (activeLocalDownloads.size < MAX_CONCURRENT_DOWNLOADS && localDownloadQueue.length > 0) {
    const item = localDownloadQueue.shift()!;
    if (activeLocalDownloads.has(item.tid)) continue;
    activeLocalDownloads.set(item.tid, true);

    const settings = getSettings();
    const mainWindow = workerMainWindow;
    const run = item.service === 'realdebrid' ? runRealdebridDownload : runTorboxDownload;
    const token = item.service === 'realdebrid' ? settings.realdebrid_token : settings.torbox_token;

    run(item.tid, item.dlData, settings, token, mainWindow).catch((err) => {
      console.error(`Local download failed for ${item.tid}:`, err);
      const rec = getDownloadByTorboxId(item.tid);
      if (rec) updateDownload(item.tid, { local_status: `failed: ${err.message}` });
      activeLocalDownloads.delete(item.tid);
      dispatchNextLocalDownload();
      if (mainWindow) mainWindow.webContents.send('downloads-updated');
    });
  }
}

/** Cancel an in-progress local download by its TorBox ID. Returns true if something was aborted. */
export function cancelLocalDownload(tid: string): boolean {
  const dl = activeDownloaders.get(tid);
  if (dl) {
    dl.abort();
    activeDownloaders.delete(tid);
    activeLocalDownloads.delete(tid);
    dispatchNextLocalDownload();
    return true;
  }
  // Remove from the waiting queue if not started yet
  const queuedIdx = localDownloadQueue.findIndex((q) => q.tid === tid);
  if (queuedIdx !== -1) {
    localDownloadQueue.splice(queuedIdx, 1);
    activeLocalDownloads.delete(tid);
    return true;
  }
  // Mark as cancelled even if Downloader not created yet (queued)
  if (activeLocalDownloads.has(tid)) {
    activeLocalDownloads.delete(tid);
    dispatchNextLocalDownload();
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
  if (workerInterval) clearInterval(workerInterval)
  workerMainWindow = mainWindow
  console.log('[Worker] Starting background worker (10s interval)')

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
        if (!activeLocalDownloads.has(tid) && !localDownloadQueue.some((q) => q.tid === tid)) {
          console.log(`[Worker] Queued TorBox download: ${name} (${tid}) — ${activeLocalDownloads.size}/${MAX_CONCURRENT_DOWNLOADS} active`)
          updateDownload(tid, { local_status: 'queued' });
          enqueueLocalDownload(tid, dlData, 'torbox');
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
        if (!activeLocalDownloads.has(tid) && !localDownloadQueue.some((q) => q.tid === tid)) {
          console.log(`[Worker] Queued RD download: ${name} (${tid}) — ${activeLocalDownloads.size}/${MAX_CONCURRENT_DOWNLOADS} active`)
          updateDownload(tid, { local_status: 'queued' });
          enqueueLocalDownload(tid, dlData, 'realdebrid');
        }
      }

      if (settings.auto_remove_completed && completedStates.includes(effectiveState) && record.local_status === 'completed') {
        await rd.deleteTorrent(dlData.id);
        deleteDownload(tid);
      }
    }
  }
}

// ── Destination resolution ─────────────────────────────
// Only media downloads (type explicitly movie/series) get the Jellyfin
// radarr/sonarr layout. Everything else keeps the flat destination folder.
// `season` (from the DB record) is passed through so every episode of a
// season resolves into the same "Season NN" folder regardless of release name.
async function resolveDestination(settings: any, name: string, type: 'movie' | 'series' | '', season?: number | null): Promise<string> {
  if (type === 'movie' || type === 'series') {
    const { root, folder } = await computeDestination(settings, name, type, season);
    if (!root) throw new Error('Destination folder is not configured');
    return path.join(root, ...folder.split('/').map(safeSegment));
  }
  if (!settings.destination_folder || !settings.destination_folder.trim()) {
    throw new Error('Destination folder is not configured');
  }
  return settings.destination_folder;
}

async function runTorboxDownload(tid: string, dlData: any, settings: any, token: string, mainWindow: BrowserWindow | null) {
  try {
    const rec = getDownloadByTorboxId(tid);
    const type: 'movie' | 'series' | '' = rec?.type || '';
    const destFolder = await resolveDestination(settings, dlData.name || tid, type, rec?.season ?? undefined);

    const tb = new TorboxAPI(token);
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
    // Files this transfer downloaded (raw names) — used to rename/subtitle ONLY
    // its own files, never touching other transfers' in-flight files.
    const downloadedFiles: string[] = [];

    for (let idx = 0; idx < files.length; idx++) {
      const fileInfo = files[idx];
      const fileId = fileInfo.id;
      const fileName = fileInfo.name || fileInfo.path || `file_${idx}`;
      // Media downloads land in a pre-computed layout folder
      // (<Title (Year)>/Season NN); flatten the torrent's internal folder
      // structure so every episode file sits directly in the season folder
      // (no per-episode / nested subfolders). Non-media keeps its structure.
      const safeRelPath = type === 'movie' || type === 'series'
        ? getSafePathPart(fileName.split(/[/\\]+/).pop() || `file_${idx}`)
        : getSafeRelativePath(fileName, `file_${idx}`);
      const filePath = path.join(destFolder, safeRelPath);
      const expectedSize = getFileSize(fileInfo);

      // Ensure subdirectory exists
      safeMkdirSync(path.dirname(filePath));

      // TorBox requestdl is metered and CDN links can expire or cut the stream
      // short (~97%). Download with retries: a fresh link per attempt and the
      // Downloader resumes the partial file (Range), so a truncated transfer
      // continues instead of failing the whole episode.
      let verified = false;
      for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
        let linkRes: any = null;
        for (let l = 1; l <= 3; l++) {
          linkRes = await tb.getDownloadLink(tid, String(fileId));
          if (linkRes && linkRes.success && linkRes.data) break;
          const reason = linkRes ? (linkRes.error || linkRes.detail || 'no data') : 'no response';
          console.warn(`[Worker] TorBox requestdl failed for ${fileName} (attempt ${l}/3):`, reason);
          if (l < 3) await new Promise((r) => setTimeout(r, l * 2000));
        }
        if (!linkRes || !linkRes.success || !linkRes.data) {
          if (attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 2000)); continue; }
          const reason = linkRes ? (linkRes.error || linkRes.detail || 'no data') : 'no response';
          throw new Error(`TorBox did not return a download link for ${fileName}: ${reason}`);
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

        // Keep the progress bar continuous across retries: base it on the bytes
        // already on disk (the resume offset) instead of resetting to 0.
        const partialBytes = expectedSize > 0 && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        updateDownload(tid, {
          local_status: `Downloading ${idx + 1}/${totalFiles}${attempt > 1 ? ` (intento ${attempt})` : ''}...`,
          local_progress: expectedSize > 0 ? Math.floor((partialBytes / expectedSize) * 100) : Math.floor((idx / totalFiles) * 100),
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
          if (result.rangeIgnored) {
            // The CDN doesn't support resume — the file on disk is all it gives.
            const sz = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
            if (sz > 0) {
              console.warn(`[Worker] ${fileName}: CDN ignores resume — accepting existing file (${sz} bytes)`);
              verified = true;
              continue;
            }
          }
          if (attempt < 3) {
            console.warn(`[Worker] Download ${fileName} failed (${result.error}), retry ${attempt + 1}/3`);
            await new Promise((r) => setTimeout(r, attempt * 2000));
            continue;
          }
          throw new Error(`Failed to download ${fileName}: ${result.error}`);
        }

        if (expectedSize > 0) {
          const actualSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
          if (actualSize === expectedSize) {
            verified = true;
          } else if (actualSize > 0 && attempt >= 2) {
            // Real file on disk but the debrid metadata size is off / the CDN
            // stopped delivering more bytes — accept it instead of re-downloading.
            console.warn(`[Worker] ${fileName}: size ${actualSize} vs expected ${expectedSize} — accepting file`);
            verified = true;
          } else {
            console.warn(`[Worker] ${fileName} partial (${actualSize}/${expectedSize} bytes), resuming on retry ${attempt + 1}/3`);
            await new Promise((r) => setTimeout(r, attempt * 2000));
          }
        } else {
          verified = true;
        }
      }

      if (verified) {
        completedBytes += expectedSize || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
        downloadedFiles.push(safeRelPath);
      } else {
        // All attempts failed (dead link, repeated truncation, 0 bytes) — fail
        // the transfer instead of silently continuing with an empty file.
        const actualSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        throw new Error(
          actualSize > 0
            ? `Failed to verify ${fileName}: expected ${expectedSize} bytes, got ${actualSize}`
            : `Download failed for ${fileName}: no data received (${expectedSize} bytes expected)`
        );
      }
    }

    updateDownload(tid, {
      local_status: 'completed',
      local_progress: 100,
      local_speed: 0,
      local_path: destFolder,
    });
    console.log(`[Worker] TorBox download complete: ${dlData.name || tid} → ${destFolder}`)
    // Subtitles FIRST (raw filenames still on disk, ownFiles match), then rename
    // the video AND its subtitle sidecars to the Jellyfin names.
    if (type === 'movie' || type === 'series') {
      await fetchSubtitlesForDownload(dlData.name || tid, type, destFolder, downloadedFiles);
    }
    if (type === 'series') {
      renameForJellyfin(dlData.name || tid, rec, destFolder, downloadedFiles);
    }
    
  } catch (err: any) {
    updateDownload(tid, {
      local_status: `failed: ${err.message}`,
      local_speed: 0,
    });
  } finally {
    activeLocalDownloads.delete(tid);
    activeDownloaders.delete(tid);
    dispatchNextLocalDownload();
    if (mainWindow) mainWindow.webContents.send('downloads-updated');
  }
}

// ── Real-Debrid local download ─────────────────────────

async function runRealdebridDownload(tid: string, dlData: any, settings: any, token: string, mainWindow: BrowserWindow | null) {
  try {
    const rec = getDownloadByTorboxId(tid);
    const type: 'movie' | 'series' | '' = rec?.type || '';
    const destFolder = await resolveDestination(settings, dlData.filename || dlData.name || tid, type, rec?.season ?? undefined);

    const rd = new RealDebridAPI(token);
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
    // Files this transfer downloaded (raw names) — for rename/subtitles scoping.
    const downloadedFiles: string[] = [];

    for (let idx = 0; idx < links.length; idx++) {
      const link = links[idx];
      let verified = false;
      let expectedSize = 0;
      let filePath = '';
      let safeName = '';

      // RD links can expire or cut short mid-stream; retry with a fresh
      // unrestricted link and resume the partial file (Range).
      for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
        // Unrestrict the link to get a direct download URL + filename
        const unrestrictRes = await rd.unrestrictLink(link);
        if (!unrestrictRes.success || !unrestrictRes.data) {
          if (attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 2000)); continue; }
          // Skip dead/expired hoster links — don't fail the whole torrent
          console.warn(`[RD] Skipping link ${idx + 1}/${totalLinks}: unrestrict failed (${unrestrictRes.error || 'unknown'})`);
          break;
        }

        const { download: directUrl, filename, filesize } = unrestrictRes.data;
        if (!directUrl) {
          if (attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 2000)); continue; }
          throw new Error(`No download URL returned for link ${idx + 1}/${totalLinks}`);
        }

        expectedSize = filesize || 0;

        // Flatten to the bare filename for media (layout folder already encodes
        // the structure); keep the path as-is for non-media downloads.
        safeName = type === 'movie' || type === 'series'
          ? getSafePathPart((filename || `part_${idx + 1}`).split(/[/\\]+/).pop() || `part_${idx + 1}`)
          : getSafeRelativePath(filename || `part_${idx + 1}`, `part_${idx + 1}`);
        filePath = path.join(destFolder, safeName);

        safeMkdirSync(path.dirname(filePath));

        // HARD GUARD
        if (!isDebridCDN(directUrl)) {
          throw new Error(
            `Security: Download URL ${directUrl} is not from a recognized debrid CDN.`
          );
        }

        const downloader = new Downloader(directUrl, filePath, expectedSize);
        activeDownloaders.set(tid, downloader);

        // Keep the progress bar continuous across retries (resume offset).
        const partialBytes = expectedSize > 0 && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        updateDownload(tid, {
          local_status: `Downloading ${idx + 1}/${totalLinks}${attempt > 1 ? ` (intento ${attempt})` : ''}...`,
          local_progress: expectedSize > 0 ? Math.floor((partialBytes / expectedSize) * 100) : Math.floor((idx / totalLinks) * 100),
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
          if (result.rangeIgnored) {
            const sz = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
            if (sz > 0) {
              console.warn(`[RD] part ${idx + 1}: CDN ignores resume — accepting existing file (${sz} bytes)`);
              verified = true;
              continue;
            }
          }
          if (attempt < 3) {
            console.warn(`[RD] Download part ${idx + 1} failed (${result.error}), retry ${attempt + 1}/3`);
            await new Promise((r) => setTimeout(r, attempt * 2000));
            continue;
          }
          throw new Error(`Failed to download part ${idx + 1}: ${result.error}`);
        }

        if (expectedSize > 0) {
          const actualSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
          if (actualSize === expectedSize) {
            verified = true;
          } else if (actualSize > 0 && attempt >= 2) {
            console.warn(`[RD] part ${idx + 1}: size ${actualSize} vs expected ${expectedSize} — accepting file`);
            verified = true;
          } else {
            console.warn(`[RD] part ${idx + 1} partial (${actualSize}/${expectedSize} bytes), resuming on retry ${attempt + 1}/3`);
            await new Promise((r) => setTimeout(r, attempt * 2000));
          }
        } else {
          verified = true;
        }
      }

      if (verified) {
        completedBytes += expectedSize || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
        downloadedFiles.push(safeName);
      } else {
        // All attempts failed (dead link, repeated truncation, 0 bytes) — fail
        // the transfer instead of silently continuing with an empty file.
        const actualSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        throw new Error(
          actualSize > 0
            ? `Failed to verify part ${idx + 1}: expected ${expectedSize} bytes, got ${actualSize}`
            : `Download failed for part ${idx + 1}: no data received (${expectedSize} bytes expected)`
        );
      }
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
    console.log(`[Worker] RD download complete: ${dlData.filename || tid} → ${destFolder}`)
    // Subtitles FIRST (raw filenames still on disk), then rename video + subs.
    if (type === 'movie' || type === 'series') {
      await fetchSubtitlesForDownload(dlData.filename || dlData.name || tid, type, destFolder, downloadedFiles);
    }
    if (type === 'series') {
      renameForJellyfin(dlData.filename || dlData.name || tid, rec, destFolder, downloadedFiles);
    }

  } catch (err: any) {
    updateDownload(tid, {
      local_status: `failed: ${err.message}`,
      local_speed: 0,
    });
  } finally {
    activeLocalDownloads.delete(tid);
    activeDownloaders.delete(tid);
    dispatchNextLocalDownload();
    if (mainWindow) mainWindow.webContents.send('downloads-updated');
  }
}

// ── Subtítulos automáticos (es/en) ─────────────────────
const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m4v|mov|wmv)$/i;
const SUB_EXT_RE = /\.(srt|vtt|ass|ssa|sub)$/i;
const EP_RE = /[sS](\d{1,2})[eE](\d{1,2})/;

// ── Renombrado Jellyfin (serie) ─────────────────────────
// Título derivado del nombre del torrent (parseReleaseName); código SxxEyy
// de la metadata guardada al agregar (season/episode) o, fallback, del nombre.
// Renombra SOLO los archivos que ESTA transferencia descargó (ownFiles): varias
// transferencias de la misma temporada comparten carpeta y renombrar "todos los
// videos de la carpeta" hacía que una transferencia renombrara el archivo que
// otra seguía descargando → verificación fallaba (path renombrado = 0 bytes) y
// la descarga se reiniciaba.
// Los subtítulos (<video>.spa.srt, .eng.srt, ...) se renombran junto al video
// para que coincidan con el episodio ya renombrado.
function renameForJellyfin(name: string, rec: { season?: number | null; episode?: number | null } | undefined, destFolder: string, ownFiles?: string[]) {
  try {
    let videos = fs.readdirSync(destFolder)
      .filter((f) => VIDEO_EXT_RE.test(f) && !f.startsWith('.'))
      .sort((a, b) => fs.statSync(path.join(destFolder, b)).size - fs.statSync(path.join(destFolder, a)).size);
    if (ownFiles && ownFiles.length > 0) {
      const own = new Set(ownFiles.map((f) => f.toLowerCase()));
      videos = videos.filter((v) => own.has(v.toLowerCase()));
    }
    if (videos.length === 0) return;

    const torrentEp = name.match(EP_RE);
    const title = parseReleaseName(name).title;
    let renamed = 0;

    /** Rename subtitle sidecars sharing the raw base (e.g. "...spa.srt"). */
    const moveSubs = (srcBase: string, dstBase: string) => {
      for (const f of fs.readdirSync(destFolder)) {
        if (!SUB_EXT_RE.test(f)) continue;
        if (!(f.startsWith(srcBase + '.') || f.startsWith(srcBase + '_'))) continue;
        const src = path.join(destFolder, f);
        const dst = path.join(destFolder, dstBase + f.slice(srcBase.length));
        try {
          if (fs.existsSync(dst)) fs.unlinkSync(src); // duplicate sidecar → drop
          else fs.renameSync(src, dst);
        } catch (e: any) {
          console.log(`[Worker] sub rename skip: ${e.message}`);
        }
      }
    };

    /** Delete subtitle sidecars of a removed duplicate video. */
    const deleteSubs = (srcBase: string) => {
      for (const f of fs.readdirSync(destFolder)) {
        if (!SUB_EXT_RE.test(f)) continue;
        if (!(f.startsWith(srcBase + '.') || f.startsWith(srcBase + '_'))) continue;
        try { fs.unlinkSync(path.join(destFolder, f)); } catch { /* ignore */ }
      }
    };

    for (const v of videos) {
      // Prefer the SxxEyy inside each file's own name (season packs); fall back
      // to the DB record, then the torrent name.
      const fileEp = v.match(EP_RE);
      const season = fileEp ? parseInt(fileEp[1], 10) : (rec?.season ?? (torrentEp ? parseInt(torrentEp[1], 10) : undefined));
      const episode = fileEp ? parseInt(fileEp[2], 10) : (rec?.episode ?? (torrentEp ? parseInt(torrentEp[2], 10) : undefined));
      if (!season || !episode) continue; // SxxEyy no determinable → mantener nombre original

      const target = path.join(destFolder, v);
      const ext = path.extname(target);
      const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      const rawBase = path.basename(v, ext);
      const newBase = `${title}.${code}`;
      const newPath = path.join(destFolder, `${newBase}${ext}`);
      if (newPath === target) continue;
      if (fs.existsSync(newPath)) {
        // The renamed file already exists (e.g. a previous run renamed this
        // episode) → this freshly downloaded file is a duplicate. Remove it
        // (and its subtitles) instead of colliding with the existing file.
        try {
          fs.unlinkSync(target);
          deleteSubs(rawBase);
          console.log(`[Worker] ${v} already exists as ${path.basename(newPath)} — removed duplicate`);
          renamed++;
        } catch (e: any) {
          console.log(`[Worker] duplicate cleanup skip: ${e.message}`);
        }
        continue;
      }
      fs.renameSync(target, newPath);
      moveSubs(rawBase, newBase);
      renamed++;
    }
    if (renamed > 0) console.log(`[Worker] Renamed ${renamed} video(s) in ${destFolder}`);
  } catch (e: any) {
    console.log(`[Worker] rename skip: ${e.message}`);
  }
}

function subtitleCommand(): { cmd: string; args: string[] } | null {
  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  if (isDev) {
    const scriptPath = path.join(__dirname, '..', 'electron', 'subtitles.py');
    if (!fs.existsSync(scriptPath)) return null;
    return { cmd: 'python', args: [scriptPath] };
  }
  // Production: prefer the bundled .exe, fall back to system python + .py
  const base = path.join(process.resourcesPath || app.getAppPath(), 'subtitles');
  const exePath = base + '.exe';
  if (fs.existsSync(exePath)) return { cmd: exePath, args: [] };
  const scriptPath = base + '.py';
  if (fs.existsSync(scriptPath)) return { cmd: 'python', args: [scriptPath] };
  return null;
}

/**
 * Tras completar una descarga media, busca el/los video(s) en la carpeta
 * destino y descarga subtítulos (español + inglés) vía electron/subtitles.py.
 * Fire-and-forget: errores solo se loguean, nunca fallan la descarga.
 */
async function fetchSubtitlesForDownload(name: string, type: string, destFolder: string, ownFiles?: string[]) {
  try {
    const run = subtitleCommand();
    if (!run) {
      console.log('[Subs] subtitles.py no encontrado, saltando subtítulos');
      return;
    }

    let videos = fs.readdirSync(destFolder)
      .filter((f) => VIDEO_EXT_RE.test(f) && !f.startsWith('.'))
      .sort((a, b) => fs.statSync(path.join(destFolder, b)).size - fs.statSync(path.join(destFolder, a)).size);
    if (ownFiles && ownFiles.length > 0) {
      const own = new Set(ownFiles.map((f) => f.toLowerCase()));
      videos = videos.filter((v) => own.has(v.toLowerCase()));
    }
    if (videos.length === 0) return;

    // Título base: quitar año, SxxExx, tags de calidad y release group
    const epMatch = name.match(EP_RE);
    const isSeries = type === 'series' || !!epMatch;
    let title = name
      .replace(/\b(19|20)\d{2}\b/g, ' ')
      .replace(EP_RE, ' ')
      .replace(/[.\-_]+/g, ' ')
      .replace(/\b(1080p|720p|4k|2160p|web[- ]?dl|bluray|webrip|hdr|x264|x265|h\.?265|hevc|h\.?264|aac|ac3|ddp5[.\s]?1|atmos|5[.\s]?1|7[.\s]?1|dual|latino|english|spanish|extended|unrated|repack|proper|nf|amzn|atvp|itunes|hmax|dsnp|uhd|remux|s\d{1,2}|complete|season|series|episode)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const tokens = title.split(' ');
    while (tokens.length > 3) {
      const last = tokens[tokens.length - 1];
      if (/^[A-Z0-9]{2,}$/.test(last) && last !== last.toLowerCase()) tokens.pop();
      else break;
    }
    title = tokens.join(' ').trim();
    if (!title) title = name;

    for (const v of videos) {
      const videoPath = path.join(destFolder, v);
      const args = [...run.args, 'fetch', '--title', title, '--type', isSeries ? 'series' : 'movie', '--dest', videoPath];
      if (isSeries && epMatch) args.push('--season', epMatch[1], '--episode', epMatch[2]);
      await new Promise<void>((resolve) => {
        const proc = spawn(run.cmd, args, { windowsHide: true, env: { ...(process.env as any), PYTHONIOENCODING: 'utf-8' } });
        let out = '';
        proc.stdout?.on('data', (c: Buffer) => (out += c.toString()));
        proc.stderr?.on('data', (c: Buffer) => (out += c.toString()));
        const timer = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} resolve(); }, 60_000);
        proc.on('close', () => { clearTimeout(timer); console.log(`[Subs] ${v}: ${out.trim().split('\n').pop()}`); resolve(); });
        proc.on('error', (e) => { clearTimeout(timer); console.log(`[Subs] error: ${e.message}`); resolve(); });
      });
    }
  } catch (e: any) {
    console.log(`[Subs] skip: ${e.message}`);
  }
}
