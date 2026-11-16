/** Release L step 11 (migration 027): team chat on each shipment — who can read, @mentions, read ticks, 5-minute corrections kept,
 *  prices hidden from people who may not see them, and "My chats". */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import { chatList, chatPost, chatEdit, chatInbox, mentionable, looksLikePrice } from '../src/server/chat';

let admin: Actor, sam: Actor, cora: Actor, sara: Actor, tm: Actor, file: string;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  sara = await mkUser(admin, 'Sara Sales', 'sales');
  tm = await mkUser(admin, 'Tom Transport', 'transport_manager');
  const cust = (await createMaster(sam, 'customers', { name: 'Zeta LLC' })).id;
  file = (await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali' })).id;
});

test('the people on the job chat; someone who cannot open the job cannot read it', async () => {
  const m: any = await chatPost(sam, file, { body: 'Customer wants delivery on Thursday' });
  assert.equal(m.mine, true);
  const l: any = await chatList(cora, file);
  assert.equal(l.messages.length, 1);
  assert.equal(l.messages[0].user_name, 'Sam Sales');
  assert.ok(l.people.some((p: any) => p.id === sam.id) && l.people.some((p: any) => p.id === cora.id));
  await assert.rejects(chatList(sara, file), (e: any) => ['NOT_FOUND', 'FORBIDDEN'].includes(e.code));
  const s: any = await chatList(sam, file);
  assert.deepEqual(s.messages[0].seen_by, ['Cora Coord'], 'Sam sees that Cora read it');
});

test('the group hears about new messages; @mentions alert the person; only people who can open the job', async () => {
  assert.ok(await one(`select 1 from notifications where user_id = $1 and job_file_id = $2 and event = 'chat'`, [cora.id, file]));
  await assert.rejects(chatPost(cora, file, { body: '@Sara please check', mentions: [sara.id] }), /cannot open this job/);
  await chatPost(cora, file, { body: '@Sam noted', mentions: [sam.id] });
  assert.ok(await one(`select 1 from notifications where user_id = $1 and job_file_id = $2 and event = 'chat_mention'`, [sam.id, file]));
  const names = (await mentionable(cora, file, 'sa')).map((x: any) => x.full_name);
  assert.ok(names.includes('Sam Sales') && !names.includes('Sara Sales'));
});

test('corrections within 5 minutes keep the old words; later ones are refused; nobody else can correct', async () => {
  const m: any = await chatPost(sam, file, { body: 'Deliver Wedensday' });
  await chatEdit(sam, file, m.id, { body: 'Deliver Wednesday' });
  assert.equal((await one('select old_body from job_chat_edits where message_id = $1', [m.id])).old_body, 'Deliver Wedensday');
  await assert.rejects(chatEdit(cora, file, m.id, { body: 'x' }), (e: any) => e.code === 'FORBIDDEN');
  await q(`update job_chat_messages set created_at = now() - interval '6 minutes' where id = $1`, [m.id]);
  await assert.rejects(chatEdit(sam, file, m.id, { body: 'again' }), (e: any) => e.code === 'TOO_LATE');
  await assert.rejects(q('delete from job_chat_edits where message_id = $1', [m.id]));
});

test('a message with a price is hidden from people who may not see prices', async () => {
  assert.equal(looksLikePrice('Selling AED 1,200 per container'), true);
  assert.equal(looksLikePrice('Truck at 9 am, gate 3'), false);
  await chatPost(sam, file, { body: 'Customer accepted USD 1450 all in' });
  const t = (await loadActor(tm.id))!;
  assert.equal(t.fin.sellingView, false, 'Transport never sees selling prices');
  const l: any = await chatList(t, file);                       // Transport follows every job, so they can read the chat…
  const h = l.messages.find((x: any) => x.hidden);
  assert.ok(h && h.body === null, '…but not the message with the price');
  assert.ok(l.messages.some((x: any) => x.body === 'Booking sent' || x.body === 'Customer wants delivery on Thursday'));
  const s: any = await chatList(sam, file);
  assert.ok(s.messages.some((x: any) => x.body === 'Customer accepted USD 1450 all in'));
});

test('My chats lists the job with my unread count', async () => {
  await chatPost(cora, file, { body: 'Booking sent' });
  const i: any = await chatInbox(sam);
  const r = i.rows.find((x: any) => x.id === file);
  assert.ok(r); assert.ok(r.unread >= 1);
  await chatList(sam, file);
  assert.equal((await chatInbox(sam)).rows.find((x: any) => x.id === file)!.unread, 0);
});
