import { DateTime, IANAZone } from 'luxon';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { ApiError, type Busy, type Interpretation, type MeetingType, type Slot, type TimeWindow } from './types.js';

const result = (status: Interpretation['status'], date: string | null, question: string | null): Interpretation => ({ status, date, question, period: 'any' });
export function parseNumericDate(text: string): Interpretation | null {
  const value = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const local = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/.exec(value);
  if (!iso && !local) return null;
  let year: number, month: number, day: number;
  if (iso) { year = +iso[1]; month = +iso[2]; day = +iso[3]; }
  else {
    day = +local![1]; month = +local![2]; year = +local![3];
    if (local![3].length === 2) year += 2000;
    if (day <= 12 && month <= 12 && day !== month) {
      const a = DateTime.fromObject({ year, month, day });
      const b = DateTime.fromObject({ year, month: day, day: month });
      return result('needs_clarification', null, `Do you mean ${a.toFormat('d LLLL yyyy')} or ${b.toFormat('d LLLL yyyy')}? Please reply with the month written out.`);
    }
    // Support an unambiguous US-formatted date too, but never guess when both are possible.
    if (month > 12 && day <= 12) [month, day] = [day, month];
  }
  const date = DateTime.fromObject({ year, month, day });
  return date.isValid ? result('resolved', date.toISODate(), null) : result('invalid', null, 'That date does not exist. Please enter a date such as 20 September 2026.');
}
// A bare day of the month ("30", "30th") is the next date with that day: this
// month if it has not passed, otherwise the next month that has it.
export function parseDayOfMonth(text: string, timezone: string, now: Date): Interpretation | null {
  const match = /^(\d{1,2})(?:st|nd|rd|th)?$/i.exec(text.trim());
  if (!match) return null;
  const day = Number(match[1]);
  if (day < 1 || day > 31) return null;
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  for (let i = 0; i < 3; i++) {
    const month = today.startOf('month').plus({ months: i });
    const date = DateTime.fromObject({ year: month.year, month: month.month, day }, { zone: timezone });
    if (date.isValid && date >= today) return result('resolved', date.toISODate(), null);
  }
  return null;
}
export function validateDate(value: string, timezone: string, now: Date, horizon: number): string | null {
  if (!IANAZone.isValidZone(timezone)) return 'Please choose a valid timezone.';
  const date = DateTime.fromISO(value, { zone: timezone });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !date.isValid) return 'That date does not exist. Please enter another date.';
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  if (date < today) return 'That date is in the past. Please choose an upcoming date.';
  if (date > today.plus({ days: horizon })) return `Please choose a date within the next ${horizon} days.`;
  return null;
}
// Every calendar date from `from` to `to` inclusive, at most `limit` days.
export function dateSpan(from: string, to: string, limit: number): string[] {
  let day = DateTime.fromISO(from); const last = DateTime.fromISO(to);
  if (!day.isValid || !last.isValid) return [];
  const days: string[] = [];
  for (; day <= last && days.length < limit; day = day.plus({ days: 1 })) days.push(day.toISODate()!);
  return days;
}
export function duration(config: Config, type: MeetingType): number {
  return type === 'support' ? config.SUPPORT_DURATION_MINUTES : config.ONBOARDING_DURATION_MINUTES;
}
export function overlap(a: Busy, b: Busy, bufferMinutes = 0): boolean {
  const pad = bufferMinutes * 60000;
  return Date.parse(a.start) < Date.parse(b.end) + pad && Date.parse(a.end) > Date.parse(b.start) - pad;
}
export function candidateSlots(config: Config, date: string, timezone: string, type: MeetingType, period: Interpretation['period'], now: Date, window: TimeWindow = {}): Slot[] {
  const error = validateDate(date, timezone, now, config.BOOKING_HORIZON_DAYS);
  if (error) throw new ApiError(422, 'invalid_date', error);
  const customerDay = DateTime.fromISO(date, { zone: timezone });
  const from = customerDay.startOf('day');
  const to = from.plus({ days: 1 });
  const at = (time: string) => from.set({ hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) });
  const windowStart = window.from ? at(window.from) : null;
  const windowEnd = window.to ? at(window.to) : null;
  const durationMinutes = duration(config, type);
  const slots: Slot[] = [];
  // Working hours belong to the organizer; customer dates belong to the customer.
  let organizerDay = from.setZone(config.DEFAULT_TIMEZONE).startOf('day');
  const lastDay = to.setZone(config.DEFAULT_TIMEZONE).startOf('day');
  while (organizerDay <= lastDay) {
    if (config.WORKING_DAYS.includes(organizerDay.weekday)) {
      const [sh, sm] = config.WORK_START.split(':').map(Number);
      const [eh, em] = config.WORK_END.split(':').map(Number);
      const close = organizerDay.set({ hour: eh, minute: em });
      for (let start = organizerDay.set({ hour: sh, minute: sm }); start.plus({ minutes: durationMinutes }) <= close; start = start.plus({ minutes: durationMinutes + config.BUFFER_MINUTES })) {
        const end = start.plus({ minutes: durationMinutes });
        const local = start.setZone(timezone);
        if (start < from || start >= to || start.toMillis() < now.getTime() + config.MIN_NOTICE_MINUTES * 60000) continue;
        if (period === 'morning' && local.hour >= 12) continue;
        if (period === 'afternoon' && (local.hour < 12 || local.hour >= 17)) continue;
        if (period === 'evening' && local.hour < 17) continue;
        if ((windowStart && start < windowStart) || (windowEnd && end > windowEnd)) continue;
        // Avoid ambiguous/nonexistent wall times during a daylight-saving transition.
        if (local.getPossibleOffsets().length !== 1 || end.setZone(timezone).getPossibleOffsets().length !== 1) continue;
        slots.push({ id: randomUUID(), start: start.toUTC().toISO()!, end: end.toUTC().toISO()!, expiresAt: new Date(now.getTime() + config.SLOT_TTL_MINUTES * 60000), label: `${local.toFormat('ccc, d LLL yyyy, h:mm a')}–${end.setZone(timezone).toFormat('h:mm a')} (${timezone}, UTC${local.toFormat('ZZ')})` });
      }
    }
    organizerDay = organizerDay.plus({ days: 1 });
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start));
}
