/** Part G2 (migration 022) — the 20-step scenario: one enquiry China → Dubai with three loading ports, rates per port,
 *  one quotation with three options, the customer picks one, booking, vessel legs (via), BL draft with a correction,
 *  customer confirmation, final BL, handover. Plus the handover rule for Exports (decision D3). */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as qt from '../src/server/quotations';
import * as cm from '../src/server/commercial';
import * as rt from '../src/server/routing';
import * as tp from '../src/server/templates';
import * as em from '../src/server/emails';
import * as docs from '../src/server/jfdocs';
import { localWrite } from '../src/server/storage';

let admin: Actor, mgr: Actor, coord: Actor, sales: Actor;
let cust: string, msc: string, cosco: string, one_: string, fileId: string, enq: string;
const routes: Record<string, string> = {};
const rate: Record<string, string> = {};
let quoteId: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
async function upload(a: Actor, id: string, name: string, doc_type: string) {
  const r = await docs.requestJfUpload(a, id, { file_name: name, mime_type: 'application/pdf', size: 700, doc_type });
  await localWrite(new URL('http://x' + r.upload.url).searchParams.get('key')!, Buffer.alloc(700, 1), 'application/pdf');
  return (await docs.confirmJfUpload(a, id, { ticket: r.ticket })).uploaded_document_id as string;
}
const notes = async (u: Actor, event: string) => (await q('select title from notifications where user_id = $1 and job_file_id = $2 and event = $3', [u.id, fileId, event]));

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  mgr = await mkUser(admin, 'Manny Manager', 'commercials_manager', undefined, { division: 'imports' });
  coord = await mkUser(admin, 'Cora Coord', 'coordinator');
  sales = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: coord.id });
  cust = (await createMaster(admin, 'customers', { name: 'Desert Retail', email: 'info@desert.ae' })).id;
  msc = (await createMaster(admin, 'vendors', { name: 'MSC', vendor_type: 'shipping_line', email: 'rates@msc.example' })).id;
  cosco = (await createMaster(admin, 'vendors', { name: 'COSCO', vendor_type: 'shipping_line', email: 'rates@cosco.example' })).id;
  one_ = (await createMaster(admin, 'vendors', { name: 'China Partner', vendor_type: 'overseas_agent', email: 'ops@cp.example' })).id;
});

test('1–2. One enquiry China → Dubai with three loading ports under the same Enquiry Ref', async () => {
  const f = await createJobFile(sales, { customer_id: cust, direction: 'import', mode: 'sea_fcl', status: 'enquiry', origin: 'Shanghai', port_of_loading: 'CNSHA',
    destination: 'Dubai', port_of_discharge: 'AEJEA', cargo_description: 'Ceramic tiles' });
  fileId = f.id; enq = f.enquiry_ref;
  await rejects(rt.routeAction(coord, fileId, { step: 'add' }), 'VALIDATION', /loading port/);
  await rt.routeAction(coord, fileId, { step: 'add', origin_city: 'Ningbo', pol: 'CNNGB', origin_country: 'China' });
  const g = await rt.routeAction(coord, fileId, { step: 'add', origin_city: 'Shenzhen', pol: 'CNSZX', origin_country: 'China' });
  assert.deepEqual(g.routes.map((r: any) => [r.option_no, r.pol, r.pod]), [[1, 'CNSHA', 'AEJEA'], [2, 'CNNGB', 'AEJEA'], [3, 'CNSZX', 'AEJEA']]);
  for (const r of g.routes) routes[r.pol] = r.id;
  assert.equal((await q('select count(*)::int n from job_files where enquiry_ref = $1', [enq]))[0].n, 1, 'no separate enquiries');
  assert.ok(g.events.some((e: any) => e.title === 'Route option 2 added'));
});

