// ── Settings ──
export interface AppSettings {
  torbox_token?: string
  realdebrid_token?: string
  tmdb_api_key?: string
  destination_folder?: string
}

// ── API responses ──
export interface ApiResult {
  success: boolean
  detail?: string
  error?: string
}

// ── Downloads ──
export interface Download {
  id: number
  torbox_id: string
  name: string
  status: string
  progress: number
  seeds?: number
  download_speed?: number
  local_status?: string
  local_progress?: number
  local_speed?: number
  local_eta?: string
  local_path?: string
  service?: string
}

// ── Search ──
export interface SearchProgress {
  type: 'engine_start' | 'engine_results' | 'done'
  engine?: string
  results?: import('../store/searchTabs').SearchResult[]
}

// ── Log ──
export interface LogEntry {
  ts: string
  text: string
  level: string
}

// ── TMDB ──
export interface TMDBItem {
  id: number
  title?: string
  name?: string
  media_type: 'movie' | 'tv'
  poster_path?: string
  vote_average?: number
  overview?: string
  imdb_id?: string
  seasons?: Array<{ season_number: number; name: string; episode_count: number }>
  number_of_seasons?: number
}

export interface TMDBLists {
  movies: Record<string, TMDBItem[]>
  tv: Record<string, TMDBItem[]>
}

export interface TMDBSeason {
  episodes: Array<{ episode_number: number; name: string }>
}

// ── Latino providers ──
export interface LatinoResult {
  title: string
  magnet?: string
  infoHash?: string
  directUrl?: string
  size?: string
  seeders?: number
  provider: string
  quality?: string
}

// ── Stremio catalog ──
export interface CatalogManifest {
  catalogs: Array<{ id: string; name: string; type: string }>
}

export interface CatalogItem {
  id: string
  title?: string
  name?: string
  poster?: string
  media_type?: string
}

export interface CatalogMeta {
  videos?: Array<{ season: number; episode: number; name: string }>
}

// ── Debrid ──
export interface FlareSolverrStatus {
  status: 'ready' | 'starting' | 'failed' | 'off'
}

// ── ElectronAPI (full typed contract matching preload.ts) ──
export interface ElectronAPI {
  getSettings: () => Promise<AppSettings>
  setSettings: (settings: Partial<AppSettings>) => Promise<ApiResult>

  searchMetaSearch: (query: string) => Promise<any>
  getDownloads: () => Promise<Download[]>
  addMagnet: (magnet: string, service?: string) => Promise<ApiResult>
  addTorrentUrl: (url: string, service?: string) => Promise<ApiResult>
  controlTorrent: (torrentId: string, operation: string) => Promise<ApiResult>
  cancelDownload: (torrentId: string) => Promise<ApiResult>

  selectFolder: () => Promise<string | null>

  authStart: () => Promise<any>
  authPoll: (deviceCode: string) => Promise<any>
  getUserInfo: () => Promise<any>
  testMetaSearch: () => Promise<any>

  rdAuthStart: () => Promise<any>
  rdAuthPoll: (deviceCode: string) => Promise<any>
  rdUserInfo: () => Promise<any>
  rdTraffic: () => Promise<any>
  rdSelectFiles: (torrentId: string) => Promise<any>

  onDownloadsUpdated: (callback: () => void) => () => void
  onLog: (callback: (entry: LogEntry) => void) => () => void
  getLogs: () => Promise<LogEntry[]>
  getVersion: () => Promise<string>
  openFolder: (folderPath: string) => Promise<{ success: boolean; error: string | null }>
  clearCompleted: () => Promise<ApiResult>

  onFlareSolverrReady: (callback: () => void) => () => void
  flaresolverrRestart: () => Promise<{ success: boolean }>
  flaresolverrStatus: () => Promise<FlareSolverrStatus>

  onSearchProgress: (callback: (progress: SearchProgress) => void) => () => void
  onSearchError: (callback: (error: string) => void) => () => void

  checkPlugins: () => Promise<any>
  updatePlugins: () => Promise<any>

  tmdbLists: () => Promise<TMDBLists>
  tmdbDetail: (tmdbId: number, mediaType: string) => Promise<TMDBItem>
  tmdbSeason: (tmdbId: number, seasonNumber: number) => Promise<TMDBSeason>
  tmdbSearch: (query: string) => Promise<TMDBLists>
  tmdbValidate: (apiKey: string) => Promise<{ success: boolean; error?: string }>

  latinoSearch: (imdbId: string, mediaType: string, season?: string, episode?: string) => Promise<LatinoResult[]>
  onLatinoSearchProgress: (callback: (progress: any) => void) => () => void

  catalogManifest: () => Promise<CatalogManifest>
  catalogItems: (type: string, id: string) => Promise<CatalogItem[]>
  catalogMeta: (type: string, imdbId: string) => Promise<CatalogMeta>

  checkForUpdates: () => Promise<any>
  downloadUpdate: () => Promise<any>
  installUpdate: () => Promise<any>
  dismissUpdate: () => Promise<any>
  onUpdateAvailable: (callback: (version: string) => void) => () => void
  onUpdateNotAvailable: (callback: () => void) => () => void
  onUpdateDownloadProgress: (callback: (percent: number) => void) => () => void
  onUpdateDownloaded: (callback: () => void) => () => void
  onUpdateError: (callback: (message: string) => void) => () => void
}

// ── Helper: typed access to ElectronAPI ──
export function getElectronAPI(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI
}
