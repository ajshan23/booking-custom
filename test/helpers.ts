import type { Config } from '../src/config.js';
export const config: Config = {
  PORT: 3080, MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DATABASE: 'test',
  SERVICE_API_KEY: 'service-secret-for-testing-only-123456', ADMIN_API_KEY: 'admin-secret-for-testing-only-12345678',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), ORGANIZATION_ID: 'test-org',
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_REDIRECT_URI: 'http://localhost:3080/v1/google/callback',
  OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'test-model', DEFAULT_TIMEZONE: 'Asia/Kolkata',
  WORKING_DAYS: [1, 2, 3, 4, 5], WORK_START: '09:00', WORK_END: '18:00',
  SUPPORT_DURATION_MINUTES: 30, ONBOARDING_DURATION_MINUTES: 30, BUFFER_MINUTES: 10,
  MIN_NOTICE_MINUTES: 60, BOOKING_HORIZON_DAYS: 60, SLOT_TTL_MINUTES: 10, SESSION_TTL_HOURS: 24, TRUST_PROXY_HOPS: 0
};