test('3–4. Separate rate requests per route; cheapest marked within each option, never across', async () => {
  await rejects(vr.createVendorRequest(coord, { vendor_id: msc, service: 'rate', job_file_id: fileId, description: '2x40HC' }), 'VALIDATION', /which route option/);
  const a = await vr.createVendorRequest(coord, { vendor_ids: [msc, cosco], service: 'rate', job_file_id: fileId, route_id: routes.CNSHA, description: '2x40HC' });
  const b = await vr.createVendorRequest(coord, { vendor_id: msc, service: 'rate', job_file_id: fileId, route_id: routes.CNNGB, description: '2x40HC' });
  const c = await vr.createVendorRequest(coord, { vendor_id: one_, service: 'rate', job_file_id: fileId, route_id: routes.CNSZX, description: '2x40HC' });
  [rate.shaMsc, rate.shaCosco] = a.ids; rate.ngb = b.id; rate.szx = c.id;
  // more vendors on the same request = the same option
  const more = await vr.createVendorRequest(coord, { vendor_id: one_, service: 'rate', same_as: rate.ngb, description: '2x40HC' });
  rate.ngbAgent = more.id;
  assert.equal((await one('select route_id from vendor_requests where id = $1', [more.id])).route_id, routes.CNNGB);
  for (const [id, cost] of [[rate.shaMsc, '1500'], [rate.shaCosco, '1400'], [rate.ngb, '1100'], [rate.ngbAgent, '1250'], [rate.szx, '1300']] as const)
    await vr.vendorRequestAction(coord, id, { status: 'quoted', quoted_cost: cost, currency: 'USD', rate_valid_until: D(20), transit_days: '18' });
  const g = await getJobFile(coord, fileId);
  const low = g.vendor_requests.filter((r: any) => r.lowest).map((r: any) => r.id).sort();
  assert.deepEqual(low, [rate.shaCosco, rate.ngb].sort(), 'Shanghai: COSCO 1400; Ningbo: MSC 1100; Shenzhen has one rate');
  // the agent email names the exact option
  const e = await em.emailDraft(coord, { kind: 'vendor_request', id: rate.ngb });
  assert.equal(e.subject, `[${enq}] Shipment Enquiry – Shanghai to Dubai – Option 2 · CNNGB → AEJEA`);
  assert.match(e.body, /Please quote for this option only:\nRoute option: Option 2\nOrigin: Ningbo, China\nPort of loading: CNNGB/);
});

test('5–9. One quotation with three options; default terms; email keeps the Enquiry Ref; approval', async () => {
  await tp.saveTermTemplate(mgr, { name: 'Imports sea FCL', division: 'imports', mode: 'sea', shipment_type: 'fcl', scope: 'Port to door', exclusions: 'Duty and VAT' });
  const L = (desc: string, r: string, cost: string, sell: string) => ({ description: desc, charge_unit: 'container', quantity: '2', cost_rate: cost, sell_rate: sell, vendor_request_id: r });
  await rejects(qt.createQuotation(coord, { customer_id: cust, service_type: 'sea_fcl', job_file_id: fileId,
    lines: [{ description: 'Local charges', charge_unit: 'shipment', quantity: '1', cost_rate: '100', sell_rate: '150' }] }), 'VALIDATION', /which route option/);
  await rejects(qt.createQuotation(coord, { customer_id: cust, service_type: 'sea_fcl', job_file_id: fileId,
    lines: [{ ...L('Ocean freight', rate.ngb, '1100', '1300'), route_id: routes.CNSHA }] }), 'VALIDATION', /another route option/);
  quoteId = (await qt.createQuotation(coord, { customer_id: cust, service_type: 'sea_fcl', job_file_id: fileId, valid_until: D(10),
    lines: [L('Ocean freight', rate.shaCosco, '1400', '1650'), L('Ocean freight', rate.ngb, '1100', '1350'), L('Ocean freight', rate.szx, '1300', '1550'),
      { description: 'DO and terminal handling', charge_unit: 'shipment', quantity: '1', cost_rate: '400', sell_rate: '500', route_id: routes.CNNGB }] })).id;
  let x = await qt.getQuotation(coord, quoteId);
  assert.deepEqual(x.options.map((o: any) => [o.option_no, o.sell_total]), [[1, '3300.00'], [2, '3200.00'], [3, '3100.00']]);
  assert.equal(x.scope, 'Port to door', 'default terms applied');
  await qt.quotationAction(coord, quoteId, { action: 'submit' });
  await qt.quotationAction(sales, quoteId, { action: 'salesman_approve' });
  x = await qt.getQuotation(coord, quoteId);
  assert.equal(x.status, 'approved');
  const copy = await qt.customerCopy(coord, quoteId, 'print');
  assert.deepEqual(copy.options!.map((o: any) => [o.option_no, o.pol, o.lines.length, o.total]), [[1, 'CNSHA', 1, '3300.00'], [2, 'CNNGB', 2, '3200.00'], [3, 'CNSZX', 1, '3100.00']]);
  const mail = await em.emailDraft(coord, { kind: 'quotation', id: quoteId });
  assert.ok(mail.subject.startsWith(`[${enq}]`));
  assert.match(mail.body, /Option 2 · CNNGB → AEJEA\n- Ocean freight: AED 1,350\.00 per container x 2 = AED 2,700\.00\n- DO and terminal handling: AED 500\.00 per shipment\nOption 2 total: AED 3,200\.00/);
  assert.ok(!/1,100|1,400|cost/i.test(mail.body));
  await qt.quotationAction(coord, quoteId, { action: 'send' });
});

