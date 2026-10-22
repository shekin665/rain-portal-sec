'use strict';
(async function () {
  $('#login-logo').append(logoSlot());
  const user = await renderHeader('register');
  if (user) { location.href = user.role === 'student' ? '/student.html' : '/staff.html'; return; }
  const cfg = await api('/api/config');
  selectOptions($('#area'), cfg.areas.map(a => ({ value: a, label: a })), 'Choose your area');
  selectOptions($('#travel_mode'), cfg.travelModes.map(m => ({ value: m, label: LABELS.mode[m] })), 'Choose');

  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('#msg');
    if (!$('#consent').checked) { showMsg(msg, 'error', 'Please tick the consent box to continue.'); return; }
    const btn = $('button[type=submit]'); btn.disabled = true;
    const val = (id) => $('#' + id).value;
    try {
      await api('/api/register', {
        method: 'POST',
        body: {
          name: val('name'), register_no: val('register_no'), email: val('email'), mobile: val('mobile'),
          department: val('department'), year: val('year'), area: val('area'), pincode: val('pincode'),
          travel_mode: val('travel_mode'), password: val('password'), address: val('address')
        }
      });
      location.href = '/student.html';
    } catch (e) {
      showMsg(msg, 'error', e.message);
      btn.disabled = false;
    }
  });
})();
