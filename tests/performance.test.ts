/** Release K step 9: My performance — own numbers for a period with the team's own measures; managers see their team; Excel download. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { one, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import { setStage, createOperationalJob, markLost } from '../src/server/commercial';
import { saveDefaultHandler, doReceived, docsCleared } from '../src/server/handlers';
import { performance, performanceXlsx } from '../src/server/performance';

let admin: Actor, cm: Actor, sam: Actor, sara: Actor, cora: Actor, cs: Actor, fred: Actor, seaMgr: Actor, dina: Actor, cust: string;
const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const P = { from: day.slice(0, 8) + '01', to: day };
const card = (r: any, k: string) => r.cards.find((c: any) => c.key === k)?.value;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cm = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id, manager_id: cm.id });
  sara = await mkUser(admin, 'Sara Sales', 'sales', undefined, { coordinator_id: cora.id, manager_id: cm.id });
  cs = await mkUser(admin, 'Ravi CS', 'customer_service');
  seaMgr = await mkUser(admin, 'Imran Sea Mgr', 'operations_manager', 'sea_import');
  fred = await mkUser(admin, 'Fred Freight', 'freight_ops', 'sea_import', { manager_id: seaMgr.id });
  dina = await mkUser(admin, 'Dina Docs', 'documentation_executive');
  cust = (await createMaster(sam, 'customers', { name: 'Epsilon LLC' })).id;
  await saveDefaultHandler(admin, { department_id: await deptId('customer_service'), user_id: cs.id });
  await saveDefaultHandler(admin, { department_id: await deptId('sea_import'), user_id: fred.id });
  await saveDefaultHandler(admin, { department_id: await deptId('documentations'), user_id: dina.id });
  const mk = async () => (await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali' })).id;
  const a = await mk(), b = await mk(), c = await mk();
  await tx((x) => setStage(x, sam, a, 'customer_confirmed'));
  await markLost(sam, b, { reason: 'Price too high' });
  void c;
  await createOperationalJob(cm, a, { job_no: 'PERF-1', skip_prealert_reason: 'test' });
  await doReceived(fred, a, {});
  await docsCleared(dina, a, {});
});

test('a Salesman sees their own commercial numbers', async () => {
  const r: any = await performance(sam, P);
  assert.equal(r.person.kind, 'commercial');
  assert.equal(card(r, 'enquiries'), 3);
  assert.equal(card(r, 'confirmed'), 1);
  assert.equal(card(r, 'lost'), 1);
  assert.match(String(card(r, 'reasons')), /Price too high/);
  assert.equal(r.series.reduce((s: number, x: any) => s + x.enquiries, 0), 3);
  assert.equal(r.rows.length, 3);
});

test('a colleague cannot open someone else\'s; the manager can', async () => {
  await assert.rejects(performance(sara, { ...P, user_id: sam.id }), (e: any) => e.code === 'FORBIDDEN');
  const r: any = await performance(cm, { ...P, user_id: sam.id });
  assert.equal(r.person.name, 'Sam Sales');
  assert.ok(r.people.some((x: any) => x.id === sam.id), 'Sam is in the manager\'s list');
  assert.equal(r.cards.some((c: any) => c.key === 'profit'), cm.fin.profitView);
});

test('Customer Service, Operations and Documentation each get their own measures', async () => {
  const c: any = await performance(cs, P);
  assert.equal(c.person.kind, 'cs');
  assert.equal(card(c, 'given'), 1); assert.equal(card(c, 'handed'), 1);
  const o: any = await performance(fred, P);
  assert.equal(o.person.kind, 'ops');
  assert.equal(card(o, 'given'), 1); assert.equal(card(o, 'do'), 1);
  const d: any = await performance(dina, P);
  assert.equal(d.person.kind, 'docs');
  assert.equal(card(d, 'cleared'), 1);
  const m: any = await performance(seaMgr, { ...P, user_id: fred.id });
  assert.equal(m.person.name, 'Fred Freight');
});

test('Excel download with Summary, period and Jobs sheets', async () => {
  const f = await performanceXlsx(sam, P);
  assert.ok(f.body.length > 1000);
  assert.match(f.name, /^performance-sam-sales-/);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(f.body as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'By week', 'Jobs']);
});
