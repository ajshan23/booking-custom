// Adds Google Calendar booking to an exported "inbound Facebook ad" flow, as two flows:
//   1. The ad flow: every "Book demo" button fires the custom-integration event
//      `demo.booking` (customer phone, name, language) and ends.
//   2. A "Demo booking" flow triggered by that event: email → day → time → confirm,
//      then the original `demo.booked` call that informs the team, then the confirmation.
// Booking cannot live inside the ad flow: the compiler copies everything after a button
// once per path, and the ad flow already copies "Book demo" 128 times.
// Usage: node scripts/generate-facebook-ad-flow.mjs <exported-ad-flow.json> [output-dir]
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [input, outDir = new URL('../flows/', import.meta.url).pathname] = process.argv.slice(2);
if (!input) throw new Error('Pass the exported flow JSON path.');
const ad = JSON.parse(readFileSync(input, 'utf8'));
const find = (list, prefix) => list.find(n => n.id.startsWith(prefix)) ?? (() => { throw new Error(`Node ${prefix} not found`); })();

const BASE = 'https://booking.flowflex.ai';
const BOOKING_EVENT = 'demo.booking';
// Per language: the "Book demo" API node, its old "demo confirmed" text, and the
// "type your question" text used when the event cannot be sent.
const AD = {
  en: { api: '7effd51e', confirmed: '9b51744c', question: '3c3740c3' },
  it: { api: '13a703b3', confirmed: '4a12ed13', question: 'c6bb172b' },
  es: { api: 'f08002aa', confirmed: 'f66d63ac', question: 'f92c7fae' }
};
for (const lang of Object.keys(AD)) for (const k of Object.keys(AD[lang])) AD[lang][k] = find(ad._nodes, AD[lang][k]).id;

const T = {
  en: {
    email: 'Great! 🙌 What email should we send the Google Meet invite to?',
    email_retry: "That email doesn't look right. Please type a valid address, e.g. name@company.com",
    date: '📅 Which day works for your 15-minute demo?\n\nYou can write things like *tomorrow*, *Monday after 3 pm* or *next week*. Times are shown in',
    slots: 'Here are the free times 👇 Tap *Times* to pick one. Need a different day? Choose *Another day* at the end of the list.',
    other_day: '📅 Another day',
    list_button: 'Times',
    confirm: 'Please confirm your demo:',
    change: 'No problem. Which other day works for you?',
    handoff: "I couldn't finish the booking automatically, so our team will help you right here in this chat. 🙏",
    exit: "No problem. If you'd like to book later, just message us here. Thank you!",
    btn_1: 'Confirm', btn_2: 'Change time', btn_3: 'Talk to team',
    done_1: '🎉 Your FlowFlex demo call has been confirmed!',
    done_2: 'A Google Calendar invite is on its way to',
    done_3: 'Thank you for your interest in FlowFlex!😊'
  },
  it: {
    email: "Perfetto! 🙌 A quale email inviamo l'invito Google Meet?",
    email_retry: "L'email non sembra corretta. Scrivi un indirizzo valido, ad es. nome@azienda.com",
    date: '📅 Quale giorno va bene per la demo di 15 minuti?\n\nPuoi scrivere ad esempio *domani*, *lunedì dopo le 15* o *la prossima settimana*. Orari mostrati in',
    slots: 'Ecco gli orari liberi 👇 Tocca *Orari* per sceglierne uno. Ti serve un altro giorno? Scegli *Un altro giorno* in fondo alla lista.',
    other_day: '📅 Un altro giorno',
    list_button: 'Orari',
    confirm: 'Conferma la tua demo:',
    change: 'Nessun problema. Quale altro giorno ti va bene?',
    handoff: 'Non sono riuscito a completare la prenotazione in automatico: il nostro team ti aiuterà qui in chat. 🙏',
    exit: 'Nessun problema. Se vuoi prenotare più avanti, scrivici qui. Grazie!',
    btn_1: 'Conferma', btn_2: 'Cambia orario', btn_3: 'Parla col team',
    done_1: '🎉 La tua demo FlowFlex è confermata!',
    done_2: "Riceverai anche l'invito di Google Calendar su",
    done_3: 'Grazie per il tuo interesse in FlowFlex! 😊'
  },
  es: {
    email: '¡Genial! 🙌 ¿A qué email enviamos la invitación de Google Meet?',
    email_retry: 'Ese email no parece correcto. Escribe una dirección válida, p. ej. nombre@empresa.com',
    date: '📅 ¿Qué día te viene bien para la demo de 15 minutos?\n\nPuedes escribir por ejemplo *mañana*, *lunes después de las 15* o *la próxima semana*. Horarios en',
    slots: 'Estos son los horarios libres 👇 Toca *Horarios* para elegir uno. ¿Necesitas otro día? Elige *Otro día* al final de la lista.',
    other_day: '📅 Otro día',
    list_button: 'Horarios',
    confirm: 'Confirma tu demo:',
    change: 'Sin problema. ¿Qué otro día te viene bien?',
    handoff: 'No pude completar la reserva automáticamente; nuestro equipo te ayudará aquí en el chat. 🙏',
    exit: 'Sin problema. Si quieres reservar más adelante, escríbenos aquí. ¡Gracias!',
    btn_1: 'Confirmar', btn_2: 'Cambiar hora', btn_3: 'Hablar con equipo',
    done_1: '🎉 ¡Tu demo de FlowFlex está confirmada!',
    done_2: 'También recibirás la invitación de Google Calendar en',
    done_3: '¡Gracias por tu interés en FlowFlex! 😊'
  }
};

