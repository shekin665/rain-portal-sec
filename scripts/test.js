'use strict';
// End-to-end check of the rules in the proposal. Run: node scripts/test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
process.env.DATA_DIR = dir;
execFileSync('node', [path.join(__dirname, 'seed-demo.js')], { env: process.env, stdio: 'pipe' });
const { server } = require('../server');

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };


// Builds the start of a JPEG that carries EXIF camera data (big-endian), for the photo check tests.
function makeJpeg({ make, model, software, taken, lat, lon }) {
  const ents = []; let extra = Buffer.alloc(0);
  const ascii = (t) => Buffer.from(t + '\0', 'latin1');
  const rat = (n, d = 1) => { const b = Buffer.alloc(8); b.writeUInt32BE(Math.round(n * d)); b.writeUInt32BE(d, 4); return b; };
  // Layout: header(8) IFD0 at 8. Out-of-line data is appended after all IFDs; offsets patched below.
  const ifd0 = [], exif = [], gps = [];
  const pending = [];
  const add = (list, tag, type, count, data) => list.push({ tag, type, count, data });
  if (make) add(ifd0, 0x010f, 2, make.length + 1, ascii(make));
  if (model) add(ifd0, 0x0110, 2, model.length + 1, ascii(model));
  if (software) add(ifd0, 0x0131, 2, software.length + 1, ascii(software));
  if (taken) add(exif, 0x9003, 2, 20, ascii(taken));
  if (lat != null) {
    const dms = (v) => { const d = Math.floor(v), m = Math.floor((v - d) * 60), sec = ((v - d) * 60 - m) * 60; return Buffer.concat([rat(d), rat(m), rat(sec, 100)]); };
    add(gps, 1, 2, 2, Buffer.from('N\0')); add(gps, 2, 5, 3, dms(lat));
    add(gps, 3, 2, 2, Buffer.from('E\0')); add(gps, 4, 5, 3, dms(lon));
  }
  if (exif.length) add(ifd0, 0x8769, 4, 1, Buffer.alloc(4));
  if (gps.length) add(ifd0, 0x8825, 4, 1, Buffer.alloc(4));
  ifd0.sort((a, b) => a.tag - b.tag);
  const ifdSize = (l) => 2 + l.length * 12 + 4;
  let pos = 8; const at = {};
  for (const [n, l] of [['ifd0', ifd0], ['exif', exif], ['gps', gps]]) { at[n] = pos; pos += l.length ? ifdSize(l) : 0; }
  const blobs = []; let dataPos = pos;
  const build = (l) => {
    const out = Buffer.alloc(ifdSize(l)); out.writeUInt16BE(l.length, 0);
    l.forEach((e, i) => {
      const o = 2 + i * 12; out.writeUInt16BE(e.tag, o); out.writeUInt16BE(e.type, o + 2); out.writeUInt32BE(e.count, o + 4);
      if (e.tag === 0x8769) out.writeUInt32BE(at.exif, o + 8);
      else if (e.tag === 0x8825) out.writeUInt32BE(at.gps, o + 8);
      else if (e.data.length <= 4) e.data.copy(out, o + 8);
      else { out.writeUInt32BE(dataPos, o + 8); blobs.push(e.data); dataPos += e.data.length; }
    });
    return out;
  };
  const parts = [build(ifd0)];
  if (exif.length) parts.push(build(exif));
  if (gps.length) parts.push(build(gps));
  const tiff = Buffer.concat([Buffer.from('MM\0*', 'latin1'), Buffer.from([0, 0, 0, 8]), ...parts, ...blobs]);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
}

