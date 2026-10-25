import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timezoneFromPhone } from '../src/timezones.js';

test('international WhatsApp numbers resolve to a primary country timezone', () => {
  assert.deepEqual(timezoneFromPhone('+919876543210'), { regionCode: 'IN', timezone: 'Asia/Kolkata' });
  assert.deepEqual(timezoneFromPhone('442071838750'), { regionCode: 'GB', timezone: 'Europe/London' });
  assert.deepEqual(timezoneFromPhone('+14155552671'), { regionCode: 'US', timezone: 'America/New_York' });
});

test('invalid or unsupported numbers return no inferred timezone', () => {
  assert.equal(timezoneFromPhone('not-a-phone'), null);
  assert.equal(timezoneFromPhone('+80012345678'), null);
});
