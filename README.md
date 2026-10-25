# customcalander

Standalone Express/TypeScript backend for booking support and onboarding meetings from Flowflex's existing API node. No new flow-builder node is required.

## What it does

- Connects one Google organizer per configured internal organization using OAuth.
- Validates email format; customers confirm the address before booking. This does not verify inbox ownership.
- Parses clear numeric dates locally and uses OpenAI for natural-language dates and clarification replies.
- Calculates slots from organizer working hours, customer timezone, Google busy periods, meeting length, buffers and minimum notice.
- Stores numbered slot choices and issues an expiring confirmation token for the selected slot.
- Creates Google Calendar invitations and requests a separate Google Meet conference for each booking.
- Handles duplicate requests, concurrent bookings, uncertain Google writes, pending Meet creation and cancellation.

Flowflex collects and sends WhatsApp messages. This service returns messages and data; it does not send WhatsApp messages directly.

## Run locally

Requires Node.js 22+, npm, MongoDB, Google OAuth credentials and an OpenAI API key/model.

```bash
cd /Users/fcsastlap029/Desktop/flowflex/customcalander
cp .env.example .env
npm ci
```

Generate three separate random values for SERVICE_API_KEY, ADMIN_API_KEY and TOKEN_ENCRYPTION_KEY. Each invocation generates a fresh 32-byte base64 value:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Fill `.env` with your own credentials and model name, then start MongoDB and run:

```bash
npm run dev
```

Alternatively, after filling `.env`, run the local Docker stack:

```bash
docker compose up --build -d
curl http://localhost:3080/health
```

The compose setup binds the HTTP port to localhost and does not publish MongoDB. For remote Flowflex workers, deploy this service behind HTTPS on a reachable hostname. The local compose database has no authentication; use a protected/authenticated database for deployment. Do not expose the development database publicly.

## Connect Google

1. Enable Google Calendar API in a Google Cloud project.
2. Configure the OAuth consent screen. Add your organizer as a test user if the app is in external Testing mode.
3. Create a Web Application OAuth client and register the exact GOOGLE_REDIRECT_URI. Use the HTTPS callback URL for deployment; localhost works for development.
4. Fill GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in `.env`.
5. Request the connection URL using the separate admin key:

```bash
curl -X POST http://localhost:3080/v1/google/connect \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Open `data.authorizationUrl` in your browser and authorize the organizer account. Check the connection with:

```bash
curl http://localhost:3080/v1/google/status \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

These commands assume the shell variables contain your keys; `.env` is loaded by the application, not automatically by your shell. Never paste keys into screenshots or commit them.

Scopes are `openid`, `calendar.freebusy` and `calendar.events`. OpenID is used to verify that reconnecting uses the original organizer. Customers do not sign in with Google. The organizer's primary calendar must support Google Meet conferences.

The OAuth state is single-use and expires after 10 minutes. Tokens are encrypted with AES-256-GCM. Preserve TOKEN_ENCRYPTION_KEY across restarts; changing it without migrating credentials makes existing tokens unreadable. Revoked Google access requires a fresh connect flow using the same account. Switching organizers is intentionally unsupported in this first version.

