# Dynamic list demo

Import `dynamic-list-demo.json` into the flow builder, choose your WhatsApp incoming-chat channel, save and activate the test flow.

The flow uses API node v2 with Success, Non-2xx response and Request failed outputs. Only Success opens the dynamic list; API errors send a separate message and end.

The flow sends a good-morning greeting, calls the calendar backend's public static `/demo/list-options` endpoint, then displays Morning, Afternoon and Evening as a dynamic WhatsApp list. A selection receives an acknowledgement; empty, invalid and five-minute timeout outcomes have separate messages.

The JSON already includes the active calendar ngrok URL. No API key is required for this static demo route. It exposes no customer or calendar data and creates no bookings. Normal calendar routes retain authentication.

Use the local feature frontend, compiler and Temporal worker together. A production worker must support dynamic options before this JSON can run there. The calendar backend and tunnel must remain running.

To populate the builder variable picker after import, open the API node, click **Test request**, run the request, choose **Use as example**, then save the API node. In the list node, select **API → data → items**. The JSON includes a synthetic 200 response example from the mock route, plus 400/500 examples. Import removes the active sample payload; use the 200 example and save, or run Test request → Use as example to refresh it from the backend. The API call fetches fresh values when the flow runs.

The source is `{{an_1.data.items}}`, with `{{item.id}}`, `{{item.title}}`, and `{{item.description}}` mappings.

Regenerate for a changed tunnel:

```bash
CALENDAR_DEMO_BASE_URL=https://your-calendar-tunnel.example node scripts/generate-dynamic-list-demo.mjs
```
