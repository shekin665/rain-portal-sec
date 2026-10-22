'use strict';
(async function () {
  const user = await requireRole('account', null);
  if (!user) return;
  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('#msg');
    if ($('#next').value !== $('#again').value) { showMsg(msg, 'error', 'The two new passwords do not match.'); return; }
    const btn = $('button[type=submit]'); btn.disabled = true;
    try {
      await api('/api/password', { method: 'POST', body: { current: $('#current').value, next: $('#next').value } });
      $('#form').reset();
      showMsg(msg, 'ok', 'Password changed.');
    } catch (e) { showMsg(msg, 'error', e.message); }
    btn.disabled = false;
  });
})();
