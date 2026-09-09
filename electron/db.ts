import Database, { type Database as DatabaseType } from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { app } from 'electron'

// Web/headless mode: TDP_DATA_DIR env wins; Electron desktop falls back to
// userData; plain Node (server.ts) falls back to ~/.tordownloader-pro.
function resolveDBPath(): string {
  if (process.env.TDP_DATA_DIR) {
    return path.join(process.env.TDP_DATA_DIR, 'tordownloader.db')
  }
  if (typeof app !== 'undefined' && app && typeof app.getPath === 'function') {
    return path.join(app.getPath('userData'), 'tordownloader.db')
  }
  return path.join(os.homedir(), '.tordownloader-pro', 'tordownloader.db')
}

const DB_PATH = resolveDBPath()
let db: Database.Database

export function initDB(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      torbox_token VARCHAR DEFAULT '',
      realdebrid_token VARCHAR DEFAULT '',
      realdebrid_refresh_token VARCHAR DEFAULT '',
      realdebrid_client_id VARCHAR DEFAULT '',
      realdebrid_client_secret VARCHAR DEFAULT '',
      destination_folder VARCHAR DEFAULT '',
      movies_folder VARCHAR DEFAULT '',
      series_folder VARCHAR DEFAULT '',
      auto_remove_completed BOOLEAN DEFAULT 0,
      tmdb_api_key VARCHAR DEFAULT '',
      last_update_prompt VARCHAR DEFAULT '',
      language_profile VARCHAR DEFAULT 'latino_first',
      monitor_enabled BOOLEAN DEFAULT 1,
      monitor_interval_minutes INTEGER DEFAULT 30,
      automation_service VARCHAR DEFAULT 'torbox',
      automation_failover BOOLEAN DEFAULT 1,
      jackett_url VARCHAR DEFAULT '',
      jackett_api_key VARCHAR DEFAULT '',
      last_monitor_run VARCHAR DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torbox_id VARCHAR UNIQUE,
      name VARCHAR DEFAULT 'Pending...',
      status VARCHAR DEFAULT 'downloading',
      progress INTEGER DEFAULT 0,
      local_status VARCHAR DEFAULT 'pending',
      local_progress INTEGER DEFAULT 0,
      local_speed INTEGER DEFAULT 0,
      local_eta VARCHAR DEFAULT '',
      local_path VARCHAR,
      service VARCHAR DEFAULT 'torbox',
      type VARCHAR DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie','series')),
      title TEXT NOT NULL,
      year TEXT DEFAULT '',
      overview TEXT DEFAULT '',
      poster TEXT DEFAULT '',
      backdrop TEXT DEFAULT '',
      imdb_id TEXT DEFAULT '',
      language_profile TEXT DEFAULT 'latino_first',
      monitored BOOLEAN DEFAULT 1,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked VARCHAR DEFAULT '',
      next_episode VARCHAR DEFAULT '',
      UNIQUE(tmdb_id, media_type)
    );

    CREATE TABLE IF NOT EXISTS grab_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      kind TEXT NOT NULL DEFAULT 'episode',
      title TEXT DEFAULT '',
      language TEXT DEFAULT '',
      source TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'grabbed',
      torbox_id VARCHAR DEFAULT '',
      info_hash VARCHAR DEFAULT '',
      error VARCHAR DEFAULT '',
      grabbed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_grab_uniq ON grab_history(tmdb_id, media_type, season, episode);
    CREATE INDEX IF NOT EXISTS idx_grab_wl ON grab_history(watchlist_id);
  `)

  // Migration: add columns that may not exist in older schema
  const migrations = [
    `ALTER TABLE downloads ADD COLUMN local_eta VARCHAR DEFAULT ''`,
    `ALTER TABLE downloads ADD COLUMN service VARCHAR DEFAULT 'torbox'`,
    `ALTER TABLE settings ADD COLUMN realdebrid_token VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN realdebrid_refresh_token VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN realdebrid_client_id VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN realdebrid_client_secret VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN tmdb_api_key VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN last_update_prompt VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN movies_folder VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN series_folder VARCHAR DEFAULT ''`,
    `ALTER TABLE downloads ADD COLUMN type VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN language_profile VARCHAR DEFAULT 'latino_first'`,
    `ALTER TABLE settings ADD COLUMN monitor_enabled BOOLEAN DEFAULT 1`,
    `ALTER TABLE settings ADD COLUMN monitor_interval_minutes INTEGER DEFAULT 30`,
    `ALTER TABLE settings ADD COLUMN automation_service VARCHAR DEFAULT 'torbox'`,
    `ALTER TABLE settings ADD COLUMN automation_failover BOOLEAN DEFAULT 1`,
    `ALTER TABLE settings ADD COLUMN jackett_url VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN jackett_api_key VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN last_monitor_run VARCHAR DEFAULT ''`,
    `ALTER TABLE downloads ADD COLUMN dest_folder VARCHAR DEFAULT ''`,
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch (_) { /* Column already exists */ }
  }
  
  // Create a default settings row if not exists
  const count = db.prepare('SELECT COUNT(*) as c FROM settings').get() as { c: number };
  if (count.c === 0) {
    db.prepare('INSERT INTO settings (id) VALUES (1)').run();
  }
}

export type DebridService = 'torbox' | 'realdebrid'
export type LanguageProfile = 'latino_first' | 'latino_only' | 'english_first'

export interface Settings {
  id: number;
  torbox_token: string;
  realdebrid_token: string;
  realdebrid_refresh_token: string;
  realdebrid_client_id: string;
  realdebrid_client_secret: string;
  destination_folder: string;
  movies_folder: string;
  series_folder: string;
  auto_remove_completed: boolean;
  tmdb_api_key: string;
  last_update_prompt: string;
  language_profile: LanguageProfile;
  monitor_enabled: boolean;
  monitor_interval_minutes: number;
  automation_service: DebridService;
  automation_failover: boolean;
  jackett_url: string;
  jackett_api_key: string;
  last_monitor_run: string;
}

export interface Download {
  id: number;
  torbox_id: string;
  name: string;
  status: string;
  progress: number;
  local_status: string;
  local_progress: number;
  local_speed: number;
  local_eta: string;
  local_path: string | null;
  service: DebridService;
  type: 'movie' | 'series' | '';
  created_at: string;
  dest_folder?: string | null;
}

export interface WatchlistItem {
  id: number;
  tmdb_id: number;
  media_type: 'movie' | 'series';
  title: string;
  year: string;
  overview: string;
  poster: string;
  backdrop: string;
  imdb_id: string;
  language_profile: LanguageProfile;
  monitored: boolean;
  added_at: string;
  last_checked: string;
  next_episode: string;
}

export interface GrabHistoryRow {
  id: number;
  watchlist_id: number;
  tmdb_id: number;
  media_type: 'movie' | 'series';
  season: number | null;
  episode: number | null;
  kind: string;
  title: string;
  language: string;
  source: string;
  status: string;
  torbox_id: string;
  info_hash: string;
  error: string;
  grabbed_at: string;
}

export function getSettings(): Settings {
  const stmt = db.prepare('SELECT * FROM settings WHERE id = 1');
  const row = stmt.get() as any;
  return {
    ...row,
    auto_remove_completed: Boolean(row.auto_remove_completed),
    monitor_enabled: row.monitor_enabled === undefined ? true : Boolean(row.monitor_enabled),
    automation_failover: row.automation_failover === undefined ? true : Boolean(row.automation_failover),
    monitor_interval_minutes: Number(row.monitor_interval_minutes || 30),
    language_profile: (row.language_profile as any) || 'latino_first',
    automation_service: (row.automation_service as any) || 'torbox',
  };
}

export function updateSettings(settings: Partial<Settings>): void {
  const fields: string[] = [];
  const values: any[] = [];
  
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'id') continue;
    fields.push(`${key} = ?`);
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  
  if (fields.length > 0) {
    const query = `UPDATE settings SET ${fields.join(', ')} WHERE id = 1`;
    db.prepare(query).run(...values);
  }
}

export function getDownloads(): Download[] {
  return db.prepare('SELECT * FROM downloads ORDER BY created_at DESC').all() as Download[];
}

export function getDownloadByTorboxId(torboxId: string): Download | undefined {
  return db.prepare('SELECT * FROM downloads WHERE torbox_id = ?').get(torboxId) as Download | undefined;
}

export function addDownload(data: Partial<Download>): void {
  const keys = Object.keys(data).join(', ');
  const placeholders = Object.keys(data).map(() => '?').join(', ');
  const values = Object.values(data);
  db.prepare(`INSERT OR IGNORE INTO downloads (${keys}) VALUES (${placeholders})`).run(...values);
}

export function updateDownload(torboxId: string, data: Partial<Download>): void {
  const fields: string[] = [];
  const values: any[] = [];
  
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || key === 'torbox_id') continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  
  if (fields.length > 0) {
    const query = `UPDATE downloads SET ${fields.join(', ')} WHERE torbox_id = ?`;
    values.push(torboxId);
    db.prepare(query).run(...values);
  }
}

export function deleteDownload(torboxId: string): void {
  db.prepare('DELETE FROM downloads WHERE torbox_id = ?').run(torboxId);
}

export function getDB(): DatabaseType {
  return db
}