const edgeStyle = { type: 'button', style: { stroke: 'rgb(127, 86, 217)', strokeWidth: 2 }, data: { readOnly: false, highlighted: false } };
const PREFIX = { apiNode: 'an', whatsappTextNode: 'wtn', buttonMessageNode: 'bmn', listMessageNode: 'lmn', conditionSplitNode: 'csn', conditionBranchNode: 'cbn', saveVariableNode: 'svn', repeatUntilNode: 'run', endLoopNode: 'eln', triggerNode: 'tg', endFlowNode: 'efn' };

// ---------------------------------------------------------------- 1. Ad flow
const removed = new Set(Object.values(AD).map(a => a.confirmed));
ad._nodes = ad._nodes.filter(n => !removed.has(n.id));
ad._edges = ad._edges.filter(e => !removed.has(e.source) && !removed.has(e.target) && !Object.values(AD).some(a => a.api === e.source));
const adEnd = ad._nodes.find(n => n.type === 'endFlowNode');
const adEdge = (source, target, handle) => ad._edges.push({ id: `flow-edge-${randomUUID()}`, source, target, sourceHandle: `${handle}-${source}`, targetHandle: 'target', ...edgeStyle });
const eventApi = find(ad._nodes, AD.en.api); // template for the team notification in flow 2
const notifyTemplate = structuredClone(eventApi.data);
for (const [lang, ids] of Object.entries(AD)) {
  const n = find(ad._nodes, ids.api);
  n.data.displayName = `Start demo booking (${lang})`;
  n.data.headers = n.data.headers.map(h => h.key === 'x-event' ? { ...h, value: BOOKING_EVENT } : h);
  n.data.body = { customer_phone: '{{tg.from}}', customer_name: '{{tg.name}}', lang };
  n.data.response_examples = [{ id: 'example-saved', status: 200, body: { ok: true, id: '6712f0c4a1b2c3d4e5f60789', idempotent: false } }];
  adEdge(n.id, adEnd.id, 'success');
  // If the event cannot be sent, the team picks the chat up as a question.
  adEdge(n.id, ids.question, 'http-error');
  adEdge(n.id, ids.question, 'request-failed');
}

// Tags by name only: the Worker finds or creates each tag in its own workspace when
// it is published, so the file carries no tag ids from this workspace.
for (const n of ad._nodes) {
  if (n.type === 'updateTagNode') {
    const names = (n.data.meta_payload?.tags ?? []).map(t => (typeof t === 'object' ? t.name : '')).filter(Boolean);
    n.data.meta_payload.tags = names.map(name => ({ name }));
    if (n.data.form_payload) n.data.form_payload.tags = names;
  }
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.source === 'contact_tags' && Array.isArray(value.value)) {
      const labels = value.tag_names ?? {};
      const names = value.value.map(id => labels[id] ?? (String(id).startsWith('name:') ? String(id).slice(5) : null)).filter(Boolean);
      value.value = names.map(name => `name:${name}`);
      value.tag_names = Object.fromEntries(names.map(name => [`name:${name}`, name]));
    }
    Object.values(value).forEach(visit);
  };
  visit(n.data);
}

