/** Commercial reports (migration 024): Salesman / Coordinator performance, Enquiry tracking, Shipments by type;
 *  Courier and Others modes. Scope and money columns follow the same rules as the screens. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import { runReport, reportList } from '../src/server/reports';
import { shipmentType } from '../src/server/commercialReports';

let admin: Actor, coord: Actor, sam: Actor, sara: Actor, cust: string, custB: string;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const P = { from: today.slice(0, 8) + '01', to: today.slice(0, 8) + '28' > today ? today.slice(0, 8) + '28' : today };
const period = { from: today.slice(0, 4) + '-01-01', to: today.slice(0, 4) + '-12-31' };
const base = { mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Factory', delivery_address: 'Warehouse, Dubai' };
void P;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  coord = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { division: 'imports', coordinator_id: coord.id });
  sara = await mkUser(admin, 'Sara Sales', 'sales', undefined, { division: 'exports', coordinator_id: coord.id });
  cust = (await createMaster(sam, 'customers', { name: 'Report Test LLC' })).id;
  custB = (await createMaster(sara, 'customers', { name: 'Export Buyer LLC' })).id;
  const mk = async (who: Actor, extra: any, stage: string) => {
    const f = await createJobFile(who, { ...base, customer_id: who === sara ? custB : cust, ...extra });
    await q('update job_files set stage = $2 where id = $1', [f.id, stage]);
    return f.id;
  };
  // Sam: 4 enquiries — one won (quoted in USD 1000, cost 800), one lost, one waiting for the customer, one new
  const won = await mk(sam, {}, 'customer_confirmed');
  const qt = await one(`insert into quotations (quote_no, customer_id, created_by, currency, status, sent_at, accepted_at, job_file_id, salesman_id, service_type, direction, valid_until)
    values ('Q-T1', $1, $2, 'USD', 'accepted', now() - interval '1 day', now(), $3, $2, 'sea_fcl', 'import', current_date + 30) returning id`, [cust, sam.id, won]);
  await q(`insert into quotation_lines (quotation_id, sort_order, description, charge_unit, quantity, cost_rate, sell_rate) values ($1, 1, 'Freight', 'shipment', 1, 800, 1000)`, [qt.id]);
  const lost = await mk(sam, {}, 'lost');
  await q("update job_files set cancel_reason = 'Price too high' where id = $1", [lost]);
  await q("insert into job_file_containers (job_file_id, container_no, size_type) values ($1, 'MSCU1234566', '40HC')", [won]);
  await q('update job_files set volume_cbm = 60, gross_weight_kg = 12000 where id = $1', [won]);
  await mk(sam, { mode: 'air', cargo_lines: [{ package_type: 'Cartons', pieces: 2, length: 50, width: 50, height: 50, dim_unit: 'cm', weight_kg: 40 }] }, 'sent_to_customer');
  await mk(sam, { mode: 'courier', incoterm: null, pickup_address: null, delivery_address: null,
    cargo_lines: [{ package_type: 'Cartons', pieces: 1, length: 40, width: 30, height: 20, dim_unit: 'cm', weight_kg: 5 }] }, 'enquiry');
  // Sara: 1 export enquiry, Others mode
  await mk(sara, { mode: 'other', incoterm: null, pickup_address: null, delivery_address: null }, 'enquiry');
});

test('Courier and Others: no Incoterm or ports needed, courier volumetric weight, the shipment types', async () => {
  const rows = await q("select mode, incoterm, chargeable_weight_kg from job_files where mode in ('courier', 'other') order by mode");
  assert.deepEqual(rows.map((r: any) => [r.mode, r.incoterm]), [['courier', null], ['other', null]]);
  assert.equal(Number(rows[0].chargeable_weight_kg), 5);                  // 0.024 CBM × 200 = 4.8 kg < 5 kg
  assert.deepEqual([shipmentType('export', 'sea_fcl'), shipmentType('import', 'sea_lcl'), shipmentType('cross_trade', 'air'), shipmentType('import', 'road'),
    shipmentType('export', 'courier'), shipmentType('import', 'other')], ['FCL Export', 'LCL Import', 'Cross Trade', 'Road Freight', 'Courier', 'Others']);
});

test('Salesman performance: counts, rates, won sales and profit in the company currency', async () => {
  const r = await runReport(admin, 'salesman_performance', period);
  const sam_ = r.rows.find((x: any) => x.name === 'Sam Sales')!;
  assert.deepEqual([sam_.enquiries, sam_.quoted, sam_.confirmed, sam_.not_confirmed, sam_.waiting_customer, sam_.win_pct], [4, 2, 1, 1, 1, 50]);
  assert.equal(sam_.won_sales, 3672.5);                                   // USD 1000 × 3.6725
  assert.equal(sam_.won_profit, 734.5);
  assert.equal(sam_.margin_pct, 20);
  assert.deepEqual([sam_.confirmed_pct, sam_.not_confirmed, sam_.lost_reasons], [25, 1, 'Price too high ×1']);
  assert.deepEqual([sam_.won_cbm, sam_.won_tonnes, sam_.won_teu], [60, 12, 2]);
  assert.equal(r.totals!.enquiries, 5);
  // a Salesman sees only their own line
  const own = await runReport(sam, 'salesman_performance', period);
  assert.deepEqual(own.rows.map((x: any) => x.name), ['Sam Sales']);
});

test('Coordinator performance, Enquiry tracking and Shipments by type', async () => {
  const c = await runReport(admin, 'coordinator_performance', period);
  assert.equal(c.rows.find((x: any) => x.name === 'Cora Coord')!.enquiries, 5);
  const t = await runReport(admin, 'enquiry_tracking', period);
  assert.equal(t.total, 5);
  const wonRow = t.rows.find((x: any) => x.quote_no === 'Q-T1')!;
  assert.deepEqual([wonRow.result, wonRow.salesman_name, wonRow.coordinator_name, wonRow.type], ['Won', 'Sam Sales', 'Cora Coord', 'FCL Import']);
  const filtered = await runReport(admin, 'enquiry_tracking', { ...period, salesman_id: sara.id });
  assert.equal(filtered.total, 1);
  const s = await runReport(admin, 'shipment_types', period);
  const n = (label: string) => s.rows.find((x: any) => x.type === label)!.enquiries;
  assert.deepEqual([n('FCL Import'), n('Air Import'), n('Courier'), n('Others'), n('LCL Export')], [2, 1, 1, 1, 0]);
  assert.equal(s.rows.length, 10);
  assert.equal(s.totals!.enquiries, 5);
});

test('who sees what: money columns need selling / profit rights; Transport does not get these reports', async () => {
  const cols = (await runReport(coord, 'salesman_performance', period)).columns.map((c: any) => c.key);
  if (!coord.fin.sellingView) assert.ok(!cols.includes('won_sales'));
  if (!coord.fin.profitView) assert.ok(!cols.includes('won_profit'));
  const transport = await mkUser(admin, 'Trans', 'transport_manager');
  const keys = (await reportList(transport)).map((r: any) => r.key);
  assert.ok(!keys.includes('salesman_performance') && !keys.includes('enquiry_tracking'));
  await assert.rejects(runReport(transport, 'salesman_performance', period), (e: any) => e.code === 'FORBIDDEN');
  const list = await reportList(admin);
  assert.equal(list.find((r: any) => r.key === 'salesman_performance')!.category, 'Commercial');
  void getJobFile;
});
