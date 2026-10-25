import type { Store } from './db.js';
import type { Booking } from './types.js';

export function notificationStatus(b: Booking) {
  if (b.source !== 'admin') return { status: 'not_requested', message: 'Custom-flow notification was not requested.' };
  if (['cancelled', 'cancelling', 'failed'].includes(b.status)) return { status: 'cancelled', message: 'Scheduling notification will not be sent for this booking.' };
  if (b.status === 'meet_failed') return { status: 'needs_attention', message: 'Meeting booked, but the Meet link failed. Custom-flow notification has not been sent.' };
  if (b.status !== 'confirmed' || !b.meetUrl) return { status: 'waiting_for_booking', message: 'Notification will be prepared once the meeting and Meet link are ready.' };
  return { status: 'not_configured', message: 'Meeting booked. Custom-flow notification is prepared but has not been sent; the API is not configured yet.' };
}

/** Stable integration boundary. Add the custom API transport here once its contract is supplied.
 * No external request is made in this version. Do not automatically replay old notifications
 * when enabling a real transport: review their dates/cancellation state first. */
export function customFlowPayload(b: Booking) {
  return {
    event: 'meeting.scheduled', idempotencyKey: `meeting.scheduled:${b._id}`,
    bookingId: b._id, customer: { name: b.name, phone: b.phone!, email: b.email },
    meeting: { type: b.meetingType, startTime: b.start, endTime: b.end, timezone: b.timezone, googleEventId: b.eventId, meetUrl: b.meetUrl! }
  };
}

export async function prepareCustomFlowNotification(store: Store, b: Booking) {
  if (b.source !== 'admin') return;
  const { status } = notificationStatus(b);
  await store.db.collection('meeting_notifications').updateOne({ org: b.org, bookingId: b._id }, {
    $set: { status, payload: status === 'not_configured' ? customFlowPayload(b) : null, updatedAt: new Date() },
    $setOnInsert: { createdAt: new Date(), event: 'meeting.scheduled' }
  }, { upsert: true });
}
