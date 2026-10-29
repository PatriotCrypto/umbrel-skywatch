import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'skywatch.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS aircraft (
      hex TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, visits INTEGER DEFAULT 0,
      last_callsign TEXT, category TEXT, closest_nm REAL, min_alt INTEGER, max_alt INTEGER, last_squawk TEXT
    );
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hex TEXT, callsign TEXT, category TEXT,
      start_ts INTEGER, end_ts INTEGER, min_dist_nm REAL, min_alt INTEGER, max_alt INTEGER, max_gs REAL, squawk TEXT
    );
    CREATE INDEX IF NOT EXISTS visits_start ON visits(start_ts);
    CREATE INDEX IF NOT EXISTS visits_hex ON visits(hex);
    CREATE TABLE IF NOT EXISTS details (
      hex TEXT PRIMARY KEY, fetched_at INTEGER, found INTEGER, registration TEXT, typecode TEXT, short_type TEXT,
      model TEXT, manufacturer TEXT, operator TEXT, owner TEXT, built TEXT, mil INTEGER, privacy INTEGER,
      category_desc TEXT, icao_type TEXT
    );
    CREATE TABLE IF NOT EXISTS types (typecode TEXT PRIMARY KEY, first_seen INTEGER, first_hex TEXT, label TEXT, aircraft INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS hourly (hour INTEGER PRIMARY KEY, aircraft INTEGER DEFAULT 0, polls INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS heat (cell TEXT PRIMARY KEY, lat REAL, lon REAL, n INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, rule_id TEXT, kind TEXT, hex TEXT,
      title TEXT, message TEXT, delivered INTEGER, error TEXT
    );
    CREATE TABLE IF NOT EXISTS apicalls (day TEXT, kind TEXT, n INTEGER DEFAULT 0, PRIMARY KEY (day, kind));
  `);
  return db;
}

export function kvGet(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function kvSet(db, key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
