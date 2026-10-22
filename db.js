'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','coordinator','transport','principal','admin')),
  register_no TEXT UNIQUE,
  department TEXT,
  year INTEGER,
  mobile TEXT,
  area TEXT,
  pincode TEXT,
  address TEXT,
  travel_mode TEXT,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roster (
  register_no TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  route TEXT NOT NULL,
  mode TEXT NOT NULL,
  issue TEXT NOT NULL,
  note TEXT,
  photo TEXT,
  report_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  removed_by INTEGER REFERENCES users(id),
  removed_reason TEXT,
  UNIQUE (user_id, route, report_date)
);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date, status);
CREATE TABLE IF NOT EXISTS day_status (
  day TEXT PRIMARY KEY,
  official_alert TEXT NOT NULL DEFAULT 'none',
  alert_ref TEXT,
  confirmed_level TEXT,
  note TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('advisory','transport','attendance','leave_online')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','published','rejected')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Add columns that older databases do not have yet.
function addColumn(table, column, definition) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('reports', 'photo_status', 'TEXT');
addColumn('reports', 'photo_notes', 'TEXT');
addColumn('reports', 'photo_lat', 'REAL');
addColumn('reports', 'photo_lon', 'REAL');
addColumn('reports', 'photo_taken', 'TEXT');

// Starter values only. The college edits the area list and thresholds in the admin page.
const DEFAULTS = {
  areas: [
    'Ramapuram', 'Porur', 'Mugalivakkam', 'Manapakkam', 'Nandambakkam',
    'Valasaravakkam', 'Virugambakkam', 'Moulivakkam', 'Kundrathur',
    'Poonamallee', 'Vadapalani', 'Koyambedu', 'Other'
  ],
  // Severity: weighted score per route, counted only when enough different students report.
  severity: { minStudents: 3, yellow: 3, orange: 8, red: 15, photoWeight: 1.5, seriousWeight: 1.5 },
  // Area classes: share of students (%) and reports per 100 students.
  areaClass: { shareHigh: 10, rateHigh: 30 },
  // Photo checks: where and how recent a photo must be to count as verified. The centre is
  // approximately the college; the college should confirm these values.
  photoCheck: { centerLat: 13.035, centerLon: 80.18, radiusKm: 35, maxAgeHours: 24 },
  periodDays: 30
};

function getSettings() {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      const v = JSON.parse(row.value);
      if (row.key in out) {
        out[row.key] = (typeof v === 'object' && !Array.isArray(v) && v)
          ? { ...out[row.key], ...v } : v;
      }
    } catch { /* ignore bad row */ }
  }
  return out;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

function audit(actorId, action, detail) {
  db.prepare('INSERT INTO audit_log(actor_id, action, detail) VALUES(?,?,?)')
    .run(actorId ?? null, action, detail ? String(detail).slice(0, 500) : null);
}

module.exports = { db, DATA_DIR, getSettings, setSetting, audit, DEFAULTS };
