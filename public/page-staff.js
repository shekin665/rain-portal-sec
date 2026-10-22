'use strict';
(async function () {
  const user = await requireRole('staff', ['coordinator', 'transport', 'principal', 'admin']);
  if (!user) return;
  const role = user.role;
  const cfg = await api('/api/config');
  $('#role-line').textContent = {
    coordinator: 'Review reports, confirm the daily level against official alerts, and publish notices.',
    transport: 'See route and area demand, and post transport notices.',
    principal: 'See the evidence, and approve attendance and leave notices.',
    admin: 'Manage accounts, the student roster and portal settings.'
  }[role];

  const TABS = {
    overview: { label: 'Today', roles: ['coordinator', 'transport', 'principal', 'admin'], load: loadOverview },
    reports: { label: 'Reports', roles: ['coordinator'], load: loadReports },
    areas: { label: 'Areas', roles: ['coordinator', 'transport', 'principal', 'admin'], load: loadAreas },
    notices: { label: 'Notices', roles: ['coordinator', 'transport', 'principal'], load: loadNotices },
    admin: { label: 'Accounts and settings', roles: ['admin'], load: loadAdmin },
    audit: { label: 'Audit log', roles: ['admin', 'principal'], load: loadAudit }
  };
  const keys = Object.keys(TABS).filter(k => TABS[k].roles.includes(role));
  const tabsEl = $('#tabs'), panelsEl = $('#panels');
  const panels = {};
  let overviewDay = '';

  for (const k of keys) {
    const btn = h('button', { type: 'button', role: 'tab', id: `tab-${k}`, 'aria-controls': `panel-${k}`, 'aria-selected': 'false', text: TABS[k].label,
      onclick: () => select(k) });
    tabsEl.append(btn);
    panels[k] = h('section', { role: 'tabpanel', id: `panel-${k}`, 'aria-labelledby': `tab-${k}`, hidden: true });
    panelsEl.append(panels[k]);
  }
  async function select(k) {
    for (const key of keys) {
      $(`#tab-${key}`).setAttribute('aria-selected', String(key === k));
      panels[key].hidden = key !== k;
    }
    location.hash = k;
    panels[k].replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
    try { await TABS[k].load(panels[k]); }
    catch (e) { panels[k].replaceChildren(h('div', { class: 'msg error', text: e.message })); }
  }

  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null);

  // ---------- Today ----------
  async function loadOverview(el) {
    const q = overviewDay ? `?date=${overviewDay}` : '';
    const d = await api('/api/staff/overview' + q);
    overviewDay = d.day;
    el.replaceChildren();

    const dateInput = h('input', { id: 'ov-date', type: 'date', value: d.day });
    dateInput.addEventListener('change', () => { overviewDay = dateInput.value; select('overview'); });
    el.append(h('div', { class: 'row no-print' },
      h('div', { class: 'field' }, h('label', { for: 'ov-date', text: 'Date' }), dateInput),
      h('div', { class: 'field' }, h('a', { class: 'btn secondary', href: '/print.html', text: 'Open summary report' }))));

    const st = d.status;
    el.append(h('div', { class: 'card' },
      h('h2', { text: 'Level for this day' }),
      h('div', { class: 'status-hero' },
        h('div', null, h('div', { class: 'tag', text: 'Suggested from reports' }), badge(d.suggested, LABELS.levelShort[d.suggested])),
        h('div', null, h('div', { class: 'tag', text: 'Confirmed by coordinator' }),
          st && st.confirmed_level ? badge(st.confirmed_level, LABELS.levelShort[st.confirmed_level]) : badge('pending', 'Not yet confirmed')),
        h('div', null, h('div', { class: 'tag', text: 'Official rain alert' }),
          h('span', { text: st ? `${LABELS.alert[st.official_alert]}${st.alert_ref ? ' · ' + st.alert_ref : ''}` : 'Not entered' }))),
      h('p', { class: 'small muted', text: `${d.totalReports} active report${d.totalReports === 1 ? '' : 's'}. A route counts only when at least ${cfg.severity.minStudents} different students report it. The suggestion never changes the public level by itself.` })));

    el.append(h('div', { class: 'card' }, h('h2', { text: 'Routes' }),
      d.routes.length
        ? table(['Route', 'Reports', 'Students', 'Score', 'Level'],
            d.routes.map(r => [r.route, String(r.reports), String(r.students), String(r.score), badge(r.level, LABELS.levelShort[r.level])]), { numCols: [1, 2, 3] })
        : h('p', { class: 'muted', text: 'No reports for this day.' })));

    if (role === 'coordinator') {
      const level = h('select', { id: 'cf-level' }, ['green', 'yellow', 'orange', 'red'].map(l => h('option', { value: l, text: LABELS.level[l] })));
      level.value = (st && st.confirmed_level) || d.suggested;
      const alert = h('select', { id: 'cf-alert' }, Object.keys(LABELS.alert).map(a => h('option', { value: a, text: LABELS.alert[a] })));
      alert.value = st ? st.official_alert : 'none';
      const ref = h('input', { id: 'cf-ref', maxlength: '200', value: (st && st.alert_ref) || '' });
      const note = h('input', { id: 'cf-note', maxlength: '300', value: (st && st.note) || '' });
      const msg = h('div');
      const form = h('form', { novalidate: true },
        h('div', { class: 'form-grid' },
          field('Confirmed level', level),
          field('Official rain alert', alert, 'From IMD Chennai or Greater Chennai Corporation.'),
          field('Alert reference', ref, 'Issuing body and time. Required when an alert is set.'),
          field('Note shown to students (optional)', note)),
        msg, h('button', { class: 'btn', type: 'submit', text: 'Confirm level' }));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try {
          await api('/api/staff/day', { method: 'POST', body: { day: d.day, level: level.value, official_alert: alert.value, alert_ref: ref.value, note: note.value } });
          await select('overview');
        } catch (e) { showMsg(msg, 'error', e.message); }
      });
      el.append(h('div', { class: 'card' }, h('h2', { text: 'Confirm the level' }),
        h('p', { class: 'small muted', text: 'Orange and Red need an official rain alert. Leave and attendance decisions stay with the principal; post them from the Notices tab.' }), form));
    }
  }

  // ---------- Reports (coordinator) ----------
  async function loadReports(el) {
    const d = await api('/api/staff/overview' + (overviewDay ? `?date=${overviewDay}` : ''));
    overviewDay = d.day;
    el.replaceChildren(h('h2', { text: `Reports for ${fmtDate(d.day)}` }),
      h('p', { class: 'small muted', text: 'Remove a report that looks false or duplicated. Every removal needs a reason and is logged. Student identity is visible only to you.' }));
    if (!d.reports.length) { el.append(h('p', { class: 'muted', text: 'No reports for this day.' })); return; }
    const rows = d.reports.map(r => {
      const actionCell = h('div');
      const renderBtn = () => {
        actionCell.replaceChildren(r.status === 'removed'
          ? h('span', { class: 'small muted', text: `Removed: ${r.removed_reason}` })
          : h('button', { class: 'btn small danger', type: 'button', text: 'Remove', onclick: askReason }));
      };
      const askReason = () => {
        const reason = h('input', { 'aria-label': 'Reason for removal', maxlength: '200', placeholder: 'Reason' });
        const err = h('div', { class: 'small' });
        actionCell.replaceChildren(reason, err,
          h('button', { class: 'btn small danger', type: 'button', text: 'Confirm removal', onclick: async () => {
            try { await api(`/api/staff/reports/${r.id}/remove`, { method: 'POST', body: { reason: reason.value } }); await select('reports'); }
            catch (e) { err.textContent = e.message; }
          } }),
          h('button', { class: 'btn small secondary', type: 'button', text: 'Cancel', onclick: renderBtn }));
      };
      renderBtn();
      return [
        fmtTime(r.created_at),
        h('div', null, h('strong', { text: r.name }), h('div', { class: 'small muted', text: `${r.register_no} · ${r.department || '-'} year ${r.year || '-'}` })),
        r.area || '-', r.route, LABELS.issue[r.issue] || r.issue, LABELS.mode[r.mode] || r.mode,
        r.has_photo ? h('div', null,
          h('a', { href: `/api/staff/photo/${r.id}`, target: '_blank', rel: 'noopener', text: 'View photo' }),
          h('div', { class: 'small', text: PHOTO_LABEL[r.photo_status] || 'Not checked' }),
          r.photo_lat != null ? h('div', { class: 'small muted', text: `Location ${r.photo_lat}, ${r.photo_lon}` }) : null,
          r.photo_notes ? h('div', { class: 'small muted', text: r.photo_notes }) : null) : 'None',
        r.note || '', actionCell
      ];
    });
    el.append(table(['Time', 'Student', 'Home area', 'Route', 'Issue', 'Mode', 'Photo', 'Details', 'Action'], rows));
  }

  // ---------- Areas ----------
  async function loadAreas(el) {
    let days = Number(el.dataset.days || 30);
    const sel = h('select', { id: 'ar-days' }, [7, 14, 30, 60, 90].map(n => h('option', { value: n, text: `Last ${n} days` })));
    sel.value = String(days);
    sel.addEventListener('change', () => { el.dataset.days = sel.value; select('areas'); });
    const d = await api(`/api/staff/areas?days=${days}`);
    el.replaceChildren(
      h('div', { class: 'row no-print' }, h('div', { class: 'field' }, h('label', { for: 'ar-days', text: 'Period' }), sel)),
      h('p', { class: 'small muted', text: `Share of students = students in the area ÷ all ${d.totalStudents} registered students × 100. Report rate = reports from the area ÷ students in the area × 100. High priority: share of at least ${d.thresholds.shareHigh}% and report rate of at least ${d.thresholds.rateHigh}. Watch: either one. The college sets these thresholds.` }));
    if (!d.areas.length) { el.append(h('p', { class: 'muted', text: 'No students registered yet.' })); return; }
    const maxShare = Math.max(1, ...d.areas.map(a => a.share)); // bars are scaled to the largest area
    el.append(table(['Area', 'Students', 'Share of students', 'Reports', 'Report rate', 'Class'],
      d.areas.map(a => [
        a.area, String(a.students),
        h('div', { class: 'row' },
          h('div', { class: 'bar-track', 'aria-hidden': 'true' }, (() => { const f = h('div', { class: 'bar-fill' }); f.style.width = `${(a.share / maxShare) * 100}%`; return f; })()),
          h('span', { text: `${a.share}%` })),
        String(a.reports), String(a.rate), badge(a.class, LABELS.cls[a.class])
      ]), { numCols: [1, 3, 4] }));
  }

  // ---------- Notices ----------
  async function loadNotices(el) {
    const { announcements } = await api('/api/staff/announcements');
    el.replaceChildren();
    const kinds = role === 'transport' ? ['transport'] : ['advisory', 'transport', 'attendance', 'leave_online'];
    const kind = h('select', { id: 'nt-kind' }, kinds.map(k => h('option', { value: k, text: LABELS.kind[k] })));
    const title = h('input', { id: 'nt-title', maxlength: '120' });
    const body = h('textarea', { id: 'nt-body', maxlength: '1500' });
    const msg = h('div');
    const form = h('form', { novalidate: true }, field('Type', kind, role === 'coordinator' ? 'Attendance and leave notices are sent to the principal for approval before they are public.' : ''),
      field('Title', title), field('Message', body), msg, h('button', { class: 'btn', type: 'submit', text: role === 'principal' ? 'Publish notice' : 'Submit notice' }));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await api('/api/staff/announcements', { method: 'POST', body: { kind: kind.value, title: title.value, body: body.value } });
        await select('notices');
        panels.notices.prepend(h('div', { class: 'msg ok', text: r.status === 'pending' ? 'Sent to the principal for approval.' : 'Notice published.' }));
      } catch (e) { showMsg(msg, 'error', e.message); }
    });
    el.append(h('div', { class: 'card' }, h('h2', { text: 'New notice' }), form));

    el.append(h('div', { class: 'card' }, h('h2', { text: 'Recent notices' }),
      announcements.length ? h('ul', { class: 'plain' }, announcements.map(a => h('li', null,
        h('div', { class: 'tag', text: `${LABELS.kind[a.kind]} · ${fmtDate(a.day)} · by ${a.author}` }),
        h('h3', null, a.title, ' ', badge(a.status === 'published' ? 'green' : a.status === 'pending' ? 'pending' : 'red', a.status === 'published' ? 'Published' : a.status === 'pending' ? 'Waiting for principal' : 'Rejected')),
        h('p', { text: a.body }),
        role === 'principal' && a.status === 'pending' ? h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', text: 'Approve and publish', onclick: () => decide(a.id, 'approve') }),
          h('button', { class: 'btn small secondary', type: 'button', text: 'Reject', onclick: () => decide(a.id, 'reject') })) : null)))
        : h('p', { class: 'muted', text: 'No notices yet.' })));
    async function decide(id, decision) {
      await api(`/api/staff/announcements/${id}/decision`, { method: 'POST', body: { decision } });
      select('notices');
    }
  }

  // ---------- Accounts and settings (admin) ----------
  async function loadAdmin(el) {
    const [users, settings] = await Promise.all([api('/api/admin/users'), api('/api/admin/settings')]);
    el.replaceChildren();

    // staff accounts
    const sName = h('input', { id: 'st-name', maxlength: '100' });
    const sEmail = h('input', { id: 'st-email', type: 'email' });
    const sRole = h('select', { id: 'st-role' }, ['coordinator', 'transport', 'principal', 'admin'].map(r => h('option', { value: r, text: LABELS.role[r] })));
    const sPass = h('input', { id: 'st-pass', type: 'password', autocomplete: 'new-password' });
    const sMsg = h('div');
    const sForm = h('form', { novalidate: true }, h('div', { class: 'form-grid' },
      field('Name', sName), field('Email', sEmail), field('Role', sRole), field('Temporary password', sPass, 'At least 10 characters. Share it privately and ask the person to keep it safe.')),
      sMsg, h('button', { class: 'btn', type: 'submit', text: 'Create account' }));
    sForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try { await api('/api/admin/staff', { method: 'POST', body: { name: sName.value, email: sEmail.value, role: sRole.value, password: sPass.value } }); await select('admin'); }
      catch (e) { showMsg(sMsg, 'error', e.message); }
    });
    el.append(h('div', { class: 'card' }, h('h2', { text: 'Staff accounts' }),
      h('p', { class: 'small muted', text: 'The principal nominates the coordinator and transport in-charge. Create their accounts here.' }),
      table(['Name', 'Email', 'Role', 'Status', ''], users.staff.map(s => [
        s.name, s.email, LABELS.role[s.role], s.active ? 'Active' : 'Deactivated',
        s.email === user.email ? '' : h('button', { class: 'btn small secondary', type: 'button', text: s.active ? 'Deactivate' : 'Activate',
          onclick: async () => { await api(`/api/admin/staff/${s.id}/active`, { method: 'POST', body: { active: !s.active } }); select('admin'); } })])),
      h('h3', { text: 'Add an account' }), sForm));

    // roster
    const csv = h('textarea', { id: 'ro-csv', placeholder: 'REGISTER_NO,email,Name' });
    const rMsg = h('div');
    const rForm = h('form', { novalidate: true }, field('Student roster', csv, 'One student per line: register number, college email, name. Importing again updates existing rows.'),
      rMsg, h('button', { class: 'btn', type: 'submit', text: 'Import roster' }));
    rForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await api('/api/admin/roster', { method: 'POST', body: { csv: csv.value } });
        showMsg(rMsg, 'ok', `Imported ${r.imported} students.${r.skipped.length ? ` Skipped ${r.skipped.length} invalid line(s).` : ''}`);
        csv.value = '';
      } catch (e) { showMsg(rMsg, 'error', e.message); }
    });
    el.append(h('div', { class: 'card' }, h('h2', { text: 'Student roster' }),
      h('p', { text: `${users.roster} students on the roster, ${users.students} registered.` }),
      h('p', { class: 'small muted', text: 'Students can register only if their register number and college email match this roster. Until a roster is imported, registration stays closed.' }), rForm));

    // settings
    const areas = h('textarea', { id: 'se-areas' }); areas.value = settings.areas.join('\n');
    const num = (id, v) => h('input', { id, type: 'number', step: 'any', value: String(v) });
    const sv = settings.severity, ac = settings.areaClass;
    const f = { min: num('se-min', sv.minStudents), y: num('se-y', sv.yellow), o: num('se-o', sv.orange), r: num('se-r', sv.red),
      pw: num('se-pw', sv.photoWeight), sw: num('se-sw', sv.seriousWeight), sh: num('se-sh', ac.shareHigh), rh: num('se-rh', ac.rateHigh) };
    const seMsg = h('div');
    const seForm = h('form', { novalidate: true },
      field('Areas and routes (one per line)', areas, 'Used for home area, route choices and area counts. Starting list: the college should correct it.'),
      h('h3', { text: 'Severity thresholds' }),
      h('div', { class: 'form-grid' },
        field('Different students needed on a route', f.min), field('Yellow score from', f.y), field('Orange score from', f.o), field('Red score from', f.r),
        field('Photo report weight', f.pw), field('Accident or near-miss weight', f.sw)),
      h('h3', { text: 'Area classes' }),
      h('div', { class: 'form-grid' }, field('High share of students from (%)', f.sh), field('High report rate from (per 100 students)', f.rh)),
      seMsg, h('button', { class: 'btn', type: 'submit', text: 'Save settings' }));
    seForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('/api/admin/settings', { method: 'POST', body: {
          areas: areas.value.split('\n'),
          severity: { minStudents: f.min.value, yellow: f.y.value, orange: f.o.value, red: f.r.value, photoWeight: f.pw.value, seriousWeight: f.sw.value },
          areaClass: { shareHigh: f.sh.value, rateHigh: f.rh.value } } });
        showMsg(seMsg, 'ok', 'Settings saved.');
      } catch (e) { showMsg(seMsg, 'error', e.message); }
    });
    el.append(h('div', { class: 'card' }, h('h2', { text: 'Settings' }), seForm));
  }

  // ---------- Audit ----------
  async function loadAudit(el) {
    const { log } = await api('/api/admin/audit');
    el.replaceChildren(h('h2', { text: 'Audit log' }), h('p', { class: 'small muted', text: 'The 200 most recent actions: sign-ins, level confirmations, removals, notices and account changes.' }),
      table(['Time', 'Who', 'Action', 'Detail'], log.map(l => [`${fmtDate(l.created_at)} ${fmtTime(l.created_at)}`, l.actor ? `${l.actor} (${LABELS.role[l.actor_role]})` : 'Unknown', l.action, l.detail || ''])));
  }

  const first = location.hash.slice(1);
  select(keys.includes(first) ? first : keys[0]);
})();
