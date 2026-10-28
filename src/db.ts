import { Db } from 'mongodb';
import type { Booking, Connection, Session, TimeBlock } from './types.js';
export class Store {
  constructor(public db: Db) {}
  get sessions() { return this.db.collection<Session>('sessions'); }
  get bookings() { return this.db.collection<Booking>('bookings'); }
  get connections() { return this.db.collection<Connection>('connections'); }
  get timeBlocks() { return this.db.collection<TimeBlock>('time_blocks'); }
  get oauthStates() { return this.db.collection<{ _id: string; org: string; expiresAt: Date }>('oauth_states'); }
  get adminSessions() { return this.db.collection<{ _id: string; expiresAt: Date }>('admin_sessions'); }
  async init() {
    // Sessions reopened after a lost slot race hold several bookings; the session freeze keeps one in flight.
    const legacy = (await this.bookings.listIndexes().toArray().catch(() => [])).find(i => i.unique && i.key?.org === 1 && i.key?.sessionId === 1);
    if (legacy) await this.bookings.dropIndex(legacy.name);
    await Promise.all([
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.sessions.createIndex({ org: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }),
      this.bookings.createIndex({ org: 1, idempotencyKey: 1 }, { unique: true }),
      this.bookings.createIndex({ org: 1, sessionId: 1 }),
      this.bookings.createIndex({ status: 1, updatedAt: 1 }),
      this.bookings.createIndex({ org: 1, start: 1, end: 1 }),
      this.timeBlocks.createIndex({ org: 1, start: 1, end: 1 }),
      this.db.collection('meeting_notifications').createIndex({ org: 1, bookingId: 1 }, { unique: true }),
      this.connections.createIndex({ org: 1 }, { unique: true }),
      this.oauthStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.adminSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]);
  }
}
