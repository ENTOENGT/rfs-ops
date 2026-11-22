/** AI batch 3 (migration 039): quotation lines keep the vendor's amount / currency / exchange rate and split-ups vs all-in;
 *  the AI's best-vendor recommendation (totals in AED worked out here, expired rates flagged, compared once per set of rates)
 *  and its mismatches (ask the customer, ask the vendor, or solve internally — all in the history). Cost viewers only. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as qt from '../src/server/quotations';
import { setAiNetwork } from '../src/server/ai';
import { issueAction, recommendBox, runRecommend } from '../src/server/recommend';
import { emailDraft, emailPrepared } from '../src/server/emails';
import { lineOnly } from '../src/server/quotereader';

const D = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let admin: Actor, coord: Actor, fred: Actor, fileId: string, rA: string, rB: string;
let answer: any = {}, calls = 0, sent: any = null;

before(async () => {
  await resetDb();
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  coord = await mkUser(admin, 'Cora Coord', 'coordinator');
  const sales = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: coord.id });
  fred = await mkUser(admin, 'Fred Ops', 'freight_ops');
  await q(`insert into settings (key, value) values ('fx_USD', '3.6725') on conflict (key) do update set value = excluded.value`);
  const cust = (await createMaster(sales, 'customers', { name: 'Comp Co', email: 'buyer@compco.ae' })).id;
  const a = (await createMaster(admin, 'vendors', { name: 'Agent A', vendor_type: 'freight_agent', email: 'a@agenta.com' })).id;
  const b = (await createMaster(admin, 'vendors', { name: 'Agent B', vendor_type: 'freight_agent', email: 'b@agentb.com' })).id;
  fileId = (await createJobFile(sales, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', port_of_loading: 'Shanghai', port_of_discharge: 'Jebel Ali',
    pickup_address: 'No 8 Industrial Rd, Shanghai', needs_clearance: true, needs_transport: true, delivery_address: 'Al Quoz, Dubai', cargo_description: 'Furniture' })).id;
  rA = (await vr.createVendorRequest(coord, { vendor_id: a, service: 'rate', job_file_id: fileId, description: 'EXW 1x40HC' })).id;
  rB = (await vr.createVendorRequest(coord, { vendor_id: b, service: 'rate', job_file_id: fileId, description: 'EXW 1x40HC' })).id;
  await vr.vendorRequestAction(coord, rA, { status: 'quoted', currency: 'USD', transit_days: 18, free_days: 14, rate_valid_until: D(10), exclusions: 'Origin pickup',
    charges: [{ section: 'freight', description: 'Ocean freight', basis: 'per 40HC', quantity: 1, amount: '3925', currency: 'USD' },
      { section: 'origin', description: 'Export customs', basis: 'per BL', quantity: 1, amount: '75', currency: 'USD' }] });
  await vr.vendorRequestAction(coord, rB, { status: 'quoted', currency: 'AED', quoted_cost: '16000', transit_days: 25, rate_valid_until: D(-1) });
  setAiNetwork((async (_u: any, init: any) => { calls++; sent = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'recommend_vendor', input: answer }] }), { status: 200 }); }) as typeof fetch);
});

test('quotation lines keep where a vendor cost came from (amount, currency, rate, split-ups / all-in); a typed cost drops it', async () => {
  const x = await qt.createQuotation(coord, { customer_id: (await one('select customer_id from job_files where id = $1', [fileId])).customer_id, service_type: 'sea_fcl', job_file_id: fileId, currency: 'AED',
    lines: [
      { description: 'Ocean freight', charge_unit: 'container', quantity: '1', cost_rate: '14414.56', cost_original: '3925.00', cost_currency: 'USD', cost_fx: '3.6725', rate_mode: 'split', vendor_request_id: rA, margin_type: 'percent', margin_value: '10' },
      { description: 'Export customs', charge_unit: 'shipment', quantity: '1', cost_rate: '300', cost_original: '75.00', cost_currency: 'USD', cost_fx: '3.6725', rate_mode: 'split', vendor_request_id: rA, sell_rate: '400' },
    ] });
  const d: any = await qt.getQuotation(coord, x.id);
  assert.deepEqual([d.lines[0].cost_currency, d.lines[0].cost_original, d.lines[0].cost_fx, d.lines[0].rate_mode], ['USD', '3925.00', '3.672500', 'split']);
  assert.deepEqual([d.lines[1].cost_currency, d.lines[1].cost_fx, d.lines[1].rate_mode], [null, null, 'split'], 'cost typed by hand (300 ≠ 75 × 3.6725): no longer the vendor amount × rate');
  await assert.rejects(qt.createQuotation(coord, { customer_id: d.customer_id, service_type: 'sea_fcl', job_file_id: fileId,
    lines: [{ description: 'x', charge_unit: 'shipment', quantity: '1', cost_rate: '1', cost_original: '1', cost_currency: 'USD', cost_fx: '-2', sell_rate: '2' }] }), /exchange rate/);
  // the vendor rates on the quotation bring their charge lines (for split-ups)
  const rates = await qt.vendorRatesFor(fileId);
  assert.equal(rates.find((r: any) => r.id === rA).charges.length, 2);
});

test('the AI recommendation: AED totals and the expired rate worked out here; compared once per set of rates', async () => {
  const before = await recommendBox(coord, fileId) as any;
  assert.deepEqual([before.allowed, before.rates, before.current], [true, 2, false]);
  answer = { recommended: 'VR-x', reason: 'r', vendors: [] };
  const no = (await one('select request_no from vendor_requests where id = $1', [rA])).request_no, noB = (await one('select request_no from vendor_requests where id = $1', [rB])).request_no;
  answer = { recommended: no, reason: 'Agent A: cheaper in AED and valid; Agent B has expired.', vendors: [{ request_no: no, verdict: 'recommended', hidden_costs: ['Origin pickup excluded'] }, { request_no: noB, verdict: 'not_suitable', risks: ['Long transit'] }],
    issues: [{ issue: 'EXW needs pickup at origin but Agent A excludes origin pickup', ask: 'Please quote the pickup from No 8 Industrial Rd, Shanghai.', target: 'vendor', request_no: no },
      { issue: 'Delivery address in Al Quoz: is a tail-lift needed?', ask: 'Do you need a tail-lift truck for delivery?', target: 'customer' }] };
  const r: any = await runRecommend(coord, fileId);
  const text = sent.messages[0].content;
  assert.match(text, /USD 4000 \(≈ AED 14690\)/, 'converted here, with the Settings rate');
  assert.match(text, /EXPIRED/);
  assert.match(text, /our customer's side covers: pickup at origin, export clearance, freight, import clearance, delivery/);
  const res = r.last.result;
  assert.deepEqual([res.recommended_request_id, res.recommended_vendor], [rA, 'Agent A']);
  const b = res.vendors.find((v: any) => v.request_id === rB);
  assert.deepEqual([b.total_aed, b.expired, b.verdict, b.risks[0]], [16000, true, 'not_suitable', 'The rate has expired — ask for a new validity']);
  assert.equal(r.issues.length, 2);
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title = 'AI recommends ${no} (Agent A)'`, [fileId]));
  const n = calls; await runRecommend(coord, fileId); assert.equal(calls, n, 'same rates: not compared again');
  assert.equal((await qt.vendorRatesFor(fileId)).find((x: any) => x.id === rA).ai_recommended, true);
});

test('mismatches: email the vendor (to its people) → asked; solved internally needs a note; all in the history', async () => {
  const box: any = await recommendBox(coord, fileId);
  const iv = box.issues.find((i: any) => i.target === 'vendor'), ic = box.issues.find((i: any) => i.target === 'customer');
  const d: any = await emailDraft(coord, { kind: 'clarify_vendor', id: iv.id });
  assert.deepEqual(d.recipients.map((x: any) => x.email), ['a@agenta.com']);
  assert.match(d.body, /Please quote the pickup from No 8 Industrial Rd/);
  await emailPrepared(coord, { kind: 'clarify_vendor', id: iv.id, to: ['a@agenta.com'], subject: d.subject, body: d.body });
  assert.equal((await one('select status from scope_issues where id = $1', [iv.id])).status, 'asked_vendor');
  assert.ok(await one(`select 1 from vendor_request_events where request_id = $1 and title = 'Clarification asked'`, [rA]));
  const dc: any = await emailDraft(coord, { kind: 'clarify_customer', id: ic.id });
  assert.match(dc.body, /tail-lift/);
  await assert.rejects(issueAction(coord, ic.id, { action: 'resolved' }), /Say how it was solved/);
  await issueAction(coord, ic.id, { action: 'resolved', note: 'Customer has a forklift' });
  const after: any = await recommendBox(coord, fileId);
  assert.ok(after.issues.every((i: any) => i.status !== 'open'));
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title = 'Mismatch solved internally'`, [fileId]));
  // a new rate → compared again; the handled mismatches stay
  await vr.vendorRequestAction(coord, rB, { what: 'revise_rate', quoted_cost: '14000', note: 'better', rate_valid_until: D(5) });
  answer = { recommended: 'none', reason: 'x', no_fit_reason: 'Neither includes the pickup.', vendors: [], issues: [] };
  const again: any = await runRecommend(coord, fileId);
  assert.deepEqual([again.last.result.recommended_request_id, again.last.result.no_fit_reason], [null, 'Neither includes the pickup.']);
  assert.equal(again.issues.length, 2, 'handled ones kept');
});

test('cost viewers only; terminal names are not shipping lines', async () => {
  assert.deepEqual(await recommendBox(fred, fileId), { allowed: false });
  await assert.rejects(runRecommend(fred, fileId), /see cost/);
  assert.equal(lineOnly('DP World'), null); assert.equal(lineOnly('MSC'), 'MSC'); assert.equal(lineOnly('Jebel Ali terminal 3'), null);
});
