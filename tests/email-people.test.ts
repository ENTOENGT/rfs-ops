/** Migration 033: To / CC on customer emails follow the shipment — contacts To/CC, our team in CC, the company CC,
 *  addresses typed in by hand and the customer's own To/CC stay; × takes someone off that shipment for good. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, pool, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { saveContact } from '../src/server/contacts';
import { createJobFile } from '../src/server/jobfiles';
import { emailDraft, emailPrepared } from '../src/server/emails';
import { learnFromReceived, removePerson } from '../src/server/emailpeople';

let admin: Actor, sam: Actor, cora: Actor, cust: string, fileId: string;
const people = async (a: Actor) => {
  const d = await emailDraft(a, { kind: 'enquiry_missing', id: fileId });
  const pick = (place: string) => d.recipients.filter((r) => (r.place ?? 'to') === place && r.picked).map((r) => r.email.toLowerCase()).sort();
  return { to: pick('to'), cc: pick('cc'), offered: d.recipients.filter((r) => !r.picked).map((r) => r.email.toLowerCase()), d };
};

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  cust = (await createMaster(sam, 'customers', { name: 'Desert Retail', email: 'info@desert.ae' })).id;
  await saveContact(admin, cust, { full_name: 'Omar Khan', email: 'omar@desert.ae', is_primary: true });
  await saveContact(admin, cust, { full_name: 'Lina Manager', email: 'lina@desert.ae', email_as: 'cc' });
  await saveContact(admin, cust, { full_name: 'Accounts', email: 'accounts@desert.ae' });
  fileId = (await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali' })).id;
});

test('defaults: main contact in To, CC contacts in CC, our coordinator in CC; the sender never copies themselves', async () => {
  const p = await people(sam);
  assert.deepEqual(p.to, ['omar@desert.ae']);
  assert.deepEqual(p.cc, ['coracoord@x.ae', 'lina@desert.ae']);
  assert.ok(p.offered.includes('accounts@desert.ae') && p.offered.includes('info@desert.ae'), 'other addresses offered, not ticked');
  assert.match(p.d.body, /^Dear Omar,/);
  assert.equal(p.d.file_id, fileId);
  // as Cora, Sam is copied instead
  assert.deepEqual((await people(cora)).cc, ['lina@desert.ae', 'samsales@x.ae']);
});

test('the company CC from Settings is copied too', async () => {
  await q(`update settings set value = '"ops@rfs.ae"' where key = 'customer_email_cc'`);
  assert.ok((await people(sam)).cc.includes('ops@rfs.ae'));
  await q(`update settings set value = '""' where key = 'customer_email_cc'`);
});

test('addresses typed in by hand stay on this shipment\'s later emails (To stays To, CC stays CC)', async () => {
  await emailPrepared(sam, { kind: 'enquiry_missing', id: fileId, to: ['omar@desert.ae', 'buyer@desert.ae'], cc: ['lina@desert.ae', 'boss@x.ae'], subject: 's', body: 'b' });
  const p = await people(sam);
  assert.ok(p.to.includes('buyer@desert.ae'));
  assert.ok(p.cc.includes('boss@x.ae'));
  const row = await one(`select side from job_file_email_people where job_file_id = $1 and email = 'boss@x.ae'`, [fileId]);
  assert.equal(row.side, 'ours', 'same company domain as our users');
  const em = await one(`select cc_addrs from email_messages where job_file_id = $1 order by created_at desc limit 1`, [fileId]);
  assert.equal(em.cc_addrs, 'lina@desert.ae, boss@x.ae');
});

test('the customer\'s own To / CC on their reply stay; an agent\'s email does not add people', async () => {
  await learnFromReceived(pool(), fileId, { from_addr: 'newguy@desert.ae', from_name: 'New Guy', to_addrs: 'samsales@x.ae', cc_addrs: 'ceo@desert.ae, cora@other.com' }, 'samsales@x.ae');
  const p = await people(sam);
  assert.ok(p.to.includes('newguy@desert.ae'), 'the sender goes in To');
  assert.ok(p.cc.includes('ceo@desert.ae') && p.cc.includes('cora@other.com'), 'the people they copied go in CC');
  await createMaster(admin, 'vendors', { name: 'MSC', vendor_type: 'shipping_line', email: 'rates@msc.example' });
  await learnFromReceived(pool(), fileId, { from_addr: 'rates@msc.example', cc_addrs: 'x@msc.example' }, null);
  assert.equal(await one(`select 1 from job_file_email_people where job_file_id = $1 and email like '%msc.example'`, [fileId]), null);
});

test('× takes someone off this shipment for good — even a default contact; typing them in again brings them back', async () => {
  await removePerson(sam, fileId, { email: 'lina@desert.ae' });
  await removePerson(sam, fileId, { email: 'ceo@desert.ae' });
  let p = await people(sam);
  assert.ok(!p.cc.includes('lina@desert.ae') && !p.cc.includes('ceo@desert.ae'));
  assert.ok(!p.d.recipients.some((r) => r.email === 'lina@desert.ae'), 'not even offered');
  // the customer copying her again on a reply does not bring her back
  await learnFromReceived(pool(), fileId, { from_addr: 'omar@desert.ae', cc_addrs: 'lina@desert.ae' }, null);
  assert.ok(!(await people(sam)).cc.includes('lina@desert.ae'));
  await emailPrepared(sam, { kind: 'enquiry_missing', id: fileId, to: ['omar@desert.ae'], cc: ['lina@desert.ae'], subject: 's', body: 'b' });
  p = await people(sam);
  assert.ok(p.cc.includes('lina@desert.ae'));
  // other shipments of the same customer are not affected
  const other = (await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali' })).id;
  const o = await emailDraft(sam, { kind: 'enquiry_missing', id: other });
  assert.ok(o.recipients.some((r) => r.email === 'ceo@desert.ae') === false && o.recipients.some((r) => r.email === 'lina@desert.ae' && r.picked));
});

test('only people who can change the shipment can take someone off', async () => {
  const otto = await mkUser(admin, 'Otto Sales', 'sales', undefined, { coordinator_id: cora.id });
  await assert.rejects(removePerson(otto, fileId, { email: 'omar@desert.ae' }), (e: any) => ['NOT_FOUND', 'FORBIDDEN'].includes(e.code));
});
