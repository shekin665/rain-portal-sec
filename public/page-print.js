'use strict';
(async function () {
  const user = await requireRole('staff', ['coordinator', 'transport', 'principal', 'admin']);
  if (!user) return;
  $('#print').addEventListener('click', () => window.print());
  $('#days').addEventListener('change', load);

  async function load() {
    const out = $('#out'); out.replaceChildren();
    const d = await api(`/api/staff/summary?days=${$('#days').value}`);
    $('#meta').textContent = `Period: ${fmtDate(d.since)} to today. Generated ${new Date(d.generated).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Only area and route totals are shown; no student names.`;
    const totalReports = d.perDay.reduce((s, r) => s + r.reports, 0);
    const serious = d.perDay.reduce((s, r) => s + r.serious, 0);
    out.append(h('div', { class: 'card' }, h('h2', { text: 'At a glance' }),
      table(['Measure', 'Value'], [
        ['Registered students', String(d.areas.totalStudents)],
        ['Reports in period', String(totalReports)],
        ['Accident and near-miss reports', String(serious)],
        ['Days with reports', String(d.perDay.length)]], { numCols: [1] })));

    out.append(h('div', { class: 'card' }, h('h2', { text: 'Days' }),
      d.perDay.length ? table(['Date', 'Reports', 'Students', 'Accident or near-miss', 'Confirmed level', 'Official alert'],
        d.perDay.map(r => [fmtDate(r.day), String(r.reports), String(r.students), String(r.serious),
          r.level ? badge(r.level, LABELS.levelShort[r.level]) : 'Not confirmed', r.alert ? LABELS.alert[r.alert] : '-']), { numCols: [1, 2, 3] })
        : h('p', { class: 'muted', text: 'No reports in this period.' })));

    out.append(h('div', { class: 'card' }, h('h2', { text: 'Routes' }),
      d.byRoute.length ? table(['Route', 'Reports', 'Students'], d.byRoute.map(r => [r.route, String(r.reports), String(r.students)]), { numCols: [1, 2] })
        : h('p', { class: 'muted', text: 'No reports in this period.' })));

    out.append(h('div', { class: 'card' }, h('h2', { text: 'Areas where students live' }),
      table(['Area', 'Students', 'Share of students (%)', 'Reports', 'Report rate (per 100)', 'Class'],
        d.areas.areas.map(a => [a.area, String(a.students), String(a.share), String(a.reports), String(a.rate), LABELS.cls[a.class]]), { numCols: [1, 2, 3, 4] })));

    out.append(h('div', { class: 'card' }, h('h2', { text: 'Issues reported' }),
      d.byIssue.length ? table(['Issue', 'Reports'], d.byIssue.map(r => [LABELS.issue[r.issue] || r.issue, String(r.reports)]), { numCols: [1] })
        : h('p', { class: 'muted', text: 'No reports in this period.' })));
  }
  await load();
})();
