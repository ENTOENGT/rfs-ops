/** G3 step 3 (migration 030): reading a pilot user's inbox — filed by subject tag or conversation, known senders wait to be
 *  filed by hand, unknown senders are not kept, nothing is filed twice, the next check reads only what is new. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { saveContact } from '../src/server/contacts';
import { createJobFile } from '../src/server/jobfiles';
import { listEmails } from '../src/server/emails';
import * as ol from '../src/server/outlook';
import { fileByHand, ignoreEmail, listToFile, syncInbox } from '../src/server/inbox';

let admin: Actor, sales: Actor, other: Actor, fileId: string, enqRef: string, jobNo: string, file2: string, enq2: string;
const urls: string[] = [];
let pages: Record<string, any> = {};
const fake = (async (url: any) => {
  const u = String(url); urls.push(u);
  const json = (j: any, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  for (const [k, v] of Object.entries(pages).sort((a, b) => b[0].length - a[0].length)) if (u.includes(k)) return typeof v === 'function' ? v() : json(v);
  return json({ error: { message: 'unknown ' + u } }, 404);
}) as typeof fetch;
const mail = (id: string, from: string, subject: string, extra: any = {}) => ({
  id, subject, from: { emailAddress: { address: from, name: from.split('@')[0] } }, toRecipients: [{ emailAddress: { address: 'sally@rfs.ae' } }],
  receivedDateTime: '2026-11-19T08:00:00Z', internetMessageId: `<${id}@mail>`, conversationId: `conv-${id}`, bodyPreview: `Text of ${id}`,
  hasAttachments: false, isDraft: false, webLink: `https://outlook.office365.com/owa/?ItemID=${id}`, ...extra });

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', APP_URL: 'https://rfsops.netlify.app' });
  ol.setNetwork(fake);
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  sales = await mkUser(admin, 'Sally Sales', 'sales');
  other = await mkUser(admin, 'Otto Sales', 'sales');
  const mgr = await mkUser(admin, 'ComMgr', 'operations_manager', 'commercial');
  const cust = (await createMaster(mgr, 'customers', { name: 'Desert Retail', email: 'info@desert.ae' })).id;
  await saveContact(admin, cust, { full_name: 'Omar Khan', email: 'omar@desert.ae', is_primary: true });
  await createMaster(mgr, 'vendors', { name: 'MSC', vendor_type: 'shipping_line', email: 'rates@msc.example' });
  const f = await createJobFile(sales, { job_no: 'SI-IN-1', customer_id: cust, direction: 'import', mode: 'sea_fcl', status: 'open', origin: 'Ningbo', destination: 'Jebel Ali' });
  fileId = f.id;
  ({ enquiry_ref: enqRef, job_no: jobNo } = (await one('select enquiry_ref, job_no from job_files where id = $1', [fileId]))!);
  const f2 = await createJobFile(sales, { job_no: 'SI-IN-2', customer_id: cust, direction: 'import', mode: 'sea_fcl', status: 'open' });
  file2 = f2.id; enq2 = (await one('select enquiry_ref from job_files where id = $1', [file2])).enquiry_ref;
  await ol.setPilot(admin, sales.id, true);
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
    values ($1, 'ms', 'sally@rfs.ae', $2, $3, now() + interval '1 hour', $4)`, [sales.id, ol.seal('r'), ol.seal('a'), ol.SCOPES]);
});

test('not connected: a clear message', async () => {
  await assert.rejects(syncInbox(other), (e: any) => e.code === 'NOT_CONNECTED');
});

test('first check: the last day; tag, conversation, known sender, unknown sender', async () => {
  pages = {
    '$select=subject': { value: [
      mail('m1', 'omar@desert.ae', `RE: [${enqRef}] Shipment Enquiry – Ningbo to Jebel Ali`, { conversationId: 'conv-A' }),
      mail('m2', 'someone@msc.example', `Our rates [${jobNo}]`),                                     // job no. tag, agent's colleague
      mail('m3', 'news@shop.com', 'Big sale this weekend'),                                          // unknown: not kept
      mail('m4', 'accounts@desert.ae', 'Payment question'),                                          // same company domain, no tag: waits
      mail('m5', 'friend@gmail.com', 'Lunch?'),                                                      // public domain: not kept
      { id: 'gone', '@removed': { reason: 'deleted' } },
    ], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=P2' },
    'skiptoken=P2': { value: [
      mail('m6', 'omar@desert.ae', 'RE: thanks', { conversationId: 'conv-A' }),                      // no tag, but same conversation as m1
    ], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D1' },
  };
  const r: any = await syncInbox(sales);
  assert.deepEqual({ filed: r.filed, unmatched: r.unmatched, waiting: r.waiting, more: r.more }, { filed: 3, unmatched: 1, waiting: 1, more: false });
  assert.match(decodeURIComponent(urls[0]), /mailFolders\/inbox\/messages\/delta\?\$select=.*&\$filter=receivedDateTime ge 20\d\d-/);
  const em = await q(`select subject, direction, status, source, from_addr, web_link from email_messages where job_file_id = $1 and source = 'mailbox' order by subject`, [fileId]);
  assert.equal(em.length, 3);
  assert.ok(em.every((m: any) => m.direction === 'in' && m.status === 'received' && m.web_link));
  assert.equal(Number((await one(`select count(*) n from outlook_inbox where from_addr in ('news@shop.com', 'friend@gmail.com')`))!.n), 0, 'unknown senders are not saved');
  // the people on the shipment see it in its history and are told (not Sally herself: it is her inbox)
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title like 'Email received from omar%'`, [fileId]));
  assert.ok((await listEmails(sales, fileId) as any).rows.some((m: any) => m.source === 'mailbox'));
  const w = await listToFile(sales);
  assert.equal(w.rows.length, 1); assert.equal(w.rows[0].from_addr, 'accounts@desert.ae'); assert.equal(w.rows[0].known_as, 'Customer: Desert Retail');
  assert.equal((await one('select delta_link from outlook_connections where user_id = $1', [sales.id])).delta_link.includes('deltatoken=D1'), true);
});

test('next check: only what is new (the saved link); nothing filed twice', async () => {
  urls.length = 0;
  pages = { 'deltatoken=D1': { value: [
    mail('m1', 'omar@desert.ae', `RE: [${enqRef}] Shipment Enquiry`, { conversationId: 'conv-A' }),   // same email again (e.g. marked read)
    mail('m7', 'rates@msc.example', `[${enq2}] Rate`),
  ], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D2' } };
  const r: any = await syncInbox(sales);
  assert.equal(r.filed, 1);
  assert.ok(urls[0].includes('deltatoken=D1'));
  assert.equal(Number((await one(`select count(*) n from email_messages where job_file_id = $1 and source = 'mailbox'`, [fileId]))!.n), 3);
  assert.equal(Number((await one(`select count(*) n from email_messages where job_file_id = $1 and source = 'mailbox'`, [file2]))!.n), 1);
});

test('file by hand: by reference; later emails of that conversation follow by themselves', async () => {
  const w = await listToFile(sales);
  const id = w.rows[0].id;
  await assert.rejects(fileByHand(sales, id, { ref: 'NOPE-123' }), /No shipment found/);
  await assert.rejects(fileByHand(other, id, { ref: jobNo }), (e: any) => e.code === 'NOT_FOUND');      // not Otto's email
  const r: any = await fileByHand(sales, id, { ref: jobNo.toLowerCase() });
  assert.equal(r.job_file_id, fileId);
  assert.equal((await listToFile(sales)).rows.length, 0);
  pages = { 'deltatoken=D2': { value: [mail('m8', 'accounts@desert.ae', 'RE: Payment question', { conversationId: 'conv-m4' })],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D3' } };
  assert.equal((await syncInbox(sales) as any).filed, 1);
  assert.ok(await one(`select 1 from email_messages where job_file_id = $1 and subject = 'RE: Payment question'`, [fileId]));
});

test('"Not for a shipment" hides it for good', async () => {
  pages = { 'deltatoken=D3': { value: [mail('m9', 'omar@desert.ae', 'Happy holidays')],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D4' } };
  await syncInbox(sales);
  const id = (await listToFile(sales)).rows[0].id;
  await ignoreEmail(sales, id);
  assert.equal((await listToFile(sales)).rows.length, 0);
  await assert.rejects(ignoreEmail(sales, id), /already handled/);
});

test('Microsoft says the saved place is too old: next check starts again from the last day', async () => {
  pages = { 'deltatoken=D4': () => new Response(JSON.stringify({ error: { message: 'Resync required. Replace any local cached copies.' } }), { status: 410 }) };
  await assert.rejects(syncInbox(sales));
  assert.equal((await one('select delta_link from outlook_connections where user_id = $1', [sales.id])).delta_link, null);
});

test('one check at a time: a running check says busy; a check stopped half-way never blocks (clears after 2 minutes)', async () => {
  pages = { '$select=subject': { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D9' } };
  await q('update outlook_connections set sync_started_at = now() where user_id = $1', [sales.id]);
  assert.deepEqual(await syncInbox(sales), { busy: true });
  await q(`update outlook_connections set sync_started_at = now() - interval '3 minutes' where user_id = $1`, [sales.id]);
  const r: any = await syncInbox(sales);
  assert.equal(r.busy, undefined); assert.equal(r.more, false);
  assert.equal((await one('select sync_started_at from outlook_connections where user_id = $1', [sales.id])).sync_started_at, null, 'cleared after the check');
  // and after a failed check too
  pages = { 'deltatoken=D9': () => new Response('{}', { status: 500 }) };
  await assert.rejects(syncInbox(sales));
  assert.equal((await one('select sync_started_at from outlook_connections where user_id = $1', [sales.id])).sync_started_at, null);
});

test('a short check: stops before the time limit and carries on next time', async () => {
  let n = 0;
  pages = { 'deltatoken=D9': () => new Response(JSON.stringify({ value: [], '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=S${++n}` }), { status: 200 }),
    'skiptoken=S': () => new Response(JSON.stringify({ value: [], '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=S${++n}` }), { status: 200 }) };
  const r: any = await syncInbox(sales, 0);            // no time left after the first page
  assert.equal(r.more, true); assert.equal(n, 1);
  assert.match((await one('select delta_link from outlook_connections where user_id = $1', [sales.id])).delta_link, /skiptoken=S1/);
});

test('background check (every 2 minutes): connected people the longest-waiting first; someone checked in the last 90 seconds is skipped', async () => {
  const { runInboxChecks } = await import('../src/server/inboxcron');
  pages = { 'skiptoken=S1': { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D10' } };
  await q(`update outlook_connections set last_sync_at = now() - interval '5 minutes', last_error = null, sync_started_at = null where user_id = $1`, [sales.id]);
  let r: any = await runInboxChecks();
  assert.ok(r.done.some((d: any) => d.user === sales.id && !d.error), JSON.stringify(r));
  assert.match((await one('select delta_link from outlook_connections where user_id = $1', [sales.id])).delta_link, /deltatoken=D10/);
  r = await runInboxChecks();
  assert.ok(!r.done.some((d: any) => d.user === sales.id), 'just checked: skipped');
  // a pilot switched off, or a connection with a problem: not checked
  await q(`update outlook_connections set last_sync_at = null, last_error = 'token expired' where user_id = $1`, [sales.id]);
  assert.ok(!(await runInboxChecks()).done.some((d: any) => d.user === sales.id));
});
