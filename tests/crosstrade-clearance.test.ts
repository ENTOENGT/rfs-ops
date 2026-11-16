/** Release K step 8 (migration 026): Cross Trade agents at both ends ("Ourselves" allowed) shown in the register;
 *  Clearance & Delivery jobs start at Documentation, or stay with the Salesman who opens them, who then has full control. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { one, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, updateJobFile, getJobFile, listJobFiles } from '../src/server/jobfiles';
import { setStage, createOperationalJob } from '../src/server/commercial';
import { saveDefaultHandler, docsCleared, doReceived } from '../src/server/handlers';
import { runReport } from '../src/server/reports';

let admin: Actor, cm: Actor, sam: Actor, cora: Actor, opsMgr: Actor, docMgr: Actor, dina: Actor, cust: string, agentA: string, agentB: string;
const cargo = [{ package_type: 'Cartons', pieces: 2, length: 50, width: 40, height: 30, dim_unit: 'cm', weight_kg: 40 }];
const row = (id: string) => one('select f.*, d.code dept from job_files f left join departments d on d.id = f.department_id where f.id = $1', [id]);
const seen = async (a: Actor, id: string) => ((await listJobFiles(a, {})) as any).rows.some((r: any) => r.id === id);

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cm = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  opsMgr = await mkUser(admin, 'Omar Ops Mgr', 'operations_manager');
  docMgr = await mkUser(admin, 'Dora Docs Mgr', 'documentation_manager');
  dina = await mkUser(admin, 'Dina Docs', 'documentation_executive');
  cust = (await createMaster(sam, 'customers', { name: 'Delta Trading' })).id;
  agentA = (await createMaster(admin, 'vendors', { name: 'Shanghai Agent Co', vendor_type: 'overseas_agent' })).id;
  agentB = (await createMaster(admin, 'vendors', { name: 'Hamburg Agent GmbH', vendor_type: 'overseas_agent' })).id;
  await saveDefaultHandler(docMgr, { department_id: await deptId('documentations'), user_id: dina.id });
});

test('Cross Trade: an agent at each end, or Ourselves; shown on the job and in the Job File register', async () => {
  const id = (await createJobFile(sam, { customer_id: cust, division: 'cross_trade', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB',
    port_of_loading: 'Shanghai', port_of_discharge: 'Hamburg', pickup_address: 'Factory', origin_agent_id: agentA, destination_is_us: true })).id;
  let f: any = await getJobFile(sam, id);
  assert.equal(f.origin_agent_name, 'Shanghai Agent Co');
  assert.equal(f.destination_is_us, true);
  await updateJobFile(sam, id, { destination_is_us: false, destination_agent_id: agentB });
  f = await getJobFile(sam, id);
  assert.equal(f.destination_agent_name, 'Hamburg Agent GmbH');
  await updateJobFile(sam, id, { origin_is_us: true });                          // Ourselves clears the origin agent
  assert.equal((await row(id)).origin_agent_id, null);
  await assert.rejects(updateJobFile(sam, id, { destination_agent_id: cust }), /destination agent/);   // not a vendor
  const day = new Date().toISOString().slice(0, 10);
  const r: any = await runReport(admin, 'jobfiles', { q: f.enquiry_ref, from: '2020-01-01', to: day });
  const line = r.rows.find((x: any) => x.origin_agent === 'Ourselves (RFS)');
  assert.ok(line, 'register shows Ourselves');
  assert.equal(line.destination_agent, 'Hamburg Agent GmbH');
});

test('a direct Clearance & Delivery job goes to Documentation\'s default handler; no Ops DO step', async () => {
  const j = await createJobFile(opsMgr, { customer_id: cust, direction: 'import', mode: 'sea_fcl', job_type: 'clearance_delivery', job_no: 'CLR-1' });
  const f = await row(j.id);
  assert.equal(f.dept, 'documentations');
  assert.equal(f.docs_handler_id, dina.id);
  assert.equal(await seen(dina, j.id), true);
  const g: any = await getJobFile(dina, j.id);
  assert.equal(g.can.docs_cleared, true);
  assert.equal(g.can.do_received, false);
  await assert.rejects(doReceived(opsMgr, j.id, {}), (e: any) => e.code === 'STAGE');
  await docsCleared(dina, j.id, { note: 'BOE passed, raise the truck' });
  assert.ok((await row(j.id)).docs_cleared_at);
  await assert.rejects(updateJobFile(dina, j.id, { job_type: 'freight' }), /job type/);
});

test('a Salesman who opens a Clearance & Delivery job keeps it with full control', async () => {
  const j = await createJobFile(sam, { customer_id: cust, direction: 'import', mode: 'air', job_type: 'clearance_delivery', job_no: 'CLR-2' });
  assert.equal((await row(j.id)).docs_handler_id, sam.id);
  const g: any = await getJobFile(sam, j.id);
  assert.equal(g.can.docs_cleared, true);
  assert.equal(g.can.docs_pick, true, 'can pass it to Documentation');
  await docsCleared(sam, j.id, {});
});

test('a Clearance & Delivery enquiry goes to Documentation at handover', async () => {
  const id = (await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF',
    port_of_discharge: 'Jebel Ali', delivery_address: 'Dubai', job_type: 'clearance_delivery' })).id;
  await tx((c) => setStage(c, sam, id, 'customer_confirmed'));
  await createOperationalJob(cm, id, { job_no: 'CLR-3', skip_prealert_reason: 'test' });
  const f = await row(id);
  assert.equal(f.dept, 'documentations');
  assert.equal(f.docs_handler_id, dina.id);
  assert.equal(f.ops_handler_id, null);
});
