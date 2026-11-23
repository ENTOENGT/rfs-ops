/** AI agent part B: the agent's / carrier's reply to a rate request → a suggested rate. Matched to the request (our VR no. or the
 *  vendor's address / domain), never taken as the customer's; read once; nothing saved until a person who sees cost presses Save rate. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import { saveContact } from '../src/server/contacts';
import * as vr from '../src/server/vendorreqs';
import { setAiNetwork } from '../src/server/ai';
import { fileOnShipment } from '../src/server/inbox';
import { readEmail, suggestionsFor } from '../src/server/agent';
import { applyQuote, dismissQuote, quoteBox, readQuote } from '../src/server/quotereader';

let admin: Actor, sam: Actor, fileId: string, reqA: any, reqB: any;
let answer: any = {};
let calls = 0;
const mail = (over: any) => ({ internet_message_id: `<${Math.random()}@x>`, conversation_id: null, to_addrs: 'admin@company.local', cc_addrs: null,
  received_at: new Date().toISOString(), has_attachments: false, web_link: null, body_excerpt: '', ...over });
const file = async (m: any) => { await tx((c) => fileOnShipment(c, admin, fileId, m, 'tag')); return one('select * from email_messages where message_id = $1', [m.internet_message_id]); };

before(async () => {
  await resetDb();
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  const cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  const cust = (await createMaster(sam, 'customers', { name: 'Red Chief' })).id;
  await saveContact(admin, cust, { full_name: 'Rahman', email: 'rahman@redchief.in', is_primary: true });
  const agentA = (await createMaster(admin, 'vendors', { name: 'Mumbai Agent', vendor_type: 'freight_agent', email: 'rates@mumbaiagent.com' })).id;
  const agentB = (await createMaster(admin, 'vendors', { name: 'Nhava Logistics', vendor_type: 'freight_agent', email: 'quotes@nhavalog.in' })).id;
  fileId = (await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB', port_of_loading: 'Nhava Sheva', port_of_discharge: 'Jebel Ali' })).id;
  reqA = await vr.createVendorRequest(admin, { vendor_id: agentA, service: 'rate', job_file_id: fileId, description: '1x40HC Nhava Sheva → Jebel Ali' });
  reqB = await vr.createVendorRequest(admin, { vendor_id: agentB, service: 'rate', job_file_id: fileId, description: '1x40HC Nhava Sheva → Jebel Ali' });
  // what we sent to agent A also went to their pricing colleague
  await q(`insert into email_messages (job_file_id, direction, status, vendor_request_id, from_addr, to_addrs, cc_addrs, subject, sent_at, source, created_by)
    values ($1, 'out', 'sent', $2, 'admin@company.local', 'rates@mumbaiagent.com', 'pricing@mumbaiagent.com', 'Rate request', now(), 'button', $3)`, [fileId, reqA.id, admin.id]);
  setAiNetwork((async () => { calls++; return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_rate', input: answer }] }), { status: 200 }); }) as typeof fetch);
});

test('replies are matched to their rate request; the customer\'s reply is not; a vendor is never learnt as the customer\'s CC', async () => {
  const a = await file(mail({ from_addr: 'pricing@mumbaiagent.com', from_name: 'Priya', subject: `RE: Rate request ${reqA.request_no}`, cc_addrs: 'boss@mumbaiagent.com' }));
  assert.equal(a.vendor_request_id, reqA.id);
  const b = await file(mail({ from_addr: 'ops@nhavalog.in', subject: 'RE: your enquiry' }));                       // same company domain as agent B
  assert.equal(b.vendor_request_id, reqB.id);
  const c = await file(mail({ from_addr: 'rahman@redchief.in', subject: 'RE: Shipment enquiry' }));
  assert.equal(c.vendor_request_id, null, 'the customer');
  const people = (await q(`select lower(email) e from job_file_email_people where job_file_id = $1`, [fileId])).map((r: any) => r.e);
  assert.ok(!people.some((e: string) => /mumbaiagent|nhavalog/.test(e)), people.join());
  assert.ok(await one(`select 1 from vendor_request_events where request_id = $1 and title = 'Vendor replied by email'`, [reqA.id]));
  // part A (customer answers) does not offer the vendors' replies, and refuses to read them
  const box = await suggestionsFor(admin, fileId);
  assert.deepEqual(box.unread.map((m: any) => m.from_addr), ['rahman@redchief.in']);
  await assert.rejects(readEmail(admin, a.id), /vendor's reply/);
});

test('the AI reads the rate and its lines; read once', async () => {
  answer = { has_rate: true, total: 1050, currency: 'usd', transit_days: 6, free_days: 14, etd: '2026-12-02', routing: 'Direct', carrier: 'MSC',
    valid_until: '2026-12-15', vendor_reference: 'Q-778', quote: 'O/F USD 850/40HC', summary: 'USD 1,050 all in, MSC direct',
    charges: [{ section: 'freight', description: 'Ocean freight', basis: 'per 40HC', quantity: 1, amount: 850, currency: 'USD' },
      { section: 'origin', description: 'THC', basis: 'per 40HC', quantity: 1, amount: 200, currency: 'usd' }] };
  const box: any = await quoteBox(admin, fileId);
  assert.equal(box.unread.length, 2);
  const e = box.unread.find((m: any) => m.request_no === reqA.request_no);
  const s: any = (await readQuote(admin, e.id)).suggestion;
  assert.equal(s.status, 'open');
  assert.deepEqual([s.answers.quoted_cost, s.answers.currency, s.answers.transit_days, s.answers.etd, s.answers.charges.length], [1050, 'USD', 6, '2026-12-02', 2]);
  const n = calls; await readQuote(admin, e.id); assert.equal(calls, n, 'not read twice');
  assert.equal(String((await one('select status from vendor_requests where id = $1', [reqA.id])).status), 'requested', 'nothing saved by the AI');
});

test('a reply without a price: noted, the request keeps waiting', async () => {
  answer = { has_rate: false, no_rate_reason: 'will revert tomorrow', summary: 'No rate yet' };
  const e = ((await quoteBox(admin, fileId)) as any).unread.find((m: any) => m.request_no === reqB.request_no);
  assert.equal((await readQuote(admin, e.id)).suggestion.status, 'nothing');
  const box: any = await quoteBox(admin, fileId);
  assert.equal(box.no_rate[0].unclear[0].note, 'will revert tomorrow');
  await dismissQuote(admin, box.no_rate[0].id);
  assert.equal((await quoteBox(admin, fileId) as any).no_rate.length, 0);
});

test('Save rate (corrected by the person): the request is Quoted, with the details and the charge lines', async () => {
  const box: any = await quoteBox(admin, fileId);
  const s = box.open[0];
  await assert.rejects(applyQuote(admin, s.id, { rate: { currency: 'GBP' } }), /currency/);
  await applyQuote(admin, s.id, { rate: { transit_days: '7' }, use_charges: true });
  const r = await one('select status, quoted_cost::float c, currency, transit_days, free_days, carrier, vendor_reference, rate_valid_until::text v from vendor_requests where id = $1', [reqA.id]);
  assert.deepEqual([r.status, r.c, r.currency, r.transit_days, r.free_days, r.carrier, r.vendor_reference, r.v], ['quoted', 1050, 'USD', 7, 14, 'MSC', 'Q-778', '2026-12-15']);
  assert.equal(Number((await one('select count(*) n from vendor_rate_charges where request_id = $1', [reqA.id])).n), 2);
  assert.equal((await one('select status from ai_suggestions where id = $1', [s.id])).status, 'applied');
  await assert.rejects(applyQuote(admin, s.id, {}), /already handled/);
});

test('only people who see cost: Freight Ops (handles requests, no cost) gets nothing and cannot read or save', async () => {
  const fred = await mkUser(admin, 'Fred Ops', 'freight_ops');
  assert.deepEqual(await quoteBox(fred, fileId), { allowed: false });
  const e = (await one(`select id from email_messages where vendor_request_id = $1 and direction = 'in' limit 1`, [reqB.id])).id;
  await assert.rejects(readQuote(fred, e), /see cost/);
  assert.ok((await quoteBox(sam, fileId) as any).allowed, 'a Salesman here sees cost');
});

test('a reply filed before this existed is matched when the enquiry is opened', async () => {
  const old = (await one(`insert into email_messages (job_file_id, direction, status, from_addr, subject, sent_at, message_id, source, created_by)
    values ($1, 'in', 'received', 'quotes@nhavalog.in', 'RE: rate', now(), '<old@x>', 'mailbox', $2) returning id`, [fileId, admin.id])).id;
  await q(`insert into job_file_email_people (job_file_id, email, side, place, source) values ($1, 'quotes@nhavalog.in', 'customer', 'to', 'customer_email')`, [fileId]);
  const box: any = await quoteBox(admin, fileId);
  assert.ok(box.unread.some((m: any) => m.id === old));
  assert.equal((await one('select vendor_request_id from email_messages where id = $1', [old])).vendor_request_id, reqB.id);
  assert.equal(await one(`select 1 from job_file_email_people where job_file_id = $1 and email = 'quotes@nhavalog.in'`, [fileId]), null);
});

test('21 Nov: "all in 4500" with its breakup → 4500, the three parts as lines; our own ref and "not stated" are dropped', async () => {
  const { settleTotal, blank } = await import('../src/server/quotereader');
  const L = (description: string, amount: number) => ({ section: 'freight', description, basis: 'per container', quantity: 1, amount, currency: 'USD' });
  const r = settleTotal(4500, 'USD', [L('Ocean freight all in', 4500), L('Transportation', 500), L('Customs', 75), L('Ocean freight', 3925)]);
  assert.equal(r.total, 4500); assert.deepEqual(r.lines.map((l: any) => l.amount), [500, 75, 3925]);
  assert.equal(settleTotal(4500, 'USD', [L('Transportation', 500), L('Customs', 75), L('Ocean freight', 3925)]).lines.length, 3);
  const off = settleTotal(4500, 'USD', [L('Transportation', 500), L('Ocean freight', 3925)]);
  assert.deepEqual([off.total, off.lines.length], [4500, 0]); assert.match(off.note!, /add up to USD 4,425, not the USD 4,500/);
  assert.equal(settleTotal(null, 'USD', [L('a', 100), L('b', 50)]).total, 150);
  assert.equal(blank('Not stated in reply'), null); assert.equal(blank('N/A'), null);
  assert.equal(blank('Direct vessel via DP World (no transhipment stated)'), 'Direct vessel via DP World');

  // the whole way, with the AI answering as it did on the real email
  answer = { has_rate: true, total: 4500, currency: 'USD', free_days: 7, etd: '2026-11-28', transit_days: 12, carrier: 'DP World', vendor_reference: 'ENQ-IMP-26-00008',
    exclusions: 'Not stated in reply', summary: 'USD 4,500 all in', charges: [L('Ocean freight (all-in breakup)', 4500), L('Transportation', 500), L('Customs', 75), L('Ocean freight', 3925)] };
  const m = await file(mail({ from_addr: 'quotes@nhavalog.in', subject: `RE: ${reqB.request_no}` }));
  const s: any = (await readQuote(admin, m.id)).suggestion;
  assert.deepEqual([s.answers.quoted_cost, s.answers.charges.length, s.answers.vendor_reference, s.answers.exclusions, s.answers.v], [4500, 3, null, null, 2]);
});

test('a suggestion read the old way (not saved yet) is read again', async () => {
  await q(`update ai_suggestions set answers = answers - 'v' where kind = 'quote' and status = 'open'`);
  const box: any = await quoteBox(admin, fileId);
  assert.equal(box.open.length, 0); assert.ok(box.unread.length >= 1);
});

test('23 Nov: a bounce / out-of-office from the vendor\'s domain is not the vendor\'s reply', async () => {
  const { isBounce } = await import('../src/server/quotereader');
  assert.ok(isBounce({ from_addr: 'postmaster@nhavalog.in', subject: 'Undeliverable: [ENQ-1] Shipment Enquiry' }));
  assert.ok(isBounce({ from_addr: 'ops@nhavalog.in', subject: 'Automatic reply: rate request' }));
  assert.ok(!isBounce({ from_addr: 'ops@nhavalog.in', subject: 'RE: rate request' }));
  const b = await file(mail({ from_addr: 'postmaster@nhavalog.in', subject: `Undeliverable: RE: ${reqB.request_no}` }));
  assert.equal(b.vendor_request_id, null);
});
