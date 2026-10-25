import { google } from 'googleapis';
import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { Store } from './db.js';
import { decrypt, digest, encrypt } from './crypto.js';
import { ApiError, type Booking, type CalendarProvider, type Connection, type ProviderEvent } from './types.js';

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type Credentials = OAuth2Client['credentials'];

const code = (error: unknown): number | undefined => Number((error as { response?: { status?: number }; code?: number })?.response?.status || (error as { code?: number })?.code) || undefined;
export function knownInsertRejection(error: unknown): boolean {
  return [400, 401, 403, 404, 422].includes(code(error) ?? 0);
}
export class GoogleCalendar implements CalendarProvider {
  constructor(private store: Store, private config: Config) { google.options({ timeout: 15000, retry: false }); }
  private oauth() {
    const client = new google.auth.OAuth2(this.config.GOOGLE_CLIENT_ID, this.config.GOOGLE_CLIENT_SECRET, this.config.GOOGLE_REDIRECT_URI);
    client.transporter.defaults = { ...client.transporter.defaults, timeout: 15000, retry: false };
    return client;
  }
  async connectUrl(): Promise<string> {
    const state = randomBytes(32).toString('hex');
    await this.store.oauthStates.insertOne({ _id: digest(state), org: this.config.ORGANIZATION_ID, expiresAt: new Date(Date.now() + 10 * 60000) });
    return this.oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', state, scope: ['openid', 'https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/calendar.events'] });
  }
  async callback(state: string, authCode?: string): Promise<void> {
    const record = await this.store.oauthStates.findOneAndDelete({ _id: digest(state), org: this.config.ORGANIZATION_ID, expiresAt: { $gt: new Date() } });
    if (!record) throw new ApiError(400, 'invalid_oauth_state', 'Connection link has expired or was already used. Start again.');
    if (!authCode) throw new ApiError(400, 'oauth_denied', 'Google connection was not authorized.');
    const client = this.oauth();
    const { tokens } = await client.getToken(authCode);
    if (!tokens.refresh_token) throw new ApiError(400, 'missing_refresh_token', 'Google did not return offline access. Reconnect and grant permission.');
    if (!tokens.id_token) throw new ApiError(400, 'missing_identity', 'Google did not return organizer identity. Reconnect.');
    const identity = (await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.GOOGLE_CLIENT_ID })).getPayload()?.sub;
    if (!identity) throw new ApiError(400, 'missing_identity', 'Could not verify organizer identity.');
    const existing = await this.store.connections.findOne({ org: record.org });
    if (existing && existing.googleAccountId !== identity) throw new ApiError(409, 'organizer_mismatch', 'Reconnect the original organizer account.');
    // Identity in the update filter also prevents simultaneous callbacks from swapping accounts.
    try {
      await this.store.connections.updateOne({ _id: record.org, googleAccountId: identity }, { $set: { org: record.org, calendarId: 'primary', googleAccountId: identity, encryptedTokens: encrypt(tokens, this.config.TOKEN_ENCRYPTION_KEY), state: 'connected', updatedAt: new Date() }, $setOnInsert: { activeBooking: null } }, { upsert: true });
    } catch (error) { if ((error as { code?: number }).code === 11000) throw new ApiError(409, 'organizer_mismatch', 'An organizer is already connected.'); throw error; }
  }
  private async auth(connection: Connection): Promise<OAuth2Client> {
    const client = this.oauth();
    const credentials = decrypt<Credentials>(connection.encryptedTokens, this.config.TOKEN_ENCRYPTION_KEY);
    client.setCredentials(credentials);
    try {
      await client.getAccessToken();
      await this.store.connections.updateOne({ _id: connection._id, encryptedTokens: connection.encryptedTokens }, { $set: { encryptedTokens: encrypt({ ...credentials, ...client.credentials }, this.config.TOKEN_ENCRYPTION_KEY), updatedAt: new Date() } });
      return client;
    } catch (error) {
      if ((error as { response?: { data?: { error?: string } } })?.response?.data?.error === 'invalid_grant') {
        await this.store.connections.updateOne({ _id: connection._id }, { $set: { state: 'reconnect_required' } });
        throw new ApiError(503, 'google_reconnect_required', 'The organizer needs to reconnect Google Calendar.');
      }
      throw new ApiError(503, 'google_unavailable', 'Google Calendar is temporarily unavailable.');
    }
  }
  async busy(connection: Connection, start: string, end: string) {
    const calendar = google.calendar({ version: 'v3', auth: await this.auth(connection) });
    const { data } = await calendar.freebusy.query({ requestBody: { timeMin: start, timeMax: end, items: [{ id: connection.calendarId }] } });
    const value = data.calendars?.[connection.calendarId];
    if (!value || value.errors?.length || !Array.isArray(value.busy)) throw new ApiError(503, 'availability_unavailable', 'Could not verify calendar availability.');
    return value.busy.map(b => {
      if (!b.start || !b.end) throw new ApiError(503, 'availability_unavailable', 'Invalid calendar availability response.');
      return { start: b.start, end: b.end };
    });
  }
  private event(data: { id?: string | null; status?: string | null; conferenceData?: { entryPoints?: { entryPointType?: string | null; uri?: string | null }[]; createRequest?: { status?: { statusCode?: string | null } } } }): ProviderEvent {
    const meetUrl = data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri ?? undefined;
    const state = data.conferenceData?.createRequest?.status?.statusCode;
    return { id: data.id!, meetUrl, cancelled: data.status === 'cancelled', conferenceStatus: meetUrl ? 'success' : state === 'failure' ? 'failure' : 'pending' };
  }
  async find(connection: Connection, eventId: string) {
    const calendar = google.calendar({ version: 'v3', auth: await this.auth(connection) });
    try { return this.event((await calendar.events.get({ calendarId: connection.calendarId, eventId })).data); }
    catch (error) { if (code(error) === 404) return null; if (code(error) === 410) return { id: eventId, cancelled: true, conferenceStatus: 'failure' as const }; throw error; }
  }
  async create(connection: Connection, booking: Booking) {
    const calendar = google.calendar({ version: 'v3', auth: await this.auth(connection) });
    const { data } = await calendar.events.insert({ calendarId: connection.calendarId, conferenceDataVersion: 1, sendUpdates: 'all', requestBody: {
      id: booking.eventId,
      summary: `${booking.meetingType === 'support' ? 'Support call' : 'Customer onboarding'} — ${booking.name}`,
      description: `Booked through Flowflex. Booking reference: ${booking._id}`,
      start: { dateTime: booking.start, timeZone: booking.timezone }, end: { dateTime: booking.end, timeZone: booking.timezone },
      attendees: [{ email: booking.email }],
      extendedProperties: { private: { bookingId: booking._id } },
      conferenceData: { createRequest: { requestId: booking.eventId, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    } });
    return this.event(data);
  }
  async cancel(connection: Connection, eventId: string) {
    const calendar = google.calendar({ version: 'v3', auth: await this.auth(connection) });
    try { await calendar.events.delete({ calendarId: connection.calendarId, eventId, sendUpdates: 'all' }); }
    catch (error) { if (![404, 410].includes(code(error) ?? 0)) throw error; }
  }
}
