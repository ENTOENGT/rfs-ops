/** Migration 035: the AI finds new enquiries in the Salesman's / Coordinator's inbox, fills them in (with a new customer when
 *  needed), a person saves; the same email in both inboxes becomes one enquiry. Microsoft and Claude are fakes. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { saveContact } from '../src/server/contacts';
import { getJobFile } from '../src/server/jobfiles';
import * as ol from '../src/server/outlook';
import { setAiNetwork } from '../src/server/ai';
import { listToFile, syncInbox } from '../src/server/inbox';
import { createFromEmail, draftEnquiry, screenInbox } from '../src/server/newenquiry';

let admin: Actor, sam: Actor, cora: Actor, desert: string;
const ai: { tool: string; user: string }[] = [];
const mail = (id: string, from: string, name: string, subject: string, preview: string, to = 'samsales@x.ae', cc = 'coracoord@x.ae') => ({
  id, subject, isDraft: false, from: { emailAddress: { address: from, name } }, toRecipients: [{ emailAddress: { address: to } }], ccRecipients: cc ? [{ emailAddress: { address: cc } }] : [],
  receivedDateTime: '2026-11-20T06:00:00Z', internetMessageId: `<${id}@mail>`, conversationId: `conv-${id}`, bodyPreview: preview, hasAttachments: false, webLink: `https://outlook/${id}` });
const inbox: Record<string, any[]> = {
  'access-sam': [
    mail('e1', 'buyer@newco-trading.com', 'Hans Becker', 'Rate request 2x40HC Hamburg to Jebel Ali', 'Dear team, please quote 2x40HC from Hamburg to Jebel Ali, FOB...'),
    mail('e2', 'news@shop.com', 'Shop', 'Weekly news', 'Our best deals'),
    mail('e3', 'promo@offers.biz', 'Offers', 'Big discount on printers', 'Buy now and save'),
    mail('e4', 'omar@desert.ae', 'Omar Khan', 'New shipment from Chennai', 'Hi, we have a new shipment of 5 pallets from Chennai...'),
    mail('e5', 'friend@gmail.com', 'Friend', 'Lunch?', 'Are you free on Friday?'),
  ],
  'access-cora': [mail('e1', 'buyer@newco-trading.com', 'Hans Becker', 'Rate request 2x40HC Hamburg to Jebel Ali', 'Dear team, please quote 2x40HC from Hamburg to Jebel Ali, FOB...')],
};
const BODY = `Dear team,\nPlease quote 2x40HC from Hamburg to Jebel Ali, FOB Hamburg. Goods: machine parts, 18 tons, not hazardous.\nReady 25 Nov.\n\nRegards,\nHans Becker\nNewCo Trading GmbH\n+49 40 555 1234`;

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', APP_URL: 'https://rfsops.netlify.app', ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  desert = (await createMaster(admin, 'customers', { name: 'Desert Retail' })).id;
  await saveContact(admin, desert, { full_name: 'Omar Khan', email: 'omar@desert.ae', is_primary: true });
  await q(`insert into customer_salesmen (customer_id, user_id, is_main) values ($1, $2, true) on conflict do nothing`, [desert, sam.id]);
  for (const [u, tok] of [[sam, 'access-sam'], [cora, 'access-cora']] as const) {
    await ol.setPilot(admin, u.id, true);
    await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
      values ($1, 'ms', $2, $3, $4, now() + interval '1 hour', $5)`, [u.id, u.email, ol.seal('r'), ol.seal(tok), ol.SCOPES]);
  }
  ol.setNetwork((async (url: any, init: any = {}) => {
    const u = String(url), tok = String(init.headers?.Authorization ?? '').replace('Bearer ', '');
    const json = (j: any) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/messages/delta')) return json({ value: inbox[tok], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=Z' });
    if (u.includes('/me/messages/e1?')) return json({ body: { content: BODY } });
    if (u.includes('/me/messages/e4?')) return json({ body: { content: 'Hi, new shipment: 5 pallets of tiles from Chennai to Jebel Ali, CIF, 4,000 kg. Omar' } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch);
  setAiNetwork((async (_url: any, init: any) => {
    const b = JSON.parse(init.body); const tool = b.tools[0].name; const user = b.messages[0].content;
    ai.push({ tool, user });
    let input: any;
    if (tool === 'classify_email') input = /Rate request|New shipment/.test(user) ? { kind: 'new_enquiry', summary: user.includes('Hamburg') ? '2x40HC Hamburg to Jebel Ali, FOB' : '5 pallets Chennai to Jebel Ali' } : { kind: 'other', summary: '' };
    else input = user.includes('Hamburg')
      ? { company_name: 'NewCo Trading GmbH', contact_person: 'Hans Becker', contact_phone: '+49 40 555 1234', mode: 'sea_fcl', incoterm: 'FOB', origin_country: 'Germany', origin_port: 'Hamburg',
          destination_country: 'UAE', destination_port: 'Jebel Ali', cargo_description: 'Machine parts', containers: '2x40HC', gross_weight_kg: 18000, cargo_ready_date: '2026-11-25', hazardous: 'no', summary: '2x40HC Hamburg to Jebel Ali' }
      : { mode: 'sea_lcl', incoterm: 'CIF', origin_country: 'India', origin_port: 'Chennai', destination_port: 'Jebel Ali', cargo_description: 'Tiles', packages: '5 pallets', gross_weight_kg: 4000, hazardous: 'unknown', summary: '5 pallets Chennai to Jebel Ali' };
    return new Response(JSON.stringify({ model: 'claude-haiku-5-5', content: [{ type: 'tool_use', name: tool, input }] }), { status: 200 });
  }) as typeof fetch);
});

const rowOf = async (u: Actor, ms: string) => (await one('select * from outlook_inbox where user_id = $1 and ms_message_id = $2', [u.id, ms]));

test('reading the inbox: unknown senders wait for the AI\'s look; automatic mail is never kept', async () => {
  const r: any = await syncInbox(sam);
  assert.equal(r.to_screen, 4, 'e1 (new sender), e3, e4 (known customer), e5');
  assert.equal(await rowOf(sam, 'e2'), null, 'news@ is automatic mail');
  assert.equal((await listToFile(sam)).rows.length, 1, 'only the known customer\'s email shows before the AI has looked');
});

test('the AI\'s quick look: new enquiries come first; other mail from unknown senders is wiped', async () => {
  const s: any = await screenInbox(sam, 10);
  assert.deepEqual({ screened: s.screened, found: s.new_enquiries, left: s.left }, { screened: 4, found: 2, left: 0 });
  assert.ok(ai.every((a) => a.tool === 'classify_email'));
  assert.match(ai[0].user, /not a known customer yet/);
  const list = (await listToFile(sam)).rows;
  assert.deepEqual(list.map((m: any) => [m.from_addr, m.ai_kind]).sort(), [['buyer@newco-trading.com', 'new_enquiry'], ['omar@desert.ae', 'new_enquiry']]);
  const e3 = await rowOf(sam, 'e3');
  assert.deepEqual([e3.status, e3.subject, e3.body_excerpt, e3.from_name], ['ignored', null, null, null], 'not kept');
  // the Coordinator got the same email: looked at once
  const n = ai.length;
  await syncInbox(cora); await screenInbox(cora);
  assert.equal(ai.length, n, 'no second AI look for the same email');
  assert.equal((await rowOf(cora, 'e1')).ai_kind, 'new_enquiry');
});

test('"Create enquiry": the AI fills the enquiry, a new customer from the signature, ports from the list', async () => {
  const r: any = await draftEnquiry(sam, (await rowOf(sam, 'e1')).id);
  const d = r.draft;
  assert.equal(d.customer_id, null);
  assert.deepEqual(d.new_customer, { name: 'NewCo Trading GmbH', contact_person: 'Hans Becker', email: 'buyer@newco-trading.com', contact_number: '+49 40 555 1234' });
  assert.equal(d.salesman_id, sam.id);
  assert.deepEqual([d.direction, d.division, d.mode, d.incoterm], ['import', 'imports', 'sea_fcl', 'FOB']);
  assert.deepEqual([d.origin_country, d.pol_code, d.destination_country, d.pod_code], ['DE', 'DEHAM', 'AE', 'AEJEA']);
  assert.equal(d.gross_weight_kg, 18000);
  assert.match(d.cargo_description, /Machine parts · 2x40HC/);
  assert.ok(Object.values(d.enquiry_details ?? {}).includes('2026-11-25') && Object.values(d.enquiry_details ?? {}).includes('no'));
  assert.match(ai.at(-1)!.user, /NewCo Trading GmbH/, 'the whole email text from Outlook');
  const n = ai.length;
  await draftEnquiry(sam, (await rowOf(sam, 'e1')).id);
  assert.equal(ai.length, n, 'read once, then kept');
});

test('Save: the new customer (main contact in To, Salesman as owner), the enquiry, and the email in both inboxes filed on it', async () => {
  const row = await rowOf(sam, 'e1');
  const d: any = (await draftEnquiry(sam, row.id)).draft;
  const { new_customer, customer_name, summary, mode_unknown, ...enquiry } = d;
  const r: any = await createFromEmail(sam, row.id, { enquiry, new_customer });
  assert.equal(r.customer_created, 'NewCo Trading GmbH');
  const f: any = await getJobFile(sam, r.id);
  assert.equal(f.customer_name ?? (await one('select name from customers where id = $1', [f.customer_id])).name, 'NewCo Trading GmbH');
  assert.equal(f.status, 'enquiry'); assert.equal(f.pol_code, 'DEHAM');
  const k = await one(`select full_name, email, is_primary, email_as from customer_contacts where customer_id = $1`, [f.customer_id]);
  assert.deepEqual(k, { full_name: 'Hans Becker', email: 'buyer@newco-trading.com', is_primary: true, email_as: 'to' });
  assert.equal((await one(`select user_id from customer_salesmen where customer_id = $1 and is_main`, [f.customer_id])).user_id, sam.id);
  assert.ok(await one(`select 1 from email_messages where job_file_id = $1 and message_id = '<e1@mail>'`, [r.id]));
  assert.deepEqual([(await rowOf(sam, 'e1')).status, (await rowOf(cora, 'e1')).status, (await rowOf(cora, 'e1')).job_file_id], ['filed', 'filed', r.id]);
  // the Coordinator opening the same email: it is already that enquiry; saving again is refused
  assert.deepEqual((await draftEnquiry(cora, (await rowOf(cora, 'e1')).id) as any).already, { id: r.id, enquiry_ref: f.enquiry_ref });
  await assert.rejects(createFromEmail(sam, row.id, { enquiry, new_customer }), (e: any) => e.code === 'JOB_FILE_EXISTS');
  assert.equal(Number((await one(`select count(*) n from customers where name = 'NewCo Trading GmbH'`))!.n), 1);
});

test('a known customer\'s new enquiry: their customer and main Salesman, no new customer', async () => {
  const row = await rowOf(sam, 'e4');
  const d: any = (await draftEnquiry(sam, row.id)).draft;
  assert.equal(d.customer_id, desert); assert.equal(d.new_customer, null); assert.equal(d.salesman_id, sam.id);
  assert.deepEqual([d.mode, d.origin_country, d.pol_code, d.incoterm], ['sea_lcl', 'IN', 'INMAA', 'CIF']);
  const { new_customer, customer_name, summary, mode_unknown, ...enquiry } = d;
  const r: any = await createFromEmail(sam, row.id, { enquiry: { ...enquiry, cargo_lines: [{ package_type: 'Pallets', pieces: 5, length: 120, width: 80, height: 100, dim_unit: 'cm', weight_kg: 4000 }] } });
  assert.equal(r.customer_created, null);
  assert.equal((await getJobFile(sam, r.id) as any).customer_id, desert);
});

test('someone else cannot use another person\'s inbox email', async () => {
  const otto = await mkUser(admin, 'Otto Sales', 'sales', undefined, { coordinator_id: cora.id });
  await assert.rejects(draftEnquiry(otto, (await rowOf(sam, 'e1')).id), (e: any) => e.code === 'NOT_FOUND');
});