test('10–11. The customer chooses Ningbo: the route is locked on the shipment, the others kept; Shipping Ref made', async () => {
  await rejects(qt.quotationAction(coord, quoteId, { action: 'accept', evidence_note: 'Email from Omar 6 Nov: go with Ningbo' }), 'VALIDATION', /Which option/);
  await qt.quotationAction(coord, quoteId, { action: 'accept', evidence_note: 'Email from Omar 6 Nov: go with Ningbo', route_id: routes.CNNGB });
  const g = await getJobFile(coord, fileId);
  assert.match(g.shipping_ref, /^SR-\d{2}-\d{5}$/);
  assert.deepEqual([g.port_of_loading, g.origin, g.selected_route_id, g.stage], ['CNNGB', 'Ningbo', routes.CNNGB, 'customer_confirmed']);
  assert.equal(g.routes.length, 3, 'other options kept');
  assert.ok(g.events.some((e: any) => e.title === 'Customer chose Option 2 · CNNGB → AEJEA'));
  await rejects(rt.routeAction(coord, fileId, { step: 'add', pol: 'CNXMN' }), 'ROUTE_LOCKED');
  assert.equal((await em.emailDraft(coord, { kind: 'job_file', id: fileId })).subject, `[${enq}] [${g.shipping_ref}] Shipment Booking – Shanghai to Dubai`, 'same subject words, SR added');
});

test('12–14. Booking only with the chosen option; confirmation details; vessel legs via Colombo', async () => {
  await rejects(cm.requestBooking(coord, fileId, { rate_request_id: rate.shaCosco }), 'VALIDATION', /did not choose/);
  await cm.requestBooking(coord, fileId, { rate_request_id: rate.ngb });
  assert.equal((await one("select route_id from vendor_requests where job_file_id = $1 and service = 'booking'", [fileId])).route_id, routes.CNNGB, 'the booking is for the chosen option');
  const bc = await upload(coord, fileId, 'booking.pdf', 'booking_confirmation');
  await cm.confirmBooking(coord, fileId, { booking_reference: 'MSC123456', carrier: 'MSC', vessel_flight: 'MSC ANNA', voyage: '045W', etd: D(5), eta: D(25),
    booking_confirmed_on: D(0), booked_equipment: '2 x 40HC', routing_type: 'via', document_id: bc });
  let g = await getJobFile(coord, fileId);
  assert.deepEqual([g.booking_reference, g.booked_equipment, g.routing_type, g.vessel_status, g.legs.length], ['MSC123456', '2 x 40HC', 'via', 'received', 1]);
  await rejects(rt.vesselAction(coord, fileId, { step: 'save', routing_type: 'via', legs: [{ vessel: 'MSC ANNA', etd: D(5), eta: D(12) }] }), 'VALIDATION', /connecting vessel/);
  await rejects(rt.vesselAction(coord, fileId, { step: 'save', routing_type: 'via', legs: [{ vessel: 'MSC ANNA', etd: D(5), eta: D(12) }, { vessel: 'MSC LENA', etd: D(10), eta: D(25) }] }),
    'VALIDATION', /leaves before leg 1 arrives/);
  g = await rt.vesselAction(coord, fileId, { step: 'save', routing_type: 'via', legs: [
    { vessel: 'MSC ANNA', voyage: '045W', from_port: 'CNNGB', to_port: 'LKCMB', etd: D(5), eta: D(12) },
    { vessel: 'MSC LENA', voyage: '112E', from_port: 'LKCMB', to_port: 'AEJEA', etd: D(14), eta: D(21) }] });
  assert.deepEqual([g.legs.length, g.vessel_flight, g.eta.toISOString?.().slice(0, 10) ?? g.eta], [2, 'MSC ANNA', D(21)]);
  assert.equal((await notes(sales, 'vessel_changed')).length >= 1, true, 'the Salesman is told');
  g = await rt.vesselAction(coord, fileId, { step: 'verify' });
  assert.equal(g.vessel_status, 'verified');
  // a later change goes back to "received", is recorded old → new, and told again
  g = await rt.vesselAction(coord, fileId, { step: 'save', routing_type: 'via', note: 'Connection rolled', legs: [
    { vessel: 'MSC ANNA', voyage: '045W', from_port: 'CNNGB', to_port: 'LKCMB', etd: D(5), eta: D(12) },
    { vessel: 'MSC NORA', voyage: '118E', from_port: 'LKCMB', to_port: 'AEJEA', etd: D(16), eta: D(23) }] });
  assert.equal(g.vessel_status, 'received');
  const ch = g.events.filter((e: any) => e.title === 'Vessel details changed').find((e: any) => e.remarks === 'Connection rolled');
  assert.ok(ch.old_value.includes('MSC LENA') && ch.new_value.includes('MSC NORA') && ch.remarks === 'Connection rolled');
});

