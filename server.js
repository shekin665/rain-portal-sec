'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, getSettings, setSetting, audit } = require('./db');
const { LEVELS, today, dayAnalysis, checkConfirm, areaAnalysis } = require('./logic');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_HOURS = 12;
const TRAVEL_MODES = ['bus', 'two_wheeler', 'car', 'hostel', 'other'];
const ISSUES = ['waterlogging', 'traffic', 'vehicle_breakdown', 'accident', 'near_miss'];
const STAFF_ROLES = ['coordinator', 'transport', 'principal', 'admin'];
const ANNOUNCE_KINDS = ['advisory', 'transport', 'attendance', 'leave_online'];
// Kinds that change attendance or classes need the principal's approval.
const NEEDS_APPROVAL = new Set(['attendance', 'leave_online']);

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function readJSON(req, limit = 3_000_000) {
  return new Promise((resolve, reject) => {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) return reject(new HttpError(415, 'JSON required.'));
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(bad('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}
function checkPassword(user, password) {
  const a = Buffer.from(hashPassword(password, user.pass_salt), 'hex');
  const b = Buffer.from(user.pass_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_HOURS * 3600_000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, expires);
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
  ).get(sha(token), Date.now());
  return row || null;
}

function requireUser(req, roles) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'Please sign in.');
  if (roles && !roles.includes(u.role)) throw new HttpError(403, 'You do not have access to this.');
  return u;
}

// simple sign-in throttle: 6 attempts per 15 minutes per address + email
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60_000);
  if (list.length >= 6) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  list.push(now); attempts.set(key, list);
}

// Behind a hosting proxy the socket address is the proxy's, so read the visitor's address from
// X-Forwarded-For, but only when TRUST_PROXY=1 (otherwise anyone could fake the header).
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress;
}

// First administrator for hosts without a shell: set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD.
// It only creates an account when no administrator exists yet.
function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const name = (process.env.ADMIN_NAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !name || !password) return;
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
  if (!isEmail(email) || password.length < 10) {
    console.error('ADMIN_EMAIL must be a valid email and ADMIN_PASSWORD at least 10 characters. No admin created.');
    return;
  }
  const { salt, hash } = makePassword(password);
  const info = db.prepare("INSERT INTO users(email,name,role,pass_salt,pass_hash) VALUES(?,?,'admin',?,?)")
    .run(email, name, salt, hash);
  audit(Number(info.lastInsertRowid), 'create_admin', 'from environment');
  console.log(`Administrator created: ${email}`);
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, area: u.area, register_no: u.register_no };
}

function savePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw bad('Photo must be a JPEG or PNG image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1_500_000) throw bad('Photo is larger than 1.5 MB.');
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!(isJpeg || isPng)) throw bad('The file is not a valid image.');
  const name = crypto.randomBytes(16).toString('hex') + (isPng ? '.png' : '.jpg');
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}

// ---------- API routes ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/config', async () => {
  const s = getSettings();
  return { areas: s.areas, travelModes: TRAVEL_MODES, issues: ISSUES, severity: s.severity, areaClass: s.areaClass, levels: LEVELS };
});

