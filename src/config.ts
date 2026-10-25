import 'dotenv/config';
import { z } from 'zod';
import { IANAZone } from 'luxon';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const positive = (fallback: number, max = 10080) => z.coerce.number().int().min(1).max(max).default(fallback);
const schema = z.object({
  PORT: positive(3080, 65535),
  MONGODB_URI: z.string().min(1), MONGODB_DATABASE: z.string().default('customcalander'),
  SERVICE_API_KEY: z.string().min(32), ADMIN_API_KEY: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().refine(v => Buffer.from(v, 'base64').length === 32, 'Must encode 32 bytes'),
  ORGANIZATION_ID: z.string().min(1).default('flowflex-internal'),
  GOOGLE_CLIENT_ID: z.string().min(1), GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.url(), OPENAI_API_KEY: z.string().min(1), OPENAI_MODEL: z.string().min(1).default('gpt-5.4-mini'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata').refine(IANAZone.isValidZone),
  WORKING_DAYS: z.string().default('1,2,3,4,5').transform(v => v.split(',').map(Number)).refine(v => v.length > 0 && v.every(n => Number.isInteger(n) && n >= 1 && n <= 7)),
  WORK_START: time.default('09:00'), WORK_END: time.default('18:00'),
  SUPPORT_DURATION_MINUTES: positive(30, 480), ONBOARDING_DURATION_MINUTES: positive(30, 480),
  BUFFER_MINUTES: z.coerce.number().int().min(0).max(120).default(10),
  MIN_NOTICE_MINUTES: positive(60), BOOKING_HORIZON_DAYS: positive(60, 180),
  SLOT_TTL_MINUTES: positive(10, 60), SESSION_TTL_HOURS: positive(24, 168),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0)
}).refine(v => v.ADMIN_API_KEY !== v.SERVICE_API_KEY, 'Admin and service keys must differ')
  .refine(v => v.WORK_START < v.WORK_END, 'Work end must follow work start');
export type Config = z.infer<typeof schema>;
export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}
