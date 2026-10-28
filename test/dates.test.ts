import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateSlots, overlap, parseDayOfMonth, parseNumericDate, validateDate } from '../src/dates.js';
import { encrypt, decrypt, equalSecret } from '../src/crypto.js';
import { config } from './helpers.js';

test('numeric formats normalize and ambiguous day/month asks rather than guesses', () => {
  assert.equal(parseNumericDate('20-09-2026')?.date, '2026-09-20');
  assert.equal(parseNumericDate('20/06/26')?.date, '2026-06-20');
  assert.equal(parseNumericDate('20/6/2026')?.date, '2026-06-20');
  assert.equal(parseNumericDate('2026-09-20')?.date, '2026-09-20');
  assert.equal(parseNumericDate('06/07/2026')?.status, 'needs_clarification');
  assert.equal(parseNumericDate('31/02/2026')?.status, 'invalid');
  assert.equal(parseNumericDate('29/02/2028')?.date, '2028-02-29');
  assert.equal(parseNumericDate('monday this month'), null);
});
test('date boundaries use the customer timezone and reject past/horizon/invalid dates', () => {
  const now = new Date('2026-09-16T20:00:00Z');
  assert.match(validateDate('2026-09-16', 'Asia/Kolkata', now, 60)!, /past/);
  assert.equal(validateDate('2026-09-16', 'America/New_York', now, 60), null);
  assert.match(validateDate('2027-09-20', 'Asia/Kolkata', now, 60)!, /60 days/);
  assert.match(validateDate('2026-02-30', 'Asia/Kolkata', now, 60)!, /does not exist/);
});
test('slots honor organizer hours, customer day, weekends, periods and notice', () => {
  const now = new Date('2026-09-16T00:00:00Z');
  const slots = candidateSlots(config, '2026-09-21', 'Asia/Kolkata', 'onboarding', 'morning', now);
  assert.equal(slots[0].start, '2026-09-21T03:30:00.000Z');
  assert.equal(slots[1].start, '2026-09-21T04:10:00.000Z');
  assert.equal(candidateSlots(config, '2026-09-20', 'Asia/Kolkata', 'support', 'any', now).length, 0);
  assert.ok(slots.every(s => new Date(s.start).getUTCHours() < 7));
  const late = candidateSlots(config, '2026-09-16', 'Asia/Kolkata', 'support', 'any', new Date('2026-09-16T11:45:00Z'));
  assert.equal(late.length, 0);
});
test('DST transition never offers an ambiguous customer wall time', () => {
  const c = { ...config, DEFAULT_TIMEZONE: 'America/New_York', WORK_START: '00:00', WORK_END: '04:00', WORKING_DAYS: [7], BUFFER_MINUTES: 0 };
  const slots = candidateSlots(c, '2026-11-01', 'America/New_York', 'support', 'any', new Date('2026-10-30T00:00:00Z'));
  assert.ok(slots.length > 0);
  assert.ok(slots.every(s => !s.label.includes('1:00 AM') && !s.label.includes('1:30 AM')));
});
test('busy overlaps include configured buffer but allow exact boundaries', () => {
  const a = { start: '2026-09-21T09:00:00Z', end: '2026-09-21T09:30:00Z' };
  assert.equal(overlap(a, { start: a.end, end: '2026-09-21T10:00:00Z' }), false);
  assert.equal(overlap(a, { start: a.end, end: '2026-09-21T10:00:00Z' }, 10), true);
});
test('token encryption detects tampering and does not expose credentials', () => {
  const token = encrypt({ refresh_token: 'secret' }, config.TOKEN_ENCRYPTION_KEY);
  assert.ok(!token.includes('secret'));
  assert.deepEqual(decrypt(token, config.TOKEN_ENCRYPTION_KEY), { refresh_token: 'secret' });
  const parts = token.split('.'); parts[2] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join('.'), config.TOKEN_ENCRYPTION_KEY));
  assert.equal(equalSecret('one', 'two'), false);
});

test('a bare day of the month is the next date with that day', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  assert.equal(parseDayOfMonth('30', 'Asia/Kolkata', now)?.date, '2026-10-30');
  assert.equal(parseDayOfMonth('30th', 'Asia/Kolkata', now)?.date, '2026-10-30');
  assert.equal(parseDayOfMonth('28', 'Asia/Kolkata', now)?.date, '2026-10-28');
  assert.equal(parseDayOfMonth('5', 'Asia/Kolkata', now)?.date, '2026-11-05');
  assert.equal(parseDayOfMonth('31', 'Asia/Kolkata', new Date('2026-11-02T12:00:00Z'))?.date, '2026-12-31');
  assert.equal(parseDayOfMonth('32', 'Asia/Kolkata', now), null);
  assert.equal(parseDayOfMonth('tomorrow', 'Asia/Kolkata', now), null);
});