route('POST', '/api/register', async (req, res) => {
  const b = await readJSON(req);
  const email = str(b.email).toLowerCase();
  const registerNo = str(b.register_no, 30).toUpperCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const name = str(b.name, 100);
  const area = str(b.area, 60);
  const settings = getSettings();
  if (!isEmail(email)) throw bad('Enter a valid college email.');
  if (!name) throw bad('Enter your name.');
  if (!registerNo) throw bad('Enter your register number.');
  if (password.length < 8) throw bad('Password must have at least 8 characters.');
  if (!settings.areas.includes(area)) throw bad('Choose your home area from the list.');
  const mode = str(b.travel_mode, 20);
  if (!TRAVEL_MODES.includes(mode)) throw bad('Choose your usual mode of travel.');
  const pincode = str(b.pincode, 6);
  if (!/^\d{6}$/.test(pincode)) throw bad('Enter a 6-digit pincode.');
  const year = Number(b.year);
  if (!Number.isInteger(year) || year < 1 || year > 4) throw bad('Choose your year of study (1 to 4).');

  // Only enrolled students may register: the college imports a roster of register
  // numbers and college emails. Without a roster, registration stays closed.
  const rosterCount = db.prepare('SELECT COUNT(*) AS n FROM roster').get().n;
  if (rosterCount === 0 && process.env.OPEN_REGISTRATION !== '1') {
    throw new HttpError(403, 'Registration opens after the college imports the student roster.');
  }
  if (rosterCount > 0) {
    const row = db.prepare('SELECT * FROM roster WHERE register_no = ?').get(registerNo);
    if (!row || row.email.toLowerCase() !== email) {
      throw new HttpError(403, 'Register number and college email do not match the college roster.');
    }
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ? OR register_no = ?').get(email, registerNo)) {
    throw new HttpError(409, 'An account already exists for this email or register number.');
  }
  const { salt, hash } = makePassword(password);
  const info = db.prepare(
    `INSERT INTO users(email,name,role,register_no,department,year,mobile,area,pincode,address,travel_mode,pass_salt,pass_hash)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(email, name, 'student', registerNo, str(b.department, 60), year, str(b.mobile, 15),
    area, pincode, str(b.address, 300) || null, mode, salt, hash);
  audit(Number(info.lastInsertRowid), 'register', registerNo);
  const cookie = createSession(res, Number(info.lastInsertRowid));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return [{ user: publicUser(user) }, { 'Set-Cookie': cookie }];
});

route('POST', '/api/login', async (req, res) => {
  const b = await readJSON(req);
  const email = str(b.email).toLowerCase();
  throttle(`${clientIp(req)}|${email}`);
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user || typeof b.password !== 'string' || !checkPassword(user, b.password)) {
    audit(null, 'login_failed', email);
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  attempts.delete(`${clientIp(req)}|${email}`);
  audit(user.id, 'login', user.role);
  return [{ user: publicUser(user) }, { 'Set-Cookie': createSession(res, user.id) }];
});

route('POST', '/api/logout', async (req) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  return [{ ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }];
});

route('GET', '/api/me', async (req) => {
  const u = currentUser(req);
  return { user: u ? publicUser(u) : null };
});

route('POST', '/api/password', async (req) => {
  const u = requireUser(req);
  const b = await readJSON(req);
  throttle(`pw|${u.id}`);
  if (typeof b.current !== 'string' || !checkPassword(u, b.current)) throw bad('Your current password is not correct.');
  const next = typeof b.next === 'string' ? b.next : '';
  const min = u.role === 'student' ? 8 : 10;
  if (next.length < min) throw bad(`The new password needs at least ${min} characters.`);
  if (next === b.current) throw bad('Choose a password different from the current one.');
  const { salt, hash } = makePassword(next);
  db.prepare('UPDATE users SET pass_salt=?, pass_hash=? WHERE id=?').run(salt, hash, u.id);
  // sign out every other device that used the old password; keep this one
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, sha(parseCookies(req).sid || ''));
  attempts.delete(`pw|${u.id}`);
  audit(u.id, 'change_password', u.role);
  return { ok: true };
});

// Public page: confirmed level and published announcements only. No names, no counts of people.
route('GET', '/api/public/status', async () => {
  const day = today();
  const a = dayAnalysis(day);
  const st = a.status;
  const routesOut = a.routes.filter(r => r.level !== 'green').map(r => ({ route: r.route, level: r.level }));
  const ann = db.prepare(
    "SELECT id, day, kind, title, body, created_at FROM announcements WHERE status='published' AND day >= date(?, '-2 day') ORDER BY id DESC LIMIT 20"
  ).all(day);
  return {
    day,
    confirmed: st && st.confirmed_level ? {
      level: st.confirmed_level, official_alert: st.official_alert, note: st.note || '', updated_at: st.updated_at
    } : null,
    routes: st && st.confirmed_level ? routesOut : [],
    announcements: ann
  };
});

// ---- student ----
route('POST', '/api/reports', async (req) => {
  const u = requireUser(req, ['student']);
  const b = await readJSON(req);
  const s = getSettings();
  const routeName = str(b.route, 60);
  if (!s.areas.includes(routeName)) throw bad('Choose the route or area you travel through.');
  if (!TRAVEL_MODES.includes(str(b.mode, 20))) throw bad('Choose your mode of travel.');
  if (!ISSUES.includes(str(b.issue, 30))) throw bad('Choose what happened.');
  const day = today();
  const exists = db.prepare('SELECT 1 FROM reports WHERE user_id=? AND route=? AND report_date=?').get(u.id, routeName, day);
  if (exists) throw new HttpError(409, 'You have already reported this route today.');
  const photo = b.photo ? savePhoto(b.photo) : null;
  const info = db.prepare(
    'INSERT INTO reports(user_id,route,mode,issue,note,photo,report_date) VALUES(?,?,?,?,?,?,?)'
  ).run(u.id, routeName, str(b.mode, 20), str(b.issue, 30), str(b.note, 500) || null, photo, day);
  return { id: Number(info.lastInsertRowid), report_date: day };
});

route('GET', '/api/reports/mine', async (req) => {
  const u = requireUser(req, ['student']);
  const rows = db.prepare(
    'SELECT id, route, mode, issue, note, photo IS NOT NULL AS has_photo, report_date, created_at, status FROM reports WHERE user_id=? ORDER BY id DESC LIMIT 30'
  ).all(u.id);
  return { reports: rows };
});

// ---- staff ----
const VIEW_ROLES = ['coordinator', 'transport', 'principal', 'admin'];

route('GET', '/api/staff/overview', async (req) => {
  const u = requireUser(req, VIEW_ROLES);
  const url = new URL(req.url, 'http://x');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : today();
  const a = dayAnalysis(day);
  // Only the coordinator sees individual reports with student identity.
  let reports = [];
  if (u.role === 'coordinator') {
    reports = db.prepare(
      `SELECT r.id, r.route, r.mode, r.issue, r.note, r.photo IS NOT NULL AS has_photo, r.created_at, r.status, r.removed_reason,
              u.name, u.register_no, u.department, u.year, u.area
       FROM reports r JOIN users u ON u.id = r.user_id WHERE r.report_date = ? ORDER BY r.id DESC`
    ).all(day);
  }
  return { ...a, reports, role: u.role };
});

route('POST', '/api/staff/day', async (req) => {
  const u = requireUser(req, ['coordinator']);
  const b = await readJSON(req);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day || '') ? b.day : today();
  const level = str(b.level, 10);
  const alert = str(b.official_alert, 10) || 'none';
  const ref = str(b.alert_ref, 200);
  const problem = checkConfirm(level, alert, ref);
  if (problem) throw bad(problem);
  db.prepare(
    `INSERT INTO day_status(day,official_alert,alert_ref,confirmed_level,note,confirmed_by,updated_at)
     VALUES(?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(day) DO UPDATE SET official_alert=excluded.official_alert, alert_ref=excluded.alert_ref,
       confirmed_level=excluded.confirmed_level, note=excluded.note, confirmed_by=excluded.confirmed_by, updated_at=datetime('now')`
  ).run(day, alert, ref || null, level, str(b.note, 300) || null, u.id);
  audit(u.id, 'confirm_level', `${day} ${level} alert=${alert} ref=${ref}`);
  return { ok: true };
});

route('POST', '/api/staff/reports/:id/remove', async (req, res, params) => {
  const u = requireUser(req, ['coordinator']);
  const b = await readJSON(req);
  const reason = str(b.reason, 200);
  if (!reason) throw bad('Enter a reason for removing the report.');
  const info = db.prepare(
    "UPDATE reports SET status='removed', removed_by=?, removed_reason=? WHERE id=? AND status='active'"
  ).run(u.id, reason, Number(params.id));
  if (!info.changes) throw new HttpError(404, 'Report not found or already removed.');
  audit(u.id, 'remove_report', `#${params.id}: ${reason}`);
  return { ok: true };
});

route('GET', '/api/staff/photo/:id', async (req, res, params) => {
  requireUser(req, ['coordinator']);
  const row = db.prepare('SELECT photo FROM reports WHERE id = ?').get(Number(params.id));
  if (!row || !row.photo) throw new HttpError(404, 'No photo.');
  const file = path.join(UPLOAD_DIR, path.basename(row.photo));
  const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
  return undefined;
});

route('GET', '/api/staff/areas', async (req) => {
  requireUser(req, VIEW_ROLES);
  const url = new URL(req.url, 'http://x');
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || getSettings().periodDays));
  return areaAnalysis(days);
});

