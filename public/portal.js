'use strict';
const $ = id => document.getElementById(id);
let settingsVersion = 0, settingsValues = null, filter = { day: 'today' }, page = 1, querySequence = 0, dirty = false, scheduleTimezone = '';
let bookingDraft = null, bookingRequest = false;
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = !message; }
// The session cookie is HttpOnly; a 401 means it expired or was signed out elsewhere.
function toLogin() { location.replace('/login'); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (response.status === 401) { toLogin(); throw new Error('Session expired. Please sign in again.'); }
  const body = await response.json();
  if (!response.ok) { const error = new Error(body.message || 'Request failed. Please retry.'); error.response = body; throw error; }
  return body;
}
async function action(button, work) { button.disabled = true; try { await work(); } catch (e) { notice(e.message || 'Unable to complete the request.', true); } finally { button.disabled = false; } }
function showTab(tab) {
  for (const name of ['schedule', 'booking', 'settings', 'chat']) { $(`${name}-panel`).hidden = name !== tab; const b = $(`${name}-tab`); b.classList.toggle('active', name === tab); if (name === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
}
function fillSettings(data) {
  settingsVersion = data.version; settingsValues = data.values;
  if (!$('booking-form').elements.timezone.value) $('booking-form').elements.timezone.value = data.values.DEFAULT_TIMEZONE;
  for (const [name, value] of Object.entries(data.values)) {
    if (name === 'WORKING_DAYS') document.querySelectorAll('[name="WORKING_DAYS"]').forEach(input => { input.checked = value.includes(Number(input.value)); });
    else $('settings-form').elements.namedItem(name).value = value;
  }
  $('settings-source').textContent = data.source === 'database' ? `Saved in database · revision ${data.version}` : 'Using server defaults. Save to store these settings in the database.';
  dirty = false;
}
async function loadSettings() { fillSettings((await api('/v1/admin/settings')).data); }
async function loadGoogle() {
  const { status } = await api('/v1/google/status');
  $('google-status').textContent = status === 'connected' ? '● Google connected' : status === 'reconnect_required' ? '● Reconnect Google' : '○ Google not connected';
  $('google-status').className = `badge ${status}`;
  $('connect').textContent = status === 'not_connected' ? 'Connect Google' : 'Reconnect Google';
}
function cell(row, text, detail) {
  const td = document.createElement('td'); td.textContent = text;
  if (detail) { const small = document.createElement('small'); small.textContent = detail; td.append(small); }
  row.append(td); return td;
}
async function loadSchedule() {
  const sequence = ++querySequence;
  $('date-heading').textContent = 'Loading schedule…'; $('bookings').replaceChildren(); $('meeting-count').textContent = '';
  $('blocks').replaceChildren(); $('block-count').textContent = ''; $('no-blocks').hidden = true;
  $('empty').hidden = true; $('pagination').hidden = true; $('table-wrap').hidden = true;
  try {
    const query = new URLSearchParams({ ...filter, page: String(page) });
    const { data } = await api(`/v1/admin/schedule?${query}`);
    if (sequence !== querySequence) return;
    $('schedule-date').value = data.date; $('timezone').textContent = data.timezone;
    if (!$('booking-form').elements.date.value) $('booking-form').elements.date.value = data.date;
    scheduleTimezone = data.timezone; $('block-date').value = data.date; $('block-timezone').textContent = `Times use ${data.timezone}. To block hours across midnight, add a block for each date.`;
    $('date-heading').textContent = new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${data.date}T12:00:00Z`));
    $('meeting-count').textContent = `${data.total} ${data.total === 1 ? 'booking' : 'bookings'}`;
    for (const name of ['today', 'tomorrow']) { $(name).classList.toggle('active', filter.day === name); $(name).setAttribute('aria-pressed', String(filter.day === name)); }
    const format = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: data.timezone });
    $('block-count').textContent = `${data.blocks.length} ${data.blocks.length === 1 ? 'block' : 'blocks'}`;
    $('no-blocks').hidden = data.blocks.length !== 0;
    for (const block of data.blocks) {
      const item = document.createElement('li'); const details = document.createElement('div'); const title = document.createElement('strong');
      title.textContent = `${format.format(new Date(block.start))} – ${format.format(new Date(block.end))}`;
      const reason = document.createElement('span'); reason.textContent = block.reason || 'Unavailable'; details.append(title, reason);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove block';
      remove.addEventListener('click', () => action(remove, async () => {
        if (!confirm('Remove this block and make these hours available again?')) return;
        await api(`/v1/admin/blocks/${encodeURIComponent(block._id)}`, { method: 'DELETE' }); notice('Blocked hours removed.'); await loadSchedule();
      }));
      item.append(details, remove); $('blocks').append(item);
    }
    for (const booking of data.bookings) {
      const row = document.createElement('tr');
      cell(row, `${format.format(new Date(booking.start))} – ${format.format(new Date(booking.end))}`);
      cell(row, booking.name, [booking.email, booking.phone].filter(Boolean).join(' · '));
      cell(row, booking.meetingType === 'support' ? 'Support call' : 'Onboarding');
      const status = cell(row, ''); const badge = document.createElement('span'); badge.className = `badge ${booking.status}`; badge.textContent = booking.status.replaceAll('_', ' '); status.append(badge);
      if (booking.errorCode) { const detail = document.createElement('small'); detail.textContent = booking.errorCode.replaceAll('_', ' '); status.append(detail); }
      if (booking.source === 'admin') { const detail = document.createElement('small'); detail.textContent = booking.notification.status === 'not_configured' ? 'Custom flow: API not configured' : `Custom flow: ${booking.notification.status.replaceAll('_', ' ')}`; status.append(detail); }
      const join = cell(row, '—');
      if (booking.meetUrl && booking.status !== 'cancelled' && booking.status !== 'failed') {
        try { const url = new URL(booking.meetUrl); if (url.protocol === 'https:' && url.hostname === 'meet.google.com') { const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Join Meet ↗'; join.replaceChildren(link); } } catch { /* Ignore invalid provider links. */ }
      }
      const actions = cell(row, '');
      if (['confirmed', 'meet_pending', 'meet_failed'].includes(booking.status)) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary danger'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => action(cancel, async () => {
          if (!confirm(`Cancel the meeting with ${booking.name}? The Google Calendar event is deleted and attendees get a cancellation email.`)) return;
          const result = await api(`/v1/admin/bookings/${encodeURIComponent(booking._id)}/cancel`, { method: 'POST' });
          notice(result.status === 'cancelled' ? 'Meeting cancelled.' : 'Cancelling the meeting. Refresh in a moment.'); await loadSchedule();
        }));
        actions.append(cancel);
      }
      $('bookings').append(row);
    }
    $('empty').hidden = data.total !== 0; $('table-wrap').hidden = data.bookings.length === 0;
    $('pagination').hidden = data.total <= data.pageSize;
    $('previous').disabled = page <= 1; $('next').disabled = !data.hasMore;
    $('page-label').textContent = `Page ${page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
  } catch (error) { if (sequence === querySequence) $('date-heading').textContent = 'Schedule could not be loaded'; throw error; }
}
$('logout').addEventListener('click', () => action($('logout'), async () => {
  await fetch('/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }); toLogin();
}));
(async () => {
  try {
    await loadSettings();
    $('workspace').hidden = false; showTab('schedule');
    await Promise.all([loadGoogle(), loadSchedule()]);
  } catch (e) { notice(e.message || 'Unable to load the workspace.', true); }
})();
$('schedule-tab').addEventListener('click', () => showTab('schedule'));
$('settings-tab').addEventListener('click', () => showTab('settings'));
$('booking-tab').addEventListener('click', () => showTab('booking'));
$('chat-tab').addEventListener('click', () => showTab('chat'));
for (const day of ['today', 'tomorrow']) $(day).addEventListener('click', () => action($(day), async () => { filter = { day }; page = 1; notice(''); await loadSchedule(); }));
$('schedule-date').addEventListener('change', () => { if ($('schedule-date').value) action($('refresh'), async () => { filter = { date: $('schedule-date').value }; page = 1; notice(''); await loadSchedule(); }); });
$('refresh').addEventListener('click', () => action($('refresh'), async () => { notice(''); await Promise.all([loadSchedule(), loadGoogle()]); }));
for (const [id, delta] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', async () => { page += delta; try { await loadSchedule(); } catch (e) { notice(e.message, true); } });
$('settings-form').addEventListener('input', () => { dirty = true; });
$('reload-settings').addEventListener('click', () => action($('reload-settings'), async () => { if (dirty && !confirm('Discard your unsaved settings?')) return; await loadSettings(); notice('Settings reloaded.'); }));
$('settings-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const form = new FormData($('settings-form')); const values = {};
    for (const name of Object.keys(settingsValues)) {
      values[name] = name === 'WORKING_DAYS' ? form.getAll(name).map(Number) : ['DEFAULT_TIMEZONE', 'WORK_START', 'WORK_END'].includes(name) ? String(form.get(name)).trim() : Number(form.get(name));
    }
    const data = (await api('/v1/admin/settings', { method: 'PUT', body: JSON.stringify({ version: settingsVersion, values }) })).data;
    fillSettings(data); notice('Settings saved. New availability checks will use these rules.'); await loadSchedule();
  });
});
$('connect').addEventListener('click', () => action($('connect'), async () => {
  const result = await api('/v1/google/connect', { method: 'POST' });
  const url = new URL(result.data.authorizationUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('Unexpected Google authorization URL.');
  $('authorize').href = url.href; $('authorize').hidden = false;
  notice('Open “Authorize Google”, finish the connection, then refresh this portal.');
}));
$('block-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    if (!scheduleTimezone) throw new Error('Load the schedule before blocking hours.');
    const form = new FormData($('block-form'));
    const body = { date: String(form.get('date')), startTime: String(form.get('startTime')), endTime: String(form.get('endTime')), reason: String(form.get('reason')).trim() || 'Unavailable', timezone: scheduleTimezone };
    const result = await api('/v1/admin/blocks', { method: 'POST', body: JSON.stringify(body) });
    filter = { date: body.date }; page = 1; notice(result.data.message); await loadSchedule();
  });
});
window.addEventListener('beforeunload', event => { if (dirty || bookingRequest || bookingDraft?.pending) { event.preventDefault(); event.returnValue = ''; } });

