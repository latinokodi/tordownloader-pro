import Database, { type Database as DatabaseType } from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'

const DB_PATH = path.join(app.getPath('userData'), 'tordownloader.db')
let db: Database.Database

export function initDB(): void {
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      torbox_token VARCHAR DEFAULT '',
      destination_folder VARCHAR DEFAULT '',
      auto_remove_completed BOOLEAN DEFAULT 0
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // Migration: add local_eta column if not present
  try {
    db.exec(`ALTER TABLE downloads ADD COLUMN local_eta VARCHAR DEFAULT ''`)
  } catch (_) {
    // Column already exists — ignore
  }
  
  // Create a default settings row if not exists
  const count = db.prepare('SELECT COUNT(*) as c FROM settings').get() as { c: number };
  if (count.c === 0) {
    db.prepare('INSERT INTO settings (id) VALUES (1)').run();
  }
}

export interface Settings {
  id: number;
  torbox_token: string;
  destination_folder: string;
  auto_remove_completed: boolean;
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
  created_at: string;
}

export function getSettings(): Settings {
  const stmt = db.prepare('SELECT * FROM settings WHERE id = 1');
  const row = stmt.get() as any;
  return {
    ...row,
    auto_remove_completed: Boolean(row.auto_remove_completed)
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