async function main() {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, body, cookie) {
    const r = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  }
  const login = async (email) => (await call('POST', '/api/login', { email, password: 'Demo-Pass-2026', portal: email.startsWith('student') ? 'student' : 'staff' })).cookie;

  const coord = await login('coordinator@demo.test');
  const principal = await login('principal@demo.test');
  const transport = await login('transport@demo.test');
  const admin = await login('admin@demo.test');
  const student = await login('student1@demo.test');

  // separate sign-in for students and staff
  const pw = 'Demo-Pass-2026';
  ok((await call('POST', '/api/login', { email: 'student1@demo.test', password: pw, portal: 'staff' })).status === 403, 'a student cannot sign in on the staff sign-in');
  ok((await call('POST', '/api/login', { email: 'admin@demo.test', password: pw, portal: 'student' })).status === 403, 'the administrator cannot sign in on the student sign-in');
  ok((await call('POST', '/api/login', { email: 'coordinator@demo.test', password: pw, portal: 'student' })).status === 403, 'staff cannot sign in on the student sign-in');
  ok((await call('POST', '/api/login', { email: 'student1@demo.test', password: pw })).status === 400, 'sign-in without a portal is refused');
  ok((await call('POST', '/api/login', { email: 'admin@demo.test', password: 'wrong', portal: 'student' })).status === 401, 'wrong password on the wrong portal does not reveal the account type');

  // staff registration: only emails on the approved list, role from the list
  const regStaff = (email) => call('POST', '/api/register-staff', { name: 'New Teacher', email, password: 'a-long-password-1' });
  ok((await regStaff('teacher@demo.test')).status === 403, 'staff registration refuses an email that is not on the approved list');
  ok((await call('POST', '/api/admin/staff-roster', { csv: 'teacher@demo.test,New Teacher,coordinator' }, student)).status === 403, 'students cannot edit the approved staff list');
  const imp = await call('POST', '/api/admin/staff-roster', { csv: 'teacher@demo.test,New Teacher,coordinator\nboss@demo.test,Boss,admin\nbad line' }, admin);
  ok(imp.json.imported === 1 && imp.json.skipped.length === 2, 'staff list import accepts valid lines and skips admin or malformed ones');
  const reg1 = await regStaff('teacher@demo.test');
  ok(reg1.status === 200 && reg1.json.user.role === 'coordinator', 'listed teacher registers and gets the listed role');
  ok((await regStaff('teacher@demo.test')).status === 409, 'second registration for the same email is refused');
  ok((await regStaff('boss@demo.test')).status === 403, 'nobody can register as administrator');

  // access control
  ok((await call('GET', '/api/staff/overview')).status === 401, 'staff overview needs sign-in');
  ok((await call('GET', '/api/staff/overview', null, student)).status === 403, 'students cannot open staff overview');
  ok((await call('POST', '/api/staff/day', { level: 'green' }, principal)).status === 403, 'principal cannot confirm levels (coordinator only)');
  ok((await call('GET', '/api/admin/users', null, coord)).status === 403, 'coordinator cannot open admin area');

  // severity from seeded reports
  const ov = (await call('GET', '/api/staff/overview', null, coord)).json;
  ok(ov.routes.length > 0 && ['green', 'yellow', 'orange', 'red'].includes(ov.suggested), `overview suggests a level (${ov.suggested})`);
  ok(ov.reports.length > 0 && ov.reports[0].name, 'coordinator sees reports with student identity');
  const ovT = (await call('GET', '/api/staff/overview', null, transport)).json;
  ok(ovT.reports.length === 0, 'transport office does not see individual reports');

  // one report per route per day
  const s1 = (await call('GET', '/api/reports/mine', null, student)).json.reports;
  const route = s1.length ? s1[0].route : 'Ramapuram';
  const dup = await call('POST', '/api/reports', { route, mode: 'bus', issue: 'traffic' }, student);
  if (s1.length) ok(dup.status === 409, 'second report for same route today is refused');
  const fresh = await call('POST', '/api/reports', { route: 'Koyambedu', mode: 'bus', issue: 'traffic' }, student);
  ok(fresh.status === 200, 'student can report a different route');
  ok((await call('POST', '/api/reports', { route: 'Nowhere', mode: 'bus', issue: 'traffic' }, student)).status === 400, 'unknown route is refused');
  ok((await call('POST', '/api/reports', { route: 'Porur', mode: 'bus', issue: 'traffic', photo: 'data:image/png;base64,AAAA' }, student)).status === 400, 'fake image is refused');


  // photo checks: camera data is read from the original file and decides if a photo counts as verified
  const nowIst = () => { const d = new Date(Date.now() + 5.5 * 3600_000 - 60_000); return d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':').replace(' ', ' '); };
  const stamp = nowIst().replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1:$2:$3');
  const shot = makeJpeg({ make: 'Google', model: 'Pixel 8', taken: stamp, lat: 13.0358, lon: 80.1851 });
  const pic = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const send = async (routeName, meta) => (await call('POST', '/api/reports', { route: routeName, mode: 'bus', issue: 'waterlogging', photo: pic, photo_meta: meta ? meta.toString('base64') : undefined }, student));
  let r = await send('Kundrathur', shot);
  ok(r.status === 200 && r.json.photo_status === 'verified', `camera photo with location in Chennai is verified (${r.json.photo_status} ${r.json.photo_notes})`);
  const photoRes = await fetch(base + `/api/staff/photo/${r.json.id}`, { headers: { Cookie: coord } });
  const photoBytes = Buffer.from(await photoRes.arrayBuffer());
  ok(photoRes.status === 200 && photoRes.headers.get('content-type') === 'image/jpeg' && photoBytes.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 'the coordinator can open a stored photo and gets the same bytes back');
  ok((await fetch(base + `/api/staff/photo/${r.json.id}`, { headers: { Cookie: student } })).status === 403, 'a student cannot open report photos');
  r = await send('Poonamallee', makeJpeg({ make: 'Google', model: 'Pixel 8', taken: stamp }));
  ok(r.status === 200 && r.json.photo_status === 'unverified' && /location/i.test(r.json.photo_notes.join()), 'photo without location is accepted but not verified');
  r = await send('Vadapalani', makeJpeg({ make: 'Google', model: 'Pixel 8', taken: stamp, lat: 28.61, lon: 77.2 }));
  ok(r.status === 200 && r.json.photo_status === 'unverified' && /outside/i.test(r.json.photo_notes.join()), 'photo taken far from Chennai is not verified');
  r = await send('Valasaravakkam', makeJpeg({ make: 'Google', model: 'Pixel 8', taken: '2020:01:01 10:00:00', lat: 13.03, lon: 80.18 }));
  ok(r.status === 200 && r.json.photo_status === 'unverified' && /ago/i.test(r.json.photo_notes.join()), 'old photo is not verified');
  r = await send('Virugambakkam', null);
  ok(r.status === 200 && r.json.photo_status === 'unverified', 'photo with no camera data (screenshot, PNG) is not verified');
  r = await send('Moulivakkam', makeJpeg({ make: 'Apple', model: 'iPhone 15', software: 'Adobe Photoshop 25.0', taken: stamp, lat: 13.03, lon: 80.18 }));
  ok(r.status === 400 && /editor/i.test(r.json.error), 'photo saved by Photoshop is rejected');
  r = await send('Manapakkam', makeJpeg({ software: 'Google Gemini', taken: stamp, lat: 13.03, lon: 80.18 }));
  ok(r.status === 400 && /generator/i.test(r.json.error), 'photo labelled as made by an image generator is rejected');
  const ov2 = (await call('GET', '/api/staff/overview', null, coord)).json;
  const withPhoto = ov2.reports.filter(x => x.photo_status === 'verified');
  ok(withPhoto.length >= 1 && withPhoto[0].photo_lat != null, 'coordinator sees the verified status and location of a photo');
  const { dayAnalysis } = require('../logic');
  ok(typeof (await dayAnalysis(ov2.day)).totalReports === 'number', 'severity analysis still runs with verified photos only');

  // few reports cannot raise the level
  const { routeLevel } = require('../logic');
  const sev = { minStudents: 3, yellow: 3, orange: 8, red: 15, photoWeight: 1.5, seriousWeight: 1.5 };
  const two = [{ user_id: 1, issue: 'accident', photo: 'x' }, { user_id: 2, issue: 'accident', photo: 'x' }];
  ok(routeLevel(two, sev).level === 'green', 'two students cannot raise a route above Green');
  const many = Array.from({ length: 9 }, (_, i) => ({ user_id: i + 1, issue: 'waterlogging', photo: null }));
  ok(routeLevel(many, sev).level === 'orange', 'nine students on one route reach Orange');
  const same = Array.from({ length: 20 }, () => ({ user_id: 1, issue: 'waterlogging', photo: null }));
  ok(routeLevel(same, sev).level === 'green', 'one student repeating cannot raise the level');

  // official alert rules
  const day = ov.day;
  ok((await call('POST', '/api/staff/day', { day, level: 'red', official_alert: 'none' }, coord)).status === 400, 'Red without an official alert is refused');
  ok((await call('POST', '/api/staff/day', { day, level: 'orange', official_alert: 'yellow', alert_ref: '' }, coord)).status === 400, 'alert without a reference is refused');
  ok((await call('POST', '/api/staff/day', { day, level: 'red', official_alert: 'yellow', alert_ref: 'IMD 6am' }, coord)).status === 400, 'Red needs an Orange or Red official alert');
  ok((await call('POST', '/api/staff/day', { day, level: 'orange', official_alert: 'orange', alert_ref: 'IMD Chennai 06:00' }, coord)).status === 200, 'coordinator confirms Orange with an alert reference');
  const pub = (await call('GET', '/api/public/status')).json;
  ok(pub.confirmed && pub.confirmed.level === 'orange', 'public page shows the confirmed level');
  ok(!JSON.stringify(pub).includes('Demo Student'), 'public page shows no student names');

  // announcements and approval
  const leave = await call('POST', '/api/staff/announcements', { kind: 'leave_online', title: 'Online classes', body: 'Classes online today.' }, coord);
  ok(leave.json.status === 'pending', 'leave notice from coordinator waits for the principal');
  ok((await call('GET', '/api/public/status')).json.announcements.every(a => a.title !== 'Online classes'), 'pending notice is not public');
  ok((await call('POST', `/api/staff/announcements/${leave.json.id}/decision`, { decision: 'approve' }, coord)).status === 403, 'coordinator cannot approve their own leave notice');
  ok((await call('POST', `/api/staff/announcements/${leave.json.id}/decision`, { decision: 'approve' }, principal)).status === 200, 'principal approves');
  ok((await call('GET', '/api/public/status')).json.announcements.some(a => a.title === 'Online classes'), 'approved notice becomes public');
  ok((await call('POST', '/api/staff/announcements', { kind: 'leave_online', title: 'x', body: 'y' }, transport)).status === 403, 'transport office cannot post leave notices');
  const adv = await call('POST', '/api/staff/announcements', { kind: 'advisory', title: 'Safety', body: 'Ride carefully.' }, coord);
  ok(adv.json.status === 'published', 'advisory publishes directly');

  // removing a false report is logged
  const rep = ov.reports[0];
  ok((await call('POST', `/api/staff/reports/${rep.id}/remove`, { reason: '' }, coord)).status === 400, 'removal needs a reason');
  ok((await call('POST', `/api/staff/reports/${rep.id}/remove`, { reason: 'Duplicate of another entry' }, coord)).status === 200, 'coordinator removes a report with a reason');
  const log = (await call('GET', '/api/admin/audit', null, admin)).json.log;
  ok(log.some(l => l.action === 'remove_report'), 'removal appears in the audit log');

  // area analysis
  const ar = (await call('GET', '/api/staff/areas?days=30', null, coord)).json;
  const shareSum = ar.areas.reduce((s, a) => s + a.share, 0);
  ok(Math.abs(shareSum - 100) < 1, `area shares add up to about 100% (${shareSum.toFixed(1)})`);
  ok(ar.areas.reduce((s, a) => s + a.students, 0) === ar.totalStudents, 'area student counts add up to total students');
  ok(ar.areas.some(a => a.class === 'high' || a.class === 'watch'), 'at least one area is classed High or Watch');
  console.log('      top areas:', ar.areas.slice(0, 3).map(a => `${a.area} ${a.students} students ${a.share}% rate ${a.rate} ${a.class}`).join(' | '));

  // registration rules
  const reg = (o) => call('POST', '/api/register', {
    name: 'New Student', register_no: 'NEW1', email: 'new1@demo.test', password: 'longenough1', area: 'Porur',
    travel_mode: 'bus', pincode: '600116', year: 2, department: 'ECE', ...o
  });
  ok((await reg({})).status === 403, 'registration refused when not on the college roster');
  await call('POST', '/api/admin/roster', { csv: 'NEW1,new1@demo.test,New Student\nbadline' }, admin);
  ok((await reg({ email: 'other@demo.test' })).status === 403, 'registration refused when email does not match the roster');
  ok((await reg({ pincode: '12' })).status === 400, 'bad pincode refused');
  ok((await reg({})).status === 200, 'rostered student registers');
  ok((await reg({})).status === 409, 'duplicate registration refused');

  // sign-in throttle
  let last;
  for (let i = 0; i < 7; i++) last = await call('POST', '/api/login', { email: 'student2@demo.test', password: 'wrong-password', portal: 'student' });
  ok(last.status === 429, 'repeated wrong passwords are throttled');

  // hosting support
  ok((await fetch(base + '/healthz')).status === 200, 'health check answers');
  const spoof = (ip) => fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ email: 'student5@demo.test', password: 'bad-password-1', portal: 'student' }) });
  let st; for (let i = 0; i < 8; i++) st = (await spoof('9.9.9.' + i)).status;
  ok(st === 429, 'X-Forwarded-For is ignored unless TRUST_PROXY=1 (header cannot dodge the throttle)');

  // password change
  const pcs = await login('student7@demo.test');
  ok((await call('POST', '/api/password', { current: 'wrong-one-123', next: 'brand-new-pass1' }, pcs)).status === 400, 'password change needs the correct current password');
  ok((await call('POST', '/api/password', { current: 'Demo-Pass-2026', next: 'short' }, pcs)).status === 400, 'short new password refused');
  ok((await call('POST', '/api/password', { current: 'Demo-Pass-2026', next: 'brand-new-pass1' })).status === 401, 'password change needs sign-in');
  ok((await call('POST', '/api/password', { current: 'Demo-Pass-2026', next: 'brand-new-pass1' }, pcs)).status === 200, 'student changes own password');
  ok((await call('POST', '/api/login', { email: 'student7@demo.test', password: 'Demo-Pass-2026', portal: 'student' })).status === 401, 'old password no longer works');
  ok((await call('POST', '/api/login', { email: 'student7@demo.test', password: 'brand-new-pass1', portal: 'student' })).status === 200, 'new password works');
  ok((await call('GET', '/api/me', null, pcs)).json.user !== null, 'the device that changed it stays signed in');

  // static + headers
  const home = await fetch(base + '/');
  ok(home.status === 200 || home.status === 404, 'static route answers (pages added next)');
  ok((await fetch(base + '/..%2f..%2fetc/passwd')).status !== 200, 'path traversal is blocked');
  ok(!!home.headers.get('content-security-policy'), 'security headers are set');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
