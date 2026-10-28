// Offline check for flows/inbound-facebook-ad-flow.json + demo-booking-flow.json: imports each with the
// frontend sanitiser, validates every edge handle, compiles it with the backend
// compiler and replays mocked conversations. No live API or WhatsApp calls.
// Run: npx tsx scripts/check-facebook-ad-flow.cjs   (COMPILER=<path> to use another compiler copy)
const fs = require('node:fs'), assert = require('node:assert/strict');
const R = `${__dirname}/../../`;
const { sanitiseFlowGraph } = require(R + 'flowflex/src/app/flows/edit-flow/flowPortability.ts');
const { partitionFlowEdges } = require(R + 'flowflex/src/app/flows/edit-flow/connectionService.ts');
const { buildFlowHandleRegistry } = require(R + 'flowflex/src/app/flows/edit-flow/sourceHandleRegistry.ts');
const { compileFlowToActivities } = require(process.env.COMPILER || R + 'moleculer-flowflex/utils/temporal_compiler');
const { evaluatepaths } = require(R + 'temporal-core-flowflex/src/common/evaluatepaths.ts');
const { ifelse } = require(R + 'temporal-core-flowflex/src/common/ifelse.ts');
const { buildDynamicOptions } = require(R + 'temporal-core-flowflex/src/common/dynamic-options.ts');

function load(name) {
  const raw = JSON.parse(fs.readFileSync(`${__dirname}/../flows/${name}.json`));
  const safe = sanitiseFlowGraph(raw._nodes, raw._edges, { preserveApiConfiguration: true });
  const partition = partitionFlowEdges(safe.nodes, safe.edges, { handles: buildFlowHandleRegistry(safe.nodes) });
  assert.equal(partition.validEdges.length, safe.edges.length, `${name}: import dropped edges`);
  const compiled = compileFlowToActivities(safe, { _id: 'test', org_id: 'test', branch_id: 'test' });
  console.log(`${name}: ${safe.nodes.length} nodes, ${safe.edges.length} edges, ${JSON.stringify(compiled).length} bytes compiled`);
  return compiled;
}
const adFlow = load('inbound-facebook-ad-flow'), bookingFlow = load('demo-booking-flow');

// Same rules as temporal-core resolve-templates: a whole {{x}} keeps its type, tg is trigger.
function resolve(v, ctx) {
  const scope = { ...ctx, tg: ctx.trigger };
  const evaluate = x => { try { return Function(...Object.keys(scope), `return (${x})`)(...Object.values(scope)); } catch { return undefined; } };
  if (typeof v === 'string') {
    const whole = v.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (whole) return evaluate(whole[1]) ?? v;
    return v.replace(/\{\{\s*([^}]+)\s*\}\}/g, (m, x) => { const value = evaluate(x); return value == null ? m : String(value); });
  }
  if (Array.isArray(v)) return v.map(x => resolve(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, ctx)]));
  return v;
}

