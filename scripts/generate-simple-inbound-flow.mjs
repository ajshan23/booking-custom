// A small inbound flow for testing the booking: welcome message → "Book a demo" →
// fire the demo.booking event (starts the Demo booking flow).
// Usage: node scripts/generate-simple-inbound-flow.mjs [output.json]
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const output = process.argv[2] ?? new URL('../flows/inbound-simple-book-demo.json', import.meta.url).pathname;
const EVENT_URL = 'https://api.flowflex.ai/v1/events/ic_26c925f89d030f6e7dd48078';
const nodes = [], edges = [];
const edgeStyle = { type: 'button', style: { stroke: 'rgb(127, 86, 217)', strokeWidth: 2 }, data: { readOnly: false, highlighted: false } };
const node = (type, title, displayName, data, y) => { const n = { id: randomUUID(), type, position: { x: 0, y }, data: { title, displayName, description: '', ...data } }; nodes.push(n); return n; };
const edge = (a, b, handle) => edges.push({ id: `flow-edge-${randomUUID()}`, source: a.id, target: b.id, sourceHandle: `${handle}-${a.id}`, targetHandle: 'target', ...edgeStyle });
const text = (title, displayName, body, y) => node('whatsappTextNode', title, displayName, {
  to: '{{tg.from}}', message_type: 'text', invalid_response_text: 'Please provide a valid response', meta_payload: { body },
  form_payload: { to: '{{tg.from}}', body, is_response_wait: false, is_check_format: false, format_unit: 'text', response_wait: '1', response_wait_unit: 'minutes' }
}, y);

const trigger = node('triggerNode', 'triggerNode_1', 'WhatsApp message', { topic: 'whatsapp.incoming_message', trigger: 'whatsapp', trigger_topic_title: 'WhatsApp Incoming Chat', trigger_topic_description: 'Workflow starts when a new chat is created' }, 0);
const welcomeBody = 'Hi 👋 Welcome to *FlowFlex AI*!\n\nWould you like a quick 15-minute demo? Tap *Book a demo* to pick a time that suits you.';
const titles = ['Book a demo', 'Not now'];
const welcome = node('buttonMessageNode', 'buttonMessageNode_1', 'Welcome', {
  to: '{{tg.from}}', message_type: 'interactive',
  meta_payload: { type: 'button', body: { text: welcomeBody }, action: { buttons: titles.map((title, i) => ({ type: 'reply', reply: { id: `BUTTON_${i + 1}`, title } })) } },
  form_payload: { to: '{{tg.from}}', header_type: 'none', body: welcomeBody, footer: '', buttons: titles.map(title => ({ title })), is_response_wait: true, response_wait: '30', response_wait_unit: 'minutes', is_check_format: false, format_unit: 'text' }
}, 220);
const book = node('apiNode', 'apiNode_1', 'Start demo booking', {
  request_version: 2, outcome_mode: 'branches', method: 'POST', api_type: 'custom', body_mode: 'json', timeout_ms: 30000,
  on_http_error: 'continue', on_transport_error: 'continue', url: EVENT_URL, parameters: [], content_type: 'application/json',
  headers: [{ key: 'x-event', value: 'demo.booking' }, { key: 'x-api-key', value: '' }, { key: 'x-api-secret', value: '' }],
  body: { customer_phone: '{{tg.from}}', customer_name: '{{tg.name}}', lang: 'en' }
}, 460);
const notNow = text('whatsappTextNode_1', 'Not now', "No problem. Message us here whenever you'd like a demo. Thank you!", 460);
const failed = text('whatsappTextNode_2', 'Booking could not start', "Sorry, I couldn't open the booking right now. Our team will help you here in this chat.", 700);
const end = node('endFlowNode', 'endFlowNode_1', 'End', {}, 940);
notNow.position.x = 380; failed.position.x = 380;

edge(trigger, welcome, 'next-step');
edge(welcome, book, 'BUTTON_1'); edge(welcome, notNow, 'BUTTON_2'); edge(welcome, end, 'no-response');
edge(book, end, 'success'); edge(book, failed, 'http-error'); edge(book, failed, 'request-failed');
edge(notNow, end, 'next-step'); edge(failed, end, 'next-step');

writeFileSync(output, JSON.stringify({ _nodes: nodes, _edges: edges }, null, 2) + '\n');
console.log(`Wrote ${nodes.length} nodes, ${edges.length} edges to ${output}`);
