/** AI agent part A (migration 032): a customer's reply → suggested answers to the enquiry's missing details. Claude and
 *  Outlook are replaced by fakes. The AI only suggests; a person ticks and applies; wrong keys / formats are dropped. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import { listEnquiryChecks } from '../src/server/checklists';
import { saveContact } from '../src/server/contacts';
import * as ol from '../src/server/outlook';
import { setAiNetwork } from '../src/server/ai';
import { syncInbox } from '../src/server/inbox';
import { applySuggestion, dismissSuggestion, readEmail, suggestionsFor } from '../src/server/agent';

let admin: Actor, sam: Actor, otto: Actor, fileId: string, enq: string, dg: string, ready: string, hs: string;
let aiCalls: any[] = [];
let aiAnswer: any = null;
let aiStatus = 200;
const REPLY = `Hi,\nPlease see the below response.\n\n-----Original Message-----\nSubject: Shipment Enquiry\n
- The pickup address, with a contact person and phone number: 44, Sivaprakasam Street, Chennai 600001
- The total cargo weight: 40 Kg
- A short description of the goods:  NA
- The HS code of the goods: NA
- Whether the cargo is hazardous (DG) — if yes, the MSDS and UN number: No
- The date the cargo will be ready for pickup: 22nd November`;

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', APP_URL: 'https://rfsops.netlify.app' });
  delete process.env.ANTHROPIC_API_KEY;
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  const cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  otto = await mkUser(admin, 'Otto Sales', 'sales', undefined, { coordinator_id: cora.id });
  const cust = (await createMaster(sam, 'customers', { name: 'Test Cus 1' })).id;
  await saveContact(admin, cust, { full_name: 'Shamsheer', email: 'shamsheer@cust.ae', is_primary: true });
  const rows = (await listEnquiryChecks(admin)).rows;
  hs = rows.find((r: any) => r.label === 'HS code')!.id; dg = rows.find((r: any) => r.label === 'Hazardous (DG) cargo')!.id;
  ready = rows.find((r: any) => r.label === 'Cargo ready date')!.id;
  const f = await createJobFile(sam, { customer_id: cust, division: 'exports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'temp', port_of_loading: 'Chennai', port_of_discharge: 'Jebel Ali' });
  fileId = f.id;
  await q(`update job_files set pickup_address = null where id = $1`, [fileId]);          // like the real enquiry: pickup address still missing
  enq = (await one('select enquiry_ref from job_files where id = $1', [fileId])).enquiry_ref;
  // Sam's Outlook is connected and the reply comes into his inbox
  await ol.setPilot(admin, sam.id, true);
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
    values ($1, 'ms', 'sam@rfs.ae', $2, $3, now() + interval '1 hour', $4)`, [sam.id, ol.seal('r'), ol.seal('a'), ol.SCOPES]);
  ol.setNetwork((async (url: any) => {
    const u = String(url);
    const json = (j: any) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/messages/delta')) return json({ value: [{ id: 'AAMk/abc=', subject: `RE: [${enq}] Shipment Enquiry`, isDraft: false,
      from: { emailAddress: { address: 'shamsheer@cust.ae', name: 'Mohamed Shamsheer' } }, receivedDateTime: '2026-11-19T10:51:00Z',
      internetMessageId: '<reply1@cust>', conversationId: 'c1', bodyPreview: 'Hi, Please see the below', hasAttachments: false }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=X' });
    if (u.includes('/me/messages/AAMk%2Fabc%3D?$select=body')) return json({ body: { contentType: 'text', content: REPLY } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch);
  setAiNetwork((async (url: any, init: any) => {
    aiCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (aiStatus !== 200) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: aiStatus });
    return new Response(JSON.stringify({ model: 'claude-haiku-5-5', content: [{ type: 'tool_use', name: 'record_answers', input: aiAnswer }] }), { status: 200 });
  }) as typeof fetch);
  await syncInbox(sam);
});

const emailId = async () => (await one(`select id from email_messages where job_file_id = $1 and direction = 'in'`, [fileId])).id as string;

test('AI key not set: nothing happens, the box stays hidden', async () => {
  assert.equal((await suggestionsFor(sam, fileId)).configured, false);
  await assert.rejects(readEmail(sam, await emailId()), (e: any) => e.code === 'AI_NOT_SET_UP');
  process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests-only-0123456789';
});

test('the AI gets the missing details and the full email; its answers are checked before they are kept', async () => {
  aiAnswer = {
    answers: [
      { key: 'pickup_address', value: '44, Sivaprakasam Street, Chennai 600001', quote: 'pickup address…: 44, Sivaprakasam Street' },
      { key: 'gross_weight_kg', value: '40 kg', quote: 'total cargo weight: 40 Kg' },
      { key: dg, value: 'No', quote: 'hazardous (DG) …: No' },
      { key: ready, value: '2026-11-22', quote: 'ready for pickup: 22nd November' },
      { key: 'cargo_description', value: 'NA', quote: 'goods: NA' },                     // NA → not an answer
      { key: 'customer_name', value: 'Hacker Ltd', quote: '' },                          // not a missing detail → dropped
    ],
    unclear: [{ key: hs, note: 'NA' }],
    summary: 'The customer answered the pickup address, weight, DG and ready date.',
  };
  const s: any = (await readEmail(sam, await emailId())).suggestion;
  const call = aiCalls.at(-1);
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.model, 'claude-haiku-5-5');
  assert.deepEqual(call.body.tool_choice, { type: 'tool', name: 'record_answers' });
  assert.match(call.body.messages[0].content, /44, Sivaprakasam Street/, 'the full email text from Outlook');
  assert.match(call.body.messages[0].content, /key: gross_weight_kg \| Cargo weight/);
  assert.equal(s.status, 'open');
  assert.deepEqual(s.answers.map((a: any) => [a.key, a.value]),
    [['pickup_address', '44, Sivaprakasam Street, Chennai 600001'], ['gross_weight_kg', '40'], [dg, 'no'], [ready, '2026-11-22']]);
  assert.deepEqual(s.unclear.map((u: any) => u.label).sort(), ['Commodity', 'HS code']);
  // nothing has changed on the enquiry yet
  const f: any = await getJobFile(sam, fileId);
  assert.equal(f.pickup_address ?? null, null);
  assert.ok(f.enquiry_gaps.some((g: any) => g.key === 'pickup_address'));
  // the email text is kept, so it is not fetched again
  assert.ok((await one('select body_text from email_messages where id = $1', [await emailId()])).body_text.includes('Chennai 600001'));
});

test('only people handling the enquiry can use it; someone else cannot even see it', async () => {
  await assert.rejects(readEmail(otto, await emailId()), (e: any) => e.code === 'NOT_FOUND');
  const s = (await suggestionsFor(sam, fileId)).open[0];
  await assert.rejects(applySuggestion(otto, s.id, { keys: ['pickup_address'] }), (e: any) => e.code === 'NOT_FOUND');
});

test('Fill in: only the ticked answers, in the person\'s name, with history; the rest stays missing', async () => {
  const s = (await suggestionsFor(sam, fileId)).open[0];
  await assert.rejects(applySuggestion(sam, s.id, { keys: [] }), /Tick at least one/);
  const r = await applySuggestion(sam, s.id, { keys: ['pickup_address', 'gross_weight_kg', dg] });     // ready date not ticked
  assert.equal(r.applied, 3);
  const f: any = await getJobFile(sam, fileId);
  assert.equal(f.pickup_address, '44, Sivaprakasam Street, Chennai 600001');
  assert.equal(Number(f.gross_weight_kg), 40);
  assert.equal(f.enquiry_details[dg], 'no');
  assert.equal(f.enquiry_details[ready], undefined);
  const keys = f.enquiry_gaps.map((g: any) => g.key);
  assert.ok(!keys.includes('pickup_address') && !keys.includes(dg) && keys.includes(ready) && keys.includes('cargo_description'));
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title like 'Filled in from the customer%' and user_id = $2`, [fileId, sam.id]));
  assert.equal((await suggestionsFor(sam, fileId)).open.length, 0);
  await assert.rejects(applySuggestion(sam, s.id, { keys: ['pickup_address'] }), /already handled/);
  // reading the same email again does not ask the AI again
  const n = aiCalls.length;
  await readEmail(sam, await emailId());
  assert.equal(aiCalls.length, n);
});

test('nothing useful in an email: kept as "nothing", no box; AI errors give a clear message', async () => {
  await q(`insert into email_messages (job_file_id, direction, status, from_addr, subject, body_excerpt, source, created_by, sent_at)
    values ($1, 'in', 'received', 'shamsheer@cust.ae', 'Thanks', 'Thank you, noted.', 'upload', $2, now())`, [fileId, sam.id]);
  const id2 = (await one(`select id from email_messages where job_file_id = $1 and subject = 'Thanks'`, [fileId])).id;
  aiAnswer = { answers: [], unclear: [], summary: 'Thanks only.' };
  assert.equal(((await readEmail(sam, id2)).suggestion as any).status, 'nothing');
  assert.equal((await suggestionsFor(sam, fileId)).unread.length, 0);
  await q(`insert into email_messages (job_file_id, direction, status, from_addr, subject, body_excerpt, source, created_by, sent_at)
    values ($1, 'in', 'received', 'x@cust.ae', 'More', 'Weight 10 kg', 'upload', $2, now())`, [fileId, sam.id]);
  const id3 = (await one(`select id from email_messages where job_file_id = $1 and subject = 'More'`, [fileId])).id;
  aiStatus = 401;
  await assert.rejects(readEmail(sam, id3), /key is not valid/);
  aiStatus = 529;
  await assert.rejects(readEmail(sam, id3), /busy/);
  aiStatus = 200;
  aiAnswer = { answers: [{ key: ready, value: '22 Nov', quote: 'x' }], unclear: [], summary: 's' };     // not a date → unclear
  const s: any = (await readEmail(sam, id3)).suggestion;
  assert.equal(s.status, 'nothing'); assert.equal(s.unclear[0].label, 'Cargo ready date');
  await dismissSuggestion(sam, s.id).catch((e) => assert.match(e.message, /already handled/));
});

test('a second email repeating answers already filled in: not offered again', async () => {
  // two emails read before either was applied: the second repeats the weight (filled in by the first) and adds the ready date
  await q(`insert into email_messages (job_file_id, direction, status, from_addr, subject, body_excerpt, source, created_by, sent_at)
    values ($1, 'in', 'received', 'shamsheer@cust.ae', 'Again', 'weight 40, ready 22 Nov', 'upload', $2, now())`, [fileId, sam.id]);
  const id4 = (await one(`select id from email_messages where job_file_id = $1 and subject = 'Again'`, [fileId])).id;
  const s = await one(`insert into ai_suggestions (job_file_id, email_id, kind, status, answers, unclear) values ($1, $2, 'enquiry', 'open', $3, '[]') returning id`,
    [fileId, id4, JSON.stringify([{ key: 'gross_weight_kg', label: 'Cargo weight', value: '40', quote: 'weight 40' }, { key: ready, label: 'Cargo ready date', value: '2026-11-22', quote: 'ready 22 Nov' }])]);
  const open = (await suggestionsFor(sam, fileId)).open;
  assert.equal(open.length, 1);
  assert.deepEqual(open[0].answers.map((a: any) => a.key), [ready], 'the weight is already filled in, so it is not offered');
  await assert.rejects(applySuggestion(sam, s.id, { keys: ['gross_weight_kg'] }), /already filled in/);
  assert.equal((await applySuggestion(sam, s.id, { keys: [ready] })).applied, 1);
  // a suggestion whose answers are all filled in by now closes by itself
  const s2 = await one(`insert into ai_suggestions (job_file_id, email_id, kind, status, answers, unclear) values ($1, $2, 'enquiry', 'open', $3, '[]') returning id`,
    [fileId, (await one(`select id from email_messages where job_file_id = $1 and subject = 'More'`, [fileId])).id,
      JSON.stringify([{ key: ready, label: 'Cargo ready date', value: '2026-11-22', quote: 'x' }])]).catch(() => null);
  if (s2) {
    assert.equal((await suggestionsFor(sam, fileId)).open.length, 0);
    assert.equal((await one('select status from ai_suggestions where id = $1', [s2.id])).status, 'nothing');
  }
});
