/** Part G1 (migration 020) — group notifications, quotation terms templates, email templates, one subject per shipment,
 *  email history with saved .eml files, reassignment, Customer Service retired. */
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
import * as tp from '../src/server/templates';
import * as em from '../src/server/emails';
import * as docs from '../src/server/jfdocs';
import { notificationsPage, saveNotificationPref } from '../src/server/notify';
import { listUsers } from '../src/server/team';
import { localWrite } from '../src/server/storage';

let admin: Actor, mgr: Actor, mgrX: Actor, coord: Actor, coord2: Actor, sales: Actor, agent: Actor;
let cust: string, cust2: string, line: string, agentV: string, fileId: string, enq: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
const notes = async (u: Actor, event?: string) => (await q(`select event, title from notifications where user_id = $1 and job_file_id = $2${event ? ' and event = $3' : ''} order by created_at`,
  event ? [u.id, fileId, event] : [u.id, fileId]));

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  mgr = await mkUser(admin, 'Manny Manager', 'commercials_manager', undefined, { division: 'imports' });
  mgrX = await mkUser(admin, 'Exa Manager', 'commercials_manager', undefined, { division: 'exports' });
  coord = await mkUser(admin, 'Cora Coord', 'coordinator');
  coord2 = await mkUser(admin, 'Colin Coord', 'coordinator');
  sales = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: coord.id });
  agent = await mkUser(admin, 'Agnes Agent', 'agent_coordinator');
  cust = (await createMaster(admin, 'customers', { name: 'Desert Retail', email: 'info@desert.ae' })).id;
  cust2 = (await createMaster(admin, 'customers', { name: 'Oasis Foods' })).id;
  line = (await createMaster(admin, 'vendors', { name: 'MSC', vendor_type: 'shipping_line', email: 'rates@msc.example' })).id;
  agentV = (await createMaster(admin, 'vendors', { name: 'China Partner', vendor_type: 'overseas_agent', email: 'ops@cp.example' })).id;
});

