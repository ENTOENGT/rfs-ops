/** 24 Nov (migration 043): a vendor quotes two options — the person saves one on the request and offers the other on the
 *  quotation too, as its own option (own rate, own total); the customer copy / email show both with the option's label. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as qt from '../src/server/quotations';
import { setAiNetwork } from '../src/server/ai';
import { fileOnShipment } from '../src/server/inbox';
import { applyQuote, readQuote } from '../src/server/quotereader';
import { emailDraft } from '../src/server/emails';

let admin: Actor, cora: Actor, sam: Actor, cust: string, agent: string;
let answer: any = {};
const D = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const TWO = {
  has_rate: true, total: 2400, currency: 'USD', carrier: 'MSC', routing: 'Direct', transit_days: 14, valid_until: D(20), summary: 'Two options: MSC direct and CMA via Colombo',
  charges: [{ section: 'freight', description: 'Ocean freight', basis: 'per container', quantity: 2, amount: 1200, currency: 'USD' }],
  options: [
    { label: 'MSC direct', total: 2400, currency: 'USD', carrier: 'MSC', routing: 'Direct', transit_days: 14,
      charges: [{ section: 'freight', description: 'Ocean freight', basis: 'per container', quantity: 2, amount: 1200, currency: 'USD' }] },
    { label: 'CMA CGM via Colombo', total: 2000, currency: 'USD', carrier: 'CMA CGM', routing: 'Via Colombo', transit_days: 22,
      charges: [{ section: 'freight', description: 'Ocean freight', basis: 'per container', quantity: 2, amount: 900, currency: 'USD' }, { section: 'origin', description: 'BL fee', quantity: 1, amount: 200, currency: 'USD' }] },
  ],
};

async function setup() {
  const fileId = (await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'exports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB', pickup_address: 'Jebel Ali FZ',
    port_of_loading: 'Jebel Ali', port_of_discharge: 'Nhava Sheva', origin: 'Dubai', destination: 'Mumbai' })).id;
  const r = await vr.createVendorRequest(cora, { vendor_id: agent, service: 'rate', job_file_id: fileId, description: '2x40HC Jebel Ali → Nhava Sheva' });
  const m = { internet_message_id: `<${Math.random()}@x>`, conversation_id: null, from_addr: 'rates@gulfagents.ae', from_name: 'Ravi', to_addrs: 'cora@x.ae', cc_addrs: null,
    subject: `RE: ${r.request_no}`, received_at: new Date(Date.now() + 60000).toISOString(), has_attachments: false, web_link: null, body_excerpt: 'Option 1 MSC direct USD 1200/40, option 2 CMA via CMB USD 900/40 + BL 200' };
  await tx((c) => fileOnShipment(c, cora, fileId, m, 'tag'));
  const e = await one('select id from email_messages where message_id = $1', [m.internet_message_id]);
  return { fileId, r, emailId: e.id, sam };
}

before(async () => {
  await resetDb();
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  cust = (await createMaster(sam, 'customers', { name: 'Red Chief', email: 'buy@redchief.in' })).id;
  agent = (await createMaster(admin, 'vendors', { name: 'Gulf Agents', vendor_type: 'freight_agent', email: 'rates@gulfagents.ae' })).id;
  setAiNetwork((async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_rate', input: answer }] }), { status: 200 })) as typeof fetch);
});

test('two options read; one saved on the request, the other becomes option 2 with its own rate (no vendor name for the customer)', async () => {
  const { fileId, r, emailId, sam } = await setup();
  answer = TWO;
  const s: any = (await readQuote(cora, emailId)).suggestion;
  assert.deepEqual(s.answers.options.map((o: any) => [o.label, o.quoted_cost, o.charges.length]), [['MSC direct', 2400, 1], ['CMA CGM via Colombo', 2000, 2]]);
  const res: any = await applyQuote(cora, s.id, { main: 0, extra: [1], use_charges: true });
  assert.equal(res.added.length, 1);
  const routes = await q('select id, option_no, pol, pod, label from enquiry_routes where job_file_id = $1 order by option_no', [fileId]);
  assert.deepEqual(routes.map((x: any) => [x.option_no, x.pol, x.pod, x.label]), [[1, 'Jebel Ali', 'Nhava Sheva', null], [2, 'Jebel Ali', 'Nhava Sheva', 'CMA CGM via Colombo']]);
  const rates = await q(`select id, request_no, status, quoted_cost::text, carrier, transit_days, route_id from vendor_requests where job_file_id = $1 and service = 'rate' order by created_at`, [fileId]);
  assert.deepEqual(rates.map((x: any) => [x.status, x.quoted_cost, x.carrier, x.transit_days, x.route_id]),
    [['quoted', '2400.00', 'MSC', 14, routes[0].id], ['quoted', '2000.00', 'CMA CGM', 22, routes[1].id]]);
  assert.equal(rates[0].id, r.id);
  assert.equal((await one('select count(*)::int n from vendor_rate_charges where request_id = $1', [rates[1].id])).n, 2, 'option 2 keeps its own breakup');
  // the quotation offers both: one section and one total per option
  const L = (desc: string, rid: string, cost: string, sell: string) => ({ description: desc, charge_unit: 'container', quantity: '2', cost_rate: cost, sell_rate: sell, vendor_request_id: rid });
  const id = (await qt.createQuotation(cora, { customer_id: cust, service_type: 'sea_fcl', job_file_id: fileId, salesman_id: sam.id, valid_until: D(10),
    lines: [L('Ocean freight (MSC direct)', rates[0].id, '1200', '1400'), L('Ocean freight (CMA via Colombo)', rates[1].id, '1000', '1150')] })).id;
  const x: any = await qt.getQuotation(cora, id);
  assert.deepEqual(x.options.map((o: any) => [o.option_no, o.sell_total]), [[1, '2800.00'], [2, '2300.00']]);
  await q(`update quotations set status = 'approved', approved_at = now() where id = $1`, [id]);
  const c: any = await qt.customerCopy(cora, id, 'pdf');
  assert.deepEqual(c.options.map((o: any) => [o.option_no, o.label, o.total]), [[1, null, '2800.00'], [2, 'CMA CGM via Colombo', '2300.00']]);
  assert.doesNotMatch(JSON.stringify(c), /Gulf Agents/, 'the vendor is never on the customer copy');
  const d: any = await emailDraft(cora, { kind: 'quotation', id });
  assert.match(d.body, /Option 2 · Jebel Ali → Nhava Sheva · CMA CGM via Colombo/);
});

test('the second option can be the one saved on the request; nothing extra when not ticked', async () => {
  const { fileId, r, emailId } = await setup();
  answer = TWO;
  const s: any = (await readQuote(cora, emailId)).suggestion;
  await applyQuote(cora, s.id, { main: 1, extra: [], use_charges: true, rate: { quoted_cost: 2000, currency: 'USD', carrier: 'CMA CGM', routing: 'Via Colombo', transit_days: 22 } });
  const v = await one('select quoted_cost::text, carrier from vendor_requests where id = $1', [r.id]);
  assert.deepEqual([v.quoted_cost, v.carrier], ['2000.00', 'CMA CGM']);
  assert.equal((await one('select count(*)::int n from vendor_rate_charges where request_id = $1', [r.id])).n, 2, 'the chosen option\'s breakup');
  assert.equal((await one('select count(*)::int n from enquiry_routes where job_file_id = $1', [fileId])).n, 0, 'no options made');
});

test('options cannot be added once the customer has confirmed; a single offer has no options', async () => {
  const { fileId, emailId } = await setup();
  answer = TWO;
  const s: any = (await readQuote(cora, emailId)).suggestion;
  await q(`update job_files set stage = 'customer_confirmed' where id = $1`, [fileId]);
  await assert.rejects(applyQuote(cora, s.id, { main: 0, extra: [1] }), /customer has confirmed/);
  assert.equal((await one(`select status from vendor_requests where job_file_id = $1 and service = 'rate'`, [fileId])).status, 'requested', 'nothing half-saved');
  const two = await setup();
  answer = { ...TWO, options: [TWO.options[0]] };
  assert.equal(((await readQuote(cora, two.emailId)).suggestion as any).answers.options, undefined);
});

test('26 Nov: two vendors\' freight on one option → each vendor its own option on save; local lines copied; a transporter may stay beside', async () => {
  const fileId = (await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB',
    port_of_loading: 'Ho Chi Minh City', port_of_discharge: 'Jebel Ali', origin: 'Ho Chi Minh City', destination: 'Dubai', cargo_description: 'Shoes 1x20, 1x40' })).id;
  const patent = (await createMaster(admin, 'vendors', { name: 'Patent International', vendor_type: 'overseas_agent', email: 'p@patent.vn' })).id;
  const sanco = (await createMaster(admin, 'vendors', { name: 'Sanco International', vendor_type: 'overseas_agent', email: 's@sanco.vn' })).id;
  const truck = (await createMaster(admin, 'vendors', { name: 'Gulf Trucks', vendor_type: 'transporter', email: 't@trucks.ae' })).id;
  const mk = async (v: string, cost: string, carrier: string, days: number) => { const r = await vr.createVendorRequest(cora, { vendor_id: v, service: 'rate', job_file_id: fileId, description: 'HCM → JEA' });
    await vr.vendorRequestAction(admin, r.id, { status: 'quoted', quoted_cost: cost, currency: 'USD', carrier, routing: 'Direct', transit_days: days }); return r; };
  const a = await mk(patent, '4150', 'CMA-CGM', 22), b = await mk(sanco, '4500', 'Maersk', 25), t = await mk(truck, '300', '', 0);
  const L = (d: string, rid: string | null, cost: string, sell: string) => ({ description: d, charge_unit: 'container', quantity: '1', cost_rate: cost, sell_rate: sell, vendor_request_id: rid });
  const x = await qt.createQuotation(cora, { customer_id: cust, service_type: 'sea_fcl', job_file_id: fileId, salesman_id: sam.id, valid_until: D(10), lines: [
    L('Ocean freight 20\'', a.id, '1500', '1600'), L('Ocean freight 40\'', a.id, '2650', '3055.56'),
    L('Ocean freight 20\'', b.id, '1600', '1700'), L('Ocean freight 40\'', b.id, '2900', '3333.33'),
    L('Delivery to warehouse', t.id, '300', '400'), L('DO fee', null, '580', '580')] });
  const routes = await q('select id, option_no, label from enquiry_routes where job_file_id = $1 order by option_no', [fileId]);
  assert.deepEqual(routes.map((r: any) => [r.option_no, r.label]), [[1, null], [2, 'Maersk, Direct, 25 days']]);
  const g: any = await qt.getQuotation(cora, x.id);
  const on = (n: number) => g.lines.filter((l: any) => l.route_id === routes[n - 1].id).map((l: any) => `${l.description}|${l.vendor_request_id === a.id ? 'A' : l.vendor_request_id === b.id ? 'B' : l.vendor_request_id === t.id ? 'T' : '-'}`);
  assert.deepEqual(on(1), ['Ocean freight 20\'|A', 'Ocean freight 40\'|A', 'Delivery to warehouse|T', 'DO fee|-']);
  assert.deepEqual(on(2).sort(), ['DO fee|-', 'Delivery to warehouse|T', 'Ocean freight 20\'|B', 'Ocean freight 40\'|B'].sort(), 'Sanco\'s freight alone + the same local lines');
  assert.deepEqual(g.options.map((o: any) => o.sell_total), ['5635.56', '6013.33']);
  assert.equal((await one('select route_id from vendor_requests where id = $1', [b.id])).route_id, routes[1].id);
  // saving again changes nothing more
  await qt.updateQuotation(cora, x.id, { lines: g.lines });
  assert.equal((await one('select count(*)::int n from enquiry_routes where job_file_id = $1', [fileId])).n, 2);
});

test('26 Nov: vendor replies are read by the AI in the background, once; automatic emails are sorted without the AI', async () => {
  const { runBackgroundReads } = await import('../src/server/inboxcron');
  const { plainlyOther, inBatches } = await import('../src/server/newenquiry');
  const { emailId } = await setup();
  answer = TWO;
  let calls = 0;
  setAiNetwork((async () => { calls++; return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_rate', input: answer }] }), { status: 200 }); }) as typeof fetch);
  const r: any = await runBackgroundReads(5);
  assert.ok(r.read >= 1, JSON.stringify(r));
  assert.equal((await one(`select status from ai_suggestions where email_id = $1 and kind = 'quote'`, [emailId])).status, 'open', 'ready when the enquiry is opened');
  const before = calls;
  await runBackgroundReads(5);
  assert.equal(calls, before, 'never read twice');
  assert.equal(plainlyOther({ from_addr: 'noreply@msc.com', subject: 'Schedule' }), 'Automatic email');
  assert.equal(plainlyOther({ from_addr: 'ravi@agent.in', subject: 'Automatic reply: Rate request' }), 'Automatic reply');
  assert.equal(plainlyOther({ from_addr: 'ravi@agent.in', subject: 'RE: VR-1012 rates' }), null);
  // side by side: 6 jobs of 50 ms, 4 at a time → about 100 ms, not 300
  const t0 = Date.now(); await inBatches([1, 2, 3, 4, 5, 6], 4, () => new Promise((ok) => setTimeout(ok, 50)));
  assert.ok(Date.now() - t0 < 200);
});

test('26 Nov: each option shows POL, POD, line, transit, free days, ETD, ETA and validity; typed values win; gaps and Incoterm clashes flagged', async () => {
  const fileId = (await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF',
    port_of_loading: 'Ningbo', port_of_discharge: 'Jebel Ali', origin: 'Ningbo', destination: 'Dubai' })).id;
  const v1 = (await createMaster(admin, 'vendors', { name: 'Ning Agents', vendor_type: 'overseas_agent', email: 'n@ning.cn' })).id;
  const v2 = (await createMaster(admin, 'vendors', { name: 'Sea Hub', vendor_type: 'overseas_agent', email: 's@hub.cn' })).id;
  const mk = async (v: string, extra: any) => { const r = await vr.createVendorRequest(cora, { vendor_id: v, service: 'rate', job_file_id: fileId, description: 'NGB → JEA' });
    await vr.vendorRequestAction(admin, r.id, { status: 'quoted', quoted_cost: '1000', currency: 'USD', ...extra }); return r; };
  const a = await mk(v1, { carrier: 'COSCO', transit_days: 20, free_days: 14, etd: '2026-12-01' }), b = await mk(v2, { carrier: 'ONE' });
  const L = (rid: string) => ({ description: 'Ocean freight', charge_unit: 'container', quantity: '1', cost_rate: '1000', sell_rate: '1200', vendor_request_id: rid });
  const id = (await qt.createQuotation(cora, { customer_id: cust, service_type: 'sea_fcl', direction: 'import', job_file_id: fileId, salesman_id: sam.id, valid_until: D(10), lines: [L(a.id), L(b.id)] })).id;
  let g: any = await qt.getQuotation(cora, id);
  assert.equal(g.details.length, 2);
  assert.deepEqual([g.details[0].line, g.details[0].transit_days, g.details[0].free_days, g.details[0].etd, g.details[0].eta, g.details[0].pol], ['COSCO', 20, 14, '2026-12-01', '2026-12-21', 'Ningbo']);
  assert.deepEqual(g.details[0].missing, []);
  assert.deepEqual(g.details[1].missing, ['transit time', 'free days', 'ETD', 'ETA']);
  assert.match(g.scope_flags.join(' '), /Freight is in the scope, but under CIF import it is the seller's side/);
  // staff type what option 2's vendor did not say; a bad value is refused
  await assert.rejects(qt.updateQuotation(cora, id, { details: { [g.details[1].key]: { transit_days: 'soon' } } }), /days from 0 to 365/);
  g = await qt.updateQuotation(cora, id, { details: { [g.details[1].key]: { transit_days: '25', free_days: '7', etd: '2026-12-05', line: 'ONE (via Singapore)' } } });
  assert.deepEqual([g.details[1].line, g.details[1].eta, g.details[1].missing], ['ONE (via Singapore)', '2026-12-30', []]);
  await q(`update quotations set status = 'approved', approved_at = now() where id = $1`, [id]);
  const c: any = await qt.customerCopy(cora, id, 'pdf');
  assert.equal(c.options[1].details.line, 'ONE (via Singapore)');
  assert.equal(c.options[0].details.key, undefined);
  const d: any = await emailDraft(cora, { kind: 'quotation', id });
  assert.match(d.body, /POL: Ningbo · POD: Jebel Ali · Line: COSCO · Transit: 20 days · Free days: 14 · ETD: 1 Dec 2026 · ETA: 21 Dec 2026/);
  assert.match(d.blocks[0].html, /Line: ONE \(via Singapore\)/);
  assert.ok(!d.missing.some((m: string) => /Option/.test(m)), 'nothing missing now');
  const { quotationPdf } = await import('../src/server/quotepdf');
  assert.ok((await quotationPdf(cora, id)).bytes.length > 1000);
});

test('26 Nov: Accept / Reject / Negotiate links in the quotation email — one per option, answered once, team told, nothing applied by itself', async () => {
  const { answerInfo, answerQuote, markAnswerHandled } = await import('../src/server/quoteanswers');
  const fileId = (await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB',
    port_of_loading: 'Busan', port_of_discharge: 'Jebel Ali', origin: 'Busan', destination: 'Dubai' })).id;
  const v1 = (await createMaster(admin, 'vendors', { name: 'Busan One', vendor_type: 'overseas_agent', email: 'a@b1.kr' })).id;
  const v2 = (await createMaster(admin, 'vendors', { name: 'Busan Two', vendor_type: 'overseas_agent', email: 'a@b2.kr' })).id;
  const mk = async (v: string) => { const r = await vr.createVendorRequest(cora, { vendor_id: v, service: 'rate', job_file_id: fileId, description: 'PUS → JEA' });
    await vr.vendorRequestAction(admin, r.id, { status: 'quoted', quoted_cost: '1000', currency: 'USD', carrier: 'HMM' }); return r; };
  const a = await mk(v1), b = await mk(v2);
  const L = (rid: string, sell: string) => ({ description: 'Ocean freight', charge_unit: 'container', quantity: '1', cost_rate: '1000', sell_rate: sell, vendor_request_id: rid });
  const id = (await qt.createQuotation(cora, { customer_id: cust, service_type: 'sea_fcl', direction: 'import', job_file_id: fileId, salesman_id: sam.id, valid_until: D(10), lines: [L(a.id, '1200'), L(b.id, '1300')] })).id;
  await q(`update quotations set status = 'approved', approved_at = now() where id = $1`, [id]);
  const d1: any = await emailDraft(cora, { kind: 'quotation', id });
  const d2: any = await emailDraft(cora, { kind: 'quotation', id });
  const tokens = [...d1.body.matchAll(/\/answer\/([A-Za-z0-9_-]+)/g)].map((m: any) => m[1]);
  assert.equal(tokens.length, 2, 'one link per option');
  assert.equal(new Set(tokens).size, 2);
  assert.deepEqual([...d2.body.matchAll(/\/answer\/([A-Za-z0-9_-]+)/g)].map((m: any) => m[1]), tokens, 'the same links when prepared again');
  assert.match(d1.blocks[0].html, /\?a=accepted[^>]*>Accept option 1</);
  const info: any = await answerInfo(tokens[1]);
  assert.deepEqual([info.total, info.answer, info.closed], ['1300.00', null, null]);
  assert.match(info.option, /Option 2/);
  assert.doesNotMatch(JSON.stringify(info), /Busan Two|1000/, 'no vendor, no cost');
  await assert.rejects(answerQuote(tokens[0], { answer: 'rejected' }, '1.2.3.4'), /tell us why/);
  await assert.rejects(answerQuote(tokens[1], { answer: 'negotiate', target_rate: 'cheaper' }, '1.2.3.4'), /target rate/);
  await assert.rejects(answerInfo('not-a-real-link-0123456789abcdef'), (e: any) => e.code === 'LINK_EXPIRED');
  await answerQuote(tokens[1], { answer: 'negotiate', target_rate: '1,150', comment: 'Match last month' }, '1.2.3.4');
  await assert.rejects(answerQuote(tokens[1], { answer: 'accepted' }, '1.2.3.4'), (e: any) => e.code === 'ALREADY_ANSWERED');
  const g: any = await qt.getQuotation(cora, id);
  assert.equal(g.status, 'approved', 'nothing applied by itself');
  assert.deepEqual(g.answers.map((x: any) => [x.answer, x.target_rate, x.target_currency, x.option_no, x.comment]), [['negotiate', '1150.00', 'AED', 2, 'Match last month']]);
  assert.ok(g.events.some((e: any) => /Customer answered from the email/.test(e.title) && /target AED 1150/.test(e.details)));
  const n = await one(`select count(*)::int n from notifications where quotation_id = $1 and event = 'customer_response'`, [id]);
  assert.ok(n.n >= 1, 'the team is told');
  assert.ok(await one(`select 1 from audit_log where entity_id = $1 and action like 'Customer answer from the email%'`, [id]));
  const h: any = await markAnswerHandled(cora, id, g.answers[0].id);
  assert.ok(h.answers[0].handled_at);
  await assert.rejects(markAnswerHandled(cora, id, g.answers[0].id), /not found/i, 'handled once');
  // a revised quotation closes the old links
  await q(`update quotations set version_no = version_no + 1 where id = $1`, [id]);
  assert.match((await answerInfo(tokens[0])).closed ?? '', /revised/);
});

test('26 Nov: after the customer approves, the vendor of that rate is asked for space; AI reads "not available"; follow-up and customer emails; nothing changed by itself', async () => {
  const av = await import('../src/server/availability');
  const { getJobFile } = await import('../src/server/jobfiles');
  const { emailPrepared } = await import('../src/server/emails');
  const { runBackgroundReads } = await import('../src/server/inboxcron');
  const fileId = (await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB',
    port_of_loading: 'Port Klang', port_of_discharge: 'Jebel Ali', origin: 'Port Klang', destination: 'Dubai' })).id;
  const v1 = (await createMaster(admin, 'vendors', { name: 'Klang One', vendor_type: 'overseas_agent', email: 'k1@klang.my' })).id;
  const v2 = (await createMaster(admin, 'vendors', { name: 'Klang Two', vendor_type: 'overseas_agent', email: 'k2@klang.my' })).id;
  const mk = async (v: string, carrier: string) => { const r = await vr.createVendorRequest(cora, { vendor_id: v, service: 'rate', job_file_id: fileId, description: 'PKG → JEA' });
    await vr.vendorRequestAction(admin, r.id, { status: 'quoted', quoted_cost: '900', currency: 'USD', carrier, routing: carrier === 'MSC' ? 'via Singapore' : 'Direct', vendor_reference: `Q-${carrier}` }); return r; };
  const a = await mk(v1, 'ONE'), b = await mk(v2, 'MSC');
  const L = (rid: string) => ({ description: 'Ocean freight', charge_unit: 'container', quantity: '1', cost_rate: '900', sell_rate: '1100', vendor_request_id: rid });
  const qid = (await qt.createQuotation(cora, { customer_id: cust, service_type: 'sea_fcl', direction: 'import', job_file_id: fileId, salesman_id: sam.id, valid_until: D(10), lines: [L(a.id), L(b.id)] })).id;
  await q(`update quotations set status = 'sent', approved_at = now() where id = $1`, [qid]);
  const routes = await q('select id, option_no from enquiry_routes where job_file_id = $1 order by option_no', [fileId]);
  await qt.quotationAction(cora, qid, { action: 'accept', evidence_note: 'Customer email: go with option 2', route_id: routes[1].id });
  const n = await one(`select title from notifications where job_file_id = $1 and event = 'customer_confirmed' order by created_at desc limit 1`, [fileId]);
  assert.match(n.title, /Customer approved Option 2/);
  let g: any = await getJobFile(cora, fileId);
  assert.equal(g.approved_rate.id, b.id, 'the vendor of the approved option');
  assert.equal(g.availability, null);
  // the draft to that same vendor: their quote reference, routing and the agreed rate
  const d: any = await emailDraft(cora, { kind: 'vendor_request', id: b.id, update: 'availability_check' });
  assert.deepEqual(d.recipients.map((x: any) => x.email), ['k2@klang.my']);
  assert.match(d.body, /confirm that space and your rate are still available/);
  assert.match(d.body, /ref\. Q-MSC · our request .* · MSC · via Singapore · USD 900\.00/);
  await emailPrepared(cora, { kind: 'vendor_request', id: b.id, update: 'availability_check', to: ['k2@klang.my'], subject: d.subject, body: d.body });
  g = await getJobFile(cora, fileId);
  assert.equal(g.availability.status, 'sent');
  // the vendor answers; the AI reads it in the background
  const m = { internet_message_id: `<${Math.random()}@klang>`, conversation_id: null, from_addr: 'k2@klang.my', from_name: 'Klang Two', to_addrs: 'cora@x.ae', cc_addrs: null,
    subject: `RE: ${d.subject}`, received_at: new Date(Date.now() + 60000).toISOString(), has_attachments: false, web_link: null, body_excerpt: 'Sorry, MV Alpha is full. Next vessel MV Beta ETD 12 Dec, same rate.' };
  await tx((c) => fileOnShipment(c, cora, fileId, m, 'tag'));
  await q(`update email_messages set vendor_request_id = $2, created_at = now() + interval '1 second' where message_id = $1`, [m.internet_message_id, b.id]);
  setAiNetwork((async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'availability_answer',
    input: { answer: 'not_available', reason: 'MV Alpha is full', alternative: 'MV Beta ETD 12 Dec, same rate' } }] }), { status: 200 })) as typeof fetch);
  try { await runBackgroundReads(3); } finally {
    setAiNetwork((async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_rate', input: answer }] }), { status: 200 })) as typeof fetch);
  }
  g = await getJobFile(cora, fileId);
  assert.deepEqual([g.availability.status, g.availability.reason, g.availability.alternative, g.availability.answer_source], ['unavailable', 'MV Alpha is full', 'MV Beta ETD 12 Dec, same rate', 'ai']);
  assert.deepEqual([g.stage, g.selected_route_id], ['customer_confirmed', routes[1].id], 'the approved option is not changed');
  assert.ok(await one(`select 1 from notifications where job_file_id = $1 and title like '%Not available%MV Alpha%'`, [fileId]), 'the team is told');
  const f2: any = await emailDraft(cora, { kind: 'vendor_request', id: b.id, update: 'availability_followup' });
  assert.match(f2.body, /next available sailing or an alternative routing/);
  const c2: any = await emailDraft(cora, { kind: 'job_file', id: fileId, update: 'shipment_update:space_unavailable' });
  assert.match(c2.body, /the originally quoted sailing is currently unavailable/);
  // ask again → confirmed by the person
  await emailPrepared(cora, { kind: 'vendor_request', id: b.id, update: 'availability_check', to: ['k2@klang.my'], subject: d.subject, body: d.body });
  await assert.rejects(av.availabilityAction(cora, fileId, { result: 'unavailable' }), /what the vendor said/);
  g = await av.availabilityAction(cora, fileId, { result: 'confirmed' });
  assert.equal(g.availability.status, 'confirmed');
  assert.equal((await q('select count(*)::int n from availability_checks where job_file_id = $1', [fileId]))[0].n, 2, 'the first check kept as history');
  // the AI's live status in the top bar shows what it read for the Coordinator
  const { aiActivity } = await import('../src/server/aiactivity');
  const act: any = await aiActivity(cora);
  assert.ok(act.recent.some((r: any) => r.kind === 'availability' && /Not available: MV Alpha/.test(r.summary)));
  assert.equal(typeof act.working, 'number');
});
