# Inbound calendar flow with interactive choices

## Prerequisites

Deploy the Temporal and compiler changes from `feature/variable-buttons-lists` before importing this flow. Enable the frontend authoring flag only after those services are ready. The separate `fix/json-import-flow` fix is required to retain API credentials and confirmation/idempotency expressions on import. Fix the known production delivery-status timeout before live testing.

The local JSON contains the current ngrok URL and private service credential. Keep it private. Regeneration preserves that configuration. Google OAuth and admin credentials stay in the backend.

## Import and configure

- Import `flowflex-inbound-calendar.json` into a new draft. It replaces the current canvas.
- Attach the appropriate customer-initiated WhatsApp trigger/campaign/channel and configure inbound re-entry so replies resume the active flow.
- Verify the URL in the setup variable node and the service authorization on all six API nodes. Booking body uses the confirmation value and its header uses the session-based idempotency key.
- Select an eligible team for the agent assignment node.
- Review the supplied Basic pricing copy and configure support/onboarding duration and working hours in the calendar admin portal.
- Restart the calendar backend to expose the additive slot title/description fields used by the dynamic list.

## Customer experience

- Welcome buttons: Book meeting / Pricing / Not now.
- Meeting type list: Onboarding / Support.
- Text replies collect name, email, and preferred date. The backend infers a primary IANA timezone from the WhatsApp number's country and the flow states that timezone in every date/time prompt.
- If a date has no slots, the same bounded booking loop asks the customer to choose another date.
- A dynamic list displays nine real slots plus **More times** while another page exists. The final page can display ten real slots.
- One Repeat Until state machine moves through `date`, `slot`, and `confirm`. Its explicit `slot_page` starts at zero and increments only when the customer chooses **More times**.
- If another customer takes the selected slot before Google booking, the backend reopens the same session and the flow returns to date and time selection. A new confirmation token also creates a new idempotency key.
- Availability pages and rejected/expired selections fail closed to the team handoff. The complete booking conversation is bounded to ten state transitions.
- Booking confirmation buttons: Confirm booking / Not now / Talk to team.
- The success message is sent only for a confirmed booking with a Meet link. Pending or failed results show the backend message and hand off to the team without creating another booking.
- Interactive nodes require tapping an option; typing a number is not a list selection. Welcome, meeting-type, name, and confirmation timeouts exit; email, date, and slot failures hand off.

## Validation and limitations

The practical graph has 53 nodes and 78 edges. The checker validates real handles and compilation and runs 19 mocked scenarios, including another-day selection, **More times**, and a two-customer slot race followed by successful reselection. Seventeen save-variable nodes are present because FlowFlex needs explicit state writes at each loop branch; they hold the stage, page, retry prompt, confirmation token, or terminal outcome rather than duplicating whole date/slot subgraphs. The flow intentionally omits global keyword interception, repeated generic gates, and in-flow status polling. The backend recovery worker still reconciles pending bookings.

This remains a booking pilot: pricing questions, cancellation and rescheduling go to a person. It does not implement the full sales FAQ, permanent opt-out storage, brochures, or scheduled nurture flows. No live WhatsApp messages or Google bookings are created by the checker.

**Files:** `flowflex-inbound-calendar.json`, `../scripts/check-inbound-flow.cjs`
