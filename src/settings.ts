import { z } from 'zod';
import { IANAZone } from 'luxon';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { ApiError } from './types.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const settingsSchema = z.object({
  DEFAULT_TIMEZONE: z.string().refine(IANAZone.isValidZone, 'Use an IANA timezone'),
  WORKING_DAYS: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(v => new Set(v).size === v.length, 'Days must be unique'),
  WORK_START: time, WORK_END: time,
  SUPPORT_DURATION_MINUTES: z.number().int().min(1).max(480),
  ONBOARDING_DURATION_MINUTES: z.number().int().min(1).max(480),
  BUFFER_MINUTES: z.number().int().min(0).max(120),
  MIN_NOTICE_MINUTES: z.number().int().min(1).max(10080),
  BOOKING_HORIZON_DAYS: z.number().int().min(1).max(180),
  SLOT_TTL_MINUTES: z.number().int().min(1).max(60),
  SESSION_TTL_HOURS: z.number().int().min(1).max(168)
}).strict().refine(v => v.WORK_START < v.WORK_END, 'Work end must follow work start')
  .refine(v => {
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const window = minutes(v.WORK_END) - minutes(v.WORK_START);
    return Math.max(v.SUPPORT_DURATION_MINUTES, v.ONBOARDING_DURATION_MINUTES) <= window;
  }, 'Meeting durations must fit within working hours');
export type ScheduleSettings = z.infer<typeof settingsSchema>;
type SettingsRecord = { _id: string; values: ScheduleSettings; version: number; updatedAt: Date };
export class SettingsStore {
  constructor(private store: Store, private defaults: Config) {}
  private get collection() { return this.store.db.collection<SettingsRecord>('schedule_settings'); }
  async read() {
    const record = await this.collection.findOne({ _id: this.defaults.ORGANIZATION_ID });
    const values = record?.values ?? Object.fromEntries(Object.keys(settingsSchema.shape).map(key => [key, this.defaults[key as keyof Config]])) as ScheduleSettings;
    return { values, version: record?.version ?? 0, updatedAt: record?.updatedAt ?? null, source: record ? 'database' : 'environment' };
  }
  async config(): Promise<Config> { return { ...this.defaults, ...(await this.read()).values }; }
  async save(values: ScheduleSettings, version: number) {
    const checked = settingsSchema.parse(values);
    try {
      const result = await this.collection.updateOne({ _id: this.defaults.ORGANIZATION_ID, version }, { $set: { values: checked, updatedAt: new Date() }, $inc: { version: 1 } }, { upsert: version === 0 });
      if (!result.matchedCount && !result.upsertedCount) throw new ApiError(409, 'settings_changed', 'Settings changed in another tab. Reload before saving.');
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ApiError(409, 'settings_changed', 'Settings changed in another tab. Reload before saving.');
      throw error;
    }
    return this.read();
  }
}
