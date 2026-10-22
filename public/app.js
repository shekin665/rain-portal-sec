'use strict';
// Shared helpers for every page. No inline scripts or styles are used (see the CSP in server.js).

const COLLEGE = 'SRM Easwari Engineering College';
const PLACE = 'Bharathi Salai, Ramapuram, Chennai 600089';
// Shown in the footer until the college authorises the portal. Set to '' once approved.
const PILOT_NOTICE = 'Pilot version. This portal is used with the approval of the college administration.';

const LABELS = {
  level: { green: 'Green: normal', yellow: 'Yellow: difficult', orange: 'Orange: risky', red: 'Red: dangerous' },
  levelShort: { green: 'Green', yellow: 'Yellow', orange: 'Orange', red: 'Red' },
  levelMeaning: {
    green: 'Normal travel. Regular schedule.',
    yellow: 'Difficult travel on some routes. Leave early and ride carefully.',
    orange: 'Risky travel on main routes. Follow transport and attendance notices.',
    red: 'Dangerous conditions. Do not travel unless the college says classes are on.'
  },
  issue: {
    waterlogging: 'Waterlogging', traffic: 'Traffic jam', vehicle_breakdown: 'Vehicle breakdown',
    accident: 'Accident', near_miss: 'Near-miss'
  },
  mode: { bus: 'Bus', two_wheeler: 'Two-wheeler', car: 'Car', hostel: 'Hostel (walking)', other: 'Other' },
  kind: { advisory: 'Safety advisory', transport: 'Transport notice', attendance: 'Attendance relaxation', leave_online: 'Leave or online classes' },
  alert: { none: 'No official alert', yellow: 'Yellow alert', orange: 'Orange alert', red: 'Red alert' },
  role: { student: 'Student', coordinator: 'Portal coordinator', transport: 'Transport in-charge', principal: 'Principal', admin: 'Administrator' },
  cls: { high: 'High priority', watch: 'Watch', normal: 'Normal' }
};

function $(sel, root) { return (root || document).querySelector(sel); }

// Build an element. Text goes in as text, never as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, options) {
  const opts = { credentials: 'same-origin', ...(options || {}) };
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function badge(level, text) {
  return h('span', { class: `badge ${level}`, text: text || LABELS.level[level] || level });
}

function showMsg(container, kind, text) {
  container.replaceChildren();
  if (text) container.append(h('div', { class: `msg ${kind}`, role: kind === 'error' ? 'alert' : 'status', text }));
}