// Media headers point at a file in the exporting workspace, which the importing
// workspace does not have (publish says "The file this step sends has been deleted").
// Drop them; re-add the file on the step if it is wanted.
for (const n of ad._nodes) {
  const header = n.data.meta_payload?.header;
  if (!header || !['document', 'image', 'video'].includes(header.type)) continue;
  delete n.data.meta_payload.header;
  const form = n.data.form_payload ?? {};
  for (const k of ['header_media_source', 'header_uploaded_file', 'header_data']) delete form[k];
  form.header_type = 'none';
}

// ---------------------------------------------------------------- 2. Booking flow
const nodes = [], edges = [], counts = {};
const node = (type, displayName, data = {}) => {
  const i = (counts[type] = (counts[type] ?? 0) + 1);
  const n = { id: randomUUID(), type, position: { x: 0, y: 0 }, data: { title: `${type}_${i}`, displayName, description: '', ...data } };
  nodes.push(n); return n;
};
const alias = n => `${PREFIX[n.type]}_${n.data.title.split('_').at(-1)}`;
const edge = (a, b, handle = 'next-step') => edges.push({ id: `flow-edge-${randomUUID()}`, source: a.id, target: b.id, sourceHandle: `${handle}-${a.id}`, targetHandle: 'target', ...edgeStyle });
const group = (filters, method = 'AND') => ({ id: randomUUID(), method, filters: filters.map(f => ({ id: randomUUID(), ...f })) });
const isTrue = expression => [group([{ type: `{{${expression}}}`, value: true, condition: 'boolean_is_true' }])];
const split = (name, expression) => node('conditionSplitNode', name, { conditions: isTrue(expression), filterGroupCondition: 'AND' });
const save = (name, values) => node('saveVariableNode', name, { variables: Object.entries(values).map(([variable_name, value]) => ({ variable_name, value })) });
const TO = '{{tg.customer_phone}}';
const wait = { is_response_wait: true, response_wait: '30', response_wait_unit: 'minutes', is_check_format: false, format_unit: 'text', is_response_valid: false, invalid_message: '' };
const text = (name, body, waits = false) => node('whatsappTextNode', name, {
  to: TO, message_type: 'text', invalid_response_text: 'Please provide a valid response', meta_payload: { body },
  form_payload: { to: TO, body, ...(waits ? wait : { is_response_wait: false, is_check_format: false, format_unit: 'text', response_wait: '1', response_wait_unit: 'minutes' }) }
});
const buttons = (name, body, titles) => node('buttonMessageNode', name, {
  to: TO, message_type: 'interactive',
  meta_payload: { type: 'button', body: { text: body }, action: { buttons: titles.map((title, i) => ({ type: 'reply', reply: { id: `BUTTON_${i + 1}`, title } })) } },
  form_payload: { to: TO, header_type: 'none', body, footer: '', buttons: titles.map(title => ({ title })), ...wait }
});
const api = (name, path, body, extraHeaders = {}) => node('apiNode', name, {
  request_version: 2, method: 'POST', api_type: 'custom', body_mode: 'json', timeout_ms: 30000,
  on_http_error: 'continue', on_transport_error: 'continue',
  url: `${BASE}${path}`, parameters: [], body, content_type: 'application/json',
  headers: [{ key: 'Authorization', value: 'Bearer {{calendar_key}}' }, ...Object.entries(extraHeaders).map(([key, value]) => ({ key, value }))]
});
const loop = (name, max, until) => node('repeatUntilNode', name, { max_iterations: max, conditions: isTrue(until), filterGroupCondition: 'AND' });
const ref = (n, path) => `{{${alias(n)}.${path}}}`;

