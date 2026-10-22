'use strict';
(async function () {
  await renderHeader('home');

  const levels = $('#levels');
  levels.append(table(['Level', 'Meaning'],
    ['green', 'yellow', 'orange', 'red'].map(l => [badge(l, LABELS.levelShort[l]), LABELS.levelMeaning[l]])));

  try {
    const s = await api('/api/public/status');
    $('#today').textContent = new Date(s.day + 'T00:00:00').toLocaleDateString('en-IN',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const status = $('#status');
    if (s.confirmed) {
      status.append(
        h('div', { class: `big ${s.confirmed.level}`, text: LABELS.levelShort[s.confirmed.level] }),
        h('div', null,
          h('p', { text: LABELS.levelMeaning[s.confirmed.level] }),
          h('p', { class: 'muted small', text: `${LABELS.alert[s.confirmed.official_alert]}. Confirmed by the college coordinator at ${fmtTime(s.confirmed.updated_at)}.` }),
          s.confirmed.note ? h('p', { text: s.confirmed.note }) : null));
      if (s.routes.length) {
        $('#routes').append(h('h3', { text: 'Routes with reported difficulty' }),
          table(['Route', 'Level'], s.routes.map(r => [r.route, badge(r.level, LABELS.levelShort[r.level])])));
      }
    } else {
      status.append(
        h('div', { class: 'big pending', text: 'Awaiting review' }),
        h('p', { text: 'The coordinator has not confirmed a level yet. Check back, and follow any notice below.' }));
    }

    const notices = $('#notices');
    if (!s.announcements.length) {
      notices.append(h('p', { class: 'muted', text: 'No notices at the moment.' }));
    } else {
      notices.append(h('ul', { class: 'plain' }, s.announcements.map(a => h('li', null,
        h('div', { class: 'tag', text: `${LABELS.kind[a.kind]} · ${fmtDate(a.day)}` }),
        h('h3', { text: a.title }),
        h('p', { text: a.body })))));
    }
  } catch (e) {
    showMsg($('#status'), 'error', 'The status could not be loaded. Please refresh the page.');
  }
})();
