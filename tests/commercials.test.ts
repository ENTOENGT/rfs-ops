/** Part E (migration 018) — Commercials Department: enquiry → rates → approval → confirmation → booking → pre-alert → Job No. → handover. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, reqFields } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createUser, updateUser, userAssignments, listUsers } from '../src/server/team';
import { createJobFile, getJobFile, listJobFiles } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as qt from '../src/server/quotations';
import * as cm from '../src/server/commercial';
import { lookups } from '../src/server/admin';
import { createJob } from '../src/server/jobs';

let admin: Actor, mgr: Actor, coord: Actor, coord2: Actor, sales: Actor, sales2: Actor, agent: Actor, ops: Actor, transport: Actor;
let custA: string, custB: string, fresh: string, line: string, line2: string, fileId: string, enq: string, rate1: string, rate2: string, quote: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
const roleId = async (code: string) => (await one('select id from roles where code = $1', [code])).id;
const dept = async (code: string) => (await one('select id from departments where code = $1', [code])).id;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  mgr = await mkUser(admin, 'Manny Manager', 'commercials_manager');
  coord = await mkUser(admin, 'Cora Coord', 'coordinator');
  coord2 = await mkUser(admin, 'Colin Coord', 'coordinator', undefined, { division: 'exports' });
  agent = await mkUser(admin, 'Agnes Agent', 'agent_coordinator');
  ops = await mkUser(admin, 'Otto Ops', 'freight_ops');
  transport = await mkUser(admin, 'Tara Trans', 'transport_manager');
  line = (await createMaster(admin, 'vendors', { name: 'MSC', vendor_type: 'shipping_line', email: 'rates@msc.example' })).id;
  line2 = (await createMaster(admin, 'vendors', { name: 'Gulf Agents', vendor_type: 'overseas_agent' })).id;
});

test('1. Structure: Commercials Department, divisions, Salesman → Coordinator mapping with history; Sea/Air departments retired', async () => {
  const d = await one(`select name from departments where code = 'commercial'`);
  assert.equal(d.name, 'Commercials');
  // the Commercials Manager adds Salesmen to the Commercials Department
  await rejects(createUser(mgr, { full_name: 'No Div', email: 'nodiv@x.ae', role_id: await roleId('sales') }), 'VALIDATION', /division/);
  await rejects(createUser(mgr, { full_name: 'Bad Coord', email: 'bc@x.ae', role_id: await roleId('sales'), division: 'imports', coordinator_id: agent.id }), 'VALIDATION', /Coordinator role/);
  const s = await createUser(mgr, { full_name: 'Sam Sales', email: 'sam@x.ae', role_id: await roleId('sales'), division: 'imports', coordinator_id: coord.id });
  await one('update users set must_change_password = false where id = $1', [s.id]);
  sales = (await loadActor(s.id))!;
  assert.equal(sales.division, 'imports'); assert.equal(sales.department_code, 'commercial');
  sales2 = await mkUser(admin, 'Sue Sales', 'sales', undefined, { coordinator_id: coord.id });   // one Coordinator, many Salesmen
  const list = await listUsers(mgr);
  assert.equal(list.users.find((u: any) => u.id === coord.id).salesmen_count, 2);
  // reassignment needs a reason and is kept
  await rejects(updateUser(mgr, sales2.id, { coordinator_id: coord2.id }), 'VALIDATION', /reason/);
  await updateUser(mgr, sales2.id, { coordinator_id: coord2.id, assignment_reason: 'Cora on leave' });
  const h = await userAssignments(mgr, sales2.id);
  assert.deepEqual([h[0].field, h[0].old_label, h[0].new_label, h[0].reason], ['coordinator', 'Cora Coord', 'Colin Coord', 'Cora on leave']);
  // retired departments can't be chosen for new users (the test database switches them back on for older tests)
  await one(`update departments set is_active = false where code = 'sea_import'`);
  await rejects(createUser(admin, { full_name: 'Old Dept', email: 'old@x.ae', role_id: await roleId('freight_ops'), department_id: await dept('sea_import') }), 'VALIDATION', /department/);
  await one(`update departments set is_active = true where code = 'sea_import'`);
});

test('2. Customers: a Salesman sees own (and unowned) customers; creating one makes them owner; Coordinator sees mapped Salesmen\'s', async () => {
  custA = (await createMaster(admin, 'customers', { name: 'Alpha Trading' })).id;
  custB = (await createMaster(admin, 'customers', { name: 'Beta Foods' })).id;
  await cm.setCustomerOwners(mgr, custB, { owners: [{ user_id: sales2.id, is_main: true }] });
  const { createCustomer } = await import('../src/server/admin');
  fresh = (await createCustomer(sales, { name: 'Gamma New Co' })).id;
  const names = async (a: Actor) => ((await lookups(a)) as any).customers.map((c: any) => c.name).sort();
  assert.deepEqual(await names(sales), ['Alpha Trading', 'Gamma New Co'], 'own + unowned; not Beta (Sue\'s)');
  assert.deepEqual(await names(sales2), ['Alpha Trading', 'Beta Foods']);
  assert.deepEqual(await names(coord), ['Alpha Trading', 'Gamma New Co'], 'Cora coordinates Sam only now');
  assert.deepEqual(await names(agent), []);
  assert.equal((await names(ops)).length, 3, 'Operations keeps seeing every customer');
  assert.deepEqual((await cm.customerOwners(mgr, fresh)).owners.map((o: any) => [o.full_name, o.is_main]), [['Sam Sales', true]]);
  await rejects(createJobFile(sales, { customer_id: custB, direction: 'import', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai' }), 'VALIDATION', /another Salesman/);
});

test('3. Enquiry by a Coordinator: picks the Salesman; Coordinator comes from the mapping; three people kept apart', async () => {
  await rejects(createJobFile(coord, { customer_id: custA, direction: 'import', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai' }), 'VALIDATION', /Salesman/);
  const f = await createJobFile(coord, { customer_id: custA, salesman_id: sales.id, direction: 'import', mode: 'sea_fcl', status: 'enquiry',
    origin: 'Shanghai', destination: 'Jebel Ali', incoterm: 'FOB', port_of_loading: 'CNSHA', port_of_discharge: 'AEJEA', cargo_description: 'Tiles, 1x40HC', job_no: 'IGNORED-1' });
  fileId = f.id; enq = f.enquiry_ref;
  const g = await getJobFile(coord, fileId);
  assert.deepEqual([g.created_by_name, g.salesman_name, g.coordinator_name, g.division, g.job_no], ['Cora Coord', 'Sam Sales', 'Cora Coord', 'imports', null]);
  // Alpha had no owner: the first enquiry makes Sam its main owner
  assert.deepEqual((await cm.customerOwners(mgr, custA)).owners.map((o: any) => o.full_name), ['Sam Sales']);
  // who sees it
  for (const [who, sees] of [[sales, true], [coord, true], [mgr, true], [sales2, false], [ops, false]] as const)
    assert.equal((await listJobFiles(who, { view: 'c_all' })).rows.some((r: any) => r.id === fileId), sees, who.full_name);
});

test('4. Rates: direct line + overseas agent through the Agent Coordinator; full rate detail, comparison, revised version kept', async () => {
  const r = await vr.createVendorRequest(coord, { vendor_ids: [line], service: 'rate', job_file_id: fileId, description: '1x40HC Shanghai → Jebel Ali, ready 20 Nov' });
  rate1 = r.id;
  const a = await vr.createVendorRequest(coord, { vendor_id: line2, service: 'rate', job_file_id: fileId, description: 'Same, via agent', assigned_to: agent.id });
  rate2 = a.id;
  assert.equal((await getJobFile(coord, fileId)).stage, 'rates_requested');
  // the Agent Coordinator sees only what is assigned to them
  const mine = await vr.listVendorRequests(agent, {});
  assert.deepEqual(mine.map((x: any) => x.id), [rate2]);
  await rejects(vr.getVendorRequest(agent, rate1), 'NOT_FOUND');
  await vr.vendorRequestAction(agent, rate2, { status: 'quoted', currency: 'USD', transit_days: 22, routing: 'via Jebel Ali direct', free_days: 14,
    inclusions: 'THC origin', exclusions: 'Duty', rate_valid_until: D(15), carrier: 'CMA CGM',
    charges: [{ section: 'freight', description: 'Ocean freight', basis: 'per container', quantity: 1, amount: '900', currency: 'USD' },
              { section: 'origin', description: 'Origin THC', amount: '150', currency: 'USD' }] });
  const ad = await vr.getVendorRequest(coord, rate2);
  assert.deepEqual([ad.quoted_cost, ad.currency, ad.transit_days, ad.free_days, ad.rate_source, ad.charges.length, ad.assigned_to_name],
    ['1050.00', 'USD', 22, 14, 'agent_coordinator', 2, 'Agnes Agent']);
  await vr.vendorRequestAction(coord, rate1, { status: 'quoted', currency: 'USD', quoted_cost: '1000', transit_days: 18, rate_valid_until: D(10) });
  const d1 = await vr.getVendorRequest(coord, rate1);
  assert.equal(d1.rate_source, 'shipping_line', 'rate source from the vendor type');
  assert.equal((await getJobFile(coord, fileId)).stage, 'rates_received');
  // the line revises its rate: old version kept
  await vr.vendorRequestAction(coord, rate1, { what: 'revise_rate', quoted_cost: '980', note: 'GRI cancelled' });
  const d2 = await vr.getVendorRequest(coord, rate1);
  assert.deepEqual([d2.quoted_cost, d2.previous_quoted_cost, d2.rate_version, d2.versions[0].snapshot.quoted_cost], ['980.00', '1000.00', 2, '1000.00']);
});

test('5. Quotation: Coordinator prepares, Salesman approves / returns; a loss needs a manager too; versions and responses kept', async () => {
  const x = await qt.createQuotation(coord, { customer_id: custA, service_type: 'sea_fcl', job_file_id: fileId,
    lines: [{ description: 'Ocean freight (MSC)', charge_unit: 'container', quantity: '1', cost_rate: '980', margin_type: 'percent', margin_value: '15', vendor_request_id: rate1 }] });
  quote = x.id;
  await qt.quotationAction(coord, quote, { action: 'submit' });
  let d = await qt.getQuotation(coord, quote);
  assert.deepEqual([d.status, d.salesman_id, d.approvals.salesman, d.can.send], ['pending_approval', sales.id, 'waiting', false]);
  assert.equal((await getJobFile(coord, fileId)).stage, 'pending_approval');
  await rejects(qt.quotationAction(coord, quote, { action: 'salesman_approve' }), 'FORBIDDEN');
  await rejects(qt.quotationAction(coord, quote, { action: 'send' }), 'QUOTE_STATE');          // no sending before approval
  assert.equal((await one(`select count(*)::int n from notifications where user_id = $1 and type = 'quote.approval'`, [sales.id])).n, 1);
  await rejects(qt.quotationAction(sales, quote, { action: 'salesman_return' }), 'VALIDATION', /change/);
  await qt.quotationAction(sales, quote, { action: 'salesman_return', reason: 'Add DO fee' });
  d = await qt.getQuotation(coord, quote);
  assert.deepEqual([d.status, d.salesman_decision], ['draft', 'returned']);
  // a loss: selling below cost — shown in red, needs the Salesman AND a manager
  await qt.updateQuotation(coord, quote, { lines: [...d.lines.map((l: any) => ({ ...l, margin_type: 'percent', margin_value: '15' })),
    { description: 'DO fee', charge_unit: 'shipment', quantity: '1', cost_rate: '400', sell_rate: '100' }] });
  await qt.updateQuotation(coord, quote, { lines: [{ description: 'Ocean freight (MSC)', charge_unit: 'container', quantity: '1', cost_rate: '980', sell_rate: '900', vendor_request_id: rate1 }] });
  d = await qt.getQuotation(coord, quote);
  assert.equal(d.loss, true);
  await qt.quotationAction(coord, quote, { action: 'submit' });
  d = await qt.getQuotation(sales, quote);
  assert.deepEqual([d.needs_manager, d.approvals.salesman, d.approvals.manager], [true, 'waiting', 'waiting']);
  await qt.quotationAction(sales, quote, { action: 'salesman_approve' });
  assert.equal((await qt.getQuotation(sales, quote)).status, 'pending_approval', 'still waits for the manager');
  await qt.quotationAction(mgr, quote, { action: 'approve' });
  assert.equal((await qt.getQuotation(sales, quote)).status, 'approved');
  // customer asks for changes → version 2, then approved and sent again
  await qt.quotationAction(coord, quote, { action: 'send' });
  await qt.quotationAction(coord, quote, { action: 'revise', reason: 'Customer wants a better rate', customer_asked: true });
  await qt.updateQuotation(coord, quote, { lines: [{ description: 'Ocean freight (MSC)', charge_unit: 'container', quantity: '1', cost_rate: '980', margin_type: 'percent', margin_value: '10', vendor_request_id: rate1 }] });
  await qt.quotationAction(coord, quote, { action: 'submit' });
  await qt.quotationAction(sales, quote, { action: 'salesman_approve' });
  await qt.quotationAction(coord, quote, { action: 'send' });
  d = await qt.getQuotation(coord, quote);
  assert.equal(d.version_no, 2); assert.equal(d.loss, false);
  assert.deepEqual(d.versions.map((v: any) => [v.version_no, v.reason]), [[2, 'approved'], [1, 'revised'], [1, 'approved']]);
  assert.equal(d.responses[0].response, 'revision_requested');
  // Operations / Transport never see quotations
  assert.equal((await getJobFile(admin, fileId)).quotations.length, 1);
  await rejects(qt.getQuotation(transport, quote), 'FORBIDDEN');
});

test('6. Customer confirms (evidence) → Shipping Ref; booking with the chosen line; pre-alert with a correction; verified', async () => {
  const d = await qt.quotationAction(coord, quote, { action: 'accept', evidence_note: 'Omar confirmed by email 5 Nov 10:12' });
  const sr = d.created_job_file.shipping_ref;
  let g = await getJobFile(coord, fileId);
  assert.deepEqual([g.stage, g.shipping_ref, g.enquiry_ref, g.job_no, g.status], ['customer_confirmed', sr, enq, null, 'enquiry']);
  await rejects(qt.createQuotation(coord, { customer_id: custA, service_type: 'sea_fcl', job_file_id: fileId, lines: [{ description: 'x', charge_unit: 'shipment', quantity: '1', sell_rate: '1' }] }), 'STAGE');
  await cm.requestBooking(coord, fileId, { rate_request_id: rate1, needed_by: D(2) });
  g = await getJobFile(coord, fileId);
  assert.equal(g.stage, 'booking_requested'); assert.equal(g.booking.vendor_name, 'MSC');
  assert.equal((await vr.getVendorRequest(coord, rate1)).status, 'confirmed', 'the chosen rate is confirmed');
  await rejects(cm.requestBooking(coord, fileId, { rate_request_id: rate2 }), 'BOOKING_OPEN');
  await rejects(cm.prealertAction(coord, fileId, { action: 'receive' }), 'STAGE');
  await cm.confirmBooking(coord, fileId, { booking_reference: 'MSCBK123', vessel_flight: 'MSC ANNA', voyage: '045E', etd: D(5), eta: D(25), prealert_expected: D(6) });
  g = await getJobFile(coord, fileId);
  assert.deepEqual([g.stage, g.booking_reference, g.vessel_flight, g.prealert.status], ['prealert_awaited', 'MSCBK123', 'MSC ANNA', 'awaited']);
  await rejects(cm.createOperationalJob(coord, fileId, { job_no: 'IMP-26-0001' }), 'STAGE', /pre-alert/);
  await cm.prealertAction(coord, fileId, { action: 'receive', source: 'shipping_line', vessel_flight: 'MSC ANNA', voyage: '045E', containers: 'MSCU1234565', mbl_mawb: 'MEDUSH001', etd: D(5), eta: D(26) });
  await cm.prealertAction(coord, fileId, { action: 'correction', note: 'Consignee name wrong on BL', follow_up_date: D(1) });
  await rejects(cm.prealertAction(coord, fileId, { action: 'verify' }), 'PREALERT_STATE', /corrected/);
  await cm.prealertAction(coord, fileId, { action: 'receive', source: 'shipping_line', vessel_flight: 'MSC ANNA', voyage: '045E', containers: 'MSCU1234565', mbl_mawb: 'MEDUSH001', etd: D(5), eta: D(26) });
  await rejects(cm.prealertAction(coord, fileId, { action: 'verify', check_vessel: true }), 'VALIDATION', /Voyage/);
  await cm.prealertAction(coord, fileId, { action: 'verify', check_vessel: true, check_voyage: true, check_containers: true, check_bl: true, check_etd: true, check_eta: true });
  g = await getJobFile(coord, fileId);
  assert.deepEqual([g.stage, g.mbl_mawb, g.eta, g.containers.map((k: any) => k.container_no)], ['prealert_verified', 'MEDUSH001', D(26), ['MSCU1234565']]);
  assert.ok(g.events.some((e: any) => e.title === 'ETA from pre-alert' && e.old_value === D(25) && e.new_value === D(26)));
});

test('7. Operational job: Job No. from the ERP on the SAME record, no duplicates, handover recorded; Operations takes over', async () => {
  await createMaster(admin, 'customers', { name: 'Other Co' });
  const other = await createJobFile(admin, { job_no: 'IMP-26-0001', customer_id: custB, direction: 'import', mode: 'air' });
  await rejects(cm.createOperationalJob(coord, fileId, { job_no: 'imp-26-0001' }), 'JOB_FILE_EXISTS');
  const trip = await createJob(transport, { ...reqFields(), job_no: 'IMP-26-0002', customer_id: custA, required_date: D(30), cargo_description: 'x' }).catch(() => null);
  const before = Number((await one('select count(*) n from job_files')).n);
  await cm.createOperationalJob(coord, fileId, { job_no: 'IMP-26-0002', notes: 'Docs with Ops' });
  assert.equal(Number((await one('select count(*) n from job_files')).n), before, 'no second record');
  const g = await getJobFile(ops, fileId);           // Operations sees it now
  assert.deepEqual([g.job_no, g.status, g.stage, g.enquiry_ref, g.shipping_ref !== null, g.handed_over_by_name], ['IMP-26-0002', 'open', 'handed_over', enq, true, 'Cora Coord']);
  assert.ok(g.events.some((e: any) => e.title === 'Operational job created — Job No. IMP-26-0002'));
  assert.ok(g.events.some((e: any) => e.title === 'Handed over to Operations' && e.remarks === 'Docs with Ops'));
  if (trip) assert.equal((await one('select job_file_id from transport_requests where id = $1', [trip.id])).job_file_id, fileId, 'a trip with the same Job No. links');
  await rejects(cm.createOperationalJob(coord, fileId, { job_no: 'IMP-26-0003' }), 'ALREADY_HANDED_OVER');
  assert.equal(g.quotations, null, 'Operations does not see quotations');
  void other;
});

test('8. History cannot be changed or deleted; lost enquiries; manager can create the job without a pre-alert, with a reason', async () => {
  await assert.rejects(q(`update job_file_events set title = 'x' where job_file_id = $1`, [fileId]), /history/);
  await assert.rejects(q(`delete from quotation_events where quotation_id = $1`, [quote]), /history/);
  const l = await createJobFile(sales, { customer_id: fresh, direction: 'export', mode: 'air', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai', cargo_lines: [{ package_type: 'Cartons', pieces: 10, length: 50, width: 40, height: 30, dim_unit: 'cm', weight_kg: 200 }] });
  await rejects(cm.markLost(sales, l.id, {}), 'VALIDATION');
  await cm.markLost(sales, l.id, { reason: 'Customer booked with another forwarder' });
  assert.deepEqual([(await getJobFile(sales, l.id)).stage, (await getJobFile(sales, l.id)).status], ['lost', 'cancelled']);
  // road job, no pre-alert: only the Commercials Manager, with a reason
  const r = await createJobFile(sales, { customer_id: fresh, direction: 'export', mode: 'road', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai', cargo_lines: [{ package_type: 'Cartons', pieces: 10, length: 50, width: 40, height: 30, dim_unit: 'cm', weight_kg: 200 }] });
  const x = await qt.createQuotation(sales, { customer_id: fresh, service_type: 'road', job_file_id: r.id, lines: [{ description: 'Truck', charge_unit: 'trip', quantity: '1', cost_rate: '1000', sell_rate: '1500' }] });
  await qt.quotationAction(sales, x.id, { action: 'submit' });
  await qt.quotationAction(sales, x.id, { action: 'accept', evidence_note: 'Confirmed on WhatsApp by the buyer' });
  await rejects(cm.createOperationalJob(coord, r.id, { job_no: 'EXP-1' }), 'STAGE');   // a Coordinator can't skip the pre-alert
  await rejects(cm.createOperationalJob(mgr, r.id, { job_no: 'EXP-1' }), 'VALIDATION', /why/);
  // an export enquiry is in the Exports division now (step 4), so the BL rule applies too
  await cm.createOperationalJob(mgr, r.id, { job_no: 'EXP-1', skip_prealert_reason: 'Road job — no pre-alert', bl_override_reason: 'Road job — CMR, no BL' });
  assert.equal((await getJobFile(mgr, r.id)).stage, 'handed_over');
});

test('9. Overview: counts by stage, division, Salesman and Coordinator; Salesman approvals waiting', async () => {
  const f = await createJobFile(sales, { customer_id: fresh, direction: 'import', mode: 'sea_lcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai', cargo_lines: [{ package_type: 'Cartons', pieces: 10, length: 50, width: 40, height: 30, dim_unit: 'cm', weight_kg: 200 }] });
  const o = await cm.commercialOverview(mgr, {});
  const t = Object.fromEntries(o.tiles.map((x: any) => [x.key, x.count]));
  assert.equal(t.c_enquiry, 1); assert.equal(t.c_handed_over, 2);
  assert.ok(o.by_division.some((d: any) => d.division === 'imports' && d.open >= 1));
  assert.ok(o.by_salesman.some((p: any) => p.full_name === 'Sam Sales'));
  assert.ok(o.by_coordinator.some((p: any) => p.full_name === 'Cora Coord'));
  const own = await cm.commercialOverview(sales2, {});
  assert.equal(own.tiles.find((x: any) => x.key === 'c_enquiry')!.count, 0, 'Sue sees only her shipments');
  void f;
});