const PHONES = { en: '971501234567', it: '393331234567', es: '34612345678' };
function scenario(mode, lang = 'en', compiled = bookingFlow) {
  const results = { trigger: compiled === adFlow ? { from: PHONES[lang], phonenumber: PHONES[lang], name: 'Test Customer', text: 'Hello! Can I get more info on this?' } : { customer_phone: PHONES[lang], customer_name: 'Test Customer', lang } };
  const sent = [], api = [];
  let ended = false, interprets = 0, availability = 0, selects = 0, books = 0, lists = 0, emails = 0, confirms = 0;
  const reply = (body, wait) => {
    if (!wait) return undefined;
    if (/^(Great|Perfetto|¡Genial)/.test(body) || /^(That email|L'email|Ese email)/.test(body)) {
      emails++;
      if (mode === 'email_silence') return undefined;
      return { message: mode === 'email_retry' && emails === 1 ? 'not-an-email' : 'test@example.com' };
    }
    if (mode === 'date_silence') return undefined;
    return { message: 'tomorrow after 4' };
  };
  function run(items, scope = {}) {
    for (const a of items) {
      if (ended) return;
      const ctx = { ...scope, ...results };
      let value;
      if (a.name === 'forloop') {
        let met = false, count = 0;
        for (let i = 0; i < a.args.n && !ended; i++) { run(a.args.activitiesToLoop, { ...scope, loop: { index: i } }); count++; if (ended) break; met = ifelse(resolve(a.args.until, { ...scope, ...results })); if (met) break; }
        value = { iterations: count, conditionMet: met };
      } else if (a.name === 'conditionalSplit') { run(a.args[results[a.args.conditionActivityKey] ? 'ifTrue' : 'ifFalse'], scope); continue; }
      else if (a.name === 'conditionalBranch') {
        // Same rule as temporal-core for API v2 outcome routing.
        const r = results[a.args.conditionActivityKey];
        const key = a.args.apiResponseOutcome ? (r.status === null ? 'request-failed' : r.ok ? 'success' : 'http-error') : r;
        run(a.args[key] || a.args.default || [], scope); continue;
      }
      else {
        const args = resolve(a.args, ctx);
        if (a.name === 'saveVariable') value = args.value;
        else if (a.name === 'ifelse') { try { value = ifelse(args.condition ?? args); } catch { value = false; } if (JSON.stringify(a.args).includes('contact_tags')) value = false; }
        else if (a.name === 'evaluatepaths') value = evaluatepaths(args);
        else if (a.name === 'updateContactTags') value = { ok: true };
        else if (a.name === 'sendDynamicWhatsappMsg') {
          assert.ok(!JSON.stringify(args.payload).includes('{{'), JSON.stringify(args.payload));
          assert.ok(args.payload.interactive.action.button.length <= 20);
          const built = buildDynamicOptions(resolve(a.args.dynamic_options.source, ctx), a.args.dynamic_options, 'list');
          assert.equal(built.outcome, 'ready'); assert.ok(built.rows.length <= 10);
          sent.push(args.payload.interactive.body.text);
          const index = mode === 'more_times' && lists++ === 0 ? built.rows.findIndex(r => r.id === '__next__') : 0;
          value = mode === 'slot_silence' ? { outcome: 'no_response' } : { outcome: 'selected', response: built.rows[index] };
        } else if (a.name === 'sendWhatsappMsg') {
          const interactive = args.payload.interactive;
          const body = args.payload.text?.body ?? interactive.body.text;
          assert.ok(!body.includes('{{'), `Unresolved text: ${body}`);
          sent.push(body); value = { success: true };
          if (interactive?.type === 'button') {
            const titles = interactive.action.buttons.map(b => b.reply.title);
            assert.ok(titles.every(t => !t.includes('{{') && t.length <= 20), titles.join('|'));
            let id;
            if (/^(Hi|Ciao|Hola) 👋/.test(body)) id = mode === 'not_now' ? 'BUTTON_3' : 'BUTTON_1';
            else if (body.includes('🗓')) {
              confirms++;
              if (mode === 'confirm_silence') id = null;
              else if (mode === 'talk_to_team') id = 'BUTTON_3';
              else if (mode === 'change_time' && confirms === 1) id = 'BUTTON_2';
              else id = 'BUTTON_1';
            }
            if (id) value.response = { id };
          } else if (args.wait) { const r = reply(body, true); if (r) value.response = r; }
        } else if (a.name === 'apiNodeV2') {
          assert.ok(!JSON.stringify(args).includes('{{'), JSON.stringify(args));
          api.push(args); const url = args.url; let status = 200, data;
          if (url.includes('/v1/events/')) {
            data = { ok: true };
            if (compiled === adFlow) {
              assert.equal(args.headers['x-event'], 'demo.booking');
              assert.deepEqual(args.body, { customer_phone: PHONES[lang], customer_name: 'Test Customer', lang });
              if (mode === 'event_fails') { status = 500; data = { error: 'down' }; }
            } else { assert.equal(args.headers['x-event'], 'demo.booked'); assert.equal(args.body.customerphonenumber, PHONES[lang]); }
          }
          else if (url.endsWith('/v1/sessions')) {
            assert.equal(args.headers.Authorization, 'Bearer REPLACE_WITH_SERVICE_API_KEY');
            assert.equal(args.body.customerRef, PHONES[lang]); assert.equal(args.body.name, 'Test Customer');
            if (args.body.email === 'not-an-email') { status = 422; data = { status: 'invalid_input', message: 'email: Invalid email address' }; }
            else data = { status: 'awaiting_date', sessionId: 'session-1', data: { email: args.body.email, timezone: 'Asia/Dubai' } };
          } else if (url.endsWith('/interpret')) {
            interprets++;
            if (mode === 'date_down') { status = 503; data = { status: 'interpretation_unavailable', message: 'Date understanding is temporarily unavailable.' }; }
            else if (mode === 'clarify' && interprets === 1) data = { status: 'needs_clarification', message: 'Quale lunedì intendi?' };
            else data = { status: 'resolved', message: 'I\'ll look for free times…' };
          } else if (url.endsWith('/availability')) {
            availability++;
            const page = args.body.page; assert.ok(Number.isInteger(page));
            if (mode === 'no_slots' && availability === 1) data = { status: 'no_slots', message: 'No free times on Mon, 2 Nov. Free times on: Tue, 3 Nov.', data: { slots: [] } };
            else {
              const slots = page === 0 ? Array.from({ length: 9 }, (_, i) => ({ id: `slot-${i + 1}`, title: `${i + 9}:00 AM–${i + 9}:30 AM`, description: 'Mon, 2 Nov 2026 · Asia/Dubai' })).concat({ id: '__next__', title: 'More times', description: 'Show the next 1 available times' })
                : [{ id: 'slot-10', title: '6:00 PM–6:30 PM', description: 'Mon, 2 Nov 2026 · Asia/Dubai' }];
              data = { status: 'slots_available', message: 'Available times', data: { slots, page } };
            }
          } else if (url.endsWith('/select')) {
            selects++;
            assert.equal(args.body.selection, mode === 'more_times' ? 'slot-10' : 'slot-1');
            data = { status: 'awaiting_confirmation', message: 'Confirm your onboarding meeting:\nMon, 2 Nov 2026, 9:00 AM–9:30 AM (Asia/Dubai)\nInvitation: test@example.com\nReply Confirm to book, or change your details.', data: { confirmationToken: `token-${selects}` } };
          } else if (url.endsWith('/book')) {
            books++;
            assert.equal(args.body.confirmed, true); assert.equal(args.headers['Idempotency-Key'], `inbound-token-${selects}`);
            if (mode === 'slot_race' && books === 1) { status = 409; data = { status: 'slot_unavailable', message: 'That time was just taken.', data: { canReselect: true } }; }
            else data = { status: 'confirmed', data: { bookingId: 'booking-1', meetUrl: 'https://meet.google.com/abc-defg-hij' } };
          } else throw Error(`Unexpected URL ${url}`);
          value = { ok: status < 300, status, headers: {}, data };
        } else if (a.name === 'endFlow') ended = true;
        else if (a.name !== 'updatableTimer') throw Error(`Unhandled activity ${a.name}`);
      }
      results[a.key] = value; if (a.exposeAs) results[a.exposeAs] = value;
    }
  }
  run(compiled);
  assert.ok(ended, `${mode}: flow did not end`);
  if (compiled === adFlow) {
    const events = api.filter(x => x.url.includes('/v1/events/'));
    assert.equal(events.length, mode === 'not_now' ? 0 : 1, mode);
    assert.ok(!sent.some(m => m.startsWith('🎉')), `${mode}: ad flow must not claim a booking`);
    if (mode === 'not_now') assert.match(sent.at(-1), /^No problem|^Nessun problema|^Sin problema/);
    if (mode === 'event_fails') assert.match(sent.at(-1), /type your question|scrivi qui|escribe aquí/);
    console.log(`PASS ad flow ${lang} ${mode}`);
    return;
  }
  const bookCalls = api.filter(x => x.url.endsWith('/book')).length;
  const events = api.filter(x => x.url.includes('/v1/events/'));
  const confirmed = sent.find(m => m.startsWith('🎉'));
  const booked = ['happy', 'more_times', 'slot_race', 'clarify', 'no_slots', 'email_retry', 'change_time'].includes(mode);
  if (booked) {
    assert.ok(confirmed?.includes('https://meet.google.com/abc-defg-hij') && confirmed.includes('Mon, 2 Nov 2026, 9:00 AM'), `${mode}: ${confirmed}`);
    assert.ok(confirmed.includes({ en: 'Your FlowFlex demo', it: 'La tua demo', es: 'Tu demo' }[lang]), `${mode}: wrong language`);
    assert.equal(events.length, 1, `${mode}: demo.booked event`); assert.equal(events[0].body.meet_link, 'https://meet.google.com/abc-defg-hij');
    assert.equal(bookCalls, mode === 'slot_race' ? 2 : 1, mode);
  } else {
    assert.ok(!confirmed, `${mode}: should not confirm`); assert.equal(events.length, 0); assert.equal(bookCalls, 0, mode);
  }
  const last = sent.at(-1);
  if (['date_down', 'talk_to_team'].includes(mode)) assert.match(last, /our team will help|team ti aiuterà|equipo te ayudará/, `${mode}: ${last}`);
  if (['email_silence', 'date_silence', 'slot_silence', 'confirm_silence', 'not_now'].includes(mode)) assert.match(last, /^No problem|^Nessun problema|^Sin problema/, `${mode}: ${last}`);
  if (mode === 'clarify') assert.ok(sent.includes('Quale lunedì intendi?'));
  if (mode === 'no_slots') assert.ok(sent.some(m => m.startsWith('No free times')));
  console.log(`PASS ${lang} ${mode} (${sent.length} messages)`);
}

for (const lang of ['en', 'it', 'es']) { scenario('book', lang, adFlow); scenario('event_fails', lang, adFlow); }
scenario('not_now', 'en', adFlow);
for (const lang of ['en', 'it', 'es']) scenario('happy', lang);
for (const mode of ['more_times', 'slot_race', 'clarify', 'no_slots', 'email_retry', 'change_time', 'talk_to_team', 'date_down', 'email_silence', 'date_silence', 'slot_silence', 'confirm_silence']) scenario(mode, mode === 'clarify' ? 'it' : 'en');
console.log('All scenarios passed. No live API or WhatsApp calls were made.');