function resetBooking() {
  bookingDraft = null; bookingRequest = false;
  $('booking-form').reset(); $('booking-details').disabled = false;
  $('booking-options').hidden = true; $('booking-result').hidden = true;
  $('booking-slot').replaceChildren(); $('booking-slot').disabled = false;
  $('check-booking').hidden = true; $('new-booking').hidden = true; $('booking-meet').hidden = true;
  $('booking-confirm').disabled = false; $('booking-confirm').checked = false;
  $('find-slots').hidden = false; $('book-send').hidden = false; $('book-send').disabled = false; $('book-send').textContent = 'Book & send';
  if (settingsValues) $('booking-form').elements.timezone.value = settingsValues.DEFAULT_TIMEZONE;
  if ($('schedule-date').value) $('booking-form').elements.date.value = $('schedule-date').value;
}
function showBookingResult(result) {
  bookingDraft.bookingId = result.data.bookingId;
  const pending = ['creating', 'reconciling', 'meet_pending', 'cancelling'].includes(result.status);
  bookingDraft.pending = pending;
  $('booking-result').hidden = false; $('booking-result-title').textContent = result.status.replaceAll('_', ' ');
  $('booking-result-message').textContent = result.message;
  $('booking-notification').textContent = result.data.notification.message;
  $('booking-reference').textContent = `Booking reference: ${result.data.bookingId}`;
  $('check-booking').hidden = !pending; $('new-booking').hidden = pending;
  $('book-send').hidden = true; $('find-slots').hidden = true;
  $('booking-meet').hidden = true;
  if (result.data.meetUrl) { try { const url = new URL(result.data.meetUrl); if (url.protocol === 'https:' && url.hostname === 'meet.google.com') { $('booking-meet').href = url.href; $('booking-meet').hidden = false; } } catch {} }
}
$('booking-details').addEventListener('input', () => { if (!bookingRequest && !bookingDraft?.submitted) { bookingDraft = null; $('booking-options').hidden = true; $('booking-slot').replaceChildren(); $('booking-confirm').checked = false; } });
$('booking-slot').addEventListener('change', () => { $('booking-confirm').checked = false; });
$('booking-form').addEventListener('submit', event => {
  event.preventDefault();
  if (bookingRequest || bookingDraft?.submitted) return;
  action($('find-slots'), async () => {
    const form = new FormData($('booking-form'));
    const values = Object.fromEntries(['name', 'phone', 'email', 'meetingType', 'date', 'timezone'].map(name => [name, String(form.get(name)).trim()]));
    bookingRequest = true; $('booking-details').disabled = true; $('booking-options').hidden = true; $('booking-result').hidden = true;
    try {
      const result = await api('/v1/admin/booking-options', { method: 'POST', body: JSON.stringify(values) });
      bookingDraft = { sessionId: result.sessionId, key: `admin-${crypto.randomUUID()}`, date: values.date, submitted: false };
      $('booking-slot').replaceChildren(); $('booking-confirm').checked = false;
      for (const slot of result.data.slots) { const option = document.createElement('option'); option.value = slot.id; option.textContent = slot.label; $('booking-slot').append(option); }
      $('booking-options').hidden = !result.data.slots.length;
      notice(result.data.slots.length ? 'Choose a time and check the details before booking.' : result.message);
    } finally { bookingRequest = false; $('booking-details').disabled = false; }
  });
});
$('book-send').addEventListener('click', () => action($('book-send'), async () => {
  if (!bookingDraft || bookingRequest) return;
  if (!$('booking-confirm').checked) throw new Error('Check the customer details and selected time, then tick the confirmation box.');
  bookingRequest = true; bookingDraft.submitted = true; bookingDraft.pending = true; bookingDraft.slotId ||= $('booking-slot').value;
  $('booking-details').disabled = true; $('booking-slot').disabled = true; $('booking-confirm').disabled = true; $('find-slots').hidden = true;
  try {
    const result = await api('/v1/admin/bookings', { method: 'POST', headers: { 'Idempotency-Key': bookingDraft.key }, body: JSON.stringify({ sessionId: bookingDraft.sessionId, slotId: bookingDraft.slotId, confirmed: true }) });
    showBookingResult(result); notice('');
  } catch (error) {
    if (error.response?.data?.bookingId) showBookingResult(error.response);
    else if (['slot_expired', 'session_not_found', 'invalid_selection'].includes(error.response?.status)) {
      bookingDraft.pending = false;
      $('new-booking').hidden = false; $('booking-result').hidden = false; $('booking-result-title').textContent = 'Choose a new time'; $('booking-result-message').textContent = error.message; $('booking-notification').textContent = ''; $('booking-reference').textContent = ''; $('book-send').hidden = true;
    } else { $('book-send').textContent = 'Retry same booking'; notice('The result is not confirmed. Retry the same booking here to avoid duplicates.', true); throw error; }
  } finally { bookingRequest = false; }
}));
$('check-booking').addEventListener('click', () => action($('check-booking'), async () => {
  if (bookingDraft?.bookingId) showBookingResult(await api(`/v1/admin/bookings/${encodeURIComponent(bookingDraft.bookingId)}`));
}));
$('new-booking').addEventListener('click', () => { resetBooking(); notice(''); });
