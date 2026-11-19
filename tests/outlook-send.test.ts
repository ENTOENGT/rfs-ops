/** G3 step 2: sending a prepared email from the person's own Outlook (Microsoft replaced by a fake). */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { saveContact } from '../src/server/contacts';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import { emailDraft, emailSend } from '../src/server/emails';
import * as ol from '../src/server/outlook';

let admin: Actor, sales: Actor, other: Actor, customer: string, vendor: string, fileId: string, reqId: string;
const sent: any[] = [];
let failNext = false;
const fake = (async (url: any, init: any = {}) => {
  const u = String(url);
  const json = (j: any, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.endsWith('/v1.0/me/sendMail')) {
    assert.equal(init.headers.Authorization, 'Bearer access-sally');
    if (failNext) { failNext = false; return json({ error: { message: 'Mailbox is full' } }, 403); }
    sent.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 202 });
  }
  return json({ error: { message: 'unknown' } }, 404);
}) as typeof fetch;

async function connect(a: Actor, email: string) {
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, ms_name, refresh_token_enc, access_token_enc, access_expires_at, scope)
    values ($1, 'ms-1', $2, $3, $4, $5, now() + interval '1 hour', $6)`, [a.id, email, a.full_name, ol.seal('refresh-x'), ol.seal('access-sally'), ol.SCOPES]);
}

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', APP_URL: 'https://rfsops.netlify.app' });
  ol.setNetwork(fake);
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  sales = await mkUser(admin, 'Sally Sales', 'sales');
  other = await mkUser(admin, 'Otto Sales', 'sales');
  const mgr = await mkUser(admin, 'ComMgr', 'operations_manager', 'commercial');
  customer = (await createMaster(mgr, 'customers', { name: 'Desert Retail', email: 'info@desert.ae' })).id;
  await saveContact(admin, customer, { full_name: 'Omar Khan', role: 'Logistics', email: 'omar@desert.ae', is_primary: true });
  vendor = (await createMaster(mgr, 'vendors', { name: 'MSC', vendor_type: 'shipping_line', contact_person: 'Raj Patel', email: 'raj@msc.example' })).id;
  fileId = (await createJobFile(sales, { job_no: 'SI-OL-1', customer_id: customer, direction: 'import', mode: 'sea_fcl', status: 'open',
    origin: 'Ningbo', destination: 'Jebel Ali', cargo_description: 'Furniture' })).id;
  reqId = (await vr.createVendorRequest(sales, { vendor_id: vendor, service: 'rate', job_no: 'SI-OL-1', description: '1x40HC', needed_by: '2030-01-01' })).id;
});

test('not a pilot user, or not connected: nothing is sent', async () => {
  const b = { kind: 'job_file', id: fileId, to: ['omar@desert.ae'], subject: 'x', body: 'y' };
  await assert.rejects(emailSend(sales, b), (e: any) => e.code === 'FORBIDDEN');
  await ol.setPilot(admin, sales.id, true);
  await assert.rejects(emailSend(sales, b), (e: any) => e.code === 'NOT_CONNECTED');
  assert.equal(sent.length, 0);
});

test('sent from my Outlook: the edited text goes out, and it is noted as sent on the shipment', async () => {
  await connect(sales, 'sally@rfs.ae');
  const d = await emailDraft(sales, { kind: 'job_file', id: fileId });
  const r = await emailSend(sales, { kind: 'job_file', id: fileId, update: d.update, to: ['Omar@Desert.ae', 'not-an-email'], subject: d.subject, body: 'Dear Omar,\nChanged by me.' });
  assert.deepEqual(r.to, ['omar@desert.ae']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].saveToSentItems, true);
  assert.equal(sent[0].message.subject, d.subject);
  assert.equal(sent[0].message.body.content, 'Dear Omar,\nChanged by me.');
  assert.deepEqual(sent[0].message.toRecipients, [{ emailAddress: { address: 'omar@desert.ae' } }]);
  const m = await one(`select status, from_addr, to_addrs from email_messages where job_file_id = $1 order by created_at desc limit 1`, [fileId]);
  assert.deepEqual(m, { status: 'sent', from_addr: 'sally@rfs.ae', to_addrs: 'omar@desert.ae' });
  const f = await getJobFile(sales, fileId);
  assert.ok(JSON.stringify(f).includes('Email sent to the customer'));
});

test('to an agent: noted on the agent request too', async () => {
  const d = await emailDraft(sales, { kind: 'vendor_request', id: reqId });
  await emailSend(sales, { kind: 'vendor_request', id: reqId, to: ['raj@msc.example'], subject: d.subject, body: d.body });
  assert.equal(sent.length, 2);
  assert.ok(await one(`select 1 from vendor_request_events where request_id = $1 and title = 'Email sent'`, [reqId]));
});

test('no address, or Microsoft refuses: a clear message and nothing is noted as sent', async () => {
  const before = Number((await one(`select count(*) n from email_messages where status = 'sent'`))!.n);
  await assert.rejects(emailSend(sales, { kind: 'job_file', id: fileId, to: [], subject: 's', body: 'b' }), /at least one email address/);
  failNext = true;
  await assert.rejects(emailSend(sales, { kind: 'job_file', id: fileId, to: ['omar@desert.ae'], subject: 's', body: 'b' }), /Mailbox is full/);
  assert.equal(Number((await one(`select count(*) n from email_messages where status = 'sent'`))!.n), before);
});

test('someone who cannot open the shipment cannot send about it', async () => {
  await ol.setPilot(admin, other.id, true);
  await assert.rejects(emailSend(other, { kind: 'job_file', id: fileId, to: ['omar@desert.ae'], subject: 's', body: 'b' }), (e: any) => ['NOT_FOUND', 'FORBIDDEN'].includes(e.code));
  assert.equal(sent.length, 2);
});
