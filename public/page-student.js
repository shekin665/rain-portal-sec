'use strict';
(async function () {
  const user = await requireRole('student', ['student']);
  if (!user) return;
  const cfg = await api('/api/config');
  selectOptions($('#route'), cfg.areas.map(a => ({ value: a, label: a })), 'Choose route or area');
  selectOptions($('#mode'), cfg.travelModes.map(m => ({ value: m, label: LABELS.mode[m] })), 'Choose');
  selectOptions($('#issue'), cfg.issues.map(i => ({ value: i, label: LABELS.issue[i] })), 'Choose');
  if (user.area && cfg.areas.includes(user.area)) $('#route').value = user.area;

  async function loadStatus() {
    const box = $('#status'); box.replaceChildren();
    try {
      const s = await api('/api/public/status');
      if (s.confirmed) {
        box.append(h('div', { class: 'status-hero' },
          h('div', { class: `big ${s.confirmed.level}`, text: LABELS.levelShort[s.confirmed.level] }),
          h('p', { text: LABELS.levelMeaning[s.confirmed.level] })));
      } else {
        box.append(h('p', { class: 'muted', text: 'The coordinator has not confirmed today\'s level yet.' }));
      }
    } catch { box.append(h('p', { class: 'muted', text: 'Status unavailable.' })); }
  }

  async function loadMine() {
    const box = $('#mine'); box.replaceChildren();
    const { reports } = await api('/api/reports/mine');
    if (!reports.length) { box.append(h('p', { class: 'muted', text: 'You have not submitted any reports yet.' })); return; }
    box.append(table(['Date', 'Route', 'Issue', 'Mode', 'Photo', 'Status'],
      reports.map(r => [
        fmtDate(r.report_date), r.route, LABELS.issue[r.issue] || r.issue, LABELS.mode[r.mode] || r.mode,
        r.has_photo ? 'Yes' : 'No', r.status === 'removed' ? 'Removed by coordinator' : 'Counted'
      ])));
  }

  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('#msg'); const btn = $('button[type=submit]'); btn.disabled = true;
    try {
      const file = $('#photo').files[0];
      const body = { route: $('#route').value, mode: $('#mode').value, issue: $('#issue').value, note: $('#note').value };
      if (file) body.photo = await readPhoto(file);
      await api('/api/reports', { method: 'POST', body });
      showMsg(msg, 'ok', 'Report submitted. Thank you.');
      $('#note').value = ''; $('#photo').value = ''; $('#issue').value = '';
      await loadMine();
    } catch (e) {
      showMsg(msg, 'error', e.message);
    } finally { btn.disabled = false; }
  });

  await Promise.all([loadStatus(), loadMine()]);
})();
