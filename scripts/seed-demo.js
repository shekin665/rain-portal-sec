'use strict';
// Fills a TEST database with fictional staff, students and reports so the pages can be tried.
// Never run this against the real database. Use: DATA_DIR=./demo-data node scripts/seed-demo.js
const crypto = require('node:crypto');
const { db, getSettings } = require('../db');

if (!process.env.DATA_DIR) {
  console.error('Refusing to seed: set DATA_DIR to a separate folder, e.g. DATA_DIR=./demo-data');
  process.exit(1);
}

const PASS = 'Demo-Pass-2026';
function user(email, name, role, extra = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(PASS, salt, 64).toString('hex');
  const cols = { email, name, role, pass_salt: salt, pass_hash: hash, ...extra };
  const keys = Object.keys(cols);
  const info = db.prepare(`INSERT INTO users(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => cols[k]));
  return Number(info.lastInsertRowid);
}

user('admin@demo.test', 'Demo Admin', 'admin');
user('coordinator@demo.test', 'Demo Coordinator', 'coordinator');
user('transport@demo.test', 'Demo Transport In-charge', 'transport');
user('principal@demo.test', 'Demo Principal', 'principal');

const areas = getSettings().areas.filter(a => a !== 'Other');
// fictional distribution: bigger groups for the first areas
const weights = [14, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const modes = ['bus', 'two_wheeler', 'car', 'bus', 'two_wheeler'];
let n = 0; const studentIds = [];
areas.forEach((area, ai) => {
  for (let i = 0; i < (weights[ai] || 1); i++) {
    n++;
    const reg = `DEMO${String(n).padStart(4, '0')}`;
    const email = `student${n}@demo.test`;
    db.prepare('INSERT INTO roster(register_no,email,name) VALUES(?,?,?)').run(reg, email, `Demo Student ${n}`);
    const id = user(email, `Demo Student ${n}`, 'student', {
      register_no: reg, department: 'CSE', year: (n % 4) + 1, area, pincode: '600089',
      travel_mode: modes[n % modes.length]
    });
    studentIds.push({ id, area });
  }
});

// reports for today: heavy in the first three areas, a couple elsewhere
const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const issues = ['waterlogging', 'traffic', 'waterlogging', 'vehicle_breakdown', 'near_miss'];
let rc = 0;
for (const s of studentIds) {
  const idx = areas.indexOf(s.area);
  const chance = idx < 3 ? 0.8 : idx < 6 ? 0.3 : 0.05;
  if ((rc * 37 % 100) / 100 < chance) {
    db.prepare('INSERT INTO reports(user_id,route,mode,issue,note,report_date) VALUES(?,?,?,?,?,?)')
      .run(s.id, s.area, 'bus', issues[rc % issues.length], null, day);
  }
  rc++;
}
console.log(`Seeded ${n} students, 4 staff accounts, password for all: ${PASS}`);
console.log('Staff logins: admin@demo.test, coordinator@demo.test, transport@demo.test, principal@demo.test');
