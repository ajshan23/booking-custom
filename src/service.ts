import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { Store } from './db.js';
import { SettingsStore } from './settings.js';
import { notificationStatus, prepareCustomFlowNotification } from './notifications.js';
import type { Config } from './config.js';
import { digest } from './crypto.js';
import { candidateSlots, dateSpan, overlap, parseDayOfMonth, parseNumericDate, validateDate } from './dates.js';
import { knownInsertRejection } from './google.js';
import { timezoneFromPhone } from './timezones.js';
import { ApiError, type Booking, type BookingState, type CalendarProvider, type Connection, type DateInterpreter, type Interpretation, type MeetingType, type ProviderEvent, type Session, type TimeWindow } from './types.js';

const pending: BookingState[] = ['creating', 'reconciling'];
const active: BookingState[] = ['creating', 'reconciling', 'confirmed', 'meet_pending', 'meet_failed', 'cancelling'];
// How many days "as soon as possible", a long range, or next-day suggestions may search.
const searchDays = 14;

const day = (date: string) => DateTime.fromISO(date).toFormat('ccc, d LLL');
const clockLabel = (time: string) => DateTime.fromFormat(time, 'HH:mm').toFormat('h:mm a');
function describeTime(period: Interpretation['period'], window: TimeWindow, prefix: string) {
  if (window.from && window.to) return `${prefix}between ${clockLabel(window.from)} and ${clockLabel(window.to)}`;
  if (window.from) return `${prefix}after ${clockLabel(window.from)}`;
  if (window.to) return `${prefix}before ${clockLabel(window.to)}`;
  return period === 'any' ? '' : `${prefix}in the ${period}`;
}
function describeRequest(dates: string[], timezone: string, period: Interpretation['period'], window: TimeWindow) {
  const days = dates.length <= 3 ? `on ${dates.map(day).join(' or ')}` : `between ${day(dates[0])} and ${day(dates.at(-1)!)}`;
  return `${days}${describeTime(period, window, ' ')} (${timezone})`;
}
function noSlotsMessage(dates: string[], timezone: string, period: Interpretation['period'], window: TimeWindow, suggested?: { suggestions: { title: string; slots: number }[]; anyTime: boolean }) {
  const missing = `There are no free times ${describeRequest(dates, timezone, period, window)}.`;
  if (!suggested?.suggestions.length) return `${missing} Please choose a later date.`;
  const list = suggested.suggestions.map(s => `${s.title} (${s.slots} free time${s.slots === 1 ? '' : 's'})`).join(', ');
  const timed = describeTime(period, window, '');
  const when = suggested.anyTime && timed ? ` Nothing is free ${timed} in the next two weeks, but these days have other times:` : ` The next days with free times${suggested.anyTime ? '' : describeTime(period, window, ' ')} are:`;
  return `${missing}${when} ${list}. Reply with one of these dates or another date.`;
}
export class BookingService {
  get settings() { return new SettingsStore(this.store, this.config); }
  constructor(public store: Store, public config: Config, private calendar: CalendarProvider, private interpreter: DateInterpreter, private now: () => Date = () => new Date()) {}
  get org() { return this.config.ORGANIZATION_ID; }
  async session(id: string) {
    const session = await this.store.sessions.findOne({ _id: id, org: this.org, expiresAt: { $gt: this.now() } });
    if (!session) throw new ApiError(404, 'session_not_found', 'Booking session expired or was not found. Start a new session.');
    return session;
  }
  async connection(): Promise<Connection> {
    const c = await this.store.connections.findOne({ org: this.org });
    if (!c || c.state !== 'connected') throw new ApiError(503, 'google_reconnect_required', 'The organizer needs to connect Google Calendar.');
    return c;
  }
  async createSession(input: { customerRef: string; email: string; name: string; timezone?: string; meetingType: MeetingType; source?: 'admin'; phone?: string }) {
    const config = await this.settings.config();
    const inferred = timezoneFromPhone(input.customerRef);
    const timezone = input.timezone ?? inferred?.timezone ?? config.DEFAULT_TIMEZONE;
    const { timezone: _requestedTimezone, ...details } = input;
    const session: Session = { _id: randomUUID(), org: this.org, ...details, timezone, history: [], slots: [], version: 0, createdAt: this.now(), expiresAt: new Date(this.now().getTime() + config.SESSION_TTL_HOURS * 3600000) };
    await this.store.sessions.insertOne(session);
    return { status: 'awaiting_date', sessionId: session._id, message: `What date would you like to meet? Times will be shown in ${session.timezone}.`, data: { email: session.email, timezone: session.timezone, timezoneSource: input.timezone ? 'provided' : inferred ? 'phone_country' : 'default', countryCode: input.timezone ? null : inferred?.regionCode ?? null, expiresAt: session.expiresAt } };
  }
  private async updateSession(s: Session, set: Partial<Session>, unset: Record<string, ''> = {}) {
    const r = await this.store.sessions.updateOne({ _id: s._id, org: this.org, version: s.version, bookingId: { $exists: false }, expiresAt: { $gt: this.now() } }, { $set: set, $unset: unset, $inc: { version: 1 } });
    if (!r.matchedCount) throw new ApiError(409, 'session_changed', 'This session changed or already has a booking. Retrieve the latest result or start a new session.');
  }
  async interpret(id: string, text: string) {
    const config = await this.settings.config();
    const s = await this.session(id);
    if (s.bookingId) throw new ApiError(409, 'booking_exists', 'This session already has a booking request.');
    const interpreted = parseNumericDate(text) ?? parseDayOfMonth(text, s.timezone, this.now()) ?? await this.interpreter.interpret(text, s.timezone, this.now(), s.history);
    let dates: string[] = [];
    if (interpreted.status === 'resolved') {
      const today = DateTime.fromJSDate(this.now(), { zone: s.timezone }).toISODate()!;
      const requested = interpreted.earliest ? dateSpan(today, '9999-12-31', searchDays)
        : interpreted.range ? dateSpan(interpreted.range.from, interpreted.range.to, 31)
        : interpreted.dates?.length ? interpreted.dates : [interpreted.date ?? ''];
      const errors = requested.map(date => validateDate(date, s.timezone, this.now(), config.BOOKING_HORIZON_DAYS));
      // Spans may start before today or run past the horizon; keep the bookable part.
      dates = [...new Set(requested.filter((_, i) => !errors[i]))].sort().slice(0, searchDays);
      if (!dates.length) { interpreted.status = 'invalid'; interpreted.question = errors[0] ?? 'Please choose another date.'; }
    }
    const window = { from: interpreted.timeFrom ?? null, to: interpreted.timeTo ?? null };
    if (window.from && window.to && window.from >= window.to) window.to = null;
    const set: Partial<Session> = { history: [...s.history.slice(-3), { text, question: interpreted.question }], slots: [] };
    const unset: Record<string, ''> = { selected: '', confirmationToken: '', date: '', dates: '', period: '', timeFrom: '', timeTo: '' };
    if (interpreted.status === 'resolved') {
      Object.assign(set, { date: dates[0], dates, period: interpreted.period });
      delete unset.date; delete unset.dates; delete unset.period;
      if (window.from) { set.timeFrom = window.from; delete unset.timeFrom; }
      if (window.to) { set.timeTo = window.to; delete unset.timeTo; }
    }
    await this.updateSession(s, set, unset);
    const resolved = interpreted.status === 'resolved';
    const message = resolved ? `I'll look for free times ${describeRequest(dates, s.timezone, interpreted.period, window)}. Choose an available time next.` : interpreted.question!;
    return { status: interpreted.status, sessionId: id, message, data: { date: resolved ? dates[0] : null, dates, period: interpreted.period, timeFrom: resolved ? window.from : null, timeTo: resolved ? window.to : null, timezone: s.timezone } };
  }
  // Free slots across the given customer dates after calendar, booking and blocked-hour checks.
  private async freeSlots(config: Config, connection: Connection, s: Session, dates: string[], period: Interpretation['period'], window: TimeWindow) {
    const candidates = dates.filter(date => !validateDate(date, s.timezone, this.now(), config.BOOKING_HORIZON_DAYS))
      .flatMap(date => candidateSlots(config, date, s.timezone, s.meetingType, period, this.now(), window))
      .sort((a, b) => a.start.localeCompare(b.start));
    if (!candidates.length) return [];
    const pad = config.BUFFER_MINUTES * 60000;
    const from = new Date(Date.parse(candidates[0].start) - pad).toISOString();
    const to = new Date(Date.parse(candidates.at(-1)!.end) + pad).toISOString();
    const busy = await this.calendar.busy(connection, from, to);
    const reserved = await this.store.bookings.find({ org: this.org, status: { $in: active }, start: { $lt: to }, end: { $gt: from } }).toArray();
    const blocks = await this.blocksBetween(candidates[0].start, candidates.at(-1)!.end);
    return candidates.filter(slot => ![...busy, ...reserved].some(b => overlap(slot, b, config.BUFFER_MINUTES)) && !blocks.some(b => overlap(slot, b)));
  }
  // The first few later days with free times, so a customer never has to guess blindly.
  private async suggestDays(config: Config, connection: Connection, s: Session, after: string, window: TimeWindow) {
    const today = DateTime.fromJSDate(this.now(), { zone: s.timezone }).toISODate()!;
    const next = DateTime.fromISO(after).plus({ days: 1 }).toISODate()!;
    const days = dateSpan(next > today ? next : today, '9999-12-31', searchDays);
    const timed = s.period !== 'any' || window.from || window.to;
    let slots = await this.freeSlots(config, connection, s, days, s.period ?? 'any', window);
    let anyTime = false;
    if (!slots.length && timed) { slots = await this.freeSlots(config, connection, s, days, 'any', {}); anyTime = true; }
    const counts = new Map<string, number>();
    for (const slot of slots) {
      const date = DateTime.fromISO(slot.start).setZone(s.timezone).toISODate()!;
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    const suggestions = [...counts].slice(0, 3).map(([date, count]) => ({
      id: date, date, slots: count,
      title: DateTime.fromISO(date).toFormat('ccc, d LLL yyyy'),
      description: `${count} free time${count === 1 ? '' : 's'}${anyTime ? '' : describeTime(s.period ?? 'any', window, ' ')}`
    }));
    return { suggestions, anyTime };
  }
  // otherDay: when set, the list ends with a row of that title (id __date__) for choosing another day.
  async availability(id: string, page = 0, otherDay?: string) {
    const config = await this.settings.config();
    const s = await this.session(id);
    if (!s.date) throw new ApiError(422, 'date_required', 'Please clarify the requested date first.');
    // Later pages use the same short-lived snapshot so the list does not shift
    // while a customer browses. Page zero refreshes current calendar/settings.
    const cachedSlotsAreCurrent = page > 0 && s.slots.length > 0 && s.slots.every(slot => slot.expiresAt > this.now());
    const dates = s.dates?.length ? s.dates : [s.date];
    const window = { from: s.timeFrom ?? null, to: s.timeTo ?? null };
    let slots = s.slots;
    let suggested: Awaited<ReturnType<BookingService['suggestDays']>> | undefined;
    if (!cachedSlotsAreCurrent) {
      const connection = await this.connection();
      // A single requested day keeps the original strict validation and error.
      if (dates.length === 1) candidateSlots(config, dates[0], s.timezone, s.meetingType, s.period ?? 'any', this.now(), window);
      slots = await this.freeSlots(config, connection, s, dates, s.period ?? 'any', window);
      if (!slots.length && page === 0) suggested = await this.suggestDays(config, connection, s, dates.at(-1)!, window);
      await this.updateSession(s, { slots }, { selected: '', confirmationToken: '' });
    }
    const multiDay = new Set(slots.map(slot => DateTime.fromISO(slot.start).setZone(s.timezone).toISODate())).size > 1;

    // WhatsApp lists allow ten rows. "Another day" takes one; "More times" takes
    // one only while another full or partial page remains.
    const capacity = otherDay ? 9 : 10;
    const pageSize = capacity - 1;
    const offset = page * pageSize;
    if (slots.length && offset >= slots.length) throw new ApiError(422, 'page_out_of_range', 'There are no more available-time pages.');
    const remaining = slots.slice(offset);
    const hasMore = remaining.length > capacity;
    const pageSlots = remaining.slice(0, hasMore ? pageSize : capacity);
    const rows = pageSlots.map((slot, i) => ({
      ...slot,
      choice: String(offset + i + 1),
      // WhatsApp list titles are limited to 24 characters, so a multi-day list moves the time range into the description.
      title: multiDay
        ? DateTime.fromISO(slot.start).setZone(s.timezone).toFormat('ccc d LLL, h:mm a')
        : `${DateTime.fromISO(slot.start).setZone(s.timezone).toFormat('h:mm a')}–${DateTime.fromISO(slot.end).setZone(s.timezone).toFormat('h:mm a')}`,
      description: multiDay
        ? `${DateTime.fromISO(slot.start).setZone(s.timezone).toFormat('h:mm a')}–${DateTime.fromISO(slot.end).setZone(s.timezone).toFormat('h:mm a')} · ${s.timezone}`
        : `${DateTime.fromISO(slot.start).setZone(s.timezone).toFormat('ccc, d LLL yyyy')} · ${s.timezone}`
    }));
    if (hasMore) rows.push({
      id: '__next__',
      start: '',
      end: '',
      expiresAt: new Date(Math.min(...pageSlots.map(slot => slot.expiresAt.getTime()))),
      label: 'More times',
      choice: '__next__',
      title: 'More times',
      description: `Show the next ${Math.min(capacity, slots.length - offset - pageSize)} available times`
    });
    if (otherDay && pageSlots.length) rows.push({
      id: '__date__', start: '', end: '', expiresAt: rows[0].expiresAt, label: otherDay, choice: '__date__', title: otherDay, description: ''
    });
    const message = pageSlots.length
      ? `Available times (${s.timezone}), page ${page + 1}:\n${pageSlots.map((slot, i) => `${offset + i + 1}. ${slot.label}`).join('\n')}${hasMore ? '\nChoose More times to see the next page.' : ''}\nThese times are not reserved until you confirm.`
      : noSlotsMessage(dates, s.timezone, s.period ?? 'any', window, suggested);
    return {
      status: pageSlots.length ? 'slots_available' : 'no_slots', sessionId: id, message,
      data: { slots: rows, page, pageNumber: page + 1, pageSize, hasMore, nextPage: hasMore ? page + 1 : null, totalSlots: slots.length, suggestions: suggested?.suggestions ?? [] }
    };
  }
  async select(id: string, selection: string) {
    const s = await this.session(id);
    const slot = /^\d{1,2}$/.test(selection) ? s.slots[Number(selection) - 1] : s.slots.find(slot => slot.id === selection);
    if (!slot) throw new ApiError(422, 'invalid_selection', 'Please select a number from the offered slots.');
    if (slot.expiresAt <= this.now()) throw new ApiError(409, 'slot_expired', 'These slot choices have expired. Please request available times again.');
    const confirmationToken = randomUUID();
    await this.updateSession(s, { selected: slot, confirmationToken });
    return { status: 'awaiting_confirmation', sessionId: id, message: `Confirm your ${s.meetingType} meeting:\n${slot.label}\nInvitation: ${s.email}\nReply Confirm to book, or change your details.`, data: { slotId: slot.id, email: s.email, confirmationToken } };
  }
  async book(id: string, key: string, confirmationToken: string) {
    const existing = await this.store.bookings.findOne({ org: this.org, idempotencyKey: key });
    if (existing) {
      if (existing.sessionId !== id) throw new ApiError(409, 'idempotency_conflict', 'This request key belongs to a different booking.');
      return this.recoverableBookingResult(await this.process(existing._id));
    }
    let s = await this.session(id);
    if (s.bookingId && s.idempotencyKey !== key) throw new ApiError(409, 'booking_exists', 'This session already has a booking request; reuse its original idempotency key.');
    if (!s.selected || s.confirmationToken !== confirmationToken) throw new ApiError(409, 'confirmation_required', 'Confirm the latest selected slot before booking.');
    if (!s.bookingId) {
      if (s.selected.expiresAt <= this.now()) throw new ApiError(409, 'slot_expired', 'Selected slot has expired. Please request available times again.');
      // Include the request key: a session reopened after a lost slot race books again under a new ID.
      const bookingId = digest(`${this.org}:${id}:${key}`);
      const frozen = await this.store.sessions.findOneAndUpdate({ _id: id, org: this.org, version: s.version, bookingId: { $exists: false }, expiresAt: { $gt: this.now() } }, { $set: { bookingId, idempotencyKey: key }, $inc: { version: 1 } }, { returnDocument: 'after' }).catch(error => {
        if (error.code === 11000) throw new ApiError(409, 'idempotency_conflict', 'This request key belongs to a different booking.');
        throw error;
      });
      if (!frozen) throw new ApiError(409, 'session_changed', 'Another request changed this session. Retry with the same request key.');
      s = frozen;
    }
    const booking = await this.materialize(s);
    return this.recoverableBookingResult(await this.process(booking._id));
  }
  private async recoverableBookingResult(b: Booking) {
    if (b.status === 'failed' && ['slot_unavailable', 'slot_expired'].includes(b.errorCode ?? '')) {
      await this.store.sessions.updateOne(
        { _id: b.sessionId, org: this.org, bookingId: b._id },
        { $set: { slots: [], history: [] }, $unset: { selected: '', confirmationToken: '', bookingId: '', idempotencyKey: '', date: '', dates: '', period: '', timeFrom: '', timeTo: '' }, $inc: { version: 1 } }
      );
    }
    return this.bookingResult(b);
  }
  // Persisted frozen sessions let recovery finish a crash between confirmation and booking insertion.
  private async materialize(s: Session): Promise<Booking> {
    const connection = await this.connection();
    const booking: Booking = { _id: s.bookingId!, org: this.org, sessionId: s._id, connectionId: connection._id, idempotencyKey: s.idempotencyKey!, eventId: `ff${s.bookingId}`, start: s.selected!.start, end: s.selected!.end, timezone: s.timezone, email: s.email, name: s.name, ...(s.source ? { source: s.source, phone: s.phone } : {}), meetingType: s.meetingType, status: 'creating', lockAcquired: false, insertAttempted: false, createdAt: this.now(), updatedAt: this.now() };
    try { await this.store.bookings.updateOne({ _id: booking._id }, { $setOnInsert: booking }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new ApiError(409, 'idempotency_conflict', 'This request key already belongs to another booking.'); throw error; }
    return (await this.store.bookings.findOne({ _id: booking._id, org: this.org }))!;
  }
  async booking(id: string): Promise<Booking> {
    const b = await this.store.bookings.findOne({ _id: id, org: this.org });
    if (!b) throw new ApiError(404, 'booking_not_found', 'Booking not found.');
    await prepareCustomFlowNotification(this.store, b);
    return b;
  }
  private async release(id: string) { await this.store.connections.updateOne({ org: this.org, activeBooking: id }, { $set: { activeBooking: null } }); }
  private async fail(b: Booking, errorCode: string) {
    const result = await this.store.bookings.updateOne({ _id: b._id, leaseOwner: b.leaseOwner }, { $set: { status: 'failed', errorCode, updatedAt: this.now() } });
    if (result.matchedCount) await this.release(b._id);
  }
  private async applyEvent(b: Booking, event: ProviderEvent) {
    const status = event.cancelled ? 'cancelled' : event.conferenceStatus === 'failure' ? 'meet_failed' : event.meetUrl ? 'confirmed' : 'meet_pending';
    const result = await this.store.bookings.updateOne({ _id: b._id, leaseOwner: b.leaseOwner }, { $set: { status, ...(event.meetUrl ? { meetUrl: event.meetUrl } : {}), updatedAt: this.now() }, $unset: { errorCode: '' } });
    if (result.matchedCount) await this.release(b._id);
  }
  async process(id: string): Promise<Booking> {
    const config = await this.settings.config();
    let b = await this.booking(id);
    if (!pending.includes(b.status) && !['meet_pending', 'cancelling'].includes(b.status)) return b;
    const owner = randomUUID();
    const acquired = await this.store.bookings.findOneAndUpdate({ _id: id, org: this.org, status: { $in: [...pending, 'meet_pending', 'cancelling'] }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: this.now() } }] }, { $set: { leaseOwner: owner, leaseUntil: new Date(this.now().getTime() + 120000), updatedAt: this.now() } }, { returnDocument: 'after' });
    if (!acquired) return this.booking(id);
    b = acquired;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.store.bookings.updateOne({ _id: id, leaseOwner: owner }, { $set: { leaseUntil: new Date(this.now().getTime() + 120000) } })
        .then(r => { if (!r.matchedCount) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, 20000);
    heartbeat.unref();
    try {
      const connection = await this.connection();
      if (b.status === 'cancelling') {
        await this.calendar.cancel(connection, b.eventId);
        const done = await this.store.bookings.updateOne({ _id: id, leaseOwner: owner }, { $set: { status: 'cancelled', updatedAt: this.now() } });
        if (done.matchedCount) await this.release(id);
      } else if (b.status === 'meet_pending') {
        const event = await this.calendar.find(connection, b.eventId);
        if (event) await this.applyEvent(b, event);
        else await this.fail(b, 'event_missing');
      } else {
        // This durable organizer lock never expires automatically after an uncertain Google
        // write. A crash/retry must reconcile that write before allowing a different booking.
        const locked = await this.store.connections.findOneAndUpdate({ _id: connection._id, $or: [{ activeBooking: null }, { activeBooking: id }] }, { $set: { activeBooking: id } }, { returnDocument: 'after' });
        if (!locked) return b;
        await this.store.bookings.updateOne({ _id: id, leaseOwner: owner }, { $set: { lockAcquired: true } });
        const found = await this.calendar.find(connection, b.eventId);
        if (found) { await this.applyEvent(b, found); }
        else {
          {
            const localDate = DateTime.fromISO(b.start).setZone(b.timezone).toISODate()!;
            const candidates = validateDate(localDate, b.timezone, this.now(), config.BOOKING_HORIZON_DAYS) ? [] : candidateSlots(config, localDate, b.timezone, b.meetingType, 'any', this.now());
            if (!candidates.some(slot => Date.parse(slot.start) === Date.parse(b.start) && Date.parse(slot.end) === Date.parse(b.end))) {
              if (!b.insertAttempted) await this.fail(b, 'slot_expired');
              else await this.store.bookings.updateOne({ _id: id, leaseOwner: owner }, { $set: { errorCode: 'reconciliation_needs_review', updatedAt: this.now() } });
              return this.booking(id);
            }
            const buffer = config.BUFFER_MINUTES * 60000;
            const busy = await this.calendar.busy(connection, new Date(Date.parse(b.start) - buffer).toISOString(), new Date(Date.parse(b.end) + buffer).toISOString());
            const reserved = await this.store.bookings.find({ org: this.org, _id: { $ne: id }, status: { $in: ['confirmed', 'meet_pending', 'meet_failed', 'cancelling'] } }).toArray();
            const blocks = await this.blocksBetween(b.start, b.end);
            if ([...busy, ...reserved].some(other => overlap(b, other, config.BUFFER_MINUTES)) || blocks.some(other => overlap(b, other))) {
              if (!b.insertAttempted) await this.fail(b, 'slot_unavailable');
              else await this.store.bookings.updateOne({ _id: id, leaseOwner: owner }, { $set: { errorCode: 'reconciliation_needs_review', updatedAt: this.now() } });
              return this.booking(id);
            }
            if (leaseLost) return this.booking(id);
            const owned = await this.store.bookings.updateOne({ _id: id, leaseOwner: owner, leaseUntil: { $gt: this.now() } }, { $set: { insertAttempted: true, status: 'reconciling', updatedAt: this.now() } });
            if (!owned.matchedCount) return this.booking(id);
          }
          try { await this.applyEvent(b, await this.calendar.create(connection, b)); }
          catch (error) {
            if (knownInsertRejection(error)) await this.fail(b, 'google_booking_rejected');
            else await this.store.bookings.updateOne({ _id: id, leaseOwner: owner }, { $set: { status: 'reconciling', errorCode: 'google_result_uncertain', updatedAt: this.now() } });
          }
        }
      }
    } catch (error) {
      await this.store.bookings.updateOne({ _id: id, leaseOwner: owner }, { $set: { errorCode: error instanceof ApiError ? error.code : 'provider_unavailable', updatedAt: this.now() } });
    } finally {
      clearInterval(heartbeat);
      await this.store.bookings.updateOne({ _id: id, leaseOwner: owner }, { $unset: { leaseOwner: '', leaseUntil: '' } });
    }
    return this.booking(id);
  }
  bookingResult(b: Booking) {
    const messages: Record<string, string> = {
      confirmed: 'Your meeting is confirmed. The Calendar invitation has been requested.',
      meet_pending: 'Your meeting is booked. The Google Meet link is still being prepared.',
      meet_failed: 'Your meeting is booked, but Google could not create the Meet link. Please contact the support team.',
      creating: 'Your booking request is being processed. Please check its status shortly.',
      reconciling: 'Your booking request is being checked. Please check its status; do not submit another booking.',
      cancelled: 'Your meeting is cancelled.', cancelling: 'Your cancellation is being processed.',
      failed: ['slot_unavailable', 'slot_expired'].includes(b.errorCode ?? '') ? 'That slot is no longer available. Please choose another date and time.' : 'The booking could not be completed. Start a new booking session or contact support.'
    };
    const recoverable = b.status === 'failed' && ['slot_unavailable', 'slot_expired'].includes(b.errorCode ?? '');
    return { status: recoverable ? b.errorCode! : b.status, sessionId: b.sessionId, message: messages[b.status], data: { bookingId: b._id, googleEventId: b.eventId, startTime: b.start, endTime: b.end, timezone: b.timezone, meetUrl: b.status === 'cancelled' ? null : b.meetUrl ?? null, email: b.email, phone: b.phone ?? null, notification: notificationStatus(b), errorCode: b.errorCode ?? null, canReselect: recoverable } };
  }
  async cancel(id: string) {
    const b = await this.booking(id);
    if (b.status === 'cancelled') return this.bookingResult(b);
    if (pending.includes(b.status)) throw new ApiError(409, 'booking_pending', 'Wait for the booking result before cancelling.');
    if (b.status === 'failed') throw new ApiError(409, 'booking_failed', 'There is no confirmed event to cancel.');
    await this.store.bookings.updateOne({ _id: id, org: this.org, status: { $in: ['confirmed', 'meet_pending', 'meet_failed'] }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: this.now() } }] }, { $set: { status: 'cancelling', updatedAt: this.now() } });
    const updated = await this.booking(id);
    if (!['cancelling', 'cancelled'].includes(updated.status)) throw new ApiError(409, 'booking_busy', 'Booking status is being updated. Retry cancellation shortly.');
    return this.bookingResult(await this.process(id));
  }
  async recover() {
    const frozen = await this.store.sessions.aggregate<Session>([
      { $match: { org: this.org, bookingId: { $exists: true } } },
      { $lookup: { from: 'bookings', localField: 'bookingId', foreignField: '_id', as: 'booking' } },
      { $match: { booking: { $size: 0 } } }, { $limit: 100 }, { $unset: 'booking' }
    ]).toArray();
    for (const s of frozen) if (!(await this.store.bookings.findOne({ _id: s.bookingId }))) await this.materialize(s).catch(() => undefined);
    // A long waiting queue must not starve the booking holding the organizer lock.
    const organizer = await this.store.connections.findOne({ org: this.org });
    if (organizer?.activeBooking) await this.process(organizer.activeBooking);
    const bookings = await this.store.bookings.find({ org: this.org, status: { $in: [...pending, 'meet_pending', 'cancelling'] } }).sort({ updatedAt: 1 }).limit(50).toArray();
    for (const b of bookings) await this.process(b._id);
    const missingNotifications = await this.store.bookings.aggregate<Booking>([
      { $match: { org: this.org, source: 'admin' } },
      { $lookup: { from: 'meeting_notifications', let: { booking: '$_id', org: '$org', bookingUpdated: '$updatedAt' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$bookingId', '$$booking'] }, { $eq: ['$org', '$$org'] }, { $gte: ['$updatedAt', '$$bookingUpdated'] }] } } }], as: 'notification' } },
      { $match: { notification: { $size: 0 } } }, { $limit: 50 }, { $unset: 'notification' }
    ]).toArray();
    for (const b of missingNotifications) await prepareCustomFlowNotification(this.store, b);
    // Release a lock left behind if the process crashed after committing a terminal state.
    const c = await this.store.connections.findOne({ org: this.org });
    if (c?.activeBooking) {
      const b = await this.store.bookings.findOne({ _id: c.activeBooking });
      if (b && !pending.includes(b.status)) await this.release(b._id);
    }
  }
  async schedule(date: string | undefined, day: 'today' | 'tomorrow' | undefined, page: number) {
    const config = await this.settings.config();
    const timezone = config.DEFAULT_TIMEZONE;
    const start = date ? DateTime.fromISO(date, { zone: timezone }).startOf('day') : DateTime.fromJSDate(this.now(), { zone: timezone }).startOf('day').plus({ days: day === 'tomorrow' ? 1 : 0 });
    if (!start.isValid) throw new ApiError(422, 'invalid_date', 'Choose a valid calendar date.');
    const filter = { org: this.org, start: { $lt: start.plus({ days: 1 }).toUTC().toISO()! }, end: { $gt: start.toUTC().toISO()! } };
    const [total, bookings, blocks] = await Promise.all([
      this.store.bookings.countDocuments(filter),
      this.store.bookings.find(filter, { projection: { _id: 1, name: 1, email: 1, phone: 1, source: 1, meetingType: 1, start: 1, end: 1, timezone: 1, status: 1, meetUrl: 1, errorCode: 1 } }).sort({ start: 1, _id: 1 }).skip((page - 1) * 50).limit(50).toArray(),
      this.blocksBetween(start.toUTC().toISO()!, start.plus({ days: 1 }).toUTC().toISO()!)
    ]);
    return { date: start.toISODate(), timezone, total, page, pageSize: 50, hasMore: page * 50 < total, bookings: bookings.map(b => ({ ...b, notification: notificationStatus(b) })), blocks };
  }
  async adminBookingOptions(input: { name: string; phone: string; email: string; date: string; timezone: string; meetingType: MeetingType }) {
    const error = validateDate(input.date, input.timezone, this.now(), (await this.settings.config()).BOOKING_HORIZON_DAYS);
    if (error) throw new ApiError(422, 'invalid_date', error);
    const { date, ...customer } = input;
    const created = await this.createSession({ ...customer, customerRef: input.phone, source: 'admin' });
    await this.interpret(created.sessionId, date);
    return this.availability(created.sessionId);
  }
  async adminBook(sessionId: string, slotId: string, key: string) {
    const existing = await this.store.bookings.findOne({ org: this.org, idempotencyKey: key });
    if (existing) {
      if (existing.sessionId !== sessionId || existing.source !== 'admin') throw new ApiError(409, 'idempotency_conflict', 'This request key belongs to another booking.');
      return this.bookingResult(await this.process(existing._id));
    }
    const s = await this.session(sessionId);
    if (s.source !== 'admin' || !s.phone) throw new ApiError(409, 'invalid_admin_session', 'Choose available slots through the admin booking form first.');
    if (s.bookingId) return this.book(sessionId, key, s.confirmationToken!);
    const selected = await this.select(sessionId, slotId);
    return this.book(sessionId, key, selected.data.confirmationToken);
  }
  private blocksBetween(start: string, end: string) {
    return this.store.timeBlocks.find({ org: this.org, removedAt: { $exists: false }, start: { $lt: end }, end: { $gt: start } }, { projection: { org: 0 } }).sort({ start: 1 }).toArray();
  }
  async blockTime(input: { date: string; startTime: string; endTime: string; timezone: string; reason: string }) {
    const settings = await this.settings.config();
    if (input.timezone !== settings.DEFAULT_TIMEZONE) throw new ApiError(409, 'timezone_changed', 'Organizer timezone changed. Refresh the schedule before blocking hours.');
    const parse = (time: string) => {
      const value = DateTime.fromISO(`${input.date}T${time}`, { zone: input.timezone });
      if (!value.isValid || value.toFormat("yyyy-MM-dd'T'HH:mm") !== `${input.date}T${time}` || value.getPossibleOffsets().length !== 1) throw new ApiError(422, 'invalid_time', 'Choose a valid, unambiguous local date and time.');
      return value;
    };
    const start = parse(input.startTime); const end = parse(input.endTime);
    if (end <= start) throw new ApiError(422, 'invalid_time_range', 'End time must be after start time on the same date.');
    if (end.toMillis() <= this.now().getTime()) throw new ApiError(422, 'past_time', 'Choose a time range that has not already ended.');
    const block = { _id: randomUUID(), org: this.org, start: start.toUTC().toISO()!, end: end.toUTC().toISO()!, timezone: input.timezone, reason: input.reason, createdAt: this.now() };
    await this.store.timeBlocks.insertOne(block);
    const existingBookings = await this.store.bookings.countDocuments({ org: this.org, status: { $in: active }, start: { $lt: block.end }, end: { $gt: block.start } });
    return { id: block._id, existingBookings, message: existingBookings ? `Hours blocked. ${existingBookings} existing booking request(s) overlap; review them separately.` : 'Hours blocked. These times will no longer be offered to customers.' };
  }
  async removeTimeBlock(id: string) {
    const result = await this.store.timeBlocks.updateOne({ _id: id, org: this.org, removedAt: { $exists: false } }, { $set: { removedAt: this.now() } });
    if (!result.matchedCount && !await this.store.timeBlocks.findOne({ _id: id, org: this.org })) throw new ApiError(404, 'block_not_found', 'Blocked hours not found.');
  }
}
