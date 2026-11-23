/** 23 Nov: the quotation PDF made by RFS CRM and attached when emailed from Outlook (charges as a table; marked sent);
 *  the AI reads the customer's answer (accepted / changes / declined / question) — nothing changes until a person confirms. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import * as qt from '../src/server/quotations';
import * as ol from '../src/server/outlook';
import { setAiNetwork } from '../src/server/ai';
import { quotationPdf } from '../src/server/quotepdf';
import { emailDraft, emailSend, toHtml } from '../src/server/emails';
import { applyReply, readReply, replyBox } from '../src/server/quotereply';

let admin: Actor, cora: Actor, fred: Actor, sam: Actor, cust: string;
let graphBody: any = null, answer: any = {};

async function approvedQuote(currency = 'USD') {
  const f = await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali', cargo_description: 'Furniture' });
  const x = await qt.createQuotation(cora, { customer_id: cust, service_type: 'sea_fcl', job_file_id: f.id, currency, valid_until: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10),
    lines: [{ description: 'Ocean freight Shanghai → Jebel Ali — 40HC', charge_unit: 'container', quantity: '2', cost_rate: '3900', sell_rate: '4300' },
      { description: 'DO & import customs <Jebel Ali>', charge_unit: 'shipment', quantity: '1', cost_rate: '400', sell_rate: '520' }] });
  await q(`update quotations set status = 'approved', approved_at = now() where id = $1`, [x.id]);
  return { fileId: f.id, id: x.id };
}

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  fred = await mkUser(admin, 'Fred Ops', 'freight_ops');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  cust = (await createMaster(sam, 'customers', { name: 'Habibi Furniture', email: 'buy@habibi.ae', contact_person: 'Omar' })).id;
  await ol.setPilot(admin, cora.id, true);
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
    values ($1, 'ms', 'coracoord@x.ae', $2, $3, now() + interval '1 hour', $4)`, [cora.id, ol.seal('r'), ol.seal('a'), ol.SCOPES]);
  ol.setNetwork((async (_u: any, init: any) => { graphBody = JSON.parse(init.body); return new Response(null, { status: 202 }); }) as typeof fetch);
  setAiNetwork((async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_customer_answer', input: answer }] }), { status: 200 })) as typeof fetch);
});

test('the PDF: a real PDF of the customer copy (selling only); not before approval; not for someone without selling prices', async () => {
  const { id } = await approvedQuote();
  const p = await quotationPdf(cora, id);
  assert.equal(Buffer.from(p.bytes).subarray(0, 5).toString(), '%PDF-');
  assert.match(p.filename, /^Quotation Q-\d+\.pdf$/);
  const raw = Buffer.from(p.bytes).toString('latin1');
  assert.ok(!raw.includes('3900'), 'no cost in the file');
  await q(`update quotations set status = 'draft' where id = $1`, [id]);
  await assert.rejects(quotationPdf(cora, id), /approved/);
  await assert.rejects(quotationPdf(fred, id), /selling prices/);
});

test('the email: charges as a table (no repeated Charges / Total lines), PDF attached, quotation marked sent', async () => {
  const { id, fileId } = await approvedQuote();
  const d: any = await emailDraft(cora, { kind: 'quotation', id });
  assert.equal(d.attach.name, `Quotation ${(await one('select quote_no from quotations where id = $1', [id])).quote_no}.pdf`);
  assert.match(d.body, /• Ocean freight Shanghai → Jebel Ali — 40HC – USD 4,300.00 per container × 2 = USD 8,600.00/);
  const html = toHtml(d.body, d.blocks);
  assert.match(html, /<table/); assert.match(html, /Total \(excluding VAT\)<\/td><td[^>]*>USD 9,120.00/);
  assert.ok(!/Charges:/.test(html) && !/>Total: /.test(html), 'the text heading / total line are not repeated');
  assert.match(html, /DO &amp; import customs &lt;Jebel Ali&gt;/, 'escaped');
  await emailSend(cora, { kind: 'quotation', id, update: d.update, to: ['buy@habibi.ae'], subject: d.subject, body: d.body });
  assert.equal(graphBody.message.body.contentType, 'HTML');
  assert.equal(graphBody.message.attachments.length, 1);
  assert.equal(graphBody.message.attachments[0].contentType, 'application/pdf');
  assert.equal(Buffer.from(graphBody.message.attachments[0].contentBytes, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal((await one('select status from quotations where id = $1', [id])).status, 'sent', 'emailed from Outlook = sent');
  assert.ok(await one(`select 1 from quotation_events where quotation_id = $1 and details like '%attached: Quotation Q-%.pdf%'`, [id]));
  // unticked: no PDF
  const b = await approvedQuote();
  const d2: any = await emailDraft(cora, { kind: 'quotation', id: b.id });
  await emailSend(cora, { kind: 'quotation', id: b.id, update: d2.update, to: ['buy@habibi.ae'], subject: d2.subject, body: d2.body, attach_pdf: false });
  assert.equal(graphBody.message.attachments, undefined);
  void fileId;
});

async function customerEmail(fileId: string, from: string, text: string, extra: any = {}) {
  return (await one(`insert into email_messages (job_file_id, direction, status, from_addr, from_name, subject, sent_at, body_text, source, created_by, vendor_request_id)
    values ($1, 'in', 'received', $2, 'Omar', 'RE: Quotation', now() + interval '1 minute', $3, 'mailbox', $4, $5) returning id`, [fileId, from, text, cora.id, extra.vr ?? null])).id;
}

test('the customer accepts: read by AI, waits; confirmed by a person → the normal "confirmed" step with the email as proof', async () => {
  const { id, fileId } = await approvedQuote();
  await qt.quotationAction(cora, id, { action: 'send' });
  const e = await customerEmail(fileId, 'buy@habibi.ae', 'Hi, ok go ahead and please share the booking details.\n\nFrom: Cora\nSent: Monday\nPlease find our quotation');
  await customerEmail(fileId, 'coracoord@x.ae', 'internal note');                                   // our own team: not read
  await customerEmail(fileId, 'postmaster@habibi.ae', 'Undeliverable');                              // a bounce: not read
  const box: any = await replyBox(cora, id);
  assert.deepEqual(box.unread.map((m: any) => m.id), [e]);
  answer = { decision: 'accepted', quote: 'ok go ahead and please share the booking details', summary: 'Customer accepts' };
  const s: any = (await readReply(cora, id, e)).suggestion;
  assert.equal(s.status, 'open');
  assert.equal((await one('select status from quotations where id = $1', [id])).status, 'sent', 'nothing changed by the AI');
  await applyReply(cora, s.id, { action: 'accepted' });
  assert.equal((await one('select status from quotations where id = $1', [id])).status, 'accepted');
  assert.match((await one(`select note from quotation_responses where quotation_id = $1 and response = 'accepted'`, [id])).note, /Confirmed by email from Omar <buy@habibi.ae> .*"ok go ahead/);
  assert.ok((await one('select shipping_ref from job_files where id = $1', [fileId])).shipping_ref);
  assert.ok(await one(`select 1 from quotation_events where quotation_id = $1 and title like 'Customer''s email read by AI — accepted (checked)'`, [id]));
  await assert.rejects(applyReply(cora, s.id, { action: 'accepted' }), /already handled/);
});

test('declined (price) → not accepted with the reason, enquiry lost for the reports; changes and questions are recorded', async () => {
  const a = await approvedQuote();
  await qt.quotationAction(cora, a.id, { action: 'send' });
  answer = { decision: 'declined', reason: 'price', reason_words: 'got USD 3,900 from another forwarder', summary: 'Too expensive' };
  const s1: any = (await readReply(cora, a.id, await customerEmail(a.fileId, 'buy@habibi.ae', 'Sorry, we got USD 3,900 elsewhere.'))).suggestion;
  await applyReply(cora, s1.id, { action: 'declined', reason: 'price', mark_lost: true });
  const qx = await one('select status, decline_reason from quotations where id = $1', [a.id]);
  assert.deepEqual([qx.status, qx.decline_reason], ['rejected', 'Price too high — got USD 3,900 from another forwarder']);
  const f = await one('select stage, cancel_reason from job_files where id = $1', [a.fileId]);
  assert.deepEqual([f.stage, f.cancel_reason], ['lost', 'Lost: Price too high — got USD 3,900 from another forwarder']);
  // changes
  const b = await approvedQuote();
  await qt.quotationAction(cora, b.id, { action: 'send' });
  answer = { decision: 'changes', changes: ['lower the ocean freight'], target_price: 8000, target_currency: 'USD', summary: 'Wants a better price' };
  const s2: any = (await readReply(cora, b.id, await customerEmail(b.fileId, 'buy@habibi.ae', 'Can you do 8000 all in?'))).suggestion;
  await applyReply(cora, s2.id, {});
  assert.match((await one(`select note from quotation_responses where quotation_id = $1 and response = 'revision_requested'`, [b.id])).note, /lower the ocean freight; target USD 8000/);
  // not about the quotation → nothing to confirm
  answer = { decision: 'other', summary: 'Thanks' };
  const s3: any = (await readReply(cora, b.id, await customerEmail(b.fileId, 'buy@habibi.ae', 'Thanks, noted.'))).suggestion;
  assert.equal(s3.status, 'nothing');
  assert.deepEqual(await replyBox(fred, b.id), { allowed: false });
});