route('GET', '/api/staff/announcements', async (req) => {
  requireUser(req, VIEW_ROLES);
  const rows = db.prepare(
    `SELECT a.id, a.day, a.kind, a.title, a.body, a.status, a.created_at, c.name AS author, d.name AS decided_by
     FROM announcements a JOIN users c ON c.id = a.created_by LEFT JOIN users d ON d.id = a.decided_by
     ORDER BY a.id DESC LIMIT 50`
  ).all();
  return { announcements: rows };
});

route('POST', '/api/staff/announcements', async (req) => {
  const u = requireUser(req, ['coordinator', 'transport', 'principal']);
  const b = await readJSON(req);
  const kind = str(b.kind, 20);
  if (!ANNOUNCE_KINDS.includes(kind)) throw bad('Unknown announcement type.');
  const title = str(b.title, 120), body = str(b.body, 1500);
  if (!title || !body) throw bad('Enter a title and a message.');
  // who may post what
  if (u.role === 'transport' && kind !== 'transport') throw new HttpError(403, 'The transport office can post transport notices only.');
  const status = (u.role === 'principal' || !NEEDS_APPROVAL.has(kind)) ? 'published' : 'pending';
  const info = db.prepare(
    'INSERT INTO announcements(day,kind,title,body,status,created_by,decided_by) VALUES(?,?,?,?,?,?,?)'
  ).run(today(), kind, title, body, status, u.id, status === 'published' && u.role === 'principal' ? u.id : null);
  audit(u.id, 'announcement_' + status, `${kind}: ${title}`);
  return { id: Number(info.lastInsertRowid), status };
});

