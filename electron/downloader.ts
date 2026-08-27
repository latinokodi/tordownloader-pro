import fs from 'fs';
import path from 'path';
import axios, { CancelTokenSource } from 'axios';

/** TorBox CDN domains — the ONLY domains this downloader will accept. */
const TORBOX_CDN_DOMAINS = [
  'dl.torbox.app',
  'cdn.torbox.app',
  'torbox.app',
  'media.torbox.app',
  'tb-cdn.io',    // TorBox CDN edge nodes
  'tb-cdn.cx',    // TorBox CDN edge nodes (alt)
];

/** Real-Debrid CDN domains — RD generates download URLs via /unrestrict/link.
 *  These URLs are always on RD's infrastructure.  Subdomains include
 *  *.download.real-debrid.com, *.rd.nu, and CDN partner domains.
 *  See https://api.real-debrid.com/ → /unrestrict/link → "download" field. */
const REALDEBRID_CDN_DOMAINS = [
  'real-debrid.com',
  'rd.nu',
];

const ALL_CDN_DOMAINS = [...TORBOX_CDN_DOMAINS, ...REALDEBRID_CDN_DOMAINS];

function isDebridCDN(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ALL_CDN_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

export { isDebridCDN };

export interface DownloadProgress {
  bytes_done: number;
  progress_percent: number;
  speed: number;
  total_bytes: number;
}

export interface DownloadResult {
  success: boolean;
  error?: string;
  bytes_downloaded: number;
  /** True when a resume was requested but the server ignored the Range header (200). */
  rangeIgnored?: boolean;
}

export class Downloader {
  private cancelSource: CancelTokenSource | null = null;

  constructor(
    private url: string,
    private destPath: string,
    private expectedSize: number = 0
  ) {
    // HARD GUARD: refuse to download from anything other than debrid CDNs.
    // This app is debrid-only — it NEVER downloads via torrents/seeds/P2P.
    if (!isDebridCDN(url)) {
      throw new Error(
        `Security: Download rejected. URL ${url} is not a recognized debrid CDN domain. ` +
        `This app only downloads via debrid services (TorBox / Real-Debrid) — never via torrents/seeds/P2P.`
      );
    }
  }

  /** Abort an in-progress download. Safe to call at any time. */
  abort(): void {
    if (this.cancelSource) {
      this.cancelSource.cancel('Download cancelled by user');
      this.cancelSource = null;
    }
  }

  async start(onProgress?: (p: DownloadProgress) => void): Promise<DownloadResult> {
    this.cancelSource = axios.CancelToken.source();

    return new Promise(async (resolve) => {
      // Resume support: if a partial file already exists (e.g. a CDN stream was
      // cut at ~97%), continue from where it stopped with an HTTP Range request
      // instead of re-downloading from scratch.
      let startOffset = 0;
      if (this.expectedSize > 0 && fs.existsSync(this.destPath)) {
        try {
          const cur = fs.statSync(this.destPath).size;
          if (cur >= this.expectedSize) {
            this.cancelSource = null;
            resolve({ success: true, bytes_downloaded: cur });
            return;
          }
          if (cur > 0) startOffset = cur;
        } catch { /* stat failed → start over */ }
      }

      try {
        const headers: Record<string, string> = {};
        if (startOffset > 0) headers['Range'] = `bytes=${startOffset}-`;

        const response = await axios({
          method: 'GET',
          url: this.url,
          responseType: 'stream',
          timeout: 60000,
          cancelToken: this.cancelSource!.token,
          headers,
        });

        // Server ignored the Range header (200 OK) → resume is impossible.
        // Do NOT truncate or overwrite the existing partial; report it so the
        // caller can accept the file instead of re-downloading it from scratch.
        if (startOffset > 0 && response.status !== 206) {
          try { response.data.destroy(); } catch { /* ignore */ }
          this.cancelSource = null;
          resolve({ success: false, error: 'Range not supported by CDN', bytes_downloaded: startOffset, rangeIgnored: true });
          return;
        }

        const effectiveOffset = startOffset > 0 ? startOffset : 0;
        const totalLength = this.expectedSize || parseInt(String(response.headers['content-length']) || '0', 10) || 0;
        let bytesDownloaded = effectiveOffset;
        let lastUpdate = Date.now();
        let lastBytes = bytesDownloaded;
        let speed = 0;

        const writer = fs.createWriteStream(this.destPath, effectiveOffset > 0 ? { flags: 'a' } : {});

        response.data.on('data', (chunk: Buffer) => {
          bytesDownloaded += chunk.length;

          const now = Date.now();
          if (now - lastUpdate > 1000) {
            speed = (bytesDownloaded - lastBytes) / ((now - lastUpdate) / 1000);
            lastUpdate = now;
            lastBytes = bytesDownloaded;

            if (onProgress) {
              const progress_percent = totalLength ? Math.min(100, (bytesDownloaded / totalLength) * 100) : 0;
              onProgress({
                bytes_done: bytesDownloaded,
                progress_percent,
                speed,
                total_bytes: totalLength,
              });
            }
          }
        });

        response.data.pipe(writer);

        writer.on('finish', () => {
          writer.close();
          this.cancelSource = null;
          // A stream that ended without delivering the expected size is a
          // FAILURE, not a success — e.g. a dead/expired CDN link returns an
          // empty body (0 bytes) which must not be treated as "partial".
          // The partial file is kept so a retry can resume it.
          if (this.expectedSize > 0 && bytesDownloaded < this.expectedSize) {
            resolve({
              success: false,
              error: `Truncated download: got ${bytesDownloaded} of ${this.expectedSize} bytes`,
              bytes_downloaded: bytesDownloaded,
            });
          } else {
            resolve({ success: true, bytes_downloaded: bytesDownloaded });
          }
        });

        writer.on('error', (err) => {
          // Keep the partial file so a retry can resume it.
          this.cancelSource = null;
          resolve({ success: false, error: err.message, bytes_downloaded: bytesDownloaded });
        });
      } catch (err: any) {
        // Keep the partial file for resume.
        this.cancelSource = null;

        if (axios.isCancel(err)) {
          resolve({ success: false, error: 'Cancelled', bytes_downloaded: startOffset });
        } else if ((err as any)?.response?.status === 416 && startOffset > 0) {
          // Range beyond EOF → the partial file is actually complete.
          let sz = startOffset;
          try { sz = fs.statSync(this.destPath).size; } catch { /* ignore */ }
          resolve({ success: true, bytes_downloaded: sz });
        } else {
          resolve({ success: false, error: err.message, bytes_downloaded: startOffset });
        }
      }
    });
  }
}
