import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// On Railway a volume is mounted at /data; locally we fall back to ./data.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'calories.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS profiles (
    device_id  TEXT PRIMARY KEY,
    sex        TEXT,
    age        INTEGER,
    weight     REAL,
    height     REAL,
    activity   REAL,
    goal       TEXT,
    target     INTEGER,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS entries (
    id            TEXT PRIMARY KEY,
    device_id     TEXT NOT NULL,
    date          TEXT NOT NULL,
    name          TEXT NOT NULL,
    brand         TEXT,
    barcode       TEXT,
    kcal          REAL NOT NULL,
    protein       REAL,
    carbs         REAL,
    fat           REAL,
    amount        REAL,
    unit          TEXT,
    serving_label TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entries_device_date ON entries (device_id, date);
  CREATE INDEX IF NOT EXISTS idx_entries_device_created ON entries (device_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

console.log(`[db] ready at ${DB_PATH}`);

/* ------------------------------- profile ------------------------------- */

const getProfileStmt = db.prepare('SELECT * FROM profiles WHERE device_id = ?');
const upsertProfileStmt = db.prepare(`
  INSERT INTO profiles (device_id, sex, age, weight, height, activity, goal, target, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id) DO UPDATE SET
    sex = excluded.sex, age = excluded.age, weight = excluded.weight,
    height = excluded.height, activity = excluded.activity, goal = excluded.goal,
    target = excluded.target, updated_at = excluded.updated_at
`);

export function getProfile(deviceId) {
  return getProfileStmt.get(deviceId) ?? null;
}

export function saveProfile(deviceId, p) {
  upsertProfileStmt.run(
    deviceId, p.sex, p.age, p.weight, p.height, p.activity,
    p.goal, p.target, new Date().toISOString()
  );
  return getProfile(deviceId);
}

/* ------------------------------- entries ------------------------------- */

const listEntriesStmt = db.prepare(
  'SELECT * FROM entries WHERE device_id = ? AND date = ? ORDER BY created_at ASC'
);
const insertEntryStmt = db.prepare(`
  INSERT INTO entries
    (id, device_id, date, name, brand, barcode, kcal, protein, carbs, fat, amount, unit, serving_label, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getEntryStmt = db.prepare('SELECT * FROM entries WHERE id = ? AND device_id = ?');
const deleteEntryStmt = db.prepare('DELETE FROM entries WHERE id = ? AND device_id = ?');

export function listEntries(deviceId, date) {
  return listEntriesStmt.all(deviceId, date);
}

export function addEntry(deviceId, e) {
  insertEntryStmt.run(
    e.id, deviceId, e.date, e.name, e.brand ?? null, e.barcode ?? null,
    e.kcal, e.protein ?? null, e.carbs ?? null, e.fat ?? null,
    e.amount ?? null, e.unit ?? null, e.serving_label ?? null,
    e.created_at ?? new Date().toISOString()
  );
  return getEntryStmt.get(e.id, deviceId);
}

export function deleteEntry(deviceId, id) {
  return deleteEntryStmt.run(id, deviceId).changes > 0;
}

/* ---------------------- history + recent foods ---------------------- */

const historyStmt = db.prepare(`
  SELECT date,
         ROUND(SUM(kcal))    AS kcal,
         ROUND(SUM(protein)) AS protein,
         ROUND(SUM(carbs))   AS carbs,
         ROUND(SUM(fat))     AS fat,
         COUNT(*)            AS items
  FROM entries
  WHERE device_id = ? AND date >= ?
  GROUP BY date
  ORDER BY date DESC
`);

export function getHistory(deviceId, sinceDate) {
  return historyStmt.all(deviceId, sinceDate);
}

// Most-logged foods first, so the quick-add list is genuinely useful.
const recentStmt = db.prepare(`
  SELECT name, brand, barcode, kcal, protein, carbs, fat, amount, unit, serving_label,
         COUNT(*) AS uses, MAX(created_at) AS last_used
  FROM entries
  WHERE device_id = ?
  GROUP BY name, brand, serving_label, kcal
  ORDER BY uses DESC, last_used DESC
  LIMIT ?
`);

export function getRecents(deviceId, limit = 20) {
  return recentStmt.all(deviceId, limit);
}

/* -------------------------------- cache -------------------------------- */

const cacheGetStmt = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?');
const cacheSetStmt = db.prepare(
  'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
);
const cachePurgeStmt = db.prepare('DELETE FROM cache WHERE expires_at < ?');

export function cacheGet(key) {
  const row = cacheGetStmt.get(key);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function cacheSet(key, value, ttlMs) {
  cacheSetStmt.run(key, JSON.stringify(value), Date.now() + ttlMs);
}

// Hourly sweep of expired rows so the cache table cannot grow without bound.
setInterval(() => {
  try { cachePurgeStmt.run(Date.now()); } catch (err) { console.error('[db] cache purge failed', err); }
}, 60 * 60 * 1000).unref();
