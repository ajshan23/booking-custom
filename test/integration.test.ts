import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { Store } from '../src/db.js';
import { BookingService } from '../src/service.js';
import { createApp } from '../src/app.js';
import { ApiError, type Booking, type CalendarProvider, type Connection, type DateInterpreter, type ProviderEvent } from '../src/types.js';
import { config } from './helpers.js';
import { DateTime } from 'luxon';

class FakeCalendar implements CalendarProvider {
  events = new Map<string, ProviderEvent & { start: string; end: string }>();
  created = 0; loseResponse = false; pendingMeet = false; failBusy = false; rejectCreate = false;
  async busy() { if (this.failBusy) throw new Error('unavailable'); return [...this.events.values()].filter(e => !e.cancelled); }
  async find(_c: Connection, id: string) { return this.events.get(id) ?? null; }
  async create(_c: Connection, b: Booking) {
    if (this.rejectCreate) throw Object.assign(new Error('rejected'), { response: { status: 403 } });
    if (this.events.has(b.eventId)) throw Object.assign(new Error('duplicate'), { response: { status: 409 } });
    this.created++;
    const event = { id: b.eventId, start: b.start, end: b.end, conferenceStatus: this.pendingMeet ? 'pending' as const : 'success' as const, ...(this.pendingMeet ? {} : { meetUrl: 'https://meet.google.com/abc-defg-hij' }) };
    this.events.set(b.eventId, event);
    if (this.loseResponse) throw new Error('response timed out');
    return event;
  }
  async cancel(_c: Connection, id: string) { const e = this.events.get(id); if (e) e.cancelled = true; }
}
let memory: MongoMemoryServer | undefined;
let client: MongoClient; let store: Store; let service: BookingService; let calendar: FakeCalendar; let clock: Date;
let interpreterCalls = 0;
const interpreter: DateInterpreter = { async interpret(text, _timezone, _now, history) {
  interpreterCalls++;
  if (text === 'monday this month') return { status: 'needs_clarification', date: null, period: 'any', question: 'Do you mean 21 September or 28 September?' };
  if (text === 'tuesday or wednesday after 4pm') return { status: 'resolved', date: '2026-09-22', dates: ['2026-09-22', '2026-09-23'], period: 'any', timeFrom: '16:00', timeTo: null, question: null };
  if (text === 'this week') return { status: 'resolved', date: '2026-09-14', range: { from: '2026-09-14', to: '2026-09-20' }, period: 'any', question: null };
  if (text === 'as soon as possible') return { status: 'resolved', date: null, earliest: true, period: 'any', question: null };
  if (text === 'saturday') return { status: 'resolved', date: '2026-09-19', dates: ['2026-09-19'], period: 'any', question: null };
  if (text === 'monday after 8pm') return { status: 'resolved', date: '2026-09-21', dates: ['2026-09-21'], period: 'any', timeFrom: '20:00', timeTo: null, question: null };
  assert.ok(history.length);
  return { status: 'resolved', date: '2026-09-21', period: 'afternoon', question: null };
} };
before(async () => {
  const uri = process.env.TEST_MONGODB_URI;
  if (!uri) memory = await MongoMemoryServer.create();
  client = await new MongoClient(uri ?? memory!.getUri()).connect();
  store = new Store(client.db(`customcalander_test_${process.pid}`));
  await store.init();
});
after(async () => { if (client) { await store.db.dropDatabase(); await client.close(); } await memory?.stop(); });
beforeEach(async () => {
  await Promise.all([store.sessions.deleteMany({}), store.bookings.deleteMany({}), store.connections.deleteMany({}), store.oauthStates.deleteMany({}), store.db.collection('schedule_settings').deleteMany({}), store.timeBlocks.deleteMany({}), store.db.collection('meeting_notifications').deleteMany({})]);
  clock = new Date('2026-09-16T00:00:00Z'); interpreterCalls = 0;
  await store.connections.insertOne({ _id: config.ORGANIZATION_ID, org: config.ORGANIZATION_ID, calendarId: 'primary', encryptedTokens: 'test', state: 'connected', activeBooking: null, updatedAt: clock });
  calendar = new FakeCalendar(); service = new BookingService(store, config, calendar, interpreter, () => clock);
});
async function ready() {
  const s = await service.createSession({ customerRef: 'customer-1', email: 'test@example.com', name: 'Test', timezone: 'Asia/Kolkata', meetingType: 'onboarding' });
  await service.interpret(s.sessionId, '2026-09-21');
  await service.availability(s.sessionId);
  const selected = await service.select(s.sessionId, '1');
  return { id: s.sessionId, token: selected.data.confirmationToken };
}
test('API auth, malformed emails, invalid JSON and explicit confirmation', async () => {
  const app = createApp(config, service, { async connectUrl() { return 'https://example.com'; }, async callback() {} });
  await request(app).post('/v1/sessions').send({}).expect(401);
  await request(app).post('/v1/google/connect').set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).expect(401);
  await request(app).post('/v1/sessions').set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).send({ customerRef: 'a', name: 'A', email: 'bad@' }).expect(422);
  await request(app).post('/v1/sessions').set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).set('Content-Type', 'application/json').send('{').expect(400);
  const s = await ready();
  await request(app).post(`/v1/sessions/${s.id}/book`).set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).set('Idempotency-Key', 'request-123').send({ confirmed: false, confirmationToken: s.token }).expect(422);
  assert.equal(calendar.created, 0);
});
test('session timezone is inferred from the WhatsApp number unless explicitly supplied', async () => {
  const india = await service.createSession({ customerRef: '+919876543210', email: 'india@example.com', name: 'India', meetingType: 'onboarding' });
  assert.equal(india.data.timezone, 'Asia/Kolkata'); assert.equal(india.data.timezoneSource, 'phone_country'); assert.equal(india.data.countryCode, 'IN');
  const override = await service.createSession({ customerRef: '+14155552671', email: 'west@example.com', name: 'West', timezone: 'America/Los_Angeles', meetingType: 'support' });
  assert.equal(override.data.timezone, 'America/Los_Angeles'); assert.equal(override.data.timezoneSource, 'provided');
  const fallback = await service.createSession({ customerRef: 'unknown-contact', email: 'fallback@example.com', name: 'Fallback', meetingType: 'support' });
  assert.equal(fallback.data.timezone, config.DEFAULT_TIMEZONE); assert.equal(fallback.data.timezoneSource, 'default');
});
test('numeric dates bypass OpenAI; clarification retains context', async () => {
  const s = await ready(); assert.equal(interpreterCalls, 0);
  const question = await service.interpret(s.id, 'monday this month');
  assert.equal(question.status, 'needs_clarification');
  await assert.rejects(service.availability(s.id), (e: ApiError) => e.code === 'date_required');
  const answer = await service.interpret(s.id, '21 September');
  assert.equal(answer.data.date, '2026-09-21'); assert.equal(interpreterCalls, 2);
});
test('booking retry returns the same event; changed key cannot duplicate the session', async () => {
  const s = await ready();
  const first = await service.book(s.id, 'same-key-123', s.token);
  const retry = await service.book(s.id, 'same-key-123', s.token);
  assert.equal(first.status, 'confirmed'); assert.equal(first.data.googleEventId, retry.data.googleEventId); assert.equal(calendar.created, 1);
  await assert.rejects(service.book(s.id, 'other-key-123', s.token), (e: ApiError) => e.code === 'booking_exists');
});
test('two concurrent customers cannot book the same interval', async () => {
  const a = await ready(); const b = await ready();
  const results = await Promise.all([service.book(a.id, 'customer-a', a.token), service.book(b.id, 'customer-b', b.token)]);
  await service.recover();
  const bookings = await store.bookings.find({}).toArray();
  assert.equal(bookings.filter(b => b.status === 'confirmed').length, 1);
  assert.equal(bookings.filter(b => b.errorCode === 'slot_unavailable').length, 1);
  assert.equal(calendar.created, 1); assert.equal(results.length, 2);
});
test('a lost Google response is reconciled by event ID without duplicate insertion', async () => {
  const s = await ready(); calendar.loseResponse = true;
  const first = await service.book(s.id, 'lost-response', s.token);
  assert.equal(first.status, 'reconciling');
  assert.ok((await service.connection()).activeBooking);
  const retry = await service.book(s.id, 'lost-response', s.token);
  assert.equal(retry.status, 'confirmed'); assert.equal(calendar.created, 1);
  assert.equal((await service.connection()).activeBooking, null);
});
test('a customer who loses a slot race can reuse the session to choose another date and time', async () => {
  const s = await ready();
  const selected = (await service.session(s.id)).selected!;
  calendar.events.set('other-customer', { id: 'other-customer', start: selected.start, end: selected.end, conferenceStatus: 'success', meetUrl: 'https://meet.google.com/other' });
  const result = await service.book(s.id, 'lost-slot-race', s.token);
  assert.equal(result.status, 'slot_unavailable'); assert.equal(result.data.canReselect, true);
  const reopened = await service.session(s.id);
  assert.equal(reopened.bookingId, undefined); assert.equal(reopened.selected, undefined); assert.equal(reopened.date, undefined); assert.deepEqual(reopened.slots, []);
  const interpreted = await service.interpret(s.id, '2026-09-22');
  assert.equal(interpreted.status, 'resolved');
  assert.equal((await service.availability(s.id)).status, 'slots_available');
  const reselected = await service.select(s.id, '1');
  const rebooked = await service.book(s.id, 'after-slot-race', reselected.data.confirmationToken);
  assert.equal(rebooked.status, 'confirmed'); assert.equal(calendar.created, 1);
  assert.notEqual(rebooked.data.bookingId, result.data.bookingId);
  assert.equal((await service.book(s.id, 'after-slot-race', reselected.data.confirmationToken)).status, 'confirmed');
  assert.equal(calendar.created, 1);
});
test('expired choices and stale confirmation tokens cannot create meetings', async () => {
  const s = await ready();
  await service.select(s.id, '2');
  await assert.rejects(service.book(s.id, 'stale-request', s.token), (e: ApiError) => e.code === 'confirmation_required');
  clock = new Date(clock.getTime() + 11 * 60000);
  await assert.rejects(service.select(s.id, '1'), (e: ApiError) => e.code === 'slot_expired');
  assert.equal(calendar.created, 0);
});
test('unavailable FreeBusy fails closed and reconnect-required blocks booking', async () => {
  const s = await ready(); calendar.failBusy = true;
  const response = await service.book(s.id, 'busy-error-123', s.token);
  assert.equal(response.status, 'creating'); assert.equal(calendar.created, 0);
  await store.connections.updateOne({ org: service.org }, { $set: { state: 'reconnect_required' } });
  await assert.rejects(service.connection(), (e: ApiError) => e.code === 'google_reconnect_required');
});
test('pending Meet link is polled without recreating the event; cancel is idempotent', async () => {
  const s = await ready(); calendar.pendingMeet = true;
  const result = await service.book(s.id, 'meet-pending', s.token);
  assert.equal(result.status, 'meet_pending'); assert.equal(result.data.meetUrl, null);
  const e = calendar.events.get(result.data.googleEventId)!;
  e.meetUrl = 'https://meet.google.com/abc-defg-hij'; e.conferenceStatus = 'success';
  assert.equal((await service.process(result.data.bookingId)).status, 'confirmed');
  assert.equal((await service.cancel(result.data.bookingId)).status, 'cancelled');
  assert.equal((await service.cancel(result.data.bookingId)).status, 'cancelled');
  assert.equal(calendar.created, 1);
});
test('definitive Google rejection releases organizer lock', async () => {
  const s = await ready(); calendar.rejectCreate = true;
  assert.equal((await service.book(s.id, 'reject-google', s.token)).status, 'failed');
  assert.equal((await service.connection()).activeBooking, null);
});
test('recovery materializes a frozen session and finishes booking', async () => {
  const s = await ready();
  await store.sessions.updateOne({ _id: s.id }, { $set: { bookingId: 'a'.repeat(64), idempotencyKey: 'recover-frozen' } });
  await service.recover();
  assert.equal((await store.bookings.findOne({ sessionId: s.id }))?.status, 'confirmed');
  assert.equal(calendar.created, 1);
});
test('a queued booking that becomes past fails without holding the organizer forever', async () => {
  const s = await ready(); calendar.failBusy = true;
  const result = await service.book(s.id, 'past-queued', s.token);
  assert.equal(result.status, 'creating');
  clock = new Date('2026-09-22T00:00:00Z'); calendar.failBusy = false;
  assert.equal((await service.process(result.data.bookingId)).status, 'failed');
  assert.equal((await service.connection()).activeBooking, null);
  assert.equal(calendar.created, 0);
});
test('uncertain insert with a new calendar conflict requires review instead of another write', async () => {
  const s = await ready(); calendar.loseResponse = true;
  const result = await service.book(s.id, 'review-conflict', s.token);
  const original = calendar.events.get(result.data.googleEventId)!;
  calendar.events.delete(result.data.googleEventId);
  calendar.events.set('external', { ...original, id: 'external' });
  const b = await service.process(result.data.bookingId);
  assert.equal(b.status, 'reconciling'); assert.equal(b.errorCode, 'reconciliation_needs_review');
  assert.equal(calendar.created, 1); assert.ok((await service.connection()).activeBooking);
});
test('the full HTTP contract supports booking, polling and cancellation', async () => {
  const app = createApp(config, service, { async connectUrl() { return 'https://example.com'; }, async callback() {} });
  const post = (path: string) => request(app).post(path).set('Authorization', `Bearer ${config.SERVICE_API_KEY}`);
  const session = await post('/v1/sessions').send({ customerRef: 'flowflex-contact', name: 'Arun', email: 'arun@example.com', timezone: 'Asia/Kolkata', meetingType: 'support' }).expect(201);
  const base = `/v1/sessions/${session.body.sessionId}`;
  await post(`${base}/interpret`).send({ text: '2026-09-21' }).expect(200);
  // The opt-in "Another day" row keeps the list within WhatsApp's ten rows.
  const withOtherDay = await post(`${base}/availability`).send({ page: 0, otherDay: 'Another day' }).expect(200);
  const otherRows = withOtherDay.body.data.slots.map((slot: { id: string }) => slot.id);
  assert.equal(otherRows.length, 10); assert.deepEqual(otherRows.slice(-2), ['__next__', '__date__']);
  assert.equal(withOtherDay.body.data.slots.at(-1).title, 'Another day');
  const otherSecond = await post(`${base}/availability`).send({ page: 1, otherDay: 'Another day' }).expect(200);
  assert.ok(!otherRows.includes(otherSecond.body.data.slots[0].id), 'page 2 continues after the 8 slots on page 1');
  assert.equal(otherSecond.body.data.slots.at(-1).id, '__date__');
  const firstPage = await post(`${base}/availability`).send({ page: 0 }).expect(200);
  assert.equal(firstPage.body.status, 'slots_available'); assert.match(firstPage.body.message, /page 1/);
  assert.equal(firstPage.body.data.page, 0); assert.equal(firstPage.body.data.hasMore, true);
  assert.equal(firstPage.body.data.slots.length, 10); assert.equal(firstPage.body.data.slots.at(-1).id, '__next__');
  const firstSlot = firstPage.body.data.slots[0];
  assert.ok(firstSlot.title.length <= 24);
  assert.ok(firstSlot.description.length <= 72);
  assert.match(firstSlot.description, /Asia\/Kolkata/);
  const secondPage = await post(`${base}/availability`).send({ page: 1 }).expect(200);
  assert.equal(secondPage.body.data.page, 1); assert.equal(secondPage.body.data.hasMore, false);
  assert.ok(secondPage.body.data.slots.length > 0); assert.ok(secondPage.body.data.slots.every((slot: { id: string }) => slot.id !== '__next__'));
  assert.equal(secondPage.body.data.totalSlots, firstPage.body.data.totalSlots);
  const selected = await post(`${base}/select`).send({ selection: secondPage.body.data.slots[0].id }).expect(200);
  const booked = await post(`${base}/book`).set('Idempotency-Key', 'http-booking-123').send({ confirmed: true, confirmationToken: selected.body.data.confirmationToken }).expect(200);
  assert.equal(booked.body.status, 'confirmed'); assert.ok(booked.body.data.meetUrl);
  await request(app).get(`/v1/bookings/${booked.body.data.bookingId}`).set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).expect(200);
  const cancelled = await post(`/v1/bookings/${booked.body.data.bookingId}/cancel`).expect(200);
  assert.equal(cancelled.body.status, 'cancelled'); assert.equal(calendar.created, 1);
});