function fmtDate(iso) {
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: iso.length === 10 ? undefined : 'Asia/Kolkata' });
}
function fmtTime(iso) {
  return new Date(iso.replace(' ', 'T') + 'Z').toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

// Logo: put the college's official logo file at public/logo.png.
// Until it is there, a plain text mark is shown. The logo is not drawn or recreated here.
function logoSlot() {
  const slot = h('span', { class: 'logo-slot' });
  const mono = h('span', { class: 'mono', text: 'SRM', 'aria-hidden': 'true' });
  slot.append(mono);
  const img = new Image();
  img.alt = `${COLLEGE} logo`;
  img.addEventListener('load', () => slot.replaceChildren(img));
  img.src = '/logo.png';
  return slot;
}

async function renderHeader(active) {
  let user = null;
  try { user = (await api('/api/me')).user; } catch { /* offline */ }
  const nav = h('nav', { 'aria-label': 'Main' });
  const link = (href, text, key) => h('a', { href, text, 'aria-current': key === active ? 'page' : false });
  nav.append(link('/', 'Today', 'home'));
  if (!user) {
    nav.append(link('/login.html', 'Sign in', 'login'), link('/register.html', 'Student registration', 'register'));
  } else {
    if (user.role === 'student') nav.append(link('/student.html', 'Report', 'student'));
    else nav.append(link('/staff.html', 'Dashboard', 'staff'));
    nav.append(h('span', { class: 'who', text: `${user.name} (${LABELS.role[user.role]})` }));
    nav.append(link('/account.html', 'Password', 'account'));
    nav.append(h('button', {
      type: 'button', text: 'Sign out',
      onclick: async () => { await api('/api/logout', { method: 'POST', body: {} }); location.href = '/'; }
    }));
  }
  const header = h('header', { class: 'site-header' },
    h('div', { class: 'bar' },
      h('a', { class: 'brand', href: '/', 'aria-label': `${COLLEGE}, Rainy Season Commute Safety Portal` },
        logoSlot(),
        h('span', { class: 'names' },
          h('span', { class: 'college', text: COLLEGE }),
          h('span', { class: 'sub', text: 'Rainy Season Commute Safety Portal' }))),
      nav));
  const mount = $('#site-header');
  mount.replaceWith(header);
  const foot = $('#site-footer');
  if (foot) {
    foot.replaceWith(h('footer', { class: 'footer' },
      h('div', { text: `${COLLEGE}, ${PLACE}` }),
      PILOT_NOTICE ? h('div', { text: PILOT_NOTICE }) : null,
      h('div', { text: 'Reports are used only to arrange safe travel. Student names are never shown publicly.' })));
  }
  return user;
}

// Pages that need a signed-in user. Redirects to sign-in otherwise.
async function requireRole(active, roles) {
  const user = await renderHeader(active);
  if (!user) { location.href = '/login.html'; return null; }
  if (roles && !roles.includes(user.role)) { location.href = '/'; return null; }
  const main = $('main');
  if (main) main.hidden = false; // protected pages stay hidden until sign-in is confirmed
  return user;
}

function selectOptions(select, items, placeholder) {
  select.replaceChildren();
  if (placeholder) select.append(h('option', { value: '', text: placeholder }));
  for (const it of items) select.append(h('option', { value: it.value, text: it.label }));
}

function table(headers, rows, opts) {
  const o = opts || {};
  const t = h('table', null,
    h('thead', null, h('tr', null, headers.map((x, i) => h('th', { class: (o.numCols || []).includes(i) ? 'num' : false, scope: 'col', text: x })))),
    h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h('td', { class: (o.numCols || []).includes(i) ? 'num' : false }, c))))));
  return h('div', { class: 'table-wrap' }, t);
}

// Copies the camera data (everything before the picture itself) out of a JPEG, as base64.
// The server uses it to check the photo; the shrunk copy sent as the picture has none of it.
function jpegMeta(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return '';
  let p = 2;
  while (p + 4 <= bytes.length && bytes[p] === 0xff) {
    const m = bytes[p + 1];
    if (m === 0xda || m === 0xd9) break;
    if (m === 0xff) { p++; continue; }
    p += 2 + ((bytes[p + 2] << 8) | bytes[p + 3]);
    if (p > 250000) return '';
  }
  let bin = '';
  const end = Math.min(p, bytes.length);
  for (let i = 0; i < end; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, end)));
  return btoa(bin);
}

// Reads a photo. Returns { photo: shrunk JPEG data URL (max 1280 px), meta: camera data of the original }.
function readPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png)$/.test(file.type)) return reject(new Error('Choose a JPEG or PNG photo.'));
    // Read as a data: URL (allowed by the page's security policy). blob: URLs are blocked by it.
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that photo.'));
    reader.onload = () => {
      const url = reader.result;
      let meta = '';
      try {
        const raw = atob(url.slice(url.indexOf(',') + 1));
        const head = new Uint8Array(Math.min(raw.length, 260000));
        for (let i = 0; i < head.length; i++) head[i] = raw.charCodeAt(i);
        meta = jpegMeta(head);
      } catch { /* no camera data */ }
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve({ photo: c.toDataURL('image/jpeg', 0.8), meta });
      };
      img.onerror = () => reject(new Error('Could not read that photo. Try a JPEG or PNG image.'));
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}

const PHOTO_LABEL = { verified: 'Verified', unverified: 'Not verified', rejected: 'Rejected' };
