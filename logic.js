'use strict';
const { db, getSettings } = require('./db');

const LEVELS = ['green', 'yellow', 'orange', 'red'];
const SERIOUS = new Set(['accident', 'near_miss']);

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function maxLevel(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

// Level for one route from its active reports. A route counts only when enough
// different students report it, so a few entries cannot raise the level.
function routeLevel(reports, sev) {
  const students = new Set(reports.map(r => r.user_id));
  if (students.size < sev.minStudents) return { level: 'green', score: 0, students: students.size };
  let score = 0;
  for (const r of reports) {
    let w = 1;
    if (r.photo) w *= sev.photoWeight;
    if (SERIOUS.has(r.issue)) w *= sev.seriousWeight;
    score += w;
  }
  let level = 'green';
  if (score >= sev.red) level = 'red';
  else if (score >= sev.orange) level = 'orange';
  else if (score >= sev.yellow) level = 'yellow';
  return { level, score: Math.round(score * 10) / 10, students: students.size };
}

async function dayAnalysis(day) {
  const sev = (await getSettings()).severity;
  const rows = await db.all(
    "SELECT id, user_id, route, issue, COALESCE(photo_status = 'verified', false) AS photo FROM reports WHERE report_date = ? AND status = 'active'",
    day);
  const byRoute = new Map();
  for (const r of rows) {
    if (!byRoute.has(r.route)) byRoute.set(r.route, []);
    byRoute.get(r.route).push(r);
  }
  const routes = [];
  let suggested = 'green';
  for (const [route, list] of byRoute) {
    const res = routeLevel(list, sev);
    suggested = maxLevel(suggested, res.level);
    routes.push({ route, reports: list.length, ...res });
  }
  routes.sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || b.score - a.score);
  const status = (await db.get('SELECT * FROM day_status WHERE day = ?', day)) || null;
  return { day, suggested, routes, totalReports: rows.length, status };
}

// Rules the coordinator must satisfy before confirming a level.
function checkConfirm(level, officialAlert, alertRef) {
  if (!LEVELS.includes(level)) return 'Unknown level.';
  if (!['none', 'yellow', 'orange', 'red'].includes(officialAlert)) return 'Unknown official alert value.';
  if ((level === 'orange' || level === 'red') && officialAlert === 'none') {
    return 'Orange and Red need an official rain alert (IMD Chennai or Greater Chennai Corporation).';
  }
  if (level === 'red' && !['orange', 'red'].includes(officialAlert)) {
    return 'Red needs an official Orange or Red rain alert.';
  }
  if (officialAlert !== 'none' && !(alertRef && alertRef.trim())) {
    return 'Enter the alert reference (issuing body and time) for the official alert.';
  }
  return null;
}

// Area analysis: students per area, share of all students, reports per 100 students,
// and a class that tells the college where to act first.
async function areaAnalysis(days) {
  const settings = await getSettings();
  const { shareHigh, rateHigh } = settings.areaClass;
  const students = await db.all(
    "SELECT COALESCE(NULLIF(area,''),'Not given') AS area, COUNT(*)::int AS n FROM users WHERE role='student' AND active=1 GROUP BY 1"
  );
  const total = students.reduce((s, r) => s + r.n, 0);
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const reps = await db.all(`
    SELECT COALESCE(NULLIF(u.area,''),'Not given') AS area, COUNT(*)::int AS n, COUNT(DISTINCT r.user_id)::int AS reporters
    FROM reports r JOIN users u ON u.id = r.user_id
    WHERE r.status='active' AND r.report_date >= ? GROUP BY 1
  `, since);
  const repMap = new Map(reps.map(r => [r.area, r]));
  const areas = students.map(s => {
    const r = repMap.get(s.area) || { n: 0, reporters: 0 };
    const share = total ? (s.n / total) * 100 : 0;
    const rate = s.n ? (r.n / s.n) * 100 : 0;
    let cls = 'normal';
    if (share >= shareHigh && rate >= rateHigh) cls = 'high';
    else if (share >= shareHigh || rate >= rateHigh) cls = 'watch';
    return {
      area: s.area, students: s.n,
      share: Math.round(share * 10) / 10,
      reports: r.n, reporters: r.reporters,
      rate: Math.round(rate * 10) / 10,
      class: cls
    };
  });
  const order = { high: 0, watch: 1, normal: 2 };
  areas.sort((a, b) => order[a.class] - order[b.class] || b.students - a.students);
  return { days, since, totalStudents: total, thresholds: { shareHigh, rateHigh }, areas };
}

module.exports = { LEVELS, SERIOUS, today, routeLevel, dayAnalysis, checkConfirm, areaAnalysis };
