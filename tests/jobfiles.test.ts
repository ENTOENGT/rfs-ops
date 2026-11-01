/** Migration 013 — Job Files: one per shipment, linked work, milestones, closure rules, visibility, register report. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, reqFields } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJob } from '../src/server/jobs';
import { createPro } from '../src/server/pro';
import { createRun } from '../src/server/runs';
import * as jf from '../src/server/jobfiles';
import { runReport } from '../src/server/reports';

let admin: Actor, seaMgr: Actor, freight: Actor, airMgr: Actor, transport: Actor, cs: Actor, wh: Actor, customer: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
const base = (extra: any = {}) => ({ job_no: 'SI-9001', customer_id: customer, direction: 'import', mode: 'sea_fcl',
  needs_clearance: true, needs_transport: true, port_of_loading: 'Shanghai', port_of_discharge: 'Jebel Ali', etd: D(-10), eta: D(5),
  mbl_mawb: 'MSCU-MBL-1', containers: [{ container_no: 'MSCU1234566', size_type: '40HC', seal_no: 'S123' }], ...extra });

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  seaMgr = await mkUser(admin, 'SeaMgr', 'operations_manager', 'sea_import');
  freight = await mkUser(admin, 'Freighty', 'freight_ops', 'sea_import');
  airMgr = await mkUser(admin, 'AirMgr', 'operations_manager', 'air_export');
  transport = await mkUser(admin, 'Trans', 'transport_manager');
  cs = await mkUser(admin, 'Cust Service', 'customer_service');
  wh = await mkUser(admin, 'Store', 'warehouse_operator');
  customer = (await createMaster(seaMgr, 'customers', { name: 'Gulf Importers' })).id;
});

let fileId: string, tripId: string;
test('A trip made before the Job File is linked when the Job File is created; Job No. kept as typed', async () => {
  const trip = await createJob(seaMgr, { ...reqFields(), job_no: 'si-9001', customer_id: customer, required_date: D(6), pickup_name: 'Jebel Ali', delivery_name: 'DIP' });
  tripId = trip.id;
  await rejects(jf.createJobFile(freight, { customer_id: customer }), 'VALIDATION', /Job No/);
  await rejects(jf.createJobFile(freight, base({ direction: '' })), 'VALIDATION');
  await rejects(jf.createJobFile(freight, base({ containers: [{ container_no: 'BAD1' }] })), 'VALIDATION', /4 letters and 7 digits/);
  await rejects(jf.createJobFile(freight, base({ etd: D(5), eta: D(1) })), 'VALIDATION', /ETA is before ETD/);
  const f = await jf.createJobFile(freight, base());
  fileId = f.id;
  assert.equal(f.job_no, 'SI-9001');
  const got = await jf.getJobFile(freight, fileId);
  assert.equal(got.trips.length, 1, 'trip with the same Job No. (any case) is linked');
  assert.equal(got.trips[0].id, tripId);
  assert.equal(got.containers[0].container_no, 'MSCU1234566');
  assert.deepEqual(got.milestones.map((m: any) => m.code), ['pre_alert', 'departed', 'arrived', 'delivery_order', 'customs_cleared', 'delivered']);
  assert.ok(got.events.some((e: any) => e.kind === 'created' && /Linked 1 truck trip/.test(e.new_value)));
  assert.equal((await one('select department_id from job_files where id = $1', [fileId])).department_id, freight.department_id);
});

test('One Job File per Job No. across the company', async () => {
  await rejects(jf.createJobFile(airMgr, base({ job_no: ' SI-9001 ' })), 'JOB_FILE_EXISTS');
  // different plan for an air export without clearance
  const air = await jf.createJobFile(airMgr, base({ job_no: 'AE-1', direction: 'export', mode: 'air', needs_clearance: false, containers: [] }));
  const g = await jf.getJobFile(airMgr, air.id);
  assert.deepEqual(g.milestones.map((m: any) => m.name), ['Booking confirmed', 'Cargo collected', 'Flight departed', 'AWB released', 'Arrived at destination']);
});

test('PRO requests and messenger runs made afterwards link themselves', async () => {
  const p = await createPro(seaMgr, { job_no: 'SI-9001', customer_id: customer, bl_number: 'MSCU-MBL-1', direction: 'import', load_type: 'LCL', uae_location: 'Jebel Ali T2',
    required_date: D(4), confirm_duplicate_job_no: true });
  const r = await createRun(seaMgr, { required_date: D(3), task_type: 'deliver', from_name: 'Office', to_name: 'MSC office', documents: 'Original BL', job_id: tripId });
  const g = await jf.getJobFile(seaMgr, fileId);
  assert.deepEqual(g.pro.map((x: any) => x.id), [p.id]);
  assert.deepEqual(g.runs.map((x: any) => x.id), [r.id]);
});

test('Who sees Job Files: own department, view-all roles, never another department', async () => {
  assert.equal((await jf.listJobFiles(seaMgr, {})).rows.some((r: any) => r.id === fileId), true);
  assert.equal((await jf.listJobFiles(airMgr, {})).rows.some((r: any) => r.id === fileId), false);
  await rejects(jf.getJobFile(airMgr, fileId), 'NOT_FOUND');
  for (const a of [transport, cs, wh]) assert.equal((await jf.getJobFile(a, fileId)).job_no, 'SI-9001');
  // view-only roles can't change it
  await rejects(jf.updateJobFile(cs, fileId, { carrier: 'X' }), 'FORBIDDEN');
  await rejects(jf.updateJobFile(transport, fileId, { carrier: 'X' }), 'FORBIDDEN');
  const driverish = await mkUser(admin, 'NoFiles', 'messenger', 'messengers');
  await rejects(jf.listJobFiles(driverish, {}), 'FORBIDDEN');
});

test('Edits, containers and milestones are recorded; arrival fills the actual arrival date', async () => {
  let g = await jf.updateJobFile(freight, fileId, { carrier: 'MSC', vessel_flight: 'MSC Aurora', gross_weight_kg: '12000' });
  assert.equal(g.carrier, 'MSC');
  assert.ok(g.events.some((e: any) => e.title === 'Shipping line / airline / transporter changed' && e.new_value === 'MSC'));
  // unchanged numbers written differently are not a change
  const before = g.events.length;
  g = await jf.updateJobFile(freight, fileId, { gross_weight_kg: '12000.00' });
  assert.equal(g.events.length, before);
  g = await jf.saveJobFileContainer(freight, fileId, { container_no: 'msku 123456 7', size_type: '20GP' });
  assert.ok(g.containers.some((k: any) => k.container_no === 'MSKU1234567'));
  await rejects(jf.saveJobFileContainer(freight, fileId, { container_no: 'MSKU1234567' }), 'VALIDATION', /already/);
  const arrived = g.milestones.find((m: any) => m.code === 'arrived');
  await rejects(jf.saveMilestone(freight, fileId, { milestone_id: arrived.id, done: true, actual_at: new Date(Date.now() + 86400000).toISOString() }), 'VALIDATION', /future/);
  g = await jf.saveMilestone(freight, fileId, { milestone_id: arrived.id, done: true, remarks: 'Berthed T2' });
  assert.equal(g.ata, D(0));
  assert.ok(g.milestones.find((m: any) => m.code === 'arrived').actual_at);
  assert.ok(g.events.some((e: any) => e.title === 'Milestone "Vessel arrived" done'));
  const search = await jf.listJobFiles(freight, { q: 'msku1234' });
  assert.equal(search.total, 1, 'container numbers are searchable');
});

test('Closing: refused while linked work is open; allowed once trips, PRO and runs are finished', async () => {
  await rejects(jf.setJobFileStatus(freight, fileId, { status: 'closed' }), 'JOB_FILE_NOT_READY', /Truck trip TR-\d+ is still/);
  const g = await jf.getJobFile(freight, fileId);
  assert.equal(g.closure.can_close, false);
  assert.ok(g.closure.blockers.some((b: string) => /PRO request PRO-\d+ is still/.test(b)));
  assert.ok(g.closure.blockers.some((b: string) => /Messenger run MR-\d+ is not finished/.test(b)));
  // A sea-import manager without close permission can't close at all
  const sub = await mkUser(admin, 'OpsSub', 'operations', 'sea_import');
  await rejects(jf.setJobFileStatus(sub, fileId, { status: 'closed' }), 'FORBIDDEN');
  // finish everything: a FAILED run still blocks, a delivered one doesn't
  await q(`update messenger_runs set status = 'failed' where job_file_id = $1`, [fileId]);
  await q(`update transport_requests set status_code = 'completed' where job_file_id = $1`, [fileId]);
  await q(`update pro_requests set status_code = 'completed' where job_file_id = $1`, [fileId]);
  await rejects(jf.setJobFileStatus(freight, fileId, { status: 'closed' }), 'JOB_FILE_NOT_READY', /Messenger run/);
  await q(`update messenger_runs set status = 'delivered' where job_file_id = $1`, [fileId]);
  const closed = await jf.setJobFileStatus(freight, fileId, { status: 'closed' });
  assert.equal(closed.status, 'closed'); assert.ok(closed.closed_at);
  // a closed file is locked, but keeps its history and linked records
  await rejects(jf.updateJobFile(freight, fileId, { carrier: 'CMA' }), 'FORBIDDEN', /closed/);
  assert.equal(closed.trips.length, 1);
  // reopen needs the close permission
  const re = await jf.setJobFileStatus(freight, fileId, { status: 'delivering', reason: 'Customer claim' });
  assert.equal(re.status, 'delivering'); assert.equal(re.closed_at, null);
});

test('A service the file needs must have finished work behind it', async () => {
  const f = await jf.createJobFile(freight, base({ job_no: 'SI-NEEDS', containers: [] }));
  const e: any = await jf.setJobFileStatus(freight, f.id, { status: 'closed' }).catch((x) => x);
  assert.equal(e.code, 'JOB_FILE_NOT_READY');
  assert.deepEqual(e.details.blockers, ['Transport is needed, but no truck trip is completed', 'Customs clearance is needed, but no PRO request is completed']);
});

test('Cancelling: needs a reason and no open work; frees the Job No. and lets linked records go', async () => {
  const f = await jf.createJobFile(freight, base({ job_no: 'SI-CXL', containers: [] }));
  const t = await createJob(freight, { ...reqFields(), job_no: 'SI-CXL', customer_id: customer, required_date: D(6), pickup_name: 'A', delivery_name: 'B' });
  await rejects(jf.setJobFileStatus(freight, f.id, { status: 'cancelled' }), 'VALIDATION', /reason/);
  await rejects(jf.setJobFileStatus(freight, f.id, { status: 'cancelled', reason: 'Order cancelled' }), 'JOB_FILE_HAS_OPEN_WORK', /TR-/);
  await q(`update transport_requests set status_code = 'cancelled' where id = $1`, [t.id]);
  const c = await jf.setJobFileStatus(freight, f.id, { status: 'cancelled', reason: 'Order cancelled' });
  assert.equal(c.status, 'cancelled');
  assert.equal((await one('select job_file_id from transport_requests where id = $1', [t.id])).job_file_id, null);
  await rejects(jf.setJobFileStatus(freight, f.id, { status: 'open' }), 'JOB_FILE_CANCELLED');
  const again = await jf.createJobFile(freight, base({ job_no: 'SI-CXL', containers: [] }));
  assert.notEqual(again.id, f.id);
  assert.equal((await one('select job_file_id from transport_requests where id = $1', [t.id])).job_file_id, again.id);
});

test('Dashboard tiles and the Job File register report use the same rules', async () => {
  const tiles = await jf.jobFileTiles(seaMgr, {});
  assert.equal(tiles.find((t) => t.key === 'needs_clearance')!.count, 2, 'SI-NEEDS and the new SI-CXL have no PRO request yet');
  const P = { from: D(-1), to: D(1) };
  const r = await runReport(seaMgr, 'jobfiles', P);
  assert.ok(r.rows.some((x: any) => x.job_no === 'SI-9001' && x.services === 'Clearance, Transport' && x.route === 'Shanghai → Jebel Ali'));
  assert.ok(!r.rows.some((x: any) => x.job_no === 'AE-1'), 'other department hidden');
  assert.ok((await runReport(transport, 'jobfiles', P)).rows.some((x: any) => x.job_no === 'AE-1'), 'view-all sees every department');
  assert.ok(!JSON.stringify(r).match(/sell|price|revenue|margin/i), 'no prices in the register');
});