test('15–19. BL draft → customer → correction → revised draft → confirmed; final BL separately; amendment needs a manager', async () => {
  await rejects(rt.blAction(coord, fileId, { step: 'send', sent_to: 'omar@desert.ae' }), 'VALIDATION', /Receive a draft/);
  await rejects(rt.blAction(coord, fileId, { step: 'final', bl_no: 'MSCUNB1' }), 'VALIDATION', /confirm the BL draft/);
  const d1 = await upload(coord, fileId, 'bl-draft-1.pdf', 'bl_draft');
  let g = await rt.blAction(coord, fileId, { step: 'receive', document_id: d1, bl_no: 'MSCUNB1' });
  assert.equal(g.bl_status, 'received');
  await rejects(rt.blAction(coord, fileId, { step: 'receive', document_id: d1 }), 'VALIDATION', /already saved/);
  await rt.blAction(coord, fileId, { step: 'review' });
  g = await rt.blAction(coord, fileId, { step: 'send', sent_to: 'omar@desert.ae' });
  assert.equal(g.bl_status, 'sent_to_customer');
  const mail = await em.emailDraft(coord, { kind: 'job_file', id: fileId, update: 'bl_draft_to_customer' });
  assert.match(mail.body, /vessel MSC ANNA 045W/);
  g = await rt.blAction(coord, fileId, { step: 'correction', correction_notes: 'Consignee address: Al Quoz 3, not Al Quoz 1' });
  assert.equal(g.bl_status, 'correction_required');
  assert.equal((await notes(sales, 'bl_correction')).length, 1);
  const agentMail = await em.emailDraft(coord, { kind: 'vendor_request', id: g.booking.id, update: 'bl_correction_request' });
  assert.match(agentMail.body, /corrections to BL MSCUNB1:\n\nConsignee address: Al Quoz 3/);
  await rt.blAction(coord, fileId, { step: 'correction_sent', sent_to: 'MSC Ningbo docs' });
  const d2 = await upload(coord, fileId, 'bl-draft-2.pdf', 'bl_draft');
  g = await rt.blAction(coord, fileId, { step: 'receive', document_id: d2 });
  assert.equal(g.bl_status, 'revised_received');
  g = await rt.blAction(coord, fileId, { step: 'send', sent_to: 'omar@desert.ae' });
  assert.equal(g.bl_status, 'revised_sent');
  await rejects(rt.blAction(coord, fileId, { step: 'confirm', evidence_note: 'ok' }), 'VALIDATION', /confirmation/);
  g = await rt.blAction(coord, fileId, { step: 'confirm', evidence_note: 'Omar replied 8 Nov: BL draft v2 approved' });
  assert.equal(g.bl_status, 'customer_confirmed');
  assert.deepEqual(g.bl_drafts.map((b: any) => [b.version, b.customer_reply]), [[2, 'confirmed'], [1, 'correction']], 'both versions kept');
  assert.equal(g.final_bl_no, null, 'a confirmed draft is not the final BL');
  // a change after confirmation: only a manager, with a reason, as a new version
  const d3 = await upload(coord, fileId, 'bl-draft-3.pdf', 'bl_draft');
  await assert.rejects(rt.blAction(coord, fileId, { step: 'receive', document_id: d3, amendment_reason: 'Weight changed' }), (e: any) => e.status === 403);
  await rejects(rt.blAction(mgr, fileId, { step: 'receive', document_id: d3 }), 'VALIDATION', /why it is being amended/);
  g = await rt.blAction(mgr, fileId, { step: 'receive', document_id: d3, amendment_reason: 'Shipper corrected the gross weight' });
  assert.deepEqual([g.bl_status, g.bl_drafts[0].version, g.bl_drafts[0].amendment_reason], ['revised_received', 3, 'Shipper corrected the gross weight']);
  await rt.blAction(coord, fileId, { step: 'send', sent_to: 'omar@desert.ae' });
  await rt.blAction(coord, fileId, { step: 'confirm', evidence_note: 'Omar replied 9 Nov: v3 approved' });
  const fin = await upload(coord, fileId, 'final-bl.pdf', 'bill_of_lading');
  g = await rt.blAction(coord, fileId, { step: 'final', bl_no: 'MSCUNB1', document_id: fin });
  assert.equal(g.final_bl_no, 'MSCUNB1');
  assert.ok(g.events.some((e: any) => e.title === 'Final BL received'));
});

