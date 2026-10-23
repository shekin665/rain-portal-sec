'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, getSettings, setSetting, audit } = require('./db');
const { checkPhoto } = require('./exif');
const { LEVELS, today, dayAnalysis, checkConfirm, areaAnalysis } = require('./logic');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
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

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_HOURS * 3600_000;
  await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha(token), userId, expires);
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}

async function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = await db.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    sha(token), Date.now());
  return row || null;
}

async function requireUser(req, roles) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, 'Please sign in.');
  if (roles && !roles.includes(u.role)) throw new HttpError(403, 'You do not have access to this.');
  return u;
}

// Sign-in throttle: 6 attempts per 15 minutes per address + email. Kept in the database, so it
// holds across serverless instances.
async function throttle(key) {
  const now = Date.now();
  await db.run('DELETE FROM login_attempts WHERE at < ?', now - 15 * 60_000);
  const n = (await db.get('SELECT COUNT(*)::int AS n FROM login_attempts WHERE key = ? AND at >= ?', key, now - 15 * 60_000)).n;
  if (n >= 6) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  await db.run('INSERT INTO login_attempts(key, at) VALUES(?,?)', key, now);
}
async function clearThrottle(key) { await db.run('DELETE FROM login_attempts WHERE key = ?', key); }

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
async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const name = (process.env.ADMIN_NAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !name || !password) return;
  if (await db.get("SELECT 1 FROM users WHERE role = 'admin'")) return;
  if (!isEmail(email) || password.length < 10) {
    console.error('ADMIN_EMAIL must be a valid email and ADMIN_PASSWORD at least 10 characters. No admin created.');
    return;
  }
  const { salt, hash } = makePassword(password);
  const id = await db.insert("INSERT INTO users(email,name,role,pass_salt,pass_hash) VALUES(?,?,'admin',?,?)",
    email, name, salt, hash);
  await await audit(id, 'create_admin', 'from environment');
  console.log(`Administrator created: ${email}`);
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, area: u.area, register_no: u.register_no };
}

// Validates a JPEG or PNG data URL and returns the bytes. The photo is stored in the database.
function readPhotoData(dataUrl) {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw bad('Photo must be a JPEG or PNG image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1_500_000) throw bad('Photo is larger than 1.5 MB.');
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!(isJpeg || isPng)) throw bad('The file is not a valid image.');
  return { buf, type: isPng ? 'image/png' : 'image/jpeg' };
}

// ---------- API routes ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/config', async () => {
  const s = (await getSettings());
  return { areas: s.areas, travelModes: TRAVEL_MODES, issues: ISSUES, severity: s.severity, areaClass: s.areaClass, levels: LEVELS };
});

// Staff register themselves only if the administrator has listed their email and role.
route('POST', '/api/register-staff', async (req, res) => {
  const b = await readJSON(req);
  const email = str(b.email).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const name = str(b.name, 100);
  if (!isEmail(email)) throw bad('Enter your college email.');
  if (!name) throw bad('Enter your name.');
  if (password.length < 10) throw bad('Staff passwords need at least 10 characters.');
  await throttle(`${clientIp(req)}|reg|${email}`);
  const row = await db.get('SELECT * FROM staff_roster WHERE email = ?', email);
  if (!row) throw new HttpError(403, 'This email is not on the approved staff list. Ask the portal administrator to add it.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account already exists for this email. Sign in instead.');
  const { salt, hash } = makePassword(password);
  const newId = await db.insert('INSERT INTO users(email,name,role,department,pass_salt,pass_hash) VALUES(?,?,?,?,?,?)',
    email, name, row.role, str(b.department, 60) || null, salt, hash);
  await audit(newId, 'register_staff', `${row.role} ${email}`);
  const cookie = await createSession(res, newId);
  const user = await db.get('SELECT * FROM users WHERE id = ?', newId);
  return [{ user: publicUser(user) }, { 'Set-Cookie': cookie }];
});

