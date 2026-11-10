/** Migrations 017 + 018 — one shipment record from enquiry: enquiry (Enquiry Ref) → vendor rate → quotation from the rate → customer confirmed (Shipping Ref). */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile, listJobFiles, setJobFileStatus } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as qt from '../src/server/quotations';
import { erpOverview } from '../src/server/erp';

let admin: Actor, sales: Actor, coord: Actor, enqRef: string, mgr: Actor, transport: Actor, fin: Actor, customer: string, other: string, vendor: string, fileId: string, rateId: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  coord = await mkUser(admin, 'Cora', 'coordinator');
  sales = await mkUser(admin, 'Sally', 'sales', undefined, { coordinator_id: coord.id });
  mgr = await mkUser(admin, 'ComMgr', 'operations_manager', 'commercial');
  transport = await mkUser(admin, 'Trans', 'transport_manager');
  fin = await mkUser(admin, 'Fin', 'finance');
  customer = (await createMaster(mgr, 'customers', { name: 'Desert Retail' })).id;
  other = (await createMaster(mgr, 'customers', { name: 'Other Co' })).id;
  vendor = (await createMaster(mgr, 'vendors', { name: 'MSC', vendor_type: 'shipping_line' })).id;
});

test('1. The enquiry opens the shipment record with its Enquiry Ref — the Job No. comes later from the ERP', async () => {
  const f = await createJobFile(sales, { customer_id: customer, direction: 'import', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai',
    origin: 'Shanghai', destination: 'Jebel Ali', cargo_description: 'Furniture, 2x40HC' });
  fileId = f.id; enqRef = f.enquiry_ref;
  assert.match(enqRef, /^ENQ-(IMP-|EXP-|CTR-)?\d{2}-\d{5}$/);
  const g = await getJobFile(sales, fileId);
  assert.equal(g.status, 'enquiry'); assert.equal(g.job_no, null); assert.equal(g.stage, 'enquiry');
  assert.equal(g.salesman_name, 'Sally'); assert.equal(g.coordinator_name, 'Cora'); assert.equal(g.created_by_name, 'Sally');
  assert.ok(g.events.some((e: any) => e.title === `Enquiry ${enqRef} received`));
  assert.equal((await listJobFiles(sales, { view: 'enquiry' })).total, 1);
  assert.equal((await listJobFiles(sales, { view: 'open' })).total, 0, 'an enquiry is not a live shipment yet');
  await rejects(setJobFileStatus(mgr, fileId, { status: 'closed' }), 'JOB_FILE_ENQUIRY');
  await rejects(setJobFileStatus(mgr, fileId, { status: 'open' }), 'JOB_FILE_ENQUIRY');
});

test('2. Ask the vendor for a rate on the same Job No.; the rate (cost) is visible only to cost viewers', async () => {
  const r = await vr.createVendorRequest(sales, { vendor_id: vendor, service: 'rate', job_no: enqRef.toLowerCase(), description: 'Rate for 2x40HC Shanghai → Jebel Ali', needed_by: D(2) });
  rateId = r.id;
  await vr.vendorRequestAction(sales, rateId, { status: 'quoted', quoted_cost: '1000', vendor_reference: 'MSC-Q-55', rate_valid_until: D(20) });
  const g = await getJobFile(sales, fileId);
  assert.deepEqual(g.vendor_requests.map((x: any) => [x.request_no, x.service, x.quoted_cost, x.rate_valid_until]), [[r.request_no, 'rate', '1000.00', D(20)]]);
  assert.equal(g.stage, 'rates_received');
  const t = await getJobFile(transport, fileId);
  assert.equal(t.quotations, null, 'no quotations for transport');
  const noCost = await mkUser(admin, 'Clerk', 'customer_service');
  const n = await getJobFile(noCost, fileId).catch(() => null);
  if (n?.vendor_requests) assert.ok(n.vendor_requests.every((x: any) => x.quoted_cost === undefined), 'no vendor cost without cost view');
});