route('POST', '/api/staff/announcements/:id/decision', async (req, res, params) => {
  const u = requireUser(req, ['principal']);
  const b = await readJSON(req);
  const decision = b.decision === 'approve' ? 'published' : b.decision === 'reject' ? 'rejected' : null;
  if (!decision) throw bad('Decision must be approve or reject.');
  const info = db.prepare("UPDATE announcements SET status=?, decided_by=? WHERE id=? AND status='pending'")
    .run(decision, u.id, Number(params.id));
  if (!info.changes) throw new HttpError(404, 'Announcement not found or already decided.');
  audit(u.id, 'announcement_' + decision, `#${params.id}`);
  return { ok: true };
});

route('GET', '/api/staff/summary', async (req) => {
  requireUser(req, VIEW_ROLES);
  const url = new URL(req.url, 'http://x');
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const perDay = db.prepare(
    `SELECT r.report_date AS day, COUNT(*) AS reports, COUNT(DISTINCT r.user_id) AS students,
            SUM(CASE WHEN r.issue IN ('accident','near_miss') THEN 1 ELSE 0 END) AS serious,
            d.confirmed_level AS level, d.official_alert AS alert
     FROM reports r LEFT JOIN day_status d ON d.day = r.report_date
     WHERE r.status='active' AND r.report_date >= ? GROUP BY r.report_date ORDER BY r.report_date DESC`
  ).all(since);
  const byRoute = db.prepare(
    `SELECT route, COUNT(*) AS reports, COUNT(DISTINCT user_id) AS students FROM reports
     WHERE status='active' AND report_date >= ? GROUP BY route ORDER BY reports DESC`
  ).all(since);
  const byIssue = db.prepare(
    `SELECT issue, COUNT(*) AS reports FROM reports WHERE status='active' AND report_date >= ? GROUP BY issue ORDER BY reports DESC`
  ).all(since);
  return { days, since, generated: new Date().toISOString(), perDay, byRoute, byIssue, areas: areaAnalysis(days) };
});

// ---- admin ----
route('GET', '/api/admin/users', async (req) => {
  requireUser(req, ['admin']);
  const users = db.prepare(
    "SELECT id,name,email,role,active,created_at FROM users WHERE role != 'student' ORDER BY id"
  ).all();
  const students = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='student'").get().n;
  const roster = db.prepare('SELECT COUNT(*) AS n FROM roster').get().n;
  return { staff: users, students, roster };
});

route('POST', '/api/admin/staff', async (req) => {
  const u = requireUser(req, ['admin']);
  const b = await readJSON(req);
  const email = str(b.email).toLowerCase();
  const role = str(b.role, 20);
  const password = typeof b.password === 'string' ? b.password : '';
  if (!isEmail(email)) throw bad('Enter a valid email.');
  if (!STAFF_ROLES.includes(role)) throw bad('Unknown role.');
  if (!str(b.name, 100)) throw bad('Enter the name.');
  if (password.length < 10) throw bad('Staff passwords need at least 10 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with this email exists.');
  const { salt, hash } = makePassword(password);
  db.prepare('INSERT INTO users(email,name,role,pass_salt,pass_hash) VALUES(?,?,?,?,?)')
    .run(email, str(b.name, 100), role, salt, hash);
  audit(u.id, 'create_staff', `${role} ${email}`);
  return { ok: true };
});

