/** Feedback 17 Nov: team managers own enquiries and choose the Coordinator; job type can be both; notifications and chat
 *  go only to the people handling that job. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile, listJobFiles } from '../src/server/jobfiles';

let admin: Actor, cm: Actor, opsMgr: Actor, sam: Actor, cora: Actor, cust: string;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cm = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  opsMgr = await mkUser(admin, 'Imran Sea Import Mgr', 'operations_manager', 'sea_import');
  cust = (await createMaster(admin, 'customers', { name: 'Iota Foods' })).id;
});

test('a team manager owns an enquiry themselves and chooses its Coordinator — or handles it alone', async () => {
  const f = await createJobFile(opsMgr, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali',
    salesman_id: opsMgr.id, coordinator_id: cora.id });
  const g: any = await getJobFile(opsMgr, f.id);
  assert.equal(g.salesman_id, opsMgr.id);
  assert.equal(g.coordinator_id, cora.id);
  assert.ok(((await listJobFiles(cora, {})) as any).rows.some((r: any) => r.id === f.id), 'the Coordinator sees it');
  const alone = await createJobFile(opsMgr, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali', salesman_id: opsMgr.id });
  assert.equal((await getJobFile(opsMgr, alone.id) as any).coordinator_id, null);
  // a manager cannot make another manager or a non-Salesman the owner
  await assert.rejects(createJobFile(opsMgr, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali', salesman_id: cm.id }),
    /owner must be an active Salesman/);
  // a Salesman still cannot pick someone else's Coordinator
  const own = (await createMaster(sam, 'customers', { name: 'Kappa Steel' })).id;
  const s = await createJobFile(sam, { customer_id: own, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali', coordinator_id: opsMgr.id });
  assert.equal((await getJobFile(sam, s.id) as any).coordinator_id, cora.id);
});

test('notifications go only to the people handling the job, not the whole team', async () => {
  const own = (await createMaster(sam, 'customers', { name: 'Lambda Trading' })).id;
  const f = await createJobFile(sam, { customer_id: own, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali' });
  const { handlingGroup } = await import('../src/server/notify');
  const { pool } = await import('../src/server/db');
  const g = await handlingGroup(pool(), f.id);
  assert.deepEqual(g.sort(), [sam.id, cora.id].sort());
  assert.ok(!(await one('select 1 from notifications where user_id = $1 and job_file_id = $2', [cm.id, f.id])), 'the Commercials Manager is not told');
});