const trigger = node('triggerNode', 'Demo booking requested', {
  trigger: 'custom_integration', topic: `custom:REPLACE_WITH_INTEGRATION:${BOOKING_EVENT}`,
  trigger_topic_title: BOOKING_EVENT, trigger_topic_description: 'Sent by the ad flow when a customer taps Book demo'
});
const end = node('endFlowNode', 'End');
const langBranch = node('conditionBranchNode', 'Customer language', {
  paths: ['it', 'es', 'en'].map(lang => ({
    label: { en: 'English', it: 'Italian', es: 'Spanish' }[lang], filterGroupCondition: 'AND',
    filters: [group([{ type: '{{tg.lang}}', condition: lang === 'en' ? 'text_not_equal_to_case_insensitive' : 'text_equals_to_case_insensitive', value: lang === 'en' ? 'xx' : lang, variable_type: 'string' }], 'OR')]
  }))
}); edge(trigger, langBranch);
// The service key lives in one place; every booking API node sends it.
const setup = save('Booking setup', {
  calendar_key: 'REPLACE_WITH_SERVICE_API_KEY',
  booking_stage: 'date', slot_page: 0, date_prompt: '', halted: false, attempt_status: '', email_ok: false,
  email_prompt: '{{bk_t_email}}', bk_slot: '', bk_meet: '', bk_email: '', booking_id: ''
});
['it', 'es', 'en'].forEach((lang, i) => {
  const texts = save(`Texts (${lang})`, Object.fromEntries(Object.entries(T[lang]).map(([k, v]) => [`bk_t_${k}`, v])));
  edge(langBranch, texts, `PATH_${i + 1}`); edge(texts, setup);
});
const handoff = text('Hand over to the team', '{{bk_t_handoff}}'); edge(handoff, end);
const exit = text('Customer left the booking', '{{bk_t_exit}}'); edge(exit, end);

// Email: up to three tries. A valid email creates the booking session; the phone's
// country code sets the customer's timezone.
const emailLoop = loop('Ask for an email: up to three tries', 3, '!!halted || email_ok === true'); edge(setup, emailLoop);
const emailEnd = node('endLoopNode', 'End email tries');
const emailQ = text('Ask for invite email', '{{email_prompt}}', true); edge(emailLoop, emailQ);
const emailTimeout = save('Email reply timed out', { halted: 'exit' }); edge(emailQ, emailTimeout, 'no-response'); edge(emailTimeout, emailEnd);
const create = api('Create booking session', '/v1/sessions', {
  customerRef: TO, name: '{{trigger.customer_name || "WhatsApp customer"}}', email: ref(emailQ, 'response.message'), meetingType: 'onboarding'
}); edge(emailQ, create);
const created = split('Session created', `${alias(create)}.ok && !!${alias(create)}.data.sessionId`); edge(create, created);
const sessionSaved = save('Remember session', { email_ok: true, bk_email: ref(create, 'data.data.email') }); edge(created, sessionSaved, 'yes'); edge(sessionSaved, emailEnd);
const emailRetry = save('Email invalid or service error', { email_prompt: '{{bk_t_email_retry}}', halted: `{{${alias(create)}.status === 422 ? false : "human"}}` });
edge(created, emailRetry, 'no'); edge(emailRetry, emailEnd);
const emailReady = split('Continue with a valid email', 'email_ok === true && !halted'); edge(emailEnd, emailReady);
const emailExit = split('Email step: customer went quiet', 'halted === "exit"'); edge(emailReady, emailExit, 'no'); edge(emailExit, exit, 'yes'); edge(emailExit, handoff, 'no');

const sessionId = ref(create, 'data.sessionId');
const timezone = `${alias(create)}.data.data.timezone`;

// Booking conversation: one bounded loop acts as a small state machine for
// day → time → confirm, including "More times", "Change time" and a lost slot race.
const bookingLoop = loop('Booking conversation: up to ten steps', 10, '!!halted || attempt_status === "confirmed"'); edge(emailReady, bookingLoop, 'yes');
const bookingEnd = node('endLoopNode', 'End booking step');
const isDate = split('Step: choose a day', 'booking_stage === "date"'); edge(bookingLoop, isDate);

