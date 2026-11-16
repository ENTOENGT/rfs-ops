/** Release K step 7 (migration 026): at handover the job goes to the Operations team for its type and to that team's default
 *  handler; Ops records the DO → Documentation; Documentation clears → back to Ops. Managers can change handlers. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { one, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, listJobFiles, getJobFile } from '../src/server/jobfiles';
import { setStage, createOperationalJob } from '../src/server/commercial';
import { saveDefaultHandler, setHandler, doReceived, docsCleared, listRoutes, saveRoute } from '../src/server/handlers';

let admin: Actor, cm: Actor, sam: Actor, cora: Actor, seaMgr: Actor, fred: Actor, fiona: Actor, airMgr: Actor, docMgr: Actor, dina: Actor, cs: Actor, cust: string;
let n = 0;
const handedOver = async (direction: string, mode: string) => {
  const id = (await createJobFile(sam, { customer_id: cust, direction, mode, status: 'enquiry', incoterm: 'EXW', pickup_address: 'Factory', delivery_address: 'Dubai',
    cargo_lines: [{ package_type: 'Cartons', pieces: 2, length: 50, width: 40, height: 30, dim_unit: 'cm', weight_kg: 40 }] })).id;
  await tx((c) => setStage(c, sam, id, 'customer_confirmed'));
  await createOperationalJob(cm, id, { job_no: `T7-${++n}`, skip_prealert_reason: 'test', bl_override_reason: 'test' });
  return id as string;
};
const row = (id: string) => one('select f.*, d.code dept from job_files f left join departments d on d.id = f.department_id where f.id = $1', [id]);
const seen = async (a: Actor, id: string) => ((await listJobFiles(a, {})) as any).rows.some((r: any) => r.id === id);
const told = (u: Actor, id: string) => one('select 1 from notifications where user_id = $1 and job_file_id = $2', [u.id, id]);

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cm = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  cs = await mkUser(admin, 'Ravi CS', 'customer_service');
  seaMgr = await mkUser(admin, 'Imran Sea Import Mgr', 'operations_manager', 'sea_import');
  fred = await mkUser(admin, 'Fred Freight', 'freight_ops', 'sea_import');
  fiona = await mkUser(admin, 'Fiona Freight', 'freight_ops', 'sea_import');
  airMgr = await mkUser(admin, 'Asha Air Export Mgr', 'operations_manager', 'air_export');
  docMgr = await mkUser(admin, 'Dora Docs Mgr', 'documentation_manager');
  dina = await mkUser(admin, 'Dina Docs', 'documentation_executive');
  cust = (await createMaster(sam, 'customers', { name: 'Gamma Imports' })).id;
  await saveDefaultHandler(seaMgr, { department_id: await deptId('sea_import'), user_id: fred.id });
  await saveDefaultHandler(docMgr, { department_id: await deptId('documentations'), user_id: dina.id });
  await saveDefaultHandler(admin, { department_id: await deptId('customer_service'), user_id: cs.id });
});

test('Sea FCL import goes to Sea Import Ops and its default handler, who sees it and is told', async () => {
  const id = await handedOver('import', 'sea_fcl');
  const f = await row(id);
  assert.equal(f.dept, 'sea_import');
  assert.equal(f.ops_handler_id, fred.id);
  assert.ok(await told(fred, id));
  assert.equal(await seen(fred, id), true);
  const g: any = await getJobFile(seaMgr, id);
  assert.equal(g.ops_handler_name, 'Fred Freight');
  assert.equal(g.can.ops_pick, true);
});

test('Air export with no default handler waits; the Air Export manager is told and chooses', async () => {
  const id = await handedOver('export', 'air');
  const f = await row(id);
  assert.equal(f.dept, 'air_export');
  assert.equal(f.ops_handler_id, null);
  assert.ok(await told(airMgr, id));
  await assert.rejects(setHandler(airMgr, id, 'ops', { user_id: fred.id }), /Air Export|team/);
});

test('the team manager changes the Ops handler with a reason; another team cannot', async () => {
  const id = await handedOver('import', 'sea_fcl');
  await assert.rejects(setHandler(seaMgr, id, 'ops', { user_id: fiona.id }), /reason/);
  await setHandler(seaMgr, id, 'ops', { user_id: fiona.id, reason: 'Fred is busy' });
  assert.equal((await row(id)).ops_handler_id, fiona.id);
  await assert.rejects(setHandler(airMgr, id, 'ops', { user_id: fred.id, reason: 'x' }), (e: any) => ['FORBIDDEN', 'NOT_FOUND'].includes(e.code));
});

test('DO received → Documentation; cleared → back to Ops; each handoff once, by the right team', async () => {
  const id = await handedOver('import', 'sea_fcl');
  await assert.rejects(docsCleared(dina, id, {}), (e: any) => ['STAGE', 'NOT_FOUND'].includes(e.code));
  assert.equal(await seen(dina, id), false, 'Documentation does not see it before the DO');
  await doReceived(fred, id, { note: 'DO from MSC' });
  let f = await row(id);
  assert.ok(f.do_received_at);
  assert.equal(f.docs_handler_id, dina.id);
  assert.ok(await told(dina, id)); assert.ok(await told(cs, id));
  assert.equal(await seen(dina, id), true);
  await assert.rejects(doReceived(fred, id, {}), (e: any) => e.code === 'STAGE');
  await assert.rejects(docsCleared(fred, id, {}), (e: any) => e.code === 'FORBIDDEN');
  await docsCleared(dina, id, { note: 'BOE passed' });
  f = await row(id);
  assert.ok(f.docs_cleared_at);
  assert.ok(await one(`select 1 from notifications where user_id = $1 and job_file_id = $2 and title like '%cleared%'`, [fred.id, id]));
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title like 'Cleared%'`, [id]));
});

test('handover routes: the Super Admin changes them; managers only read', async () => {
  const l = await listRoutes(seaMgr);
  assert.equal(l.editable, false);
  assert.ok(l.rows.some((r: any) => r.direction === 'import' && r.mode === 'sea_fcl'));
  await assert.rejects(saveRoute(seaMgr, { direction: 'import', mode: 'road', department_id: await deptId('sea_import') }), (e: any) => e.code === 'FORBIDDEN');
  await saveRoute(admin, { direction: 'import', mode: 'road', department_id: await deptId('sea_import') });
  const id = await handedOver('import', 'road');
  assert.equal((await row(id)).dept, 'sea_import');
});
