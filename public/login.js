'use strict';
const form = document.getElementById('login-form');
const error = document.getElementById('login-error');
// Already signed in: skip the form.
fetch('/v1/auth/session', { credentials: 'same-origin' }).then(r => { if (r.ok) location.replace('/portal'); }).catch(() => {});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true; error.hidden = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const response = await fetch('/v1/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    if (response.ok) return location.replace('/portal');
    const body = await response.json().catch(() => ({}));
    error.textContent = body.message || 'Sign-in failed. Please retry.'; error.hidden = false;
    form.password.value = ''; form.password.focus();
  } catch { error.textContent = 'Could not reach the server. Please retry.'; error.hidden = false; }
  finally { button.disabled = false; }
});