const dateQ = text('Ask which day', `{{date_prompt || (bk_t_date + " " + ${timezone} + ".")}}`, true); edge(isDate, dateQ, 'yes');
const dateTimeout = save('Day reply timed out', { halted: 'exit' }); edge(dateQ, dateTimeout, 'no-response'); edge(dateTimeout, bookingEnd);
const interpret = api('Understand the day', `/v1/sessions/${sessionId}/interpret`, { text: ref(dateQ, 'response.message') }); edge(dateQ, interpret);
const resolved = split('Day understood', `${alias(interpret)}.ok && ${alias(interpret)}.data.status === "resolved"`); edge(interpret, resolved);
const unavailable = split('Date service failed', `!${alias(interpret)}.ok && ${alias(interpret)}.status !== 422`); edge(resolved, unavailable, 'no');
const dateFailed = save('Date service failed: hand over', { halted: 'human' }); edge(unavailable, dateFailed, 'yes'); edge(dateFailed, bookingEnd);
// Clarifying questions come back in the customer's own language.
const dateRetry = save('Ask again with the clarifying question', { booking_stage: 'date', date_prompt: `{{${alias(interpret)}.data.message}}` }); edge(unavailable, dateRetry, 'no'); edge(dateRetry, bookingEnd);
const firstPage = api('Find free times', `/v1/sessions/${sessionId}/availability`, { page: 0, otherDay: '{{bk_t_other_day}}' }); edge(resolved, firstPage, 'yes');
const hasSlots = split('Free times found', `${alias(firstPage)}.ok && ${alias(firstPage)}.data.status === "slots_available"`); edge(firstPage, hasSlots);
const toSlots = save('Show the times', { booking_stage: 'slot', slot_page: 0 }); edge(hasSlots, toSlots, 'yes'); edge(toSlots, bookingEnd);
// The no-slot message names the next days that do have free times.
const noSlots = save('No free times: ask for another day', { booking_stage: 'date', date_prompt: `{{${alias(firstPage)}.data.message || bk_t_change}}` }); edge(hasSlots, noSlots, 'no'); edge(noSlots, bookingEnd);

const isSlot = split('Step: choose a time', 'booking_stage === "slot"'); edge(isDate, isSlot, 'no');
const page = api('Load a page of times', `/v1/sessions/${sessionId}/availability`, { page: '{{slot_page}}', otherDay: '{{bk_t_other_day}}' }); edge(isSlot, page, 'yes');
const slotList = node('listMessageNode', 'Pick a time', {
  to: TO, message_type: 'interactive', options_mode: 'dynamic',
  dynamic_options: { source: ref(page, 'data.data.slots'), id: '{{item.id}}', title: '{{item.title}}', description: '{{item.description}}', section_title: 'Available times', limit: 10 },
  meta_payload: { type: 'list', body: { text: '{{bk_t_slots}}' }, action: { button: '{{bk_t_list_button}}' } },
  form_payload: { to: TO, header_type: 'none', body: '{{bk_t_slots}}', footer: '', list_title: '{{bk_t_list_button}}', options_mode: 'dynamic', ...wait }
}); edge(page, slotList);
const slotTimeout = save('Time reply timed out', { halted: 'exit' }); edge(slotList, slotTimeout, 'no-response'); edge(slotTimeout, bookingEnd);
const slotFailed = save('Times could not be shown', { halted: 'human' }); edge(slotList, slotFailed, 'empty'); edge(slotList, slotFailed, 'invalid'); edge(slotFailed, bookingEnd);
const more = split('Customer chose More times', `${alias(slotList)}.response.id === "__next__"`); edge(slotList, more, 'selected');
const nextPage = save('Next page of times', { slot_page: '{{slot_page + 1}}' }); edge(more, nextPage, 'yes'); edge(nextPage, bookingEnd);
// Lists ignore typed text, so "Another day" is a row the customer can tap.
const otherDay = split('Customer chose Another day', `${alias(slotList)}.response.id === "__date__"`); edge(more, otherDay, 'no');
const toDate = save('Ask for another day', { booking_stage: 'date', slot_page: 0, date_prompt: '{{bk_t_change}}' }); edge(otherDay, toDate, 'yes'); edge(toDate, bookingEnd);
const select = api('Hold the chosen time', `/v1/sessions/${sessionId}/select`, { selection: ref(slotList, 'response.id') }); edge(otherDay, select, 'no');
const selectedOK = split('Time ready to confirm', `${alias(select)}.ok && ${alias(select)}.data.status === "awaiting_confirmation"`); edge(select, selectedOK);
const reselect = save('Time expired: choose again', { booking_stage: 'date', date_prompt: '{{bk_t_change}}' }); edge(selectedOK, reselect, 'no'); edge(reselect, bookingEnd);
const toConfirm = save('Ask to confirm', {
  booking_stage: 'confirm', confirmation_value: ref(select, 'data.data.confirmationToken'),
  bk_slot: `{{${alias(select)}.data.message.split("\\n")[1] || ${alias(select)}.data.message}}`
}); edge(selectedOK, toConfirm, 'yes'); edge(toConfirm, bookingEnd);

