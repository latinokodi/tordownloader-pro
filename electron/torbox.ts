import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';

export class TorboxAPI {
  private readonly baseUrl = 'https://api.torbox.app/v1/api';
  private client: AxiosInstance;

  constructor(public token?: string) {
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'User-Agent': 'TorboxDownloader/2.0',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 30000, // 30 seconds default
    });
  }

  static torrentIdentity(data: any): { id: string; hash: string } {
    const id = String(data?.id || data?.torrent_id || '').trim();
    const hash = String(data?.hash || '').trim().toLowerCase();
    return { id, hash };
  }

  static normalizeProgress(value: any, state: string = ''): number {
    const stateLower = state.toLowerCase();
    if (['completed', 'cached', 'finished'].includes(stateLower)) {
      return 100;
    }
    let raw = Number(value || 0);
    if (isNaN(raw)) raw = 0;
    if (raw <= 1 && raw > 0) raw *= 100;
    return Math.max(0, Math.min(100, Math.floor(raw)));
  }

  static normalizeTorrent(data: any): any {
    const normalized = { ...data };
    const state =
      normalized.download_state ||
      normalized.download_status ||
      (normalized.download_finished || normalized.download_present ? 'completed' : 'unknown');
    
    normalized.download_state = state;
    normalized.progress = TorboxAPI.normalizeProgress(normalized.progress, String(state));
    return normalized;
  }

  private async request(config: AxiosRequestConfig): Promise<any> {
    try {
      const response = await this.client.request(config);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const e = error as AxiosError<any>;
        if (e.code === 'ECONNABORTED') {
          return { success: false, error: 'Timeout', detail: 'The request to TorBox timed out.' };
        }
        if (e.response && e.response.data) {
          return e.response.data; // TorBox usually returns JSON even on errors
        }
        return { success: false, error: 'RequestError', detail: e.message };
      }
      return { success: false, error: 'UnknownError', detail: String(error) };
    }
  }

  async getDeviceCode(): Promise<any> {
    return this.request({
      method: 'GET',
      url: '/user/auth/device/start',
      params: { app: 'TorboxDownloader' },
    });
  }

  async getToken(deviceCode: string): Promise<any> {
    return this.request({
      method: 'POST',
      url: '/user/auth/device/token',
      data: { device_code: deviceCode },
    });
  }

  async getUserInfo(): Promise<any> {
    return this.request({
      method: 'GET',
      url: '/user/me',
    });
  }

  async addMagnet(magnet: string): Promise<any> {
    const data = new URLSearchParams();
    data.append('magnet', magnet);
    data.append('seed', '0');       // 0 = never seed — debrid-only, no P2P from this app
    data.append('allow_zip', 'false');

    return this.request({
      method: 'POST',
      url: '/torrents/createtorrent',
      data,
      timeout: 60000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
  }

  /** Upload a .torrent file as a Buffer (multipart/form-data) */
  async addTorrentFile(fileBuffer: Buffer, fileName: string = 'file.torrent'): Promise<any> {
    // Build a multipart body manually — Node.js FormData can be problematic with axios.
    // Use the form-data npm package for reliable multipart uploads in Node.js.
    const FormDataLib = require('form-data');
    const form = new FormDataLib();
    form.append('file', fileBuffer, {
      filename: fileName,
      contentType: 'application/x-bittorrent',
    });
    form.append('seed', '0');       // 0 = never seed — debrid-only, no P2P from this app
    form.append('allow_zip', 'false');

    return this.request({
      method: 'POST',
      url: '/torrents/createtorrent',
      data: form,
      timeout: 60000,
      headers: {
        ...form.getHeaders(),
      },
    });
  }

  /** Download a .torrent file from a URL and upload to TorBox */
  async addTorrentFromUrl(torrentUrl: string): Promise<any> {
    // Download the .torrent file from the external URL
    const response = await axios({
      method: 'GET',
      url: torrentUrl,
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'TorboxDownloader/2.0',
      },
    });

    const buffer = Buffer.from(response.data);
    const contentDisposition = response.headers['content-disposition'] || '';
    const urlPath = new URL(torrentUrl).pathname;
    let fileName = 'file.torrent';

    // Extract filename from Content-Disposition or URL path
    const cdMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (cdMatch) {
      fileName = cdMatch[1].replace(/['"]/g, '').trim();
    } else {
      const urlParts = urlPath.split('/');
      const lastPart = urlParts[urlParts.length - 1];
      if (lastPart && lastPart.endsWith('.torrent')) {
        fileName = decodeURIComponent(lastPart);
      }
    }

    return this.addTorrentFile(buffer, fileName);
  }

  async getTorrents(): Promise<any> {
    const data = await this.request({
      method: 'GET',
      url: '/torrents/mylist',
      params: { bypass_cache: 'true' },
    });
    if (data && Array.isArray(data.data)) {
      data.data = data.data.map((item: any) => TorboxAPI.normalizeTorrent(item));
    }
    return data;
  }

  async getTorrentInfo(torrentId: string): Promise<any> {
    const data = await this.request({
      method: 'GET',
      url: '/torrents/mylist',
      params: { id: torrentId },
    });
    if (data && Array.isArray(data.data)) {
      data.data = data.data.map((item: any) => TorboxAPI.normalizeTorrent(item));
    } else if (data && typeof data.data === 'object' && data.data !== null) {
      data.data = TorboxAPI.normalizeTorrent(data.data);
    }
    return data;
  }

  async getDownloadLink(torrentId: string, fileId: string): Promise<any> {
    return this.request({
      method: 'GET',
      url: '/torrents/requestdl',
      params: { torrent_id: torrentId, file_id: fileId, token: this.token },
    });
  }

  async controlTorrent(torrentId: string, operation: string): Promise<any> {
    const data = new URLSearchParams();
    data.append('torrent_id', torrentId);
    data.append('operation', operation);

    return this.request({
      method: 'POST',
      url: '/torrents/controltorrent',
      data,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
  }
}