test('20. Handover continues as before; Exports need the BL confirmed (manager can override with a reason)', async () => {
  // the pre-alert flow as before, then the ERP Job No.
  await cm.prealertAction(coord, fileId, { action: 'receive', details: { vessel_flight: 'MSC ANNA' } }).catch(() => {});
  await cm.createOperationalJob(mgr, fileId, { job_no: 'IMP-26-0501', skip_prealert_reason: 'Testing the route flow end to end' });
  const g = await getJobFile(coord, fileId);
  assert.deepEqual([g.job_no, g.stage], ['IMP-26-0501', 'handed_over']);
  assert.equal((await em.emailDraft(coord, { kind: 'job_file', id: fileId, update: 'handover_notification' })).subject, `[${enq}] [IMP-26-0501] Shipment Update – Shanghai to Dubai`);
  // an Exports shipment without a confirmed BL draft
  const xs = await mkUser(admin, 'Ed Exports', 'sales', undefined, { division: 'exports', coordinator_id: coord.id });
  const xm = await mkUser(admin, 'Ella ExpMgr', 'commercials_manager', undefined, { division: 'exports' });
  const cx = (await createMaster(admin, 'customers', { name: 'Nairobi Traders' })).id;
  const ex = await createJobFile(xs, { customer_id: cx, direction: 'export', mode: 'sea_fcl', status: 'enquiry', origin: 'Jebel Ali', destination: 'Mombasa' });
  await q(`update job_files set stage = 'prealert_verified' where id = $1`, [ex.id]);
  await rejects(cm.createOperationalJob(coord, ex.id, { job_no: 'EXP-26-0001' }), 'BL_NOT_CONFIRMED');
  await rejects(cm.createOperationalJob(xm, ex.id, { job_no: 'EXP-26-0001' }), 'VALIDATION', /BL draft is not confirmed/);
  await cm.createOperationalJob(xm, ex.id, { job_no: 'EXP-26-0001', bl_override_reason: 'Customer on holiday, confirmed by phone' });
  const e = await getJobFile(xm, ex.id);
  assert.equal(e.handover_override_reason, 'Customer on holiday, confirmed by phone');
  assert.ok(e.events.some((v: any) => v.title === 'Handed over before the customer confirmed the BL draft'));
});
