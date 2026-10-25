export type MeetingType = 'support' | 'onboarding';
export type Interpretation = {
  status: 'resolved' | 'needs_clarification' | 'invalid'; date: string | null; period: 'any' | 'morning' | 'afternoon' | 'evening'; question: string | null;
  // Optional wider requests: alternatives ("Tuesday or Wednesday"), a span ("next week") or "as soon as possible".
  dates?: string[]; range?: { from: string; to: string } | null; earliest?: boolean;
  // Customer-local HH:MM preferences ("after 4 pm" → timeFrom 16:00).
  timeFrom?: string | null; timeTo?: string | null;
};
export type TimeWindow = { from?: string | null; to?: string | null };
export type Slot = { id: string; start: string; end: string; expiresAt: Date; label: string };
export type Session = {
  source?: 'admin'; phone?: string;
  _id: string; org: string; customerRef: string; email: string; name: string; timezone: string;
  meetingType: MeetingType; date?: string; dates?: string[]; period?: Interpretation['period']; timeFrom?: string; timeTo?: string;
  history: { text: string; question: string | null }[]; slots: Slot[]; selected?: Slot;
  version: number; confirmationToken?: string; bookingId?: string; idempotencyKey?: string; createdAt: Date; expiresAt: Date;
};
export type Connection = {
  _id: string; org: string; calendarId: string; googleAccountId?: string; encryptedTokens: string;
  state: 'connected' | 'reconnect_required'; activeBooking?: string | null; updatedAt: Date;
};
export type BookingState = 'creating' | 'reconciling' | 'confirmed' | 'meet_pending' | 'meet_failed' | 'failed' | 'cancelling' | 'cancelled';
export type Booking = {
  source?: 'admin'; phone?: string;
  _id: string; org: string; sessionId: string; connectionId: string; idempotencyKey: string;
  eventId: string; start: string; end: string; timezone: string; email: string; name: string;
  meetingType: MeetingType; status: BookingState; meetUrl?: string; errorCode?: string;
  lockAcquired: boolean; insertAttempted: boolean; leaseOwner?: string; leaseUntil?: Date; createdAt: Date; updatedAt: Date;
};
export type ProviderEvent = { id: string; meetUrl?: string; conferenceStatus: 'success' | 'pending' | 'failure'; cancelled?: boolean };
export type Busy = { start: string; end: string };
export type TimeBlock = { _id: string; org: string; start: string; end: string; timezone: string; reason: string; createdAt: Date; removedAt?: Date };
export interface CalendarProvider {
  busy(connection: Connection, start: string, end: string): Promise<Busy[]>;
  find(connection: Connection, eventId: string): Promise<ProviderEvent | null>;
  create(connection: Connection, booking: Booking): Promise<ProviderEvent>;
  cancel(connection: Connection, eventId: string): Promise<void>;
}
export interface DateInterpreter {
  interpret(text: string, timezone: string, now: Date, history: Session['history']): Promise<Interpretation>;
}
export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