test('portal assets are served but admin data rejects service keys and anonymous callers', async () => {
  const app = createApp(config, service, { async connectUrl() { return 'https://example.com'; }, async callback() {} });
  const html = await request(app).get('/').expect(200);
  assert.match(html.text, /href="\/login"/); assert.match(html.headers['content-security-policy'], /script-src 'self'/);
  assert.match((await request(app).get('/login').expect(200)).text, /id="password"/);
  assert.match((await request(app).get('/portal').expect(200)).text, /Scheduling workspace/);
  await request(app).get('/portal.js').expect(200);
  await request(app).get('/v1/admin/settings').expect(401);
  await request(app).get('/v1/admin/schedule').set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).expect(401);
  const settings = await request(app).get('/v1/admin/settings').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).expect(200);
  assert.equal(settings.body.data.source, 'environment');
  assert.ok(!JSON.stringify(settings.body).includes(config.GOOGLE_CLIENT_SECRET));
  assert.ok(!('SERVICE_API_KEY' in settings.body.data.values));
});
test('portal sign-in uses username and password and a session cookie', async () => {
  const app = createApp(config, service, { async connectUrl() { return 'https://example.com'; }, async callback() {} });
  await request(app).post('/v1/auth/login').send({ username: 'admin', password: 'wrong-password-123' }).expect(401);
  await request(app).post('/v1/auth/login').send({ username: 'someone', password: config.ADMIN_PASSWORD }).expect(401);
  await request(app).get('/v1/auth/session').expect(401);
  const login = await request(app).post('/v1/auth/login').send({ username: 'admin', password: config.ADMIN_PASSWORD }).expect(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  assert.ok(!(await service.store.adminSessions.findOne({ _id: cookie.split('=')[1] })), 'raw token must not be stored');
  await request(app).get('/v1/auth/session').set('Cookie', cookie).expect(200);
  await request(app).get('/v1/admin/settings').set('Cookie', cookie).expect(200);
  await request(app).get('/v1/google/status').set('Cookie', cookie).expect(200);
  await request(app).post('/v1/sessions').set('Cookie', cookie).send({}).expect(401);
  const chat = await request(app).post('/v1/admin/chat/sessions').set('Cookie', cookie).send({ customerRef: '+919876543210', name: 'Chat', email: 'chat@example.com' }).expect(201);
  assert.equal(chat.body.data.timezone, 'Asia/Kolkata');
  await request(app).post('/v1/admin/chat/sessions').set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).send({ customerRef: '+919876543210', name: 'Chat', email: 'chat@example.com' }).expect(401);
  await request(app).post('/v1/auth/logout').set('Cookie', cookie).expect(200);
  await request(app).get('/v1/admin/settings').set('Cookie', cookie).expect(401);
});
test('admin settings persist, reject stale revisions and cannot accept secrets', async () => {
  const app = createApp(config, service, { async connectUrl() { return 'https://example.com'; }, async callback() {} });
  const defaults = await service.settings.read();
  const values = { ...defaults.values, WORK_START: '11:00', DEFAULT_TIMEZONE: 'Europe/London' };
  const save = await request(app).put('/v1/admin/settings').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).send({ version: 0, values }).expect(200);
  assert.equal(save.body.data.version, 1);
  const restarted = new BookingService(store, config, calendar, interpreter, () => clock);
  assert.equal((await restarted.settings.config()).WORK_START, '11:00');
  await request(app).put('/v1/admin/settings').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).send({ version: 0, values }).expect(409);
  await request(app).put('/v1/admin/settings').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).send({ version: 1, values: { ...values, GOOGLE_CLIENT_SECRET: 'unwanted' } }).expect(422);
  await request(app).put('/v1/admin/settings').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).send({ version: 1, values: { ...values, WORK_END: '08:00' } }).expect(422);
  const session = await request(app).post('/v1/sessions').set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).send({ customerRef: 'new', name: 'New', email: 'new@example.com' }).expect(201);
  assert.equal(session.body.data.timezone, 'Europe/London');
});
test('changed settings change availability immediately and invalidate incompatible unbooked slots', async () => {
  const s = await ready();
  const settings = await service.settings.read();
  await service.settings.save({ ...settings.values, WORK_START: '12:00' }, settings.version);
  const booked = await service.book(s.id, 'new-hours-test', s.token);
  assert.equal(booked.status, 'slot_expired'); assert.equal(booked.data.canReselect, true); assert.equal(calendar.created, 0);
  const other = await ready();
  const latest = await service.session(other.id);
  assert.equal(latest.slots[0].start, '2026-09-21T06:30:00.000Z');
});
test('admin day filters use organizer timezone, include overlapping meetings and isolate organization', async () => {
  const s = await ready(); const b = await service.book(s.id, 'schedule-seed', s.token);
  // India today spans Sep 15 18:30Z through Sep 16 18:30Z at the injected clock.
  await store.bookings.updateOne({ _id: b.data.bookingId }, { $set: { start: '2026-09-16T18:00:00.000Z', end: '2026-09-16T19:00:00.000Z' } });
  const original = await service.booking(b.data.bookingId);
  await store.bookings.insertOne({ ...original, _id: 'other-org', org: 'other-org', sessionId: 'other', idempotencyKey: 'other' });
  assert.equal((await service.schedule(undefined, 'today', 1)).total, 1);
  assert.equal((await service.schedule(undefined, 'tomorrow', 1)).total, 1);
  assert.equal((await service.schedule('2026-09-18', undefined, 1)).total, 0);
  const app = createApp(config, service, { async connectUrl() { return 'https://example.com'; }, async callback() {} });
  await request(app).get('/v1/admin/schedule?date=2026-02-30').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).expect(422);
  await request(app).get('/v1/admin/schedule?date=2026-09-16&day=today').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).expect(422);
  const result = await request(app).get('/v1/admin/schedule?day=today').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).expect(200);
  assert.equal(result.body.data.timezone, 'Asia/Kolkata');
  assert.ok(!('idempotencyKey' in result.body.data.bookings[0]));
});
test('blocked hours remove slots and invalidate a previously confirmed selection before booking', async () => {
  const s = await ready();
  const block = await service.blockTime({ date: '2026-09-21', startTime: '09:00', endTime: '11:00', timezone: 'Asia/Kolkata', reason: 'Team meeting' });
  assert.equal(block.existingBookings, 0);
  assert.equal((await service.book(s.id, 'block-old-choice', s.token)).status, 'slot_unavailable');
  assert.equal(calendar.created, 0);
  const next = await ready();
  assert.equal((await service.session(next.id)).slots[0].start, '2026-09-21T05:30:00.000Z');
  const schedule = await service.schedule('2026-09-21', undefined, 1);
  assert.equal(schedule.blocks.length, 1); assert.equal(schedule.blocks[0].reason, 'Team meeting');
  await service.removeTimeBlock(block.id); await service.removeTimeBlock(block.id);
  const restored = await ready();
  assert.equal((await service.session(restored.id)).slots[0].start, '2026-09-21T03:30:00.000Z');
  assert.equal((await service.schedule('2026-09-21', undefined, 1)).blocks.length, 0);
  assert.ok((await store.timeBlocks.findOne({ _id: block.id }))?.removedAt);
});
test('blocking hours warns about existing meetings without cancelling them', async () => {
  const s = await ready(); const booking = await service.book(s.id, 'existing-booking', s.token);
  const block = await service.blockTime({ date: '2026-09-21', startTime: '09:00', endTime: '10:00', timezone: 'Asia/Kolkata', reason: 'Time off' });
  assert.equal(block.existingBookings, 1);
  assert.equal((await service.booking(booking.data.bookingId)).status, 'confirmed');
  assert.equal(calendar.events.get(booking.data.googleEventId)?.cancelled, undefined);
});
test('block admin APIs reject invalid ranges, past times and service-key access', async () => {
  const app = createApp(config, service, { async connectUrl() { return ''; }, async callback() {} });
  const body = { date: '2026-09-21', startTime: '13:00', endTime: '14:00', timezone: 'Asia/Kolkata', reason: 'Lunch' };
  await request(app).post('/v1/admin/blocks').set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).send(body).expect(401);
  const post = (v: object) => request(app).post('/v1/admin/blocks').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).send(v);
  await post({ ...body, endTime: '12:00' }).expect(422);
  await post({ ...body, date: '2026-02-30' }).expect(422);
  await post({ ...body, date: '2026-09-15' }).expect(422);
  await post({ ...body, timezone: 'Europe/London' }).expect(409);
  const result = await post(body).expect(201);
  await request(app).delete(`/v1/admin/blocks/${result.body.data.id}`).set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).expect(200);
});
test('block times reject DST gaps and repeated hours', async () => {
  const settings = await service.settings.read();
  await service.settings.save({ ...settings.values, DEFAULT_TIMEZONE: 'America/New_York' }, 0);
  clock = new Date('2026-03-01T00:00:00Z');
  await assert.rejects(service.blockTime({ date: '2026-03-08', startTime: '02:30', endTime: '04:00', timezone: 'America/New_York', reason: 'Gap' }), (e: ApiError) => e.code === 'invalid_time');
  await assert.rejects(service.blockTime({ date: '2026-11-01', startTime: '01:30', endTime: '03:00', timezone: 'America/New_York', reason: 'Repeated' }), (e: ApiError) => e.code === 'invalid_time');
});