let q1: string, q2: string;
test('3. The quotation is made on the same Job No., with the vendor rate as its cost line and the margin on top', async () => {
  const g = await getJobFile(sales, fileId);
  const line = { description: 'Ocean freight (MSC)', charge_unit: 'shipment', quantity: '1', cost_rate: g.vendor_requests[0].quoted_cost,
    margin_type: 'percent', margin_value: '20', vendor_request_id: rateId };
  await rejects(qt.createQuotation(sales, { customer_id: other, service_type: 'sea_fcl', job_file_id: fileId, lines: [line] }), 'VALIDATION', /another customer/);
  // a vendor rate from another Job No. can't be used
  const f2 = await createJobFile(sales, { customer_id: customer, direction: 'import', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai' });
  await rejects(qt.createQuotation(sales, { customer_id: customer, service_type: 'sea_fcl', job_file_id: f2.id, lines: [line] }), 'VALIDATION', /another Job No/);
  const x = await qt.createQuotation(sales, { customer_id: customer, service_type: 'sea_fcl', job_no: enqRef, origin: 'Shanghai', destination: 'Jebel Ali',
    lines: [line, { description: 'Documentation', charge_unit: 'shipment', quantity: '1', cost_rate: '0', sell_rate: '150' }] });
  q1 = x.id;
  const d = await qt.getQuotation(sales, q1);
  assert.equal(d.job_no, null); assert.equal(d.enquiry_ref, enqRef); assert.equal(d.salesman_id, sales.id);
  assert.deepEqual([d.lines[0].cost_rate, d.lines[0].sell_rate, d.lines[0].vendor_request_id], ['1000.00', '1250.00', rateId]);
  assert.equal(d.vendor_rates.length, 1, 'the Job No.\'s vendor rates are offered when editing');
  assert.ok((await getJobFile(sales, fileId)).events.some((e: any) => e.title === `Quotation ${d.quote_no} prepared`));
  // a second option for the same enquiry
  q2 = (await qt.copyQuotation(sales, q1)).id;
  assert.equal((await qt.getQuotation(sales, q2)).job_file_id, fileId, 'the copy stays on the same Job No.');
});

test('4. Customer confirms: SAME record, Shipping Ref made, evidence kept; the other option is cancelled; still Commercials until handover', async () => {
  await qt.quotationAction(sales, q1, { action: 'submit' });
  await qt.quotationAction(sales, q2, { action: 'submit' });
  await qt.quotationAction(sales, q1, { action: 'send' });
  assert.equal((await getJobFile(sales, fileId)).stage, 'sent_to_customer');
  const before = Number((await one('select count(*) n from job_files')).n);
  await rejects(qt.quotationAction(sales, q1, { action: 'accept' }), 'VALIDATION', /confirmation/);
  const d = await qt.quotationAction(sales, q1, { action: 'accept', evidence_note: 'Customer confirmed by email on 5 Nov, Omar' });
  assert.equal(d.status, 'accepted');
  assert.equal(d.created_job_file.id, fileId); assert.match(d.created_job_file.shipping_ref, /^SR-\d{2}-\d{5}$/);
  assert.equal(Number((await one('select count(*) n from job_files')).n), before, 'no second record');
  const g = await getJobFile(sales, fileId);
  assert.equal(g.status, 'enquiry'); assert.equal(g.stage, 'customer_confirmed'); assert.equal(g.job_no, null);
  assert.equal(g.shipping_ref, d.created_job_file.shipping_ref); assert.equal(g.quotation.id, q1);
  assert.ok(g.events.some((e: any) => e.title === `Quotation ${d.quote_no} v1 confirmed by the customer` && e.new_value === g.shipping_ref));
  assert.equal(d.responses[0].response, 'accepted'); assert.ok(d.versions.some((v: any) => v.reason === 'confirmed by the customer'));
  const other = await qt.getQuotation(sales, q2);
  assert.equal(other.status, 'cancelled'); assert.match(other.decline_reason, /was accepted instead/);
  assert.deepEqual(g.quotations.map((x: any) => x.status), ['accepted', 'cancelled']);
});

test('5. A rate request is not a service to pay: it never goes to the ERP', async () => {
  await vr.vendorRequestAction(sales, rateId, { status: 'confirmed', vendor_reference: 'MSC-Q-55' });
  await vr.vendorRequestAction(sales, rateId, { status: 'completed', note: 'Rate used in the accepted quotation' });
  assert.equal((await erpOverview(fin)).ready_by_type.vendor, 0);
});

test('6. One rate request to several vendors: compare, lowest marked, warning when a dearer vendor is chosen', async () => {
  const cma = (await createMaster(mgr, 'vendors', { name: 'CMA CGM', vendor_type: 'shipping_line' })).id;
  const mae = (await createMaster(mgr, 'vendors', { name: 'Maersk', vendor_type: 'shipping_line' })).id;
  const one3 = (await createMaster(mgr, 'vendors', { name: 'ONE', vendor_type: 'shipping_line' })).id;
  const f = await createJobFile(sales, { customer_id: customer, direction: 'import', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai' });
  await rejects(vr.createVendorRequest(sales, { vendor_ids: [vendor, cma], service: 'booking', job_file_id: f.id, description: 'x' }), 'VALIDATION', /rate requests/);
  const r = await vr.createVendorRequest(sales, { vendor_ids: [vendor, cma, mae], service: 'rate', job_file_id: f.id, description: '1x40HC Ningbo → Jebel Ali', needed_by: D(1) });
  assert.equal(r.ids.length, 3); assert.ok(r.rate_group);
  const [msc, cmaR, maeR] = r.ids;
  await vr.vendorRequestAction(sales, msc, { status: 'quoted', quoted_cost: '1000', rate_valid_until: D(10) });
  await vr.vendorRequestAction(sales, cmaR, { status: 'quoted', quoted_cost: '900', rate_valid_until: D(10) });
  await vr.vendorRequestAction(sales, maeR, { status: 'quoted', quoted_cost: '800', rate_valid_until: D(-1) }); // expired: does not count
  // one more vendor on the same request later; the same vendor twice is refused
  const extra = await vr.createVendorRequest(sales, { vendor_id: one3, same_as: msc });
  await rejects(vr.createVendorRequest(sales, { vendor_id: cma, same_as: msc }), 'VALIDATION', /already been asked/);
  const g = await getJobFile(sales, f.id);
  const rates = g.vendor_requests.filter((x: any) => x.rate_group === r.rate_group);
  assert.equal(rates.length, 4);
  assert.deepEqual(rates.filter((x: any) => x.lowest).map((x: any) => x.vendor_name), ['CMA CGM']);
  assert.equal((await vr.getVendorRequest(sales, extra.id)).compare.length, 4);
  // choosing MSC (dearer) gives the message
  const d = await vr.getVendorRequest(sales, msc);
  assert.match(d.cheaper_warning, /CMA CGM quoted less for the same request: AED 900.00/);
  assert.equal((await vr.getVendorRequest(sales, cmaR)).cheaper_warning, null, 'no message for the cheapest');
  const x = await qt.createQuotation(sales, { customer_id: customer, service_type: 'sea_fcl', job_file_id: f.id,
    lines: [{ description: 'Ocean freight', charge_unit: 'shipment', quantity: '1', cost_rate: '1000', margin_type: 'percent', margin_value: '10', vendor_request_id: msc }] });
  assert.equal(x.warnings.length, 1); assert.match(x.warnings[0], /^"Ocean freight": CMA CGM quoted less/);
  const qd = await qt.getQuotation(sales, x.id);
  assert.equal(qd.rate_warnings.length, 1);
  assert.ok(qd.events.some((e: any) => e.title === 'Dearer vendor rate used'));
  assert.deepEqual(qd.vendor_rates.filter((v: any) => v.lowest).map((v: any) => v.vendor_name), ['CMA CGM']);
  // switch the line to CMA: the message goes away
  const u = await qt.updateQuotation(sales, x.id, { lines: [{ description: 'Ocean freight', charge_unit: 'shipment', quantity: '1', cost_rate: '900', margin_type: 'percent', margin_value: '10', vendor_request_id: cmaR }] });
  assert.deepEqual(u.rate_warnings, []);
  // confirming the dearer vendor anyway is allowed and recorded
  await vr.vendorRequestAction(sales, msc, { status: 'confirmed', vendor_reference: 'MSC-1' });
  assert.ok((await vr.getVendorRequest(sales, msc)).events.some((e: any) => e.title === 'Chosen although another vendor quoted less'));
});
