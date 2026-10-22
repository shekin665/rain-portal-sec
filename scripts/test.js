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
  const login = async (email) => (await call('POST', '/api/login', { email, password: 'Demo-Pass-2026' })).cookie;

  const coord = await login('coordinator@demo.test');
  const principal = await login('principal@demo.test');
  const transport = await login('transport@demo.test');
  const admin = await login('admin@demo.test');
  const student = await login('student1@demo.test');

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
  for (let i = 0; i < 7; i++) last = await call('POST', '/api/login', { email: 'student2@demo.test', password: 'wrong-password' });
  ok(last.status === 429, 'repeated wrong passwords are throttled');

  // hosting support
  ok((await fetch(base + '/healthz')).status === 200, 'health check answers');
  const spoof = (ip) => fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ email: 'student5@demo.test', password: 'bad-password-1' }) });
  let st; for (let i = 0; i < 8; i++) st = (await spoof('9.9.9.' + i)).status;
  ok(st === 429, 'X-Forwarded-For is ignored unless TRUST_PROXY=1 (header cannot dodge the throttle)');

  // password change
  const pcs = await login('student7@demo.test');
  ok((await call('POST', '/api/password', { current: 'wrong-one-123', next: 'brand-new-pass1' }, pcs)).status === 400, 'password change needs the correct current password');
  ok((await call('POST', '/api/password', { current: 'Demo-Pass-2026', next: 'short' }, pcs)).status === 400, 'short new password refused');
  ok((await call('POST', '/api/password', { current: 'Demo-Pass-2026', next: 'brand-new-pass1' })).status === 401, 'password change needs sign-in');
  ok((await call('POST', '/api/password', { current: 'Demo-Pass-2026', next: 'brand-new-pass1' }, pcs)).status === 200, 'student changes own password');
  ok((await call('POST', '/api/login', { email: 'student7@demo.test', password: 'Demo-Pass-2026' })).status === 401, 'old password no longer works');
  ok((await call('POST', '/api/login', { email: 'student7@demo.test', password: 'brand-new-pass1' })).status === 200, 'new password works');
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
