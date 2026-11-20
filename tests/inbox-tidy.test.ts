/** Fix 20 Nov: our own colleagues (our domain) are never "the customer", automatic mail is left out, emails the AI calls
 *  "other" are tucked away, and "please quote the attached sheet" from a new sender is kept for the AI. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { saveContact } from '../src/server/contacts';
import * as ol from '../src/server/outlook';
import { setAiNetwork } from '../src/server/ai';
import { knownSender, listToFile, syncInbox } from '../src/server/inbox';
import { screenInbox } from '../src/server/newenquiry';

let admin: Actor, cora: Actor, cust: string;
const seen: string[] = [];
const mail = (id: string, from: string, subject: string, preview: string, att = false) => ({ id, subject, isDraft: false, from: { emailAddress: { address: from, name: from } },
  toRecipients: [{ emailAddress: { address: 'coracoord@x.ae' } }], receivedDateTime: '2026-11-20T05:51:00Z', internetMessageId: `<${id}@m>`, conversationId: `c-${id}`,
  bodyPreview: preview, hasAttachments: att, webLink: null });
let batch: any[] = [];

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  cust = (await createMaster(admin, 'customers', { name: 'Test Cus 1' })).id;
  await saveContact(admin, cust, { full_name: 'Test contact on our domain', email: 'cus1@x.ae', is_primary: true });   // like cus1@relianceuae.ae
  await saveContact(admin, cust, { full_name: 'Real buyer', email: 'buyer@testcus.ae' });
  await ol.setPilot(admin, cora.id, true);
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
    values ($1, 'ms', 'coracoord@x.ae', $2, $3, now() + interval '1 hour', $4)`, [cora.id, ol.seal('r'), ol.seal('a'), ol.SCOPES]);
  ol.setNetwork((async () => new Response(JSON.stringify({ value: batch, '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=N' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
  setAiNetwork((async (_u: any, init: any) => {
    const user = JSON.parse(init.body).messages[0].content; seen.push(user);
    const kind = /best rate|quote/i.test(user) ? 'new_enquiry' : 'other';
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'classify_email', input: { kind, summary: kind === 'other' ? '' : 'Rate request (sheet attached)' } }] }), { status: 200 });
  }) as typeof fetch);
});

test('our own domain is never a customer, even when a test contact uses it', async () => {
  assert.equal(await knownSender('frontdesk.ja@x.ae'), null);
  assert.equal(await knownSender('cus1@x.ae'), null);
  assert.equal(await knownSender('someone@testcus.ae'), 'Customer: Test Cus 1', 'a real customer domain still counts');
});

test('internal mail, postmaster and greetings stay out; "please quote the attached sheet" from a new sender becomes a new enquiry', async () => {
  // rows kept by the old version (before this fix) are tidied away at the next check
  await q(`insert into outlook_inbox (user_id, ms_message_id, from_addr, subject, status) values ($1, 'old1', 'frontdesk.ja@x.ae', 'HAPPY BIRTHDAY', 'unmatched'),
    ($1, 'old2', 'postmaster@x.ae', 'A message triggered content policies', 'unmatched')`, [cora.id]);
  batch = [
    mail('m1', 'frontdesk.ja@x.ae', 'HAPPY BIRTHDAY MS. MAMTA', 'Today is your birthday'),
    mail('m2', 'postmaster@x.ae', 'A message triggered content policies', 'Contact your administrator'),
    mail('m3', 'cs@entoen.example', 'New request', 'Dear Shamsheer, Please find the attached Sheet, kindly check and provide the best rate.', true),
    mail('m4', 'buyer@testcus.ae', 'Season greetings', 'Happy holidays to the team'),
  ];
  const r: any = await syncInbox(cora);
  assert.equal(r.to_screen, 2, 'the new sender and the customer\'s greeting');
  const s: any = await screenInbox(cora, 10);
  assert.equal(s.new_enquiries, 1);
  assert.match(seen.find((x) => x.includes('entoen'))!, /Has attachments: yes/);
  const l: any = await listToFile(cora);
  assert.deepEqual(l.rows.map((m: any) => [m.from_addr, m.ai_kind]), [['cs@entoen.example', 'new_enquiry']]);
  assert.equal(l.other_hidden, 1, 'the customer\'s greeting is tucked away, not lost');
  assert.equal((await listToFile(cora, true)).rows.length, 2);
  const old = await q(`select status, subject from outlook_inbox where user_id = $1 and ms_message_id in ('old1', 'old2')`, [cora.id]);
  assert.deepEqual(old.map((o) => [o.status, o.subject]), [['ignored', null], ['ignored', null]]);
  assert.equal(await one(`select 1 from outlook_inbox where ms_message_id in ('m1', 'm2')`), null, 'never kept');
});

test('one user on another company\'s address does not make that whole company "us"', async () => {
  const { isOurs, ourDomains } = await import('../src/server/emailpeople');
  await mkUser(admin, 'Shamsheer Two', 'coordinator', undefined, { email: 'shamsheer@entoen.example' } as any).catch(async () => {
    await q(`update users set email = 'shamsheer@entoen.example' where id = (select id from users where full_name = 'Shamsheer Two')`);
  });
  if (!(await one(`select 1 from users where email = 'shamsheer@entoen.example'`)))
    await q(`update users set email = 'shamsheer@entoen.example' where id = (select id from users where full_name = 'Shamsheer Two')`);
  assert.ok(!(await ourDomains()).has('entoen.example'));
  assert.equal(await isOurs('shamsheer@entoen.example'), true, 'that person is still a colleague');
  assert.equal(await isOurs('cs@entoen.example'), false, 'the rest of that company is an outside sender');
  assert.equal(await isOurs('anyone@x.ae'), true, 'a domain many of our users share is ours');
});