route('POST', '/api/admin/staff/:id/active', async (req, res, params) => {
  const u = requireUser(req, ['admin']);
  const b = await readJSON(req);
  const id = Number(params.id);
  if (id === u.id) throw bad('You cannot deactivate your own account.');
  const info = db.prepare("UPDATE users SET active=? WHERE id=? AND role != 'student'").run(b.active ? 1 : 0, id);
  if (!info.changes) throw new HttpError(404, 'Staff account not found.');
  if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(u.id, b.active ? 'activate_staff' : 'deactivate_staff', `#${id}`);
  return { ok: true };
});

// Roster text: one student per line, "REGISTER_NO,email,Name"
route('POST', '/api/admin/roster', async (req) => {
  const u = requireUser(req, ['admin']);
  const b = await readJSON(req, 2_000_000);
  const lines = String(b.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const ins = db.prepare(
    'INSERT INTO roster(register_no,email,name) VALUES(?,?,?) ON CONFLICT(register_no) DO UPDATE SET email=excluded.email, name=excluded.name'
  );
  let ok = 0; const skipped = [];
  db.exec('BEGIN');
  try {
    for (const line of lines) {
      const [reg, email, ...nm] = line.split(',').map(s => s.trim());
      if (!reg || !isEmail((email || '').toLowerCase())) { skipped.push(line.slice(0, 60)); continue; }
      ins.run(reg.toUpperCase(), email.toLowerCase(), nm.join(',') || null); ok++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(u.id, 'import_roster', `${ok} rows, ${skipped.length} skipped`);
  return { imported: ok, skipped };
});

route('GET', '/api/admin/settings', async (req) => {
  requireUser(req, ['admin']);
  return getSettings();
});

route('POST', '/api/admin/settings', async (req) => {
  const u = requireUser(req, ['admin']);
  const b = await readJSON(req);
  if (b.areas !== undefined) {
    const areas = (Array.isArray(b.areas) ? b.areas : []).map(a => str(a, 60)).filter(Boolean);
    if (areas.length < 2 || new Set(areas).size !== areas.length) throw bad('Give at least two different area names.');
    setSetting('areas', areas);
  }
  const num = (v, min, max, label) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max}.`);
    return n;
  };
  if (b.severity) {
    const sv = b.severity;
    const next = {
      minStudents: num(sv.minStudents, 1, 100, 'Minimum students'),
      yellow: num(sv.yellow, 1, 1000, 'Yellow score'),
      orange: num(sv.orange, 1, 1000, 'Orange score'),
      red: num(sv.red, 1, 1000, 'Red score'),
      photoWeight: num(sv.photoWeight, 1, 5, 'Photo weight'),
      seriousWeight: num(sv.seriousWeight, 1, 5, 'Serious-issue weight')
    };
    if (!(next.yellow < next.orange && next.orange < next.red)) throw bad('Scores must rise: Yellow < Orange < Red.');
    setSetting('severity', next);
  }
  if (b.areaClass) {
    setSetting('areaClass', {
      shareHigh: num(b.areaClass.shareHigh, 0, 100, 'Share threshold'),
      rateHigh: num(b.areaClass.rateHigh, 0, 1000, 'Report-rate threshold')
    });
  }
  audit(u.id, 'update_settings', Object.keys(b).join(','));
  return getSettings();
});

route('GET', '/api/admin/audit', async (req) => {
  requireUser(req, ['admin', 'principal']);
  const rows = db.prepare(
    `SELECT l.id, l.action, l.detail, l.created_at, u.name AS actor, u.role AS actor_role
     FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.id DESC LIMIT 200`
  ).all();
  return { log: rows };
});

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    // No logo file yet: answer "no content" so the header shows its text mark without a browser error.
    if ((err || !st.isFile()) && p === '/logo.png') { res.writeHead(204); return res.end(); }
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin'
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/healthz') return send(res, 200, 'ok'); // used by the host to check the service is up
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res);
  }
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const out = await r.handler(req, res, params);
      if (out === undefined) return; // handler streamed its own response
      if (Array.isArray(out)) return send(res, 200, out[0], out[1]);
      return send(res, 200, out);
    }
    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

// clear expired sessions every hour
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600_000).unref();

if (require.main === module) {
  bootstrapAdmin();
  server.listen(PORT, () => console.log(`Portal running on http://localhost:${PORT}`));
}
module.exports = { server };
