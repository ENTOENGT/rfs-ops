/** Part D — email drafts: right people, right details, never cost to a customer, history note when prepared. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { saveContact } from '../src/server/contacts';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as qt from '../src/server/quotations';
import { createCase, getCase } from '../src/server/cases';
import { emailDraft, emailPrepared } from '../src/server/emails';

let admin: Actor, sales: Actor, mgr: Actor, transport: Actor, customer: string, vendor: string, fileId: string, reqId: string, quoteId: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  sales = await mkUser(admin, 'Sally Sales', 'sales');
  mgr = await mkUser(admin, 'ComMgr', 'operations_manager', 'commercial');
  transport = await mkUser(admin, 'Trans', 'transport_manager');
  customer = (await createMaster(mgr, 'customers', { name: 'Desert Retail', email: 'info@desert.ae' })).id;
  await saveContact(admin, customer, { full_name: 'Omar Khan', role: 'Logistics', email: 'omar@desert.ae', is_primary: true });
  await saveContact(admin, customer, { full_name: 'Accounts', role: 'Accounts', email: 'accounts@desert.ae' });
  vendor = (await createMaster(mgr, 'vendors', { name: 'MSC', vendor_type: 'shipping_line', contact_person: 'Raj Patel', email: 'raj@msc.example' })).id;
  fileId = (await createJobFile(sales, { job_no: 'SI-EM-1', customer_id: customer, direction: 'import', mode: 'sea_fcl', status: 'open',
    origin: 'Ningbo', destination: 'Jebel Ali', cargo_description: 'Furniture', customer_reference: 'PO-77' })).id;
  reqId = (await vr.createVendorRequest(sales, { vendor_id: vendor, service: 'rate', job_no: 'SI-EM-1', description: '1x40HC, ready 10 Nov', needed_by: D(2) })).id;
  await vr.vendorRequestAction(sales, reqId, { status: 'quoted', quoted_cost: '1000' });
});

test('1. Vendor rate request email: vendor address, Job No., route, our reference, reply-by date', async () => {
  const d = await emailDraft(sales, { kind: 'vendor_request', id: reqId });
  assert.deepEqual(d.recipients.map((r) => [r.email, r.picked]), [['raj@msc.example', true]]);
  // Part G1: one subject for the whole shipment, Enquiry Ref first
  assert.match(d.subject, /^\[ENQ-IMP-\d{2}-\d{5}\] \[SI-EM-1\] Shipment Update – Ningbo to Jebel Ali$/);
  assert.equal(d.template?.key, 'liner_rate_request', 'a shipping line gets the liner template');
  assert.match(d.body, /^Dear Raj,/);
  for (const s of ['1x40HC, ready 10 Nov', 'SI-EM-1', 'Route: Ningbo → Jebel Ali', 'We need your rate by', 'Sally Sales']) assert.ok(d.body.includes(s), s);
  assert.ok(!d.body.includes('Desert'), 'agents never see the customer name');
  await emailPrepared(sales, { kind: 'vendor_request', id: reqId, to: ['raj@msc.example'], subject: d.subject });
  assert.ok((await vr.getVendorRequest(sales, reqId)).events.some((e: any) => e.title === 'Email prepared' && e.details.includes('raj@msc.example')));
});

test('2. Quotation email: only when approved; selling prices only — the cost never appears', async () => {
  quoteId = (await qt.createQuotation(sales, { customer_id: customer, service_type: 'sea_fcl', job_file_id: fileId, origin: 'Ningbo', destination: 'Jebel Ali', enquiry_reference: 'PO-77',
    lines: [{ description: 'Ocean freight', charge_unit: 'container', quantity: '2', cost_rate: '1000', margin_type: 'percent', margin_value: '20', vendor_request_id: reqId }] })).id;
  await assert.rejects(emailDraft(sales, { kind: 'quotation', id: quoteId }), (e: any) => e.code === 'QUOTE_NOT_READY');
  await qt.quotationAction(sales, quoteId, { action: 'submit' });
  const d = await emailDraft(sales, { kind: 'quotation', id: quoteId });
  assert.deepEqual(d.recipients.map((r) => [r.email, r.picked]), [['omar@desert.ae', true], ['accounts@desert.ae', false], ['info@desert.ae', false]]);
  assert.match(d.subject, /^\[ENQ-IMP-\d{2}-\d{5}\] \[SI-EM-1\] Shipment Update – Ningbo to Jebel Ali$/);
  assert.match(d.body, /^Dear Omar,/);
  assert.ok(d.body.includes('Ocean freight: AED 1,250.00 per container x 2 = AED 2,500.00'));
  assert.ok(d.body.includes('Total: AED 2,500.00 (excluding VAT)'));
  assert.ok(!/1,000|1000|margin|cost/i.test(d.body), 'no cost or margin in a customer email');
  assert.match(d.note!, /Attach the PDF/);
  await assert.rejects(emailDraft(transport, { kind: 'quotation', id: quoteId }), (e: any) => e.status === 403);
});

test('3. Job File update to the customer: chosen update, shipment details, missing documents', async () => {
  await qt.quotationAction(sales, quoteId, { action: 'accept', evidence_note: 'Confirmed by phone with Omar' });
  const { updateJobFile } = await import('../src/server/jobfiles');
  await updateJobFile(sales, fileId, { carrier: 'MSC', vessel_flight: 'MSC AURORA', voyage: '123W', mbl_mawb: 'MSCU123', eta: D(12), etd: D(1) });
  const d = await emailDraft(sales, { kind: 'job_file', id: fileId, update: 'departed' });
  assert.equal(d.update, 'shipment_update:departed');
  assert.match(d.subject, /^\[ENQ-IMP-\d{2}-\d{5}\] \[SI-EM-1\] Shipment Update – Ningbo to Jebel Ali$/);
  for (const s of ['Your shipment has departed', 'Carrier / vessel: MSC · MSC AURORA · voy. 123W', 'BL no.: MSCU123', 'ETA:']) assert.ok(d.body.includes(s), s);
  const docs = await emailDraft(sales, { kind: 'job_file', id: fileId, update: 'documents_needed' });
  const missing = (await getJobFile(sales, fileId)).checklist.filter((c: any) => c.status === 'missing');
  assert.ok(missing.length > 0 && missing.every((c: any) => docs.body.includes(`- ${c.name}`)));
  await emailPrepared(sales, { kind: 'job_file', id: fileId, update: 'departed', to: ['omar@desert.ae'], subject: d.subject });
  assert.ok((await getJobFile(sales, fileId)).events.some((e: any) => e.title === 'Email prepared for the customer'));
});

test('4. Case reply: case contact first, case number, counts as the first response', async () => {
  const k = await createCase(sales, { customer_id: customer, job_no: 'SI-EM-1', subject: 'Where is my cargo?', description: 'ETA please', kind: 'enquiry',
    priority: 'normal', channel: 'email', contact_name: 'Sara Ali', contact_detail: 'sara@desert.ae' });
  const d = await emailDraft(sales, { kind: 'case', id: k.id });
  assert.equal(d.recipients[0].email, 'sara@desert.ae'); assert.equal(d.recipients[0].picked, true);
  assert.match(d.subject, /^Re: Where is my cargo\? – Case .+ – Job SI-EM-1$/);
  assert.match(d.body, /^Dear Sara,/);
  await emailPrepared(sales, { kind: 'case', id: k.id, to: ['sara@desert.ae'], subject: d.subject });
  const after = await getCase(sales, k.id);
  assert.ok(after.first_response_at, 'replying counts as first response');
  assert.ok(after.events.some((e: any) => e.title === 'Email reply prepared'));
});
