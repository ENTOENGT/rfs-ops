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