route('POST', '/api/register', async (req, res) => {
  const b = await readJSON(req);
  const email = str(b.email).toLowerCase();
  const registerNo = str(b.register_no, 30).toUpperCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const name = str(b.name, 100);
  const area = str(b.area, 60);
  const settings = (await getSettings());
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
  const rosterCount = (await db.get('SELECT COUNT(*)::int AS n FROM roster')).n;
  if (rosterCount === 0 && process.env.OPEN_REGISTRATION !== '1') {
    throw new HttpError(403, 'Registration opens after the college imports the student roster.');
  }
  if (rosterCount > 0) {
    const row = await db.get('SELECT * FROM roster WHERE register_no = ?', registerNo);
    if (!row || row.email.toLowerCase() !== email) {
      throw new HttpError(403, 'Register number and college email do not match the college roster.');
    }
  }
  if (await db.get('SELECT 1 FROM users WHERE email = ? OR register_no = ?', email, registerNo)) {
    throw new HttpError(409, 'An account already exists for this email or register number.');
  }
  const { salt, hash } = makePassword(password);
  const newId = await db.insert(
    `INSERT INTO users(email,name,role,register_no,department,year,mobile,area,pincode,address,travel_mode,pass_salt,pass_hash)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    email, name, 'student', registerNo, str(b.department, 60), year, str(b.mobile, 15),
    area, pincode, str(b.address, 300) || null, mode, salt, hash);
  await audit(newId, 'register', registerNo);
  const cookie = await createSession(res, newId);
  const user = await db.get('SELECT * FROM users WHERE id = ?', newId);
  return [{ user: publicUser(user) }, { 'Set-Cookie': cookie }];
});

route('POST', '/api/login', async (req, res) => {
  const b = await readJSON(req);
  const email = str(b.email).toLowerCase();
  await throttle(`${clientIp(req)}|${email}`);
  const user = await db.get('SELECT * FROM users WHERE email = ? AND active = 1', email);
  if (!user || typeof b.password !== 'string' || !checkPassword(user, b.password)) {
    await audit(null, 'login_failed', email);
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  // Students and staff have separate sign-in pages. Checked only after the password is right.
  const portal = b.portal === 'staff' ? 'staff' : b.portal === 'student' ? 'student' : '';
  if (!portal) throw bad('Use the student or staff sign-in page.');
  if ((user.role === 'student') !== (portal === 'student')) {
    throw new HttpError(403, user.role === 'student'
      ? 'This is the staff sign-in. Students sign in on the student sign-in page.'
      : 'This is the student sign-in. Staff and administrators use the staff sign-in page.');
  }
  await clearThrottle(`${clientIp(req)}|${email}`);
  await audit(user.id, 'login', user.role);
  return [{ user: publicUser(user) }, { 'Set-Cookie': await createSession(res, user.id) }];
});

route('POST', '/api/logout', async (req) => {
  const token = parseCookies(req).sid;
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
  return [{ ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }];
});

route('GET', '/api/me', async (req) => {
  const u = await currentUser(req);
  return { user: u ? publicUser(u) : null };
});

route('POST', '/api/password', async (req) => {
  const u = await requireUser(req);
  const b = await readJSON(req);
  await throttle(`pw|${u.id}`);
  if (typeof b.current !== 'string' || !checkPassword(u, b.current)) throw bad('Your current password is not correct.');
  const next = typeof b.next === 'string' ? b.next : '';
  const min = u.role === 'student' ? 8 : 10;
  if (next.length < min) throw bad(`The new password needs at least ${min} characters.`);
  if (next === b.current) throw bad('Choose a password different from the current one.');
  const { salt, hash } = makePassword(next);
  await db.run('UPDATE users SET pass_salt=?, pass_hash=? WHERE id=?', salt, hash, u.id);
  // sign out every other device that used the old password; keep this one
  await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', u.id, sha(parseCookies(req).sid || ''));
  await clearThrottle(`pw|${u.id}`);
  await audit(u.id, 'change_password', u.role);
  return { ok: true };
});

// Public page: confirmed level and published announcements only. No names, no counts of people.
route('GET', '/api/public/status', async () => {
  const day = today();
  const a = await dayAnalysis(day);
  const st = a.status;
  const routesOut = a.routes.filter(r => r.level !== 'green').map(r => ({ route: r.route, level: r.level }));
  const ann = await db.all(
    "SELECT id, day, kind, title, body, created_at FROM announcements WHERE status='published' AND day >= to_char(?::date - 2, 'YYYY-MM-DD') ORDER BY id DESC LIMIT 20",
    day);
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
  const u = await requireUser(req, ['student']);
  const b = await readJSON(req);
  const s = (await getSettings());
  const routeName = str(b.route, 60);
  if (!s.areas.includes(routeName)) throw bad('Choose the route or area you travel through.');
  if (!TRAVEL_MODES.includes(str(b.mode, 20))) throw bad('Choose your mode of travel.');
  if (!ISSUES.includes(str(b.issue, 30))) throw bad('Choose what happened.');
  const day = today();
  const exists = await db.get('SELECT 1 FROM reports WHERE user_id=? AND route=? AND report_date=?', u.id, routeName, day);
  if (exists) throw new HttpError(409, 'You have already reported this route today.');
  // Photo check: the page sends the camera data (EXIF and similar) read from the original file,
  // because the shrunk copy no longer has it. See exif.js for what this can and cannot prove.
  let check = null;
  if (b.photo) {
    const metaB64 = typeof b.photo_meta === 'string' && b.photo_meta.length <= 300_000 && /^[A-Za-z0-9+/=]*$/.test(b.photo_meta) ? b.photo_meta : '';
    check = metaB64
      ? checkPhoto(Buffer.from(metaB64, 'base64'), s.photoCheck, Date.now())
      : { status: 'unverified', notes: ['No camera data in the photo (screenshots, downloaded pictures and PNG files have none)'], lat: null, lon: null, taken: null };
    if (check.status === 'rejected') throw bad('This photo cannot be used. ' + check.notes.join('. ') + '. Take a new photo with your phone camera.');
  }
  const photo = b.photo ? readPhotoData(b.photo) : null;
  const newId = await db.insert(
    'INSERT INTO reports(user_id,route,mode,issue,note,photo,photo_data,photo_type,report_date,photo_status,photo_notes,photo_lat,photo_lon,photo_taken) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    u.id, routeName, str(b.mode, 20), str(b.issue, 30), str(b.note, 500) || null,
    photo ? 'db' : null, photo ? photo.buf : null, photo ? photo.type : null, day,
    check ? check.status : null, check ? check.notes.join('; ') || null : null, check ? check.lat : null, check ? check.lon : null, check ? check.taken : null);
  return { id: newId, report_date: day, photo_status: check ? check.status : null, photo_notes: check ? check.notes : [] };
});

route('GET', '/api/reports/mine', async (req) => {
  const u = await requireUser(req, ['student']);
  const rows = await db.all(
    'SELECT id, route, mode, issue, note, photo IS NOT NULL AS has_photo, photo_status, report_date, created_at, status FROM reports WHERE user_id=? ORDER BY id DESC LIMIT 30',
    u.id);
  return { reports: rows };
});

// ---- staff ----
const VIEW_ROLES = ['coordinator', 'transport', 'principal', 'admin'];

route('GET', '/api/staff/overview', async (req) => {
  const u = await requireUser(req, VIEW_ROLES);
  const url = new URL(req.url, 'http://x');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : today();
  const a = await dayAnalysis(day);
  // Only the coordinator sees individual reports with student identity.
  let reports = [];
  if (u.role === 'coordinator') {
    reports = await db.all(
      `SELECT r.id, r.route, r.mode, r.issue, r.note, r.photo IS NOT NULL AS has_photo, r.photo_status, r.photo_notes, r.photo_lat, r.photo_lon, r.photo_taken, r.created_at, r.status, r.removed_reason,
              u.name, u.register_no, u.department, u.year, u.area
       FROM reports r JOIN users u ON u.id = r.user_id WHERE r.report_date = ? ORDER BY r.id DESC`,
      day);
  }
  return { ...a, reports, role: u.role };
});

route('POST', '/api/staff/day', async (req) => {
  const u = await requireUser(req, ['coordinator']);
  const b = await readJSON(req);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day || '') ? b.day : today();
  const level = str(b.level, 10);
  const alert = str(b.official_alert, 10) || 'none';
  const ref = str(b.alert_ref, 200);
  const problem = checkConfirm(level, alert, ref);
  if (problem) throw bad(problem);
  await db.run(
    `INSERT INTO day_status(day,official_alert,alert_ref,confirmed_level,note,confirmed_by,updated_at)
     VALUES(?,?,?,?,?,?,${db.NOW})
     ON CONFLICT(day) DO UPDATE SET official_alert=excluded.official_alert, alert_ref=excluded.alert_ref,
       confirmed_level=excluded.confirmed_level, note=excluded.note, confirmed_by=excluded.confirmed_by, updated_at=${db.NOW}`,
    day, alert, ref || null, level, str(b.note, 300) || null, u.id);
  await audit(u.id, 'confirm_level', `${day} ${level} alert=${alert} ref=${ref}`);
  return { ok: true };
});

route('POST', '/api/staff/reports/:id/remove', async (req, res, params) => {
  const u = await requireUser(req, ['coordinator']);
  const b = await readJSON(req);
  const reason = str(b.reason, 200);
  if (!reason) throw bad('Enter a reason for removing the report.');
  const info = await db.run(
    "UPDATE reports SET status='removed', removed_by=?, removed_reason=? WHERE id=? AND status='active'",
    u.id, reason, Number(params.id));
  if (!info.changes) throw new HttpError(404, 'Report not found or already removed.');
  await audit(u.id, 'remove_report', `#${params.id}: ${reason}`);
  return { ok: true };
});

route('GET', '/api/staff/photo/:id', async (req, res, params) => {
  await requireUser(req, ['coordinator']);
  const row = await db.get('SELECT photo_data, photo_type FROM reports WHERE id = ?', Number(params.id));
  if (!row || !row.photo_data) throw new HttpError(404, 'No photo.');
  const data = Buffer.from(row.photo_data);
  res.writeHead(200, { 'Content-Type': row.photo_type || 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
  return undefined;
});

route('GET', '/api/staff/areas', async (req) => {
  await requireUser(req, VIEW_ROLES);
  const url = new URL(req.url, 'http://x');
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || (await getSettings()).periodDays));
  return await areaAnalysis(days);
});

route('GET', '/api/staff/announcements', async (req) => {
  await requireUser(req, VIEW_ROLES);
  const rows = await db.all(
    `SELECT a.id, a.day, a.kind, a.title, a.body, a.status, a.created_at, c.name AS author, d.name AS decided_by
     FROM announcements a JOIN users c ON c.id = a.created_by LEFT JOIN users d ON d.id = a.decided_by
     ORDER BY a.id DESC LIMIT 50`);
  return { announcements: rows };
});

route('POST', '/api/staff/announcements', async (req) => {
  const u = await requireUser(req, ['coordinator', 'transport', 'principal']);
  const b = await readJSON(req);
  const kind = str(b.kind, 20);
  if (!ANNOUNCE_KINDS.includes(kind)) throw bad('Unknown announcement type.');
  const title = str(b.title, 120), body = str(b.body, 1500);
  if (!title || !body) throw bad('Enter a title and a message.');
  // who may post what
  if (u.role === 'transport' && kind !== 'transport') throw new HttpError(403, 'The transport office can post transport notices only.');
  const status = (u.role === 'principal' || !NEEDS_APPROVAL.has(kind)) ? 'published' : 'pending';
  const newId = await db.insert(
    'INSERT INTO announcements(day,kind,title,body,status,created_by,decided_by) VALUES(?,?,?,?,?,?,?)',
    today(), kind, title, body, status, u.id, status === 'published' && u.role === 'principal' ? u.id : null);
  await audit(u.id, 'announcement_' + status, `${kind}: ${title}`);
  return { id: newId, status };
});

route('POST', '/api/staff/announcements/:id/decision', async (req, res, params) => {
  const u = await requireUser(req, ['principal']);
  const b = await readJSON(req);
  const decision = b.decision === 'approve' ? 'published' : b.decision === 'reject' ? 'rejected' : null;
  if (!decision) throw bad('Decision must be approve or reject.');
  const info = await db.run("UPDATE announcements SET status=?, decided_by=? WHERE id=? AND status='pending'",
    decision, u.id, Number(params.id));
  if (!info.changes) throw new HttpError(404, 'Announcement not found or already decided.');
  await audit(u.id, 'announcement_' + decision, `#${params.id}`);
  return { ok: true };
});

route('GET', '/api/staff/summary', async (req) => {
  await requireUser(req, VIEW_ROLES);
  const url = new URL(req.url, 'http://x');
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const perDay = await db.all(
    `SELECT r.report_date AS day, COUNT(*)::int AS reports, COUNT(DISTINCT r.user_id)::int AS students,
            SUM(CASE WHEN r.issue IN ('accident','near_miss') THEN 1 ELSE 0 END)::int AS serious,
            d.confirmed_level AS level, d.official_alert AS alert
     FROM reports r LEFT JOIN day_status d ON d.day = r.report_date
     WHERE r.status='active' AND r.report_date >= ?
     GROUP BY r.report_date, d.confirmed_level, d.official_alert ORDER BY r.report_date DESC`,
    since);
  const byRoute = await db.all(
    `SELECT route, COUNT(*)::int AS reports, COUNT(DISTINCT user_id)::int AS students FROM reports
     WHERE status='active' AND report_date >= ? GROUP BY route ORDER BY reports DESC`,
    since);
  const byIssue = await db.all(
    `SELECT issue, COUNT(*)::int AS reports FROM reports WHERE status='active' AND report_date >= ? GROUP BY issue ORDER BY reports DESC`,
    since);
  return { days, since, generated: new Date().toISOString(), perDay, byRoute, byIssue, areas: await areaAnalysis(days) };
});

// ---- admin ----
route('GET', '/api/admin/users', async (req) => {
  await requireUser(req, ['admin']);
  const users = await db.all(
    "SELECT id,name,email,role,active,created_at FROM users WHERE role != 'student' ORDER BY id");
  const students = (await db.get("SELECT COUNT(*)::int AS n FROM users WHERE role='student'")).n;
  const roster = (await db.get('SELECT COUNT(*)::int AS n FROM roster')).n;
  const staffRoster = await db.all('SELECT email, name, role FROM staff_roster ORDER BY role, email');
  return { staff: users, students, roster, staffRoster };
});

route('POST', '/api/admin/staff', async (req) => {
  const u = await requireUser(req, ['admin']);
  const b = await readJSON(req);
  const email = str(b.email).toLowerCase();
  const role = str(b.role, 20);
  const password = typeof b.password === 'string' ? b.password : '';
  if (!isEmail(email)) throw bad('Enter a valid email.');
  if (!STAFF_ROLES.includes(role)) throw bad('Unknown role.');
  if (!str(b.name, 100)) throw bad('Enter the name.');
  if (password.length < 10) throw bad('Staff passwords need at least 10 characters.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with this email exists.');
  const { salt, hash } = makePassword(password);
  await db.run('INSERT INTO users(email,name,role,pass_salt,pass_hash) VALUES(?,?,?,?,?)',
    email, str(b.name, 100), role, salt, hash);
  await audit(u.id, 'create_staff', `${role} ${email}`);
  return { ok: true };
});

route('POST', '/api/admin/staff/:id/active', async (req, res, params) => {
  const u = await requireUser(req, ['admin']);
  const b = await readJSON(req);
  const id = Number(params.id);
  if (id === u.id) throw bad('You cannot deactivate your own account.');
  const info = await db.run("UPDATE users SET active=? WHERE id=? AND role != 'student'", b.active ? 1 : 0, id);
  if (!info.changes) throw new HttpError(404, 'Staff account not found.');
  if (!b.active) await db.run('DELETE FROM sessions WHERE user_id = ?', id);
  await audit(u.id, b.active ? 'activate_staff' : 'deactivate_staff', `#${id}`);
  return { ok: true };
});

// Roster text: one student per line, "REGISTER_NO,email,Name"
route('POST', '/api/admin/roster', async (req) => {
  const u = await requireUser(req, ['admin']);
  const b = await readJSON(req, 2_000_000);
  const lines = String(b.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const ins = 'INSERT INTO roster(register_no,email,name) VALUES(?,?,?) ON CONFLICT(register_no) DO UPDATE SET email=excluded.email, name=excluded.name';
  let ok = 0; const skipped = [];
  for (const line of lines) {
    const [reg, email, ...nm] = line.split(',').map(s => s.trim());
    if (!reg || !isEmail((email || '').toLowerCase())) { skipped.push(line.slice(0, 60)); continue; }
    await db.run(ins, reg.toUpperCase(), email.toLowerCase(), nm.join(',') || null); ok++;
  }
  await audit(u.id, 'import_roster', `${ok} rows, ${skipped.length} skipped`);
  return { imported: ok, skipped };
});

// Approved staff list: one per line, "email,Name,role" where role is coordinator, transport or principal.
route('POST', '/api/admin/staff-roster', async (req) => {
  const u = await requireUser(req, ['admin']);
  const b = await readJSON(req);
  const lines = String(b.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const ins = 'INSERT INTO staff_roster(email,name,role) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role';
  let ok = 0; const skipped = [];
  for (const line of lines) {
    const parts = line.split(',').map(x => x.trim());
    const email = (parts[0] || '').toLowerCase(), role = (parts[parts.length - 1] || '').toLowerCase();
    if (!isEmail(email) || !['coordinator', 'transport', 'principal'].includes(role) || parts.length < 2) { skipped.push(line.slice(0, 60)); continue; }
    await db.run(ins, email, parts.length > 2 ? parts.slice(1, -1).join(',') : null, role); ok++;
  }
  await audit(u.id, 'import_staff_roster', `${ok} rows, ${skipped.length} skipped`);
  return { imported: ok, skipped };
});

route('POST', '/api/admin/staff-roster/remove', async (req) => {
  const u = await requireUser(req, ['admin']);
  const b = await readJSON(req);
  await db.run('DELETE FROM staff_roster WHERE email = ?', str(b.email).toLowerCase());
  await audit(u.id, 'remove_staff_roster', str(b.email));
  return { ok: true };
});

route('GET', '/api/admin/settings', async (req) => {
  await requireUser(req, ['admin']);
  return (await getSettings());
});

route('POST', '/api/admin/settings', async (req) => {
  const u = await requireUser(req, ['admin']);
  const b = await readJSON(req);
  if (b.areas !== undefined) {
    const areas = (Array.isArray(b.areas) ? b.areas : []).map(a => str(a, 60)).filter(Boolean);
    if (areas.length < 2 || new Set(areas).size !== areas.length) throw bad('Give at least two different area names.');
    await setSetting('areas', areas);
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
    await setSetting('severity', next);
  }
  if (b.areaClass) {
    await setSetting('areaClass', {
      shareHigh: num(b.areaClass.shareHigh, 0, 100, 'Share threshold'),
      rateHigh: num(b.areaClass.rateHigh, 0, 1000, 'Report-rate threshold')
    });
  }
  await audit(u.id, 'update_settings', Object.keys(b).join(','));
  return (await getSettings());
});

route('GET', '/api/admin/audit', async (req) => {
  await requireUser(req, ['admin', 'principal']);
  const rows = await db.all(
    `SELECT l.id, l.action, l.detail, l.created_at, u.name AS actor, u.role AS actor_role
     FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.id DESC LIMIT 200`);
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
    if ((err || !st.isFile()) && (p === '/logo.png' || p === '/campus.jpg')) { res.writeHead(204); return res.end(); }
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

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/healthz') return send(res, 200, 'ok'); // used by the host to check the service is up
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res);
  }
  try {
    await ensureReady();
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
}

const server = http.createServer(handle);

// The first administrator is created from ADMIN_* settings, once per process.
let bootstrapped;
const ensureReady = () => bootstrapped || (bootstrapped = db.ready.then(async () => {
  await bootstrapAdmin();
  await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}));

if (require.main === module) {
  ensureReady().then(() => server.listen(PORT, () => console.log(`Portal running on http://localhost:${PORT}`)))
    .catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
}
module.exports = { server, handle, ensureReady };
