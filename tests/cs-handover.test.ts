/** Release K step 6 (migration 026): Customer Service owns a shipment from the customer's confirmation.
 *  Default handlers are set once; the CS Manager, Coordinator or Salesman can change the handler; the handler sees and acts on the job. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { q, one, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, listJobFiles, getJobFile } from '../src/server/jobfiles';
import { setStage } from '../src/server/commercial';
import { saveDefaultHandler, listDefaultHandlers, setCsHandler, removeDefaultHandler } from '../src/server/handlers';

let admin: Actor, csm: Actor, ravi: Actor, meena: Actor, cora: Actor, sam: Actor, otto: Actor, custA: string, custB: string;
const confirm = async (id: string) => tx((c) => setStage(c, sam, id, 'customer_confirmed'));
const newFile = async (cust: string) => (await createJobFile(sam, { customer_id: cust, direction: 'import', mode: 'sea_fcl', status: 'enquiry',
  incoterm: 'EXW', pickup_address: 'Factory', delivery_address: 'Warehouse, Dubai' })).id as string;
const seen = async (a: Actor, id: string) => ((await listJobFiles(a, {})) as any).rows.some((r: any) => r.id === id);

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  csm = await mkUser(admin, 'Cathy CS Manager', 'customer_service_manager');
  ravi = await mkUser(admin, 'Ravi CS', 'customer_service', undefined, { manager_id: csm.id });
  meena = await mkUser(admin, 'Meena CS', 'customer_service', undefined, { manager_id: csm.id });
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  otto = await mkUser(admin, 'Otto Ops', 'operations');
  custA = (await createMaster(sam, 'customers', { name: 'Alpha Trading' })).id;
  custB = (await createMaster(sam, 'customers', { name: 'Beta Foods' })).id;
});

test('with no default handler, the confirmed job waits and the CS Manager is told', async () => {
  const id = await newFile(custA);
  await confirm(id);
  assert.equal((await one('select cs_handler_id from job_files where id = $1', [id])).cs_handler_id, null);
  assert.ok(await one(`select 1 from notifications where user_id = $1 and job_file_id = $2`, [csm.id, id]));
  assert.equal(await seen(csm, id), true, 'the CS Manager can open it to assign it');
  assert.equal(await seen(ravi, id), false);
});

test('default handlers: one for the team, one for a customer; only the team\'s own manager or the Super Admin set them', async () => {
  const cs = await deptId('customer_service');
  await saveDefaultHandler(csm, { department_id: cs, user_id: ravi.id });
  await saveDefaultHandler(csm, { department_id: cs, customer_id: custB, user_id: meena.id });
  await saveDefaultHandler(csm, { department_id: cs, customer_id: custB, user_id: meena.id });          // same again: no duplicate
  assert.equal((await listDefaultHandlers(csm)).rows.length, 2);
  await assert.rejects(saveDefaultHandler(csm, { department_id: cs, user_id: cora.id }), /active member of that team/);
  await assert.rejects(saveDefaultHandler(cora, { department_id: cs, user_id: ravi.id }), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(saveDefaultHandler(csm, { department_id: await deptId('commercial'), user_id: cora.id }), /team/);
});

test('a confirmed job goes to the customer\'s handler, else the team\'s; the handler sees it and is told', async () => {
  const a = await newFile(custA), b = await newFile(custB);
  assert.equal(await seen(ravi, a), false, 'not before confirmation');
  await confirm(a); await confirm(b);
  assert.equal((await one('select cs_handler_id from job_files where id = $1', [a])).cs_handler_id, ravi.id);
  assert.equal((await one('select cs_handler_id from job_files where id = $1', [b])).cs_handler_id, meena.id);
  assert.equal(await seen(ravi, a), true);
  assert.equal(await seen(ravi, b), false, 'not someone else\'s');
  assert.equal(await seen(csm, b), true, 'the CS Manager sees the team\'s');
  assert.ok(await one(`select 1 from notifications where user_id = $1 and job_file_id = $2`, [ravi.id, a]));
  const f: any = await getJobFile(ravi, a);
  assert.equal(f.cs_handler_name, 'Ravi CS');
});

test('the Coordinator, the Salesman or the CS Manager change the handler (reason needed); others cannot', async () => {
  const id = await newFile(custA);
  await confirm(id);
  await assert.rejects(setCsHandler(cora, id, { user_id: meena.id }), /reason/);
  await setCsHandler(cora, id, { user_id: meena.id, reason: 'Ravi on leave' });
  await setCsHandler(csm, id, { user_id: ravi.id, reason: 'Back to CS' });
  await setCsHandler(sam, id, { user_id: sam.id, reason: 'I will handle this customer myself' });      // the Salesman keeps it
  await assert.rejects(setCsHandler(sam, id, { user_id: otto.id, reason: 'x' }), /Customer Service/);
  await assert.rejects(setCsHandler(otto, id, { user_id: ravi.id, reason: 'x' }), (e: any) => ['FORBIDDEN', 'NOT_FOUND'].includes(e.code));
  const ev = await q(`select title from job_file_events where job_file_id = $1 and field = 'Customer Service' order by at`, [id]);
  assert.equal(ev.length, 4);
});

test('Customer Service is only for confirmed jobs', async () => {
  const id = await newFile(custA);
  await assert.rejects(setCsHandler(sam, id, { user_id: ravi.id }), (e: any) => e.code === 'STAGE');
});

test('removing a default handler', async () => {
  const r = (await listDefaultHandlers(admin)).rows.find((x: any) => x.customer_id);
  await removeDefaultHandler(admin, r.id);
  assert.equal((await listDefaultHandlers(admin)).rows.length, 1);
});
