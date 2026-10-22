'use strict';
(async function () {
  const user = await renderHeader('login');
  if (user) { location.href = user.role === 'student' ? '/student.html' : '/staff.html'; return; }
  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('button[type=submit]'); btn.disabled = true;
    try {
      const r = await api('/api/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
      location.href = r.user.role === 'student' ? '/student.html' : '/staff.html';
    } catch (e) {
      showMsg($('#msg'), 'error', e.message);
      btn.disabled = false;
    }
  });
})();
