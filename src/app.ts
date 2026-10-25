import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { IANAZone } from 'luxon';
import { z } from 'zod';
import type { Config } from './config.js';
import { equalSecret } from './crypto.js';
import { ApiError } from './types.js';
import { BookingService } from './service.js';
import { settingsSchema } from './settings.js';

export interface GoogleAuth { connectUrl(): Promise<string>; callback(state: string, code?: string): Promise<void> }
export function createApp(config: Config, service: BookingService, google: GoogleAuth) {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY_HOPS) app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null } } }));
  app.use(express.json({ limit: '16kb' }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.locals.requestId = randomUUID(); res.set('X-Request-Id', res.locals.requestId); next(); });
  const auth = (key: string): RequestHandler => (req, _res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer /i, '') ?? '';
    if (!equalSecret(token, key)) return next(new ApiError(401, 'unauthorized', 'A valid API key is required.'));
    next();
  };
  const limiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, _res, next) => next(new ApiError(429, 'rate_limited', 'Too many requests. Please retry shortly.')) });
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { dotfiles: 'deny' }));
  // Public, static demo data only: no calendar access or booking side effects.
  app.options('/demo/list-options', limiter, (_req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'ngrok-skip-browser-warning' });
    res.sendStatus(204);
  });
  app.get('/demo/list-options', limiter, (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ items: [
      { id: 'demo_morning', title: 'Morning', description: 'Demo option: 9:00 AM to 12:00 PM' },
      { id: 'demo_afternoon', title: 'Afternoon', description: 'Demo option: 12:00 PM to 3:00 PM' },
      { id: 'demo_evening', title: 'Evening', description: 'Demo option: 3:00 PM to 6:00 PM' },
    ] });
  });
  app.use('/v1/admin', limiter, auth(config.ADMIN_API_KEY));
  app.get('/v1/admin/settings', async (_req, res) => { res.json({ status: 'ok', data: await service.settings.read() }); });
  app.put('/v1/admin/settings', async (req, res) => {
    const input = z.object({ version: z.number().int().min(0), values: settingsSchema }).strict().parse(req.body);
    res.json({ status: 'saved', data: await service.settings.save(input.values, input.version) });
  });
  app.get('/v1/admin/schedule', async (req, res) => {
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), day: z.enum(['today', 'tomorrow']).optional(), page: z.coerce.number().int().min(1).max(100000).default(1) }).strict().refine(v => !(v.date && v.day), 'Provide date or day, not both').parse(req.query);
    res.json({ status: 'ok', data: await service.schedule(query.date, query.day, query.page) });
  });
  app.post('/v1/admin/blocks', async (req, res) => {
    const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: time, endTime: time, timezone: z.string().refine(IANAZone.isValidZone), reason: z.string().trim().max(200).default('Unavailable') }).strict().parse(req.body);
    res.status(201).json({ status: 'blocked', data: await service.blockTime(body) });
  });
  app.delete('/v1/admin/blocks/:id', async (req, res) => {
    await service.removeTimeBlock(z.uuid().parse(req.params.id));
    res.json({ status: 'removed', message: 'Blocked hours removed. Availability will still respect working hours and calendar conflicts.' });
  });
  app.post('/v1/admin/booking-options', async (req, res) => {
    const settings = await service.settings.config();
    const body = z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(254), phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +919876543210'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timezone: z.string().default(settings.DEFAULT_TIMEZONE).refine(IANAZone.isValidZone), meetingType: z.enum(['support', 'onboarding']) }).strict().parse(req.body);
    res.json(await service.adminBookingOptions(body));
  });
  app.post('/v1/admin/bookings', async (req, res) => {
    const body = z.object({ sessionId: z.uuid(), slotId: z.uuid(), confirmed: z.literal(true) }).strict().parse(req.body);
    const key = z.string().min(8).max(200).parse(req.get('idempotency-key'));
    const result = await service.adminBook(body.sessionId, body.slotId, key);
    res.status(['creating', 'reconciling', 'meet_pending'].includes(result.status) ? 202 : ['failed', 'slot_unavailable', 'slot_expired'].includes(result.status) ? 409 : 200).json(result);
  });
  app.get('/v1/admin/bookings/:id', async (req, res) => {
    res.json(service.bookingResult(await service.process(z.string().min(1).max(100).parse(req.params.id))));
  });
  app.get('/health', async (_req, res) => {
    try { await service.store.db.command({ ping: 1 }); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.post('/v1/google/connect', auth(config.ADMIN_API_KEY), limiter, async (_req, res) => {
    res.json({ status: 'authorization_required', data: { authorizationUrl: await google.connectUrl() } });
  });
  app.get('/v1/google/callback', limiter, async (req, res) => {
    const query = z.object({ state: z.string().min(1).max(200), code: z.string().max(4096).optional(), error: z.string().max(200).optional() }).parse(req.query);
    await google.callback(query.state, query.error ? undefined : query.code);
    res.type('text').send('Google Calendar connected. You may close this window.');
  });
  app.get('/v1/google/status', auth(config.ADMIN_API_KEY), async (_req, res) => {
    const connection = await service.store.connections.findOne({ org: service.org });
    res.json({ status: connection?.state ?? 'not_connected', data: { calendarId: connection?.calendarId ?? null, bookingInProgress: Boolean(connection?.activeBooking) } });
  });
  app.use('/v1', auth(config.SERVICE_API_KEY), limiter);
  const id = z.string().min(1).max(100);
  app.post('/v1/sessions', async (req, res) => {
    const input = z.object({
      customerRef: z.string().min(1).max(200), name: z.string().trim().min(1).max(120),
      email: z.email().max(254), timezone: z.string().refine(IANAZone.isValidZone, 'Use an IANA timezone, e.g. Asia/Kolkata').optional(),
      meetingType: z.enum(['support', 'onboarding']).default('onboarding')
    }).strict().parse(req.body);
    res.status(201).json(await service.createSession(input));
  });
  app.post('/v1/sessions/:id/interpret', async (req, res) => {
    const body = z.object({ text: z.string().trim().min(1).max(1000) }).strict().parse(req.body);
    res.json(await service.interpret(id.parse(req.params.id), body.text));
  });
  app.post('/v1/sessions/:id/availability', async (req, res) => {
    const body = z.object({ page: z.coerce.number().int().min(0).max(9).default(0) }).strict().parse(req.body ?? {});
    res.json(await service.availability(id.parse(req.params.id), body.page));
  });
  app.post('/v1/sessions/:id/select', async (req, res) => {
    const body = z.object({ selection: z.string().trim().min(1).max(100) }).strict().parse(req.body);
    res.json(await service.select(id.parse(req.params.id), body.selection));
  });
  app.post('/v1/sessions/:id/book', async (req, res) => {
    const body = z.object({ confirmed: z.literal(true), confirmationToken: z.uuid() }).strict().parse(req.body);
    const key = z.string().min(8).max(200).parse(req.get('idempotency-key'));
    const result = await service.book(id.parse(req.params.id), key, body.confirmationToken);
    res.status(['creating', 'reconciling', 'meet_pending'].includes(result.status) ? 202 : ['slot_unavailable', 'slot_expired', 'failed'].includes(result.status) ? 409 : 200).json(result);
  });
  app.get('/v1/bookings/:id', async (req, res) => { res.json(service.bookingResult(await service.process(id.parse(req.params.id)))); });
  app.post('/v1/bookings/:id/cancel', async (req, res) => { res.json(await service.cancel(id.parse(req.params.id))); });
  app.use((_req, _res, next) => next(new ApiError(404, 'not_found', 'Endpoint not found.')));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    let code = 500; let status = 'internal_error'; let message = 'The request could not be completed.';
    if (error instanceof ApiError) { code = error.statusCode; status = error.code; message = error.message; }
    else if (error instanceof z.ZodError) { code = 422; status = 'invalid_input'; message = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '); }
    else if (error?.type === 'entity.parse.failed') { code = 400; status = 'invalid_json'; message = 'Request body must be valid JSON.'; }
    else if (error?.type === 'entity.too.large') { code = 413; status = 'input_too_large'; message = 'Request is too large.'; }
    // Never log request bodies, tokens, provider errors, OAuth codes, or customer details.
    if (code >= 500) console.error(JSON.stringify({ event: 'request_failed', requestId: res.locals.requestId, code: status }));
    res.status(code).json({ status, message, data: null, requestId: res.locals.requestId });
  };
  app.use(errors);
  return app;
}
