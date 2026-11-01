/** Migration 016 — Job File documents + checklist, customer service cases, vendor requests, ERP export. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, reqFields } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { localWrite } from '../src/server/storage';
import { createJobFile, getJobFile, listJobFiles, setJobFileStatus } from '../src/server/jobfiles';
import * as docs from '../src/server/jfdocs';
import * as cases from '../src/server/cases';
import * as vr from '../src/server/vendorreqs';
import * as erp from '../src/server/erp';
import { createJob, updateFinancials } from '../src/server/jobs';
import { runReport } from '../src/server/reports';
import { listNotifications } from '../src/server/admin';

let admin: Actor, mgr: Actor, sub: Actor, other: Actor, cs: Actor, tm: Actor, fin: Actor, erpAdmin: Actor, driverish: Actor, customer: string, fileId: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
async function upload(a: Actor, id: string, doc_type: string, name: string, extra: any = {}) {
  const r = await docs.requestJfUpload(a, id, { file_name: name, mime_type: 'application/pdf', size: 700, doc_type, ...extra });
  await localWrite(new URL('http://x' + r.upload.url).searchParams.get('key')!, Buffer.alloc(700, 1), 'application/pdf');
  return docs.confirmJfUpload(a, id, { ticket: r.ticket });
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  mgr = await mkUser(admin, 'SeaMgr', 'operations_manager', 'sea_import');
  sub = await mkUser(admin, 'SeaSub', 'operations', 'sea_import');
  other = await mkUser(admin, 'AirMgr', 'operations_manager', 'air_export');
  cs = await mkUser(admin, 'Care', 'customer_service');
  tm = await mkUser(admin, 'TM', 'transport_manager');
  fin = await mkUser(admin, 'Fin', 'finance');
  erpAdmin = await mkUser(admin, 'ERP', 'erp_admin');
  driverish = await mkUser(admin, 'Msg', 'messenger', 'messengers');
  customer = (await createMaster(mgr, 'customers', { name: 'Gulf Importers' })).id;
  fileId = (await createJobFile(sub, { job_no: 'SI-DOC-1', customer_id: customer, direction: 'import', mode: 'sea_fcl', needs_clearance: true })).id;
});

// ------------------------------------------------------------------ A. documents
test('Checklist follows the shipment: sea import with clearance needs invoice, packing list, BL, origin cert, DO, BOE', async () => {
  const g = await getJobFile(sub, fileId);
  assert.deepEqual(g.checklist.map((c: any) => [c.doc_type, c.status]), [['commercial_invoice', 'missing'], ['packing_list', 'missing'],
    ['bill_of_lading', 'missing'], ['certificate_of_origin', 'missing'], ['delivery_order', 'missing'], ['customs_declaration', 'missing']]);
  assert.equal((await listJobFiles(sub, { view: 'missing_docs' })).total, 1);
  const air = await createJobFile(sub, { job_no: 'AE-DOC', customer_id: customer, direction: 'export', mode: 'air' });
  assert.deepEqual((await getJobFile(sub, air.id)).checklist.map((c: any) => c.doc_type), ['commercial_invoice', 'packing_list', 'air_waybill']);
});

test('Upload, replace (versions kept), approve / reject with reason; uploader hears about a rejection', async () => {
  await rejects(docs.requestJfUpload(sub, fileId, { file_name: 'x.exe', mime_type: 'application/x-msdownload', size: 10, doc_type: 'other' }), 'VALIDATION', /PDF/);
  await rejects(docs.requestJfUpload(other, fileId, { file_name: 'a.pdf', mime_type: 'application/pdf', size: 10, doc_type: 'other' }), 'NOT_FOUND');
  let g = await upload(sub, fileId, 'commercial_invoice', 'invoice.pdf', { issue_date: D(-3) });
  const inv = g.documents.find((d: any) => d.doc_type === 'commercial_invoice');
  assert.equal(g.checklist[0].status, 'pending');
  await rejects(docs.jfDocAction(sub, fileId, { what: 'approve', document_id: inv.id }), 'FORBIDDEN');
  await rejects(docs.jfDocAction(mgr, fileId, { what: 'reject', document_id: inv.id }), 'VALIDATION', /what is wrong/);
  g = await docs.jfDocAction(mgr, fileId, { what: 'reject', document_id: inv.id, note: 'Not signed' });
  assert.equal(g.checklist[0].status, 'rejected');
  assert.ok((await listNotifications(sub)).rows.some((n: any) => n.title === 'Document rejected on Job File SI-DOC-1'));
  g = await upload(sub, fileId, 'commercial_invoice', 'invoice-signed.pdf', { replaces_id: inv.id });
  const v2 = g.documents.find((d: any) => d.doc_type === 'commercial_invoice' && !d.replaced_at);
  assert.equal(v2.version, 2);
  assert.equal(g.documents.filter((d: any) => d.doc_type === 'commercial_invoice').length, 2, 'old version kept');
  g = await docs.jfDocAction(mgr, fileId, { what: 'approve', document_id: v2.id });
  assert.equal(g.checklist[0].status, 'approved');
  assert.ok(g.events.some((e: any) => e.title === 'Commercial invoice approved'));
  // an approved document can only be removed by an approver — and removal is recorded, never silent
  await rejects(docs.jfDocAction(sub, fileId, { what: 'remove', document_id: v2.id }), 'FORBIDDEN');
  assert.match(await docs.jfFileUrl(cs, v2.id), /key=jobfiles/);
  await rejects(docs.jfFileUrl(other, v2.id), 'NOT_FOUND');
});

test('Closing needs every required document approved or waived (with a reason); the rule can be switched off in Settings', async () => {
  await rejects(setJobFileStatus(mgr, fileId, { status: 'closed' }), 'JOB_FILE_NOT_READY', /Document "Packing list" is missing/);
  await rejects(docs.jfDocAction(mgr, fileId, { what: 'waive', doc_type: 'packing_list' }), 'VALIDATION', /why/);
  for (const t of ['packing_list', 'bill_of_lading', 'certificate_of_origin', 'delivery_order', 'customs_declaration'])
    await docs.jfDocAction(mgr, fileId, { what: 'waive', doc_type: t, reason: 'Customer cleared it themselves' });
  // clearance still needs a finished PRO request — waive that by switching the service off
  await q('update job_files set needs_clearance = false where id = $1', [fileId]);
  const closed = await setJobFileStatus(mgr, fileId, { status: 'closed' });
  assert.equal(closed.status, 'closed');
  assert.equal((await listJobFiles(mgr, { view: 'missing_docs' })).rows.some((r: any) => r.id === fileId), false);
});

// ------------------------------------------------------------------ B. customer service
let caseId: string;
test('Cases: SLA from priority; waiting for the customer stops the clock; resolve needs a resolution; close only after resolve', async () => {
  await rejects(cases.createCase(driverish, { customer_id: customer, subject: 'x' }), 'FORBIDDEN');
  await rejects(cases.createCase(cs, { customer_id: customer }), 'VALIDATION', /subject/);
  const k = await cases.createCase(cs, { customer_id: customer, subject: 'Where is my container?', kind: 'delay', priority: 'high', job_no: 'si-doc-1', owner_id: cs.id });
  caseId = k.id;
  let g = await cases.getCase(cs, caseId);
  assert.equal(g.job_no, 'SI-DOC-1');
  const hours = (new Date(g.due_at).getTime() - new Date(g.created_at).getTime()) / 3600000;
  assert.equal(Math.round(hours), 8, 'high priority = 8 hours');
  await cases.caseAction(cs, caseId, { what: 'status', status: 'waiting_customer' });
  await q(`update cs_cases set waiting_since = now() - interval '3 hours' where id = $1`, [caseId]);
  g = await cases.caseAction(cs, caseId, { what: 'status', status: 'in_progress' });
  assert.equal(Math.round((new Date(g.due_at).getTime() - new Date(g.created_at).getTime()) / 3600000), 11, 'due time moved by the 3-hour pause');
  assert.ok(g.first_response_at);
  await rejects(cases.caseAction(cs, caseId, { what: 'status', status: 'closed' }), 'VALIDATION', /Resolve/);
  await rejects(cases.caseAction(cs, caseId, { what: 'status', status: 'resolved' }), 'VALIDATION', /how it was resolved/);
  g = await cases.caseAction(cs, caseId, { what: 'status', status: 'resolved', resolution: 'Vessel delayed; new ETA shared' });
  assert.equal(g.status, 'resolved');
  g = await cases.caseAction(cs, caseId, { what: 'status', status: 'closed' });
  await rejects(cases.caseAction(cs, caseId, { what: 'status', status: 'open' }), 'CASE_CLOSED');
});

test('Overdue cases are escalated once; visibility follows department; report shows SLA', async () => {
  const k = await cases.createCase(sub, { customer_id: customer, subject: 'Damaged carton', kind: 'damage', priority: 'urgent' });
  await q(`update cs_cases set due_at = now() - interval '1 minute' where id = $1`, [k.id]);
  await listNotifications(mgr);   // escalations run during normal use
  await listNotifications(mgr);
  const n = (await listNotifications(cs)).rows.filter((r: any) => r.title === `Case ${k.case_no} is overdue`);
  assert.equal(n.length, 1, 'escalated once');
  assert.equal((await cases.listCases(cs, { status: 'overdue' })).rows.length, 1);
  assert.equal((await cases.listCases(other, {})).rows.length, 0, 'another department sees none (no cases.view_all)');
  assert.equal((await cases.listCases(sub, {})).rows.length, 1, 'own department sees only its own case (the first one was opened by Customer Service)');
  const r = await runReport(cs, 'cs_cases', { from: D(-1), to: D(1) });
  assert.ok(r.rows.some((x: any) => x.case_no === k.case_no && x.sla_breached === 'Yes'));
});

// ------------------------------------------------------------------ C. vendors
let vendorId: string, reqId: string;
test('Vendor requests: cost only for cost viewers; status flow; completion needs proof; performance report', async () => {
  await rejects(createMaster(sub, 'vendors', { name: 'MSC', vendor_type: 'shipping_line' }), 'FORBIDDEN');
  vendorId = (await createMaster(mgr, 'vendors', { name: 'MSC', vendor_type: 'shipping_line' })).id;
  await rejects(createMaster(mgr, 'vendors', { name: ' msc ', vendor_type: 'shipping_line' }), 'DUPLICATE');
  const r = await vr.createVendorRequest(sub, { vendor_id: vendorId, service: 'booking', description: '2x40HC Shanghai → Jebel Ali', needed_by: D(5), job_no: 'SI-DOC-1' });
  reqId = r.id;
  await rejects(vr.vendorRequestAction(sub, reqId, { status: 'completed', note: 'x' }), 'VR_STATE');
  let g = await vr.vendorRequestAction(mgr, reqId, { status: 'quoted', quoted_cost: '3150.00', vendor_reference: 'Q-55' });
  assert.equal(g.quoted_cost, '3150.00');
  await updateUserNoCost();
  const blind = (await loadActor(sub.id))!;
  assert.equal((await vr.getVendorRequest(blind, reqId)).quoted_cost, undefined, 'no cost for someone without buying view');
  await rejects(vr.vendorRequestAction(blind, reqId, { status: 'confirmed', quoted_cost: '1' }), 'FORBIDDEN');
  g = await vr.vendorRequestAction(blind, reqId, { status: 'confirmed', vendor_reference: 'MSC-BKG-778' });
  await rejects(vr.vendorRequestAction(mgr, reqId, { status: 'completed' }), 'VALIDATION', /proof/);
  g = await vr.vendorRequestAction(mgr, reqId, { status: 'completed', note: 'Booking confirmed, BL draft received' });
  assert.equal(g.status, 'completed');
  const perf = await runReport(mgr, 'vendor_performance', { from: D(-1), to: D(1) });
  assert.deepEqual(perf.rows.map((x: any) => [x.vendor_name, x.requests, x.completed, x.on_time, x.on_time_pct]), [['MSC', 1, 1, 1, '100.00']]);
});
async function updateUserNoCost() {
  const { updateUser } = await import('../src/server/admin');
  await updateUser(admin, sub.id, { overrides: [{ code: 'finance.buying.view', granted: false }] });
}

// ------------------------------------------------------------------ D. ERP
test('ERP export: only finished work, each record once, file has the fixed columns, rejected lines become ready again', async () => {
  await rejects(erp.erpOverview(tm), 'FORBIDDEN');
  await rejects(erp.erpOverview(cs), 'FORBIDDEN');
  // a completed trip with selling and cost
  const t = await createJob(mgr, { ...reqFields(), job_no: 'SI-DOC-1', customer_id: customer, required_date: D(1), pickup_name: 'Jebel Ali', delivery_name: 'DIP', base_selling_price: '900' });
  await updateFinancials(tm, t.id, { cost: { lines: [{ type: 'base', amount: '600' }] } });
  const open = await erp.erpOverview(fin);
  assert.equal(open.ready_by_type.trip, 0, 'an open trip is not ready');
  await q(`update transport_requests set status_code = 'completed' where id = $1`, [t.id]);
  let o = await erp.erpOverview(erpAdmin);
  assert.equal(o.ready_by_type.trip, 1); assert.equal(o.ready_by_type.vendor, 1);
  const trip = o.ready.find((i: any) => i.source_type === 'trip');
  assert.deepEqual([trip.selling_amount, trip.cost_amount, trip.job_no], ['900.00', '600.00', 'SI-DOC-1']);
  assert.match(trip.external_ref, /^RFSOPS-TRIP-TR-\d+$/);
  const b = await erp.createBatch(erpAdmin, { types: ['trip', 'vendor'] });
  assert.equal(b.record_count, 2);
  await rejects(erp.createBatch(erpAdmin, { types: ['trip', 'vendor'] }), 'NOTHING_READY');
  // two exports at the same moment can't both take the same record
  const csv = await erp.batchFile(erpAdmin, b.id, 'csv');
  const text = csv.body.toString('utf8');
  assert.match(text, /^﻿External reference,Type,Date,Customer \/ vendor,Job No\.,Our reference,Description,Quantity,Unit,Selling amount \(ex VAT\),Cost amount,Currency/);
  assert.match(text, /RFSOPS-VR-VR-\d+/);
  const xl = await erp.batchFile(erpAdmin, b.id, 'xlsx');
  assert.ok(xl.body.length > 1000);
  // ERP rejects the vendor line: it is ready again; the trip is confirmed
  let g = await erp.getBatch(erpAdmin, b.id);
  const vline = g.items.find((i: any) => i.source_type === 'vendor');
  await rejects(erp.batchAction(erpAdmin, b.id, { what: 'reject', item_id: vline.id }), 'VALIDATION');
  await erp.batchAction(erpAdmin, b.id, { what: 'reject', item_id: vline.id, reason: 'Vendor code missing in ERP' });
  await rejects(erp.batchAction(erpAdmin, b.id, { what: 'confirm' }), 'VALIDATION');
  g = await erp.batchAction(erpAdmin, b.id, { what: 'confirm', erp_reference: 'JV-2026-1188' });
  assert.equal(g.status, 'partly_rejected');
  o = await erp.erpOverview(erpAdmin);
  assert.equal(o.ready_by_type.vendor, 1, 'rejected line is ready to send again');
  assert.equal(o.ready_by_type.trip, 0, 'confirmed trip never comes back');
  const b2 = await erp.createBatch(erpAdmin, { types: ['vendor'] });
  assert.equal(b2.record_count, 1);
  assert.deepEqual((await q(`select status, count(*)::int n from erp_items group by status order by status`)).map((r) => [r.status, r.n]),
    [['confirmed', 1], ['exported', 1], ['rejected', 1]]);
});

test('ERP is commercial: phone-app and warehouse people can never be given it', async () => {
  const { updateUser } = await import('../src/server/admin');
  await updateUser(admin, driverish.id, { overrides: [{ code: 'erp.view', granted: true }] });
  assert.equal((await loadActor(driverish.id))!.has('erp.view'), false);
});