test('admin booking saves phone and prepares one custom-flow payload without claiming delivery', async () => {
  const app = createApp(config, service, { async connectUrl() { return ''; }, async callback() {} });
  const post = (path: string) => request(app).post(path).set('Authorization', `Bearer ${config.ADMIN_API_KEY}`);
  const options = await post('/v1/admin/booking-options').send({ name: 'Arun', email: 'arun@example.com', phone: '+919876543210', date: '2026-09-21', timezone: 'Asia/Kolkata', meetingType: 'onboarding' }).expect(200);
  const body = { sessionId: options.body.sessionId, slotId: options.body.data.slots[0].id, confirmed: true };
  const first = await post('/v1/admin/bookings').set('Idempotency-Key', 'admin-test-booking').send(body).expect(200);
  const second = await post('/v1/admin/bookings').set('Idempotency-Key', 'admin-test-booking').send(body).expect(200);
  assert.equal(first.body.status, 'confirmed'); assert.equal(first.body.data.phone, '+919876543210');
  assert.equal(first.body.data.notification.status, 'not_configured');
  assert.equal(second.body.data.bookingId, first.body.data.bookingId); assert.equal(calendar.created, 1);
  const notifications = await store.db.collection('meeting_notifications').find({}).toArray();
  assert.equal(notifications.length, 1); assert.equal(notifications[0].status, 'not_configured');
  assert.equal(notifications[0].payload.customer.phone, '+919876543210');
  assert.equal(notifications[0].payload.meeting.meetUrl, first.body.data.meetUrl);
  const schedule = await service.schedule('2026-09-21', undefined, 1);
  assert.equal(schedule.bookings[0].phone, '+919876543210');
  await service.cancel(first.body.data.bookingId);
  assert.equal((await store.db.collection('meeting_notifications').findOne({ bookingId: first.body.data.bookingId }))?.payload, null);
});
test('admin booking API validates phone, access and explicit confirmation', async () => {
  const app = createApp(config, service, { async connectUrl() { return ''; }, async callback() {} });
  const customer = { name: 'Test', email: 'test@example.com', phone: '9876543210', date: '2026-09-21', meetingType: 'support' };
  await request(app).post('/v1/admin/booking-options').set('Authorization', `Bearer ${config.SERVICE_API_KEY}`).send(customer).expect(401);
  await request(app).post('/v1/admin/booking-options').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).send(customer).expect(422);
  const options = await request(app).post('/v1/admin/booking-options').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).send({ ...customer, phone: '+919876543210' }).expect(200);
  await request(app).post('/v1/admin/bookings').set('Authorization', `Bearer ${config.ADMIN_API_KEY}`).set('Idempotency-Key', 'unconfirmed-admin').send({ sessionId: options.body.sessionId, slotId: options.body.data.slots[0].id, confirmed: false }).expect(422);
  assert.equal(calendar.created, 0); assert.equal(await store.db.collection('meeting_notifications').countDocuments({}), 0);
});
test('pending Meet creation defers custom-flow payload until recovery has a link', async () => {
  calendar.pendingMeet = true;
  const options = await service.adminBookingOptions({ name: 'Arun', email: 'arun@example.com', phone: '+919876543210', date: '2026-09-21', timezone: 'Asia/Kolkata', meetingType: 'onboarding' });
  const result = await service.adminBook(options.sessionId, options.data.slots[0].id, 'admin-pending-meet');
  assert.equal(result.status, 'meet_pending'); assert.equal(result.data.notification.status, 'waiting_for_booking');
  assert.equal((await store.db.collection('meeting_notifications').findOne({ bookingId: result.data.bookingId }))?.payload, null);
  const event = calendar.events.get(result.data.googleEventId)!; event.meetUrl = 'https://meet.google.com/abc-defg-hij'; event.conferenceStatus = 'success';
  await service.recover();
  const record = await store.db.collection('meeting_notifications').findOne({ bookingId: result.data.bookingId });
  assert.equal(record?.status, 'not_configured'); assert.ok(record?.payload.meeting.meetUrl); assert.equal(calendar.created, 1);
});
async function askFor(text: string) {
  const s = await service.createSession({ customerRef: 'customer-1', email: 'test@example.com', name: 'Test', timezone: 'Asia/Kolkata', meetingType: 'onboarding' });
  return { id: s.sessionId, interpreted: await service.interpret(s.sessionId, text) };
}
const localStart = (slot: { start: string }) => DateTime.fromISO(slot.start).setZone('Asia/Kolkata');
test('alternative days with a time limit only offer matching times on those days', async () => {
  const { id, interpreted } = await askFor('tuesday or wednesday after 4pm');
  assert.deepEqual(interpreted.data.dates, ['2026-09-22', '2026-09-23']); assert.equal(interpreted.data.timeFrom, '16:00');
  assert.match(interpreted.message, /Tue, 22 Sep or Wed, 23 Sep after 4:00 PM/);
  const available = await service.availability(id);
  assert.equal(available.status, 'slots_available');
  const real = available.data.slots.filter(slot => slot.id !== '__next__');
  assert.deepEqual([...new Set(real.map(slot => localStart(slot).toISODate()))], ['2026-09-22', '2026-09-23']);
  assert.ok(real.every(slot => localStart(slot).hour >= 16));
  assert.ok(real.every(slot => slot.title.length <= 24 && /^(Tue|Wed) /.test(slot.title)));
});
test('a date span keeps only bookable days, and "as soon as possible" starts with the earliest free time', async () => {
  const week = await askFor('this week');
  assert.deepEqual(week.interpreted.data.dates, ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
  const soon = await askFor('as soon as possible');
  assert.equal(soon.interpreted.data.dates.length, 14); assert.equal(soon.interpreted.data.dates[0], '2026-09-16');
  const available = await service.availability(soon.id);
  assert.equal(available.data.slots[0].start, '2026-09-16T03:30:00.000Z');
  assert.ok(available.data.hasMore);
});
test('a day without free times suggests the next days that have them', async () => {
  const { id } = await askFor('saturday');
  const available = await service.availability(id);
  assert.equal(available.status, 'no_slots');
  assert.deepEqual(available.data.suggestions.map(s => s.date), ['2026-09-21', '2026-09-22', '2026-09-23']);
  assert.match(available.message, /no free times on Sat, 19 Sep/); assert.match(available.message, /Mon, 21 Sep 2026 \(\d+ free times\)/);
  const late = await askFor('monday after 8pm');
  const fallback = await service.availability(late.id);
  assert.equal(fallback.status, 'no_slots');
  assert.match(fallback.message, /Nothing is free after 8:00 PM in the next two weeks/);
  assert.equal(fallback.data.suggestions[0].date, '2026-09-22');
});