// Confirm: one node; its button labels come from the language texts.
const confirm = buttons('Confirm the demo', '{{bk_t_confirm}}\n\n🗓 {{bk_slot}}\n📧 {{bk_email}}', ['{{bk_t_btn_1}}', '{{bk_t_btn_2}}', '{{bk_t_btn_3}}']); edge(isSlot, confirm, 'no');
const book = api('Book the meeting (once)', `/v1/sessions/${sessionId}/book`, { confirmed: true, confirmationToken: '{{confirmation_value}}' }, { 'Idempotency-Key': 'inbound-{{confirmation_value}}' });
const confirmTimeout = save('Confirm reply timed out', { halted: 'exit' }); edge(confirmTimeout, bookingEnd);
const changeTime = save('Customer wants another time', { booking_stage: 'date', date_prompt: '{{bk_t_change}}' }); edge(changeTime, bookingEnd);
const askTeam = save('Customer asked for the team', { halted: 'human' }); edge(askTeam, bookingEnd);
edge(confirm, book, 'BUTTON_1'); edge(confirm, changeTime, 'BUTTON_2'); edge(confirm, askTeam, 'BUTTON_3'); edge(confirm, confirmTimeout, 'no-response');
const booked = split('Booked with a Meet link', `${alias(book)}.data.status === "confirmed" && !!${alias(book)}.data.data.meetUrl`); edge(book, booked);
const bookingSaved = save('Remember the booking', { attempt_status: 'confirmed', bk_meet: ref(book, 'data.data.meetUrl'), booking_id: ref(book, 'data.data.bookingId') }); edge(booked, bookingSaved, 'yes'); edge(bookingSaved, bookingEnd);
const lostRace = split('Time was just taken', `["slot_unavailable","slot_expired"].includes(${alias(book)}.data.status) && ${alias(book)}.data.data.canReselect === true`); edge(booked, lostRace, 'no');
const retryBooking = save('Pick another time after a clash', { booking_stage: 'date', slot_page: 0, date_prompt: `{{${alias(book)}.data.message}} {{bk_t_change}}` }); edge(lostRace, retryBooking, 'yes'); edge(retryBooking, bookingEnd);
const bookingFailed = save('Booking needs the team', { halted: 'human' }); edge(lostRace, bookingFailed, 'no'); edge(bookingFailed, bookingEnd);

// After the loop: confirmed → inform the team (the original demo.booked call) → confirmation.
const completed = split('Demo booked', 'attempt_status === "confirmed"'); edge(bookingEnd, completed);
const notify = node('apiNode', 'Inform Nafih (demo.booked)', {
  ...notifyTemplate, title: undefined, displayName: undefined, outcome_mode: undefined, on_transport_error: 'continue',
  body: {
    ...notifyTemplate.body, customername: '{{tg.customer_name}}', customerphonenumber: '{{tg.customer_phone}}',
    customer_email: '{{bk_email}}', meeting_time: '{{bk_slot}}', meet_link: '{{bk_meet}}', booking_id: '{{booking_id}}'
  }
});
Object.assign(notify.data, { title: `apiNode_${counts.apiNode}`, displayName: 'Inform Nafih (demo.booked)' });
delete notify.data.outcome_mode;
edge(completed, notify, 'yes');
const done = text('Demo confirmed', '{{bk_t_done_1}}\n\n🗓 {{bk_slot}}\n🎥 Google Meet: {{bk_meet}}\n\n{{bk_t_done_2}} {{bk_email}}.\n\n{{bk_t_done_3}}'); edge(notify, done); edge(done, end);
const quiet = split('Customer left or went quiet', 'halted === "exit"'); edge(completed, quiet, 'no'); edge(quiet, exit, 'yes'); edge(quiet, handoff, 'no');

