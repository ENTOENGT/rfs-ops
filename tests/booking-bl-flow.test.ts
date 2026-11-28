/** 27 Nov (migration 048, Import flow test part B): booking with the option, rate and parties; the booking confirmation checked against
 *  the request; the customer told by itself; the BL draft chased, sent with its file, checked by AI, and the customer's answer read. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as cm from '../src/server/commercial';
import * as rt from '../src/server/routing';
import * as docs from '../src/server/jfdocs';
import { localWrite } from '../src/server/storage';
import { emailDraft, emailPrepared } from '../src/server/emails';
import { bookingChecks } from '../src/server/bookingreader';
import { setAiNetwork } from '../src/server/ai';
import { fileOnShipment } from '../src/server/inbox';
import { runShipmentReminders } from '../src/server/reminders';

let admin: Actor, cora: Actor, fileId: string, rate: any;
let ai: any = {};
const D = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function upload(a: Actor, id: string, name: string, doc_type: string) {
  const r = await docs.requestJfUpload(a, id, { file_name: name, mime_type: 'application/pdf', size: 700, doc_type });
  await localWrite(new URL('http://x' + r.upload.url).searchParams.get('key')!, Buffer.alloc(700, 1), 'application/pdf');
  return (await docs.confirmJfUpload(a, id, { ticket: r.ticket })).uploaded_document_id as string;
}

before(async () => {
  await resetDb();
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  const sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  const cust = (await createMaster(sam, 'customers', { name: 'Red Chief', email: 'buy@redchief.in', address: 'Al Quoz 3, Dubai' })).id;
  const line = (await createMaster(admin, 'vendors', { name: 'MSC Agency', vendor_type: 'shipping_line', email: 'rates@msc-agency.com' })).id;
  fileId = (await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB',
    port_of_loading: 'Nhava Sheva', port_of_discharge: 'Jebel Ali', cargo_description: 'Rice in bags, 2x40HC' })).id;
  await q(`update job_files set coordinator_id = $2 where id = $1`, [fileId, cora.id]);
  rate = await vr.createVendorRequest(admin, { vendor_id: line, service: 'rate', job_file_id: fileId, description: '2x40HC Nhava Sheva → Jebel Ali' });
  await vr.vendorRequestAction(admin, rate.id, { status: 'quoted', quoted_cost: '1000', currency: 'USD', carrier: 'MSC', routing: 'Direct', vendor_reference: 'MSC-Q-77', etd: D(10) });
  await q(`update job_files set stage = 'customer_confirmed' where id = $1`, [fileId]);
  setAiNetwork((async (_u: any, init: any) => { const tool = JSON.parse(String(init.body)).tool_choice.name;
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: ai[tool] ?? {} }] }), { status: 200 }); }) as typeof fetch);
});

test('booking: the shipper is asked when missing; the booking email has the confirmed rate and the parties; consignee = our customer', async () => {
  const ask: any = await emailDraft(cora, { kind: 'job_file', id: fileId, update: 'shipment_update:parties_needed' });
  assert.match(ask.body, /shipper \/ supplier details for the cargo collection/);
  await cm.requestBooking(cora, fileId, { rate_request_id: rate.id, shipper: 'Ganesh Rice Mills, Plot 4, Navi Mumbai, Mr Rao +91 98 1234', consignee: 'Red Chief, Al Quoz 3, Dubai' });
  const g: any = await getJobFile(cora, fileId);
  assert.equal(g.shipper, 'Ganesh Rice Mills, Plot 4, Navi Mumbai, Mr Rao +91 98 1234');
  const d: any = await emailDraft(cora, { kind: 'vendor_request', id: g.booking.id });
  assert.match(d.body, /Confirmed: MSC, Direct · your rate MSC-Q-77 \/ our ref\. VR-\d+ — USD 1,000\.00/);
  assert.match(d.body, /Shipper \(cargo collection\): Ganesh Rice Mills/);
  assert.match(d.body, /Consignee: Red Chief, Al Quoz 3, Dubai/);
  assert.ok(d.missing.includes('NotifyParty'), 'the notify party is flagged before sending');
});

test('booking confirmation: what differs from the request or is missing is listed to ask the vendor', () => {
  const f = { mode: 'sea_fcl', port_of_loading: 'Nhava Sheva', port_of_discharge: 'Jebel Ali', rate_carrier: 'MSC', rate_etd: '2026-12-10', containers_n: { n20: 0, n40: 2 }, containers_wanted: '2x40' };
  const out = bookingChecks(f, { fields: { booking_reference: 'BK1', carrier: 'CMA CGM', port_of_loading: 'Mundra', booked_equipment: '1 x 40HC', etd: '2026-12-20', eta: '2027-01-05', vessel_flight: 'X' } });
  assert.equal(out.length, 5);
  assert.match(out.join(' | '), /Line is CMA CGM, but your rate was with MSC.*Port of loading is Mundra.*Containers booked: 1 x 40HC; we asked for 2x40.*ETD is 2026-12-20.*cut-off/);
  assert.deepEqual(bookingChecks(f, { fields: { booking_reference: 'BK1', carrier: 'MSC', port_of_loading: 'Nhava Sheva', booked_equipment: '2x40HC', etd: '2026-12-11', eta: '2027-01-01',
    vessel_flight: 'MSC ANNA', cutoff_si: '2026-12-08 12:00', cutoff_gate: '2026-12-09 18:00' } }), []);
});

test('booking confirmed: the customer is told by itself (or the reason shows); then the BL draft is awaited and chased after the cut-off', async () => {
  const g: any = await cm.confirmBooking(cora, fileId, { booking_reference: 'MSCBK1', vessel_flight: 'MSC ANNA', voyage: '045W', etd: D(-3), eta: D(15) });
  assert.match(g.booking_mail_error, /Outlook is not connected/, 'no Outlook here: the reason, and "Email customer" offered');
  await emailPrepared(cora, { kind: 'job_file', id: fileId, update: 'shipment_update:booking_confirmed', to: ['buy@redchief.in'], subject: 's', body: 'b' });
  assert.ok((await one('select booking_mail_at from job_files where id = $1', [fileId])).booking_mail_at, 'sent with the button: the warning goes');
  await q(`update job_files set cutoff_gate = $2 where id = $1`, [fileId, `${D(-2)} 18:00`]);
  const r = await runShipmentReminders();
  assert.equal(r.sent.bl_draft_late, 1);
  assert.equal((await runShipmentReminders()).sent.bl_draft_late, 0, 'once');
  const f: any = await vr.getVendorRequest(cora, (await one('select booking_vendor_request_id b from job_files where id = $1', [fileId])).b);
  const ask: any = await emailDraft(cora, { kind: 'vendor_request', id: f.id, update: 'bl_draft_followup' });
  assert.match(ask.body, /loading status of booking MSCBK1 .* send us the BL draft/);
});

test('BL draft: goes to the customer with its file; the AI checks it and reads the customer\'s corrections; Record uses the normal step', async () => {
  const doc = await upload(cora, fileId, 'bl-draft-1.pdf', 'bl_draft');
  await rt.blAction(cora, fileId, { step: 'receive', document_id: doc, bl_no: 'MSCUNB1' });
  const d: any = await emailDraft(cora, { kind: 'job_file', id: fileId, update: 'bl_draft_to_customer' });
  assert.deepEqual(d.attach, { name: 'bl-draft-1.pdf', href: `/api/jf-files/${doc}` });
  const { checkBlDraft, readBlReply, blAiBox, blReplyAction, blReplies } = await import('../src/server/blai');
  ai.bl_draft_check = { differences: [{ field: 'Shipper', on_draft: 'Ganesh Rice Mill', on_record: 'Ganesh Rice Mills, Plot 4' }], not_on_draft: ['Notify party'], summary: 'Two points to check' };
  const box: any = await checkBlDraft(cora, fileId);
  assert.equal(box.draft.ai_check.differences[0].field, 'Shipper');
  await rt.blAction(cora, fileId, { step: 'send', sent_to: 'buy@redchief.in' });
  await q(`update bl_drafts set sent_at = now() - interval '1 hour' where job_file_id = $1`, [fileId]);
  const m = { internet_message_id: `<${Math.random()}@redchief>`, conversation_id: null, from_addr: 'buy@redchief.in', from_name: 'Omar', to_addrs: 'cora@x.ae', cc_addrs: null,
    subject: 'RE: BL draft', received_at: new Date().toISOString(), has_attachments: false, web_link: null, body_excerpt: 'Please change the notify party to Red Chief Trading.' };
  await tx((c) => fileOnShipment(c, cora, fileId, m, 'tag'));
  const waiting = await blReplies(5);
  assert.equal(waiting.length, 1);
  ai.bl_customer_answer = { answer: 'corrections', corrections: 'Notify party: Red Chief Trading', quote: 'Please change the notify party' };
  await readBlReply(cora, waiting[0].id);
  const b2: any = await blAiBox(cora, fileId);
  assert.equal(b2.replies[0].answers.answer, 'corrections');
  await blReplyAction(cora, fileId, { action: 'record', id: b2.replies[0].id });
  const g: any = await getJobFile(cora, fileId);
  assert.equal(g.bl_status, 'correction_required');
  assert.equal(g.bl_drafts[0].correction_notes, 'Notify party: Red Chief Trading');
  assert.deepEqual((await blAiBox(cora, fileId) as any).replies, [], 'handled once');
});