test('1. New enquiry: Enquiry Ref carries the division; the email subject is fixed; the handling group is told (not the one who did it)', async () => {
  const f = await createJobFile(sales, { customer_id: cust, direction: 'import', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai', origin: 'Shanghai', destination: 'Jebel Ali', cargo_description: 'Tiles' });
  fileId = f.id; enq = f.enquiry_ref;
  assert.match(enq, /^ENQ-IMP-\d{2}-\d{5}$/);
  const g = await getJobFile(sales, fileId);
  assert.equal(g.email_subject, `[${enq}] Shipment Enquiry – Shanghai to Jebel Ali`);
  assert.equal((await notes(coord, 'new_enquiry')).length, 1, 'the Coordinator');
  assert.equal((await notes(mgr, 'new_enquiry')).length, 1, 'the Imports manager');
  assert.equal((await notes(mgrX, 'new_enquiry')).length, 0, 'not the Exports manager');
  assert.equal((await notes(sales)).length, 0, 'not the Salesman who opened it');
  assert.match((await notes(coord, 'new_enquiry'))[0].title, new RegExp(`^${enq} · Desert Retail: New enquiry created`));
  // the route changes later, the subject stays
  const { updateJobFile } = await import('../src/server/jobfiles');
  await updateJobFile(coord, fileId, { origin: 'Ningbo' });
  assert.equal((await getJobFile(coord, fileId)).email_subject, `[${enq}] Shipment Enquiry – Shanghai to Jebel Ali`);
});

test('2. Rates: requested / received / updated tell the group, the Agent Coordinator too; no duplicates', async () => {
  const a = await vr.createVendorRequest(coord, { vendor_id: agentV, service: 'rate', job_file_id: fileId, description: '1x40HC', assigned_to: agent.id });
  assert.equal((await notes(agent, 'rate_requested')).length, 1, 'the Agent Coordinator hears about the request');
  assert.equal((await notes(sales, 'rate_requested')).length, 1);
  await vr.vendorRequestAction(agent, a.id, { status: 'quoted', quoted_cost: '1000', currency: 'USD', rate_valid_until: D(10) });
  assert.equal((await notes(coord, 'rate_received')).length, 1);
  assert.match((await notes(coord, 'rate_received'))[0].title, /China Partner/);
  assert.equal((await notes(agent, 'rate_received')).length, 0, 'not the person who entered it');
  // a second notification of the same event about the same rate within two minutes is dropped
  const { notifyGroup } = await import('../src/server/notify');
  const { pool } = await import('../src/server/db');
  assert.equal(await notifyGroup(pool(), agent, fileId, 'rate_received', 'again', { vendorRequestId: a.id }), 0);
  await vr.vendorRequestAction(coord, a.id, { what: 'revise_rate', quoted_cost: '950', note: 'Agent lowered the price' });
  assert.equal((await notes(sales, 'rate_updated')).length, 1);
  const b = await vr.createVendorRequest(coord, { vendor_id: line, service: 'rate', job_file_id: fileId, description: '1x40HC direct' });
  await vr.vendorRequestAction(coord, b.id, { status: 'quoted', quoted_cost: '1100', currency: 'USD', rate_valid_until: D(10) });
  assert.equal((await notes(sales, 'rate_received')).length, 2, 'one per vendor');
});

test('3. Quotation terms templates: most specific wins, fills a new quotation, later template changes never touch it', async () => {
  await rejects(tp.saveTermTemplate(coord, { name: 'X', scope: 'Y' }), 'FORBIDDEN');
  await rejects(tp.saveTermTemplate(mgr, { name: 'Bad', mode: 'air', shipment_type: 'fcl', scope: 'x' }), 'VALIDATION', /sea only/);
  const gen = await tp.saveTermTemplate(mgr, { name: 'General', scope: 'Freight only', exclusions: 'Duty and VAT', terms: 'Standard trading conditions' });
  await tp.saveTermTemplate(mgr, { name: 'Imports sea FCL', division: 'imports', mode: 'sea', shipment_type: 'fcl', scope: 'Port to door', exclusions: 'Duty, VAT, demurrage',
    terms: 'Subject to space', payment_terms: '30 days', additional_remarks: 'Rates per container' });
  await tp.saveTermTemplate(mgr, { name: 'Oasis special', customer_id: cust2, scope: 'Door to door', terms: 'Oasis contract 2026' });
  const pick = await tp.pickTermsFor(coord, { customer_id: cust, service_type: 'sea_fcl', job_file_id: fileId });
  assert.equal(pick.template_name, 'Imports sea FCL');
  assert.equal((await tp.pickTermsFor(coord, { customer_id: cust, service_type: 'air', job_file_id: fileId })).template_name, 'General');
  assert.equal((await tp.pickTermsFor(coord, { customer_id: cust2, service_type: 'sea_fcl' })).template_name, 'Oasis special', 'the customer\'s own beats the rest');
  // a quotation made without terms gets the template's
  const rates = (await getJobFile(coord, fileId)).vendor_requests;
  const quote = await qt.createQuotation(coord, { customer_id: cust, service_type: 'sea_fcl', job_file_id: fileId, origin: 'Shanghai', destination: 'Jebel Ali',
    lines: [{ description: 'Ocean freight', charge_unit: 'container', quantity: '1', cost_rate: '950', sell_rate: '1200', vendor_request_id: rates[0].id }] });
  let x = await qt.getQuotation(coord, quote.id);
  assert.deepEqual([x.scope, x.payment_terms, x.terms_template_name, x.terms_edited], ['Port to door', '30 days', 'Imports sea FCL', false]);
  await qt.updateQuotation(coord, quote.id, { exclusions: 'Duty, VAT, demurrage, inspection' });
  x = await qt.getQuotation(coord, quote.id);
  assert.equal(x.terms_edited, true, 'changed for this quotation');
  // changing the template later leaves the quotation alone; the change is in the history
  const t = (await tp.listTermTemplates(mgr)).rows.find((r: any) => r.name === 'Imports sea FCL');
  await tp.saveTermTemplate(mgr, { ...t, scope: 'CHANGED' });
  assert.equal((await qt.getQuotation(coord, quote.id)).scope, 'Port to door');
  assert.equal((await tp.listTermTemplates(mgr)).history.filter((h: any) => h.template_id === t.id).length, 2);
  await assert.rejects(q('delete from quote_term_template_history'), /history/);
  assert.ok(gen.id);
  // customer copy carries the two new texts
  await qt.quotationAction(coord, quote.id, { action: 'submit' });
  assert.equal((await notes(sales, 'quotation_submitted')).length, 1, 'the Salesman is asked to approve');
  await qt.quotationAction(sales, quote.id, { action: 'salesman_approve' });
  assert.equal((await notes(coord, 'quotation_approved')).length, 1);
  const copy = await qt.customerCopy(coord, quote.id, 'print');
  assert.deepEqual([copy.payment_terms, copy.additional_remarks], ['30 days', 'Rates per container']);
});

test('4. Email templates: placeholders checked, Enquiry Ref kept in the subject, agents never get the customer name', async () => {
  await rejects(tp.saveEmailTemplate(coord, { template_key: 'agent_rate_request', subject: '{{ThreadSubject}}', body: 'x' }), 'FORBIDDEN');
  await rejects(tp.saveEmailTemplate(mgr, { template_key: 'agent_rate_request', subject: 'Rate please', body: 'x' }), 'VALIDATION', /ThreadSubject/);
  await rejects(tp.saveEmailTemplate(mgr, { template_key: 'agent_rate_request', subject: '{{ThreadSubject}}', body: 'For {{CustomerName}}' }), 'VALIDATION', /CustomerName/);
  await rejects(tp.saveEmailTemplate(mgr, { template_key: 'quotation_submission', subject: '{{ThreadSubject}}', body: '{{NoSuchThing}}' }), 'VALIDATION', /NoSuchThing/);
  await tp.saveEmailTemplate(mgr, { template_key: 'quotation_submission', division: 'imports', subject: '{{ThreadSubject}}',
    body: '{{Greeting}}\n\nQuote {{QuoteNumber}} for {{CustomerName}}: {{Total}}. Vessel {{VesselName}}.\n\n{{Signature}}' });
  const quote = (await one('select id from quotations where job_file_id = $1', [fileId])).id;
  const d = await em.emailDraft(coord, { kind: 'quotation', id: quote });
  assert.equal(d.subject, `[${enq}] Shipment Enquiry – Shanghai to Jebel Ali`);
  assert.deepEqual([d.template?.source, d.template?.key], ['saved', 'quotation_submission']);
  assert.match(d.body, /for Desert Retail: AED 1,200\.00/);
  assert.deepEqual(d.missing, ['VesselName'], 'the vessel is not known yet');
  assert.ok(d.body.includes('[VesselName]'));
  // the agent rate request uses the built-in text, without the customer name
  const r = (await one('select id from vendor_requests where vendor_id = $1', [agentV])).id;
  const v = await em.emailDraft(coord, { kind: 'vendor_request', id: r });
  assert.equal(v.template?.key, 'agent_rate_request');
  assert.ok(v.subject.startsWith(`[${enq}]`) && !v.body.includes('Desert'));
  // other emails can be chosen; prepared ones are listed on the shipment
  const ack = await em.emailDraft(coord, { kind: 'job_file', id: fileId });
  assert.equal(ack.update, 'enquiry_ack');
  await em.emailPrepared(coord, { kind: 'quotation', id: quote, to: ['info@desert.ae'], subject: d.subject, body: d.body });
  const list = await em.listEmails(coord, fileId);
  assert.deepEqual([list.rows.length, list.rows[0].direction, list.rows[0].status, list.rows[0].template_key], [1, 'out', 'prepared', 'quotation_submission']);
});

function eml(subject: string, msgId: string, from = 'omar@desert.ae') {
  const pdf = Buffer.from('%PDF-1.4 booking').toString('base64');
  return Buffer.from([
    `From: Omar Khan <${from}>`, 'To: cora@rfs.example', 'Cc: accounts@desert.ae', `Subject: ${subject}`, 'Date: Thu, 05 Nov 2026 10:15:00 +0400',
    `Message-ID: <${msgId}>`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain; charset=utf-8', '', 'Please go ahead with option 1. Shipper details attached.', '',
    '--b1', 'Content-Type: application/pdf; name="shipper.pdf"', 'Content-Disposition: attachment; filename="shipper.pdf"', 'Content-Transfer-Encoding: base64', '', pdf, '',
    '--b1', 'Content-Type: application/x-msdownload; name="bad.exe"', 'Content-Disposition: attachment; filename="bad.exe"', 'Content-Transfer-Encoding: base64', '', 'TVqQ', '',
    '--b1--', ''].join('\r\n'));
}
async function uploadEml(a: Actor, body: Buffer, name = 'reply.eml') {
  const r = await docs.requestJfUpload(a, fileId, { file_name: name, mime_type: 'message/rfc822', size: body.length, doc_type: 'correspondence' });
  await localWrite(new URL('http://x' + r.upload.url).searchParams.get('key')!, body, 'message/rfc822');
  return (await docs.confirmJfUpload(a, fileId, { ticket: r.ticket })).uploaded_document_id as string;
}

test('5. Saved emails: sender, recipients, date and attachments read from the .eml; no duplicates; another shipment\'s Ref asks first', async () => {
  const doc = await uploadEml(coord, eml(`RE: [${enq}] Shipment Enquiry – Shanghai to Jebel Ali`, 'abc-1@desert.ae'));
  const r = await em.saveEmailFile(coord, fileId, { document_id: doc });
  const m = r.rows.find((x: any) => x.message_id === '<abc-1@desert.ae>' || x.message_id === 'abc-1@desert.ae' || String(x.message_id).includes('abc-1'));
  assert.ok(m, 'saved');
  assert.deepEqual([m.direction, m.status, m.from_addr, m.from_name, m.to_addrs, m.cc_addrs], ['in', 'received', 'omar@desert.ae', 'Omar Khan', 'cora@rfs.example', 'accounts@desert.ae']);
  assert.equal(new Date(m.sent_at).toISOString(), '2026-11-05T06:15:00.000Z');
  assert.match(m.body_excerpt, /option 1/);
  assert.deepEqual(m.attachments.map((a: any) => a.file_name), ['shipper.pdf'], 'the .exe is not kept');
  assert.equal(r.skipped, 1);
  assert.equal((await notes(sales, 'email_saved')).length, 1);
  // the same email again (another copy of the file) is refused
  const again = await uploadEml(coord, eml(`RE: [${enq}] Shipment Enquiry – Shanghai to Jebel Ali`, 'abc-1@desert.ae'), 'copy.eml');
  await rejects(em.saveEmailFile(coord, fileId, { document_id: again }), 'EMAIL_EXISTS');
  // an email whose subject carries another Enquiry Ref needs a confirmation
  const other = await uploadEml(coord, eml('[ENQ-EXP-26-09999] Shipment Enquiry – X', 'abc-2@desert.ae'), 'other.eml');
  await rejects(em.saveEmailFile(coord, fileId, { document_id: other }), 'EMAIL_OTHER_SHIPMENT', /ENQ-EXP-26-09999/);
  await em.saveEmailFile(coord, fileId, { document_id: other, force: true });
  // our own sent email (from a user's address) is recorded as sent
  const mine = await uploadEml(coord, eml(`[${enq}] Shipment Enquiry – Shanghai to Jebel Ali`, 'abc-3@rfs.example', 'coracoord@x.ae'), 'mine.eml');
  const r3 = await em.saveEmailFile(coord, fileId, { document_id: mine });
  assert.equal(r3.rows.find((x: any) => String(x.message_id).includes('abc-3')).direction, 'out');
  // people who can't edit the shipment can't add emails
  const ops = await mkUser(admin, 'Otto Ops', 'freight_ops');
  await assert.rejects(em.saveEmailFile(ops, fileId, { document_id: mine }), (e: any) => e.status === 404 || e.status === 403);
});

test('6. Reassign: Commercials Manager only, with a reason; old and new Coordinator are told; history kept', async () => {
  await assert.rejects(cm.reassignPeople(coord, fileId, { coordinator_id: coord2.id, reason: 'x' }), (e: any) => e.status === 403);
  await rejects(cm.reassignPeople(mgr, fileId, { coordinator_id: coord2.id }), 'VALIDATION', /why/i);
  await cm.reassignPeople(mgr, fileId, { coordinator_id: coord2.id, reason: 'Cora on leave' });
  const g = await getJobFile(mgr, fileId);
  assert.equal(g.coordinator_name, 'Colin Coord');
  assert.ok(g.events.some((e: any) => e.title === 'Coordinator changed' && e.old_value === 'Cora Coord' && e.remarks === 'Cora on leave'));
  assert.equal((await notes(coord, 'assigned')).length, 1, 'the old Coordinator');
  assert.equal((await notes(coord2, 'assigned')).length, 1, 'the new Coordinator');
});

test('7. Notifications page: filters, unread count, read, email choices saved', async () => {
  const p = await notificationsPage(coord, { page: '1' });
  assert.ok(p.total >= 5 && p.unread === p.total);
  const only = await notificationsPage(coord, { page: '1', event: 'rate_received' });
  assert.ok(only.rows.every((r: any) => r.event === 'rate_received'));
  assert.equal(only.rows[0].event_name, 'Rate received');
  const { markNotificationsRead } = await import('../src/server/admin');
  await markNotificationsRead(coord, [only.rows[0].id]);
  assert.equal((await notificationsPage(coord, { page: '1' })).unread, p.unread - 1);
  await saveNotificationPref(coord, { event: 'customer_confirmed', email: true });
  assert.equal((await notificationsPage(coord, { page: '1' })).email_prefs.customer_confirmed, true);
  await rejects(saveNotificationPref(coord, { event: 'nonsense', email: true }), 'VALIDATION');
});

test('8. Customer Service retired: the role can no longer be given, people who have it are flagged, history stays', async () => {
  const roles = (await listUsers(admin)).roles.map((r: any) => r.code);
  assert.ok(!roles.includes('customer_service'));
  const csRole = (await one(`select id from roles where code = 'customer_service'`)).id;
  await q('update users set role_id = $2 where id = $1', [agent.id, csRole]);
  assert.equal((await listUsers(admin)).users.find((u: any) => u.id === agent.id).role_retired, true);
  assert.ok(await one(`select 1 from information_schema.tables where table_name = 'cs_cases'`), 'cases are kept');
});