// Simple grid layout; tidy it with the editor's auto-layout after import.
nodes.forEach((n, i) => { n.position = { x: (i % 5) * 340, y: Math.floor(i / 5) * 230 }; });

// ---------------------------------------------------------------- 3. Organizer alert flow
// demo.booked → Internal alert (WhatsApp template + email). Recipients are picked in the Worker.
const alertNodes = [], alertEdges = [];
const alertTrigger = { id: randomUUID(), type: 'triggerNode', position: { x: 0, y: 0 }, data: {
  title: 'triggerNode_1', displayName: 'Demo booked', description: '', trigger: 'custom_integration',
  topic: 'custom:REPLACE_WITH_INTEGRATION:demo.booked', trigger_topic_title: 'demo.booked',
  trigger_topic_description: 'Sent by the Demo booking flow after a demo is confirmed'
} };
const fields = { customer_name: '{{tg.customername}}', customer_phone: '{{tg.customerphonenumber}}', customer_email: '{{tg.customer_email}}', meeting_time: '{{tg.meeting_time}}', meet_link: '{{tg.meet_link}}' };
const alertNode = { id: randomUUID(), type: 'internalAlertNode', position: { x: 0, y: 260 }, data: {
  title: 'internalAlertNode_1', displayName: 'Alert the organizer', description: '',
  alert: {
    version: 1, via: ['whatsapp', 'email'],
    whatsapp: { template_mode: 'inline', inline_template: {
      category: 'UTILITY', language: 'en',
      // Meta rejects a template body that starts or ends with a variable.
      body: 'New demo booked ✅\n\nCustomer: {{customer_name}}\nWhatsApp: {{customer_phone}}\nEmail: {{customer_email}}\nWhen: {{meeting_time}}\nGoogle Meet: {{meet_link}}\n\nThe Google Calendar invite has been sent to the customer.',
      mapping: fields,
      samples: { customer_name: 'Ajmal', customer_phone: '971501234567', customer_email: 'ajmal@company.com', meeting_time: 'Mon, 2 Nov 2026, 4:00 PM–4:15 PM (Asia/Dubai)', meet_link: 'https://meet.google.com/abc-defg-hij' }
    } },
    email: {
      subject: 'New demo booked: {{tg.customername}} — {{tg.meeting_time}}',
      body: 'A new FlowFlex demo was booked from WhatsApp.\n\nCustomer: {{tg.customername}}\nWhatsApp: {{tg.customerphonenumber}}\nEmail: {{tg.customer_email}}\nWhen: {{tg.meeting_time}}\nGoogle Meet: {{tg.meet_link}}\nBooking reference: {{tg.booking_id}}\n\nThe Google Calendar invite has been sent to the customer.'
    }
  }
} };
const alertEnd = { id: randomUUID(), type: 'endFlowNode', position: { x: 0, y: 520 }, data: { title: 'endFlowNode_1', displayName: 'End', description: '' } };
alertNodes.push(alertTrigger, alertNode, alertEnd);
for (const [a, b] of [[alertTrigger, alertNode], [alertNode, alertEnd]]) alertEdges.push({ id: `flow-edge-${randomUUID()}`, source: a.id, target: b.id, sourceHandle: `next-step-${a.id}`, targetHandle: 'target', ...edgeStyle });
writeFileSync(`${outDir}/demo-booked-alert-flow.json`, JSON.stringify({ _nodes: alertNodes, _edges: alertEdges }, null, 2) + '\n');

writeFileSync(`${outDir}/inbound-facebook-ad-flow.json`, JSON.stringify(ad, null, 2) + '\n');
writeFileSync(`${outDir}/demo-booking-flow.json`, JSON.stringify({ _nodes: nodes, _edges: edges }, null, 2) + '\n');
console.log(`Ad flow: ${ad._nodes.length} nodes. Booking flow: ${nodes.length} nodes, ${edges.length} edges.`);
