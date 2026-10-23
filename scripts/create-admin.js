'use strict';
// Usage: node scripts/create-admin.js "Full Name" admin@college.edu "a-long-password"
// Creates the first administrator in the database set by DATABASE_URL.
// The admin then creates the coordinator, transport, and principal accounts from the portal and imports the student roster.
const crypto = require('node:crypto');
const { db, audit } = require('../db');

(async () => {
  const [name, emailArg, password] = process.argv.slice(2);
  const email = (emailArg || '').toLowerCase();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 10) {
    console.error('Usage: node scripts/create-admin.js "Full Name" email "password (10+ characters)"');
    process.exit(1);
  }
  await db.ready;
  if (await db.get('SELECT 1 FROM users WHERE email = ?', email)) {
    console.error('An account with this email already exists.');
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const id = await db.insert("INSERT INTO users(email,name,role,pass_salt,pass_hash) VALUES(?,?,'admin',?,?)", email, name, salt, hash);
  await audit(id, 'create_admin', email);
  console.log(`Administrator created: ${email}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
