'use strict';
// Test chat: drives the same session API the WhatsApp flow uses, through the signed-in portal session.
(() => {
  const el = id => document.getElementById(id);
  const log = el('chat-log');
  let chat = null; // { sessionId, stage, token, bookingKey, bookingId }
  let busy = false;

  async function call(path, body, headers = {}) {
    const response = await fetch(`/v1/admin/chat${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 401) { location.replace('/login'); throw new Error('Session expired. Please sign in again.'); }
    const result = await response.json().catch(() => ({ message: 'Unexpected server response.' }));
    if (!response.ok && response.status !== 409) { const error = new Error(result.message || 'Request failed.'); error.result = result; throw error; }
    return result;
  }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function say(role, text, { buttons = [], raw, error = false, link } = {}) {
    const bubble = document.createElement('div'); bubble.className = `bubble ${role}${error ? ' error' : ''}`;
    const body = document.createElement('p'); body.textContent = text; bubble.append(body);
    if (link) { const a = document.createElement('a'); a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = link; bubble.append(a); }
    if (buttons.length) {
      const list = document.createElement('div'); list.className = 'choices';
      for (const b of buttons) {
        const button = document.createElement('button'); button.type = 'button';
        const title = document.createElement('strong'); title.textContent = b.label; button.append(title);
        if (b.sub) { const sub = document.createElement('span'); sub.textContent = b.sub; button.append(sub); }
        button.addEventListener('click', () => { if (busy) return; list.querySelectorAll('button').forEach(x => { x.disabled = true; }); button.classList.add('picked'); say('user', b.label); run(b.action); });
        list.append(button);
      }
      bubble.append(list);
    }
    if (raw) {
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'API response';
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(raw, null, 2); details.append(summary, pre); bubble.append(details);
    }
    log.append(bubble); scroll();
  }
  async function run(work) {
    busy = true; el('chat-form').querySelector('button').disabled = true;
    const typing = document.createElement('div'); typing.className = 'bubble bot typing'; typing.textContent = '…'; log.append(typing); scroll();
    try { await work(); }
    catch (error) { say('bot', error.message || 'Something went wrong.', { error: true, raw: error.result }); }
    finally { typing.remove(); busy = false; el('chat-form').querySelector('button').disabled = false; el('chat-text').focus(); }
  }

  async function understand(text) {
    const result = await call(`/sessions/${chat.sessionId}/interpret`, { text });
    say('bot', result.message, { raw: result });
    if (result.status === 'resolved') await times(0);
    else chat.stage = 'date';
  }
  async function times(page) {
    const result = await call(`/sessions/${chat.sessionId}/availability`, { page });
    if (result.status === 'slots_available') {
      chat.stage = 'slots';
      const buttons = result.data.slots.map(slot => slot.id === '__next__'
        ? { label: slot.title, sub: slot.description, action: () => times(result.data.nextPage) }
        : { label: slot.title, sub: slot.description, action: () => pick(slot.choice) });
      say('bot', `Pick a time (page ${result.data.pageNumber}, ${result.data.totalSlots} free). These aren't reserved until you confirm.`, { buttons, raw: result });
    } else {
      chat.stage = 'date';
      const buttons = (result.data?.suggestions ?? []).map(day => ({ label: day.title, sub: day.description, action: () => understand(day.date) }));
      say('bot', result.message, { buttons, raw: result });
    }
  }
  async function pick(choice) {
    const result = await call(`/sessions/${chat.sessionId}/select`, { selection: choice });
    if (result.status !== 'awaiting_confirmation') { say('bot', result.message, { error: true, raw: result }); return; }
    chat.stage = 'confirm'; chat.token = result.data.confirmationToken; chat.bookingKey = `chat-${crypto.randomUUID()}`;
    say('bot', result.message, { raw: result, buttons: [{ label: 'Confirm', action: confirm }, { label: 'Pick another time', action: () => times(0) }] });
  }
  async function confirm() {
    let result = await call(`/sessions/${chat.sessionId}/book`, { confirmed: true, confirmationToken: chat.token }, { 'Idempotency-Key': chat.bookingKey });
    // Creating the event and Meet link can take a few seconds; poll the booking until it settles.
    for (let i = 0; i < 15 && ['creating', 'reconciling', 'meet_pending'].includes(result.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      result = await call(`/bookings/${encodeURIComponent(result.data.bookingId)}`);
    }
    chat.bookingId = result.data?.bookingId;
    if (result.status === 'confirmed') {
      chat.stage = 'booked';
      say('bot', result.message, { raw: result, link: result.data.meetUrl, buttons: [{ label: 'Cancel this test booking', action: cancel }] });
    } else if (result.data?.canReselect) {
      say('bot', result.message, { error: true, raw: result }); await times(0);
    } else say('bot', result.message || `Booking status: ${result.status}`, { error: result.status === 'failed', raw: result });
  }
  async function cancel() {
    const result = await call(`/bookings/${encodeURIComponent(chat.bookingId)}/cancel`, {});
    say('bot', result.message || `Booking ${result.status}.`, { raw: result });
  }

  el('chat-setup').addEventListener('submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(el('chat-setup')));
    log.replaceChildren(); el('chat-setup').hidden = true; el('chat').hidden = false;
    el('chat-who').textContent = `${values.name} · ${values.phone} · ${values.meetingType}`;
    run(async () => {
      const result = await call('/sessions', { customerRef: values.phone, name: values.name, email: values.email, meetingType: values.meetingType });
      chat = { sessionId: result.sessionId, stage: 'date' };
      const zone = result.data.timezoneSource === 'phone_country' ? `from the ${result.data.countryCode} number` : 'default';
      say('bot', `${result.message}\n(Timezone ${result.data.timezone}, ${zone}.)`, { raw: result });
    });
  });
  el('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = el('chat-text').value.trim();
    if (!text || busy || !chat) return;
    el('chat-text').value = ''; say('user', text);
    if (chat.stage === 'booked') { say('bot', 'This chat already has a booking. Start a new chat to book again.'); return; }
    if (chat.stage === 'confirm' && /^(confirm|yes|ok)$/i.test(text)) return run(confirm);
    if (chat.stage === 'slots' && /^\d{1,2}$/.test(text)) return run(() => pick(text));
    run(() => understand(text));
  });
  el('chat-reset').addEventListener('click', () => { chat = null; log.replaceChildren(); el('chat').hidden = true; el('chat-setup').hidden = false; });
})();
