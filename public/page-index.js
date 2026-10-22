'use strict';
(async function () {
  await renderHeader('home');
  const when = (a) => `${fmtDate(a.day)}, ${fmtTime(a.created_at)}`;
  const fill = (sel, list, empty) => {
    const box = $(sel);
    if (!list.length) { box.append(h('p', { class: 'empty', text: empty })); return; }
    list.forEach(a => box.append(h('div', { class: 'sched-item' },
      h('strong', { text: a.title }), h('p', { text: a.body }), h('span', { class: 'when', text: when(a) }))));
  };
  try {
    const s = await api('/api/public/status');
    $('#today').textContent = new Date(s.day + 'T00:00:00').toLocaleDateString('en-IN',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const by = (...kinds) => s.announcements.filter(a => kinds.includes(a.kind));
    fill('#s-online', by('leave_online', 'attendance'), 'No online classes or leave announced.');
    fill('#s-transport', by('transport'), 'No extra buses or route changes announced.');
    fill('#s-advisory', by('advisory'), 'No safety advisory at the moment.');

    const notices = $('#notices');
    if (!s.announcements.length) {
      notices.append(h('p', { class: 'empty', text: 'No notices at the moment.' }));
    } else {
      notices.append(h('ul', { class: 'notice-list' }, s.announcements.map(a => h('li', { class: 'notice' },
        h('span', { class: 'chip', text: LABELS.kind[a.kind] }),
        h('h3', { text: a.title }),
        h('p', { text: a.body }),
        h('span', { class: 'when', text: when(a) })))));
    }
  } catch (e) {
    $('#notices').append(h('p', { class: 'empty', text: 'The notices could not be loaded. Please refresh the page.' }));
  }
})();
