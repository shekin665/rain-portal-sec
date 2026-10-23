'use strict';
// Database layer. PostgreSQL in production (Supabase) through DATABASE_URL.
// With no DATABASE_URL (local demo and tests) an embedded Postgres (PGlite) is used, stored in DATA_DIR.
// Everything is async: await db.ready once, then db.get / db.all / db.run / db.insert.
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const NOW = "to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')";

let query; // (text, params) => { rows, rowCount }

if (process.env.DATABASE_URL) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => Number(v)); // bigint -> number
  const raw = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(raw);
  const url = raw.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const pool = new Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000
  });
  pool.on('error', (e) => console.error('database pool error', e.message));
  query = (text, params) => pool.query(text, params);
} else {
  const { PGlite } = require('@electric-sql/pglite');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lite = new PGlite(path.join(DATA_DIR, 'pgdata'), { parsers: { 20: (v) => Number(v) } });
  query = async (text, params) => {
    const r = await lite.query(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
}

// "?" placeholders -> $1, $2 ...
const numbered = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

const db = {
  NOW,
  async all(sql, ...params) { return (await query(numbered(sql), params)).rows; },
  async get(sql, ...params) { return (await query(numbered(sql), params)).rows[0]; },
  async run(sql, ...params) { const r = await query(numbered(sql), params); return { changes: r.rowCount }; },
  // INSERT into a table that has an "id" column; returns the new id.
  async insert(sql, ...params) { const r = await query(numbered(sql) + ' RETURNING id', params); return Number(r.rows[0].id); }
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_key ON login_attempts(key, at);
CREATE TABLE IF NOT EXISTS roster (
  register_no TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT
);
CREATE TABLE IF NOT EXISTS staff_roster (
  email TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('coordinator','transport','principal'))
);
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  route TEXT NOT NULL,
  mode TEXT NOT NULL,
  issue TEXT NOT NULL,
  note TEXT,
  photo TEXT,
  photo_data BYTEA,
  photo_type TEXT,
  photo_status TEXT,
  photo_notes TEXT,
  photo_lat DOUBLE PRECISION,
  photo_lon DOUBLE PRECISION,
  photo_taken TEXT,
  report_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
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
  updated_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('advisory','transport','attendance','leave_online')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','published','rejected')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Create the tables once per process (and so once per cold start on Vercel).
db.ready = (async () => {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await query(stmt, []);
  // Supabase exposes public tables through its own web API. Turning on row security with no policies
  // closes that door: only this server's database login (which bypasses it) can read the data.
  for (const t of ['users', 'sessions', 'login_attempts', 'roster', 'staff_roster', 'reports', 'day_status', 'announcements', 'audit_log', 'settings']) {
    await query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`, []);
  }
})();
db.ready.catch((e) => console.error('database setup failed:', e.message));

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

async function getSettings() {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  for (const row of await db.all('SELECT key, value FROM settings')) {
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

async function setSetting(key, value) {
  await db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key, JSON.stringify(value));
}

async function audit(actorId, action, detail) {
  await db.run('INSERT INTO audit_log(actor_id, action, detail) VALUES(?,?,?)',
    actorId ?? null, action, detail ? String(detail).slice(0, 500) : null);
}

module.exports = { db, DATA_DIR, getSettings, setSetting, audit, DEFAULTS };
