'use strict';
(async function () {
  $('#login-logo').append(logoSlot());
  const user = await renderHeader('staffregister');
  if (user) { location.href = user.role === 'student' ? '/student.html' : '/staff.html'; return; }
  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('button[type=submit]'); btn.disabled = true;
    try {
      await api('/api/register-staff', { method: 'POST', body: {
        name: $('#name').value, email: $('#email').value, department: $('#department').value, password: $('#password').value } });
      location.href = '/staff.html';
    } catch (e) {
      showMsg($('#msg'), 'error', e.message);
      btn.disabled = false;
    }
  });
})();