External OAuth apps in Testing can have refresh tokens expire after seven days; configure an appropriate internal/production consent setup before relying on this for ongoing work. See [Google OAuth documentation](https://developers.google.com/identity/protocols/oauth2).

## API contract

### Admin portal

Open `http://localhost:3080/` (or `/index.html`) after starting the server. Enter ADMIN_API_KEY to unlock the portal; the key stays in tab memory and is cleared when you lock or reload the page.

- **Book a meeting:** Enter customer name, international-format phone (e.g. +919876543210), email, meeting type, date and timezone. Find available times, choose a slot, check the confirmation box and click **Book & send**. The existing booking service checks availability and blocked hours, creates the Calendar event/invitation, and saves the phone with the booking. If processing or Meet generation is pending, use **Check booking status**. Network retries reuse the same request key. The schedule shows customer phone and custom-flow notification status.
- **Custom-flow notification placeholder:** Admin bookings create an idempotent record in `meeting_notifications`. Once the meeting and Meet link are confirmed, its payload is prepared with status `not_configured`. No custom API is called and no WhatsApp message is sent yet. The portal explicitly distinguishes this from the Google Calendar email invitation. Failed/cancelled bookings do not retain a ready scheduling payload. Supply the endpoint, authentication, request mapping and expected response to connect the transport in `src/notifications.ts`. Do not automatically replay historical records when enabling delivery; first check booking date and cancellation state.

Admin booking endpoints: POST `/v1/admin/booking-options` (customer name, phone, email, date, timezone, meetingType), POST `/v1/admin/bookings` (sessionId, slotId, confirmed: true; Idempotency-Key header required), and GET `/v1/admin/bookings/:id` (status/reconciliation). All use the admin key. The provisional custom-flow payload contains event, idempotencyKey, bookingId, customer { name, phone, email }, and meeting { type, startTime, endTime, timezone, googleEventId, meetUrl }.

- **Schedule:** Today, Tomorrow or any chosen date, with customer name/email, meeting type, status and a Meet link. Dates and times use the organizer timezone, and overlapping midnight bookings appear on both applicable dates. Results are paginated, 50 per page. This is a list of customcalander bookings, not all events on the connected Google Calendar.
- **Availability settings:** Change timezone, working days/hours, meeting durations, buffer, minimum notice, booking horizon and slot/conversation expiry. These values are stored in MongoDB's `schedule_settings` collection, scoped to ORGANIZATION_ID. Until the first save, the portal uses `.env` defaults. Saved values override those defaults and are read on each scheduling operation; restart is unnecessary.
- **Google connection:** Connect/reconnect the organizer from the portal, then refresh after authorization.
- **Blocked hours:** On the Schedule tab, choose a date, From/Until times and an optional reason, then select Block hours. Lunch breaks, team meetings and time off are saved in MongoDB and excluded from new availability and pre-booking checks. Remove a block to reopen the interval (normal working hours and calendar conflicts still apply). Blocks use the organizer timezone and are one-off, same-day intervals; create one per date for a multi-day absence. Ambiguous/nonexistent DST times are rejected. This does not create a Google event or cancel an existing meeting. Booking requests already being written to Google may finish; the portal warns when an existing request overlaps. Removal keeps a soft-deleted record for audit.

Your team can use the same portal with the admin access key. This version uses shared admin access, not individual team accounts or per-person permissions. Keep the admin key with trusted scheduling staff; it also authorizes Google connection management.

Confirmed meetings are not moved by settings changes. New sessions use the current default timezone and expiry; existing sessions retain their timezone/expiry. Previously offered slots are revalidated against the current rules before booking. Concurrent settings edits return a conflict rather than silently overwriting another admin's changes.

Database connection, API keys, Google credentials, OpenAI model/key, organization ID and server options remain environment settings and are never returned by the portal API. Use HTTPS outside local development.

Admin-only endpoints are GET/PUT `/v1/admin/settings` and GET `/v1/admin/schedule?day=today`, `?day=tomorrow` or `?date=YYYY-MM-DD`. Schedule requests accept `page`, defaulting to 1. PUT settings takes `{ "version": <loaded revision>, "values": <complete settings object> }`.

POST `/v1/admin/blocks` accepts `{ "date": "2026-09-21", "startTime": "13:00", "endTime": "14:00", "timezone": "Asia/Kolkata", "reason": "Lunch" }`. DELETE `/v1/admin/blocks/:id` removes a block. The schedule endpoint includes that date's active blocks.

In `.env`, use plain names such as `MONGODB_URI` (no backslash escapes), and a plain callback URL such as `GOOGLE_REDIRECT_URI=http://localhost:3080/v1/google/callback` (not a Markdown link).

### Booking API

All `/v1/sessions` and `/v1/bookings` routes require:

```http
Authorization: Bearer <SERVICE_API_KEY>
Content-Type: application/json
```

The admin key is for `/v1/google/connect` and `/v1/google/status` only. The OAuth callback uses its validated state instead of an API key. Do not send the admin key through a customer flow. Keep the service key limited to authorized flow editors/server-side API calls.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/health` | Checks database connectivity; not a Google/OpenAI readiness check |
| POST | `/v1/sessions` | Customer reference, name, email and meeting type; timezone is optional and otherwise inferred from the phone country |
| POST | `/v1/sessions/:id/interpret` | `{ "text": "tomorrow afternoon" }`; retains last four exchanges |
| POST | `/v1/sessions/:id/availability` | Body `{ "page": 0 }`; returns nine slots plus a `__next__` row while more pages exist, or up to ten slots on the final page |
| POST | `/v1/sessions/:id/select` | `{ "selection": "2" }` or a returned slot ID |
| POST | `/v1/sessions/:id/book` | `{ "confirmed": true, "confirmationToken": "..." }`; Idempotency-Key header required |
| GET | `/v1/bookings/:id` | Retrieves/reconciles a pending booking and polls Meet status |
| POST | `/v1/bookings/:id/cancel` | Cancels the event and requests attendee updates |

Create a session:

```json
{
  "customerRef": "flowflex-contact-id",
  "name": "Arun",
  "email": "arun@example.com",
  "timezone": "Asia/Kolkata",
  "meetingType": "onboarding"
}
```

When timezone is omitted, the service parses the international customer reference, maps its country to a primary IANA timezone, and falls back to `DEFAULT_TIMEZONE` only when the phone is invalid or unsupported. Calling codes cannot identify a city inside multi-timezone countries such as the US, Canada or Australia, so this is a country default; an explicit timezone remains the precise override. The flow must tell the customer which timezone it is using. For a changed email, timezone or meeting type, start a new session before booking.

Successful conversation responses use this envelope:

```json
{
  "status": "awaiting_confirmation",
  "sessionId": "session-id",
  "message": "Confirm your onboarding meeting: ...",
  "data": {
    "slotId": "slot-id",
    "email": "arun@example.com",
    "confirmationToken": "uuid"
  }
}
```

HTTP 202 means processing continues; poll `GET /v1/bookings/:id`. An HTTP 409 conflict does not mean a network error: branch on the JSON status. Validation errors return 422; authentication errors return 401; unavailable services return 503. Generic errors do not expose provider responses or credentials. A request ID is included for unexpected error correlation.

## Date interpretation rules

- `20-09-2026`, `20/9/2026`, `20/09/26` and `2026-09-20` normalize to the same date. Two-digit years mean 2000–2099.
- `06/07/2026` asks which month/day is intended. Reply with the month written out.
- Past dates, invalid dates and dates beyond the configured horizon are rejected.
- Natural-language input is sent to the configured OpenAI model using the Responses API with Structured Outputs and `store: false`.
- The model receives date text, timezone, server current time and limited clarification history. Customer name/email, tokens and calendar event details are not included. Date text itself may contain whatever the customer typed; do not send unnecessary personal data in it.
- OpenAI schema validation does not prove a date interpretation is correct. Server validation and the final explicit date/time/email confirmation are required.
- Periods are morning (before 12), afternoon (12–17) and evening (17 onward), in the customer's timezone. Exact typed times are not reservations; customers must select an offered slot.
- OpenAI errors/refusals fail closed; the customer may retry with an ISO date instead.

## Booking consistency and recovery

A booking call freezes the selected slot and confirmation token. Reuse the same idempotency key for transport retries of that exact confirmation. If final validation reports `slot_unavailable` or `slot_expired`, the backend safely reopens the session, clears its date/selection and returns `data.canReselect: true`; the next selected slot uses its new confirmation token as a new idempotency key. All other uncertain outcomes remain frozen for reconciliation.

The Google event ID is derived from the stored booking ID. Before retrying an uncertain insert, the service looks up that exact event. If an insert is still necessary, it uses the same event ID and conference request ID. Google is never asked to blindly create a fresh event on retry.

MongoDB stores a durable per-organizer booking lock and a renewable processing lease. A second booking waits until the first is resolved. Availability is rechecked while holding the organizer lock. App reservations and Google busy intervals both exclude occupied times. MongoDB standalone is supported; transactions are not required.

A recovery loop runs on startup and every 30 seconds. It restores a frozen session if the process stopped before inserting its booking, reconciles uncertain writes, retries pending cancellation and polls pending Meet generation. An unresolved Google write intentionally keeps the organizer locked. If `data.errorCode` is `reconciliation_needs_review`, notify an operator: check the event ID in Google and investigate before clearing any lock. Never delete the lock merely to resume bookings.

The lock coordinates this application only. Manual Calendar edits or other booking applications are outside its transaction boundary. Existing confirmed bookings are not continuously synchronized from Google in this version. Use this service for cancellation; manual edits require operational review.

Sessions expire after SESSION_TTL_HOURS. Booking records remain for reconciliation/audit; define your organization's retention policy before wider rollout.

## Verification

```bash
npm run build
npm test
```

Tests use a temporary local MongoDB server plus fake Google/OpenAI providers, never send invitations, and never call a paid model. The test dependency may download a MongoDB binary on first use. Alternatively set TEST_MONGODB_URI to an isolated test server; the suite creates and drops its own `customcalander_test_<pid>` database.

Tests cover phone-country timezone inference, numeric/ambiguous dates, timezone boundaries and DST, another-day selection, paginated availability, selection from later pages, slot-race recovery, email validation, confirmation, expired choices, concurrency, idempotency, uncertain provider responses, pending Meet, cancellation and recovery.

For live acceptance, connect a test organizer and use an attendee email you control. Run one natural-language clarification, book a slot, verify the Calendar invitation and Meet URL, retry the exact request to confirm no duplicate, then cancel. This requires real credentials and will send real Calendar notifications.

## First-version boundaries

- One organization, organizer and primary calendar per service deployment/database.
- One attendee email per meeting; no inbox OTP verification.
- No dedicated flow-builder node or changes to the Flowflex frontend; a standalone admin portal is included.
- Availability supports numbered text and dynamic WhatsApp lists. The main flow stores an explicit zero-based `slot_page`, increments it only for the synthetic `__next__` ID, and never treats navigation as a bookable slot.
- No round-robin assignment, calendar-selection UI, reminders or in-place rescheduling. Rescheduling is cancel plus a new booking.
- Working hours use the organizer's configured timezone. Slots display the customer timezone and UTC offset.
- Google/OpenAI credentials are required for live operation. OPENAI_MODEL defaults to `gpt-5.4-mini`, which supports the Responses API and Structured Outputs. Your OpenAI API project must have model access. See the [official model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

See [Flowflex integration guide](docs/flowflex.md) for node-by-node mappings.
