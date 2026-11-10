/** Cargo lines (migration 023): package types, several sizes, CBM and chargeable weight worked out; dimensions required
 *  on new enquiries except full containers; the totals on the shipment follow the lines; old lines are kept, marked removed. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile, updateJobFile } from '../src/server/jobfiles';
import { cargoTotals, lineCbm, lineProblem } from '../src/lib/cargoRules';
import { incotermMissing, incotermNeeds } from '../src/lib/incotermRules';

let admin: Actor, sales: Actor, coord: Actor, cust: string;
const line = (o: any = {}) => ({ package_type: 'Cartons', pieces: 10, length: 50, width: 40, height: 30, dim_unit: 'cm', weight_kg: 200, ...o });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  coord = await mkUser(admin, 'Cora Coord', 'coordinator');
  sales = await mkUser(admin, 'Sam Sales', 'sales', undefined, { division: 'imports', coordinator_id: coord.id });
  cust = (await createMaster(sales, 'customers', { name: 'Cargo Test LLC' })).id;
});

test('the sums: CBM per unit, chargeable weight for air, W/M for LCL', () => {
  assert.equal(lineCbm(line()), 0.6);                                                   // 10 × 0.5 × 0.4 × 0.3
  assert.equal(lineCbm(line({ pieces: 2, length: 1.2, width: 1, height: 1.5, dim_unit: 'm' })), 3.6);
  assert.equal(lineCbm(line({ pieces: 1, length: 40, width: 40, height: 40, dim_unit: 'in' })), 1.049);
  const t = cargoTotals([line(), line({ package_type: 'Pallets', pieces: 2, length: 120, width: 100, height: 150, weight_kg: 800 })], 'air');
  assert.deepEqual([t.packages, t.weight, t.cbm, t.package_type], [12, 1000, 4.2, 'Mixed']);
  assert.equal(t.chargeable_kg, 1000);                                                  // 4.2 × 167 = 701.4 < 1000 kg
  assert.equal(cargoTotals([line({ weight_kg: 20 })], 'air').chargeable_kg, 100.2);     // 0.6 × 167
  assert.equal(cargoTotals([line({ weight_kg: 900 })], 'sea_lcl').wm, 0.9);              // 900 kg = 0.9 t > 0.6 CBM
  assert.match(lineProblem(line({ length: 0 }))!, /more than 0/);
  assert.match(lineProblem(line({ package_type: 'Other' }))!, /Type the package type/);
  assert.match(lineProblem(line({ pieces: 1.5 }))!, /whole number/);
});

test('a new LCL / air / road enquiry needs dimensions; a full container does not', async () => {
  await rejects(createJobFile(sales, { customer_id: cust, direction: 'import', mode: 'sea_lcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai' }), 'VALIDATION', /dimensions/);
  await rejects(createJobFile(sales, { customer_id: cust, direction: 'import', mode: 'air', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai', cargo_lines: [line({ height: '' })] }), 'VALIDATION', /Cargo line 1/);
  const fcl = await createJobFile(sales, { customer_id: cust, direction: 'import', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai' });
  assert.equal((await getJobFile(sales, fcl.id)).cargo_lines.length, 0);
});

test('lines are saved and the shipment totals come from them, also after an edit', async () => {
  const f = await createJobFile(sales, { customer_id: cust, direction: 'import', mode: 'air', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Seller warehouse', delivery_address: 'Customer warehouse, Dubai', packages: 999,
    cargo_lines: [line(), line({ package_type: 'Other', package_other: 'Crated machine', pieces: 1, length: 200, width: 150, height: 180, weight_kg: 1500 })] });
  let d = await getJobFile(sales, f.id);
  assert.equal(d.cargo_lines.length, 2);
  assert.deepEqual([d.packages, Number(d.gross_weight_kg), Number(d.volume_cbm), Number(d.chargeable_weight_kg), d.package_type], [11, 1700, 6, 1700, 'Mixed']);
  // typed totals are ignored while there are lines
  d = await updateJobFile(sales, f.id, { packages: 5, gross_weight_kg: 1 });
  assert.equal(d.packages, 11);
  // change the lines: totals follow, the change is in the history, the old lines are kept (removed)
  d = await updateJobFile(sales, f.id, { cargo_lines: [line({ pieces: 20 })] });
  assert.deepEqual([d.packages, Number(d.volume_cbm), d.package_type], [20, 1.2, 'Cartons']);
  assert.ok(d.events.some((e: any) => e.title === 'Cargo dimensions changed' && /20 Cartons/.test(e.new_value)));
  assert.equal((await q('select 1 from job_file_cargo_lines where job_file_id = $1 and removed_at is not null', [f.id])).length, 2);
  // switching to sea LCL drops the air chargeable weight rule but keeps the totals
  d = await updateJobFile(sales, f.id, { mode: 'sea_lcl' });
  assert.equal(Number(d.volume_cbm), 1.2);
  // an enquiry cannot lose all its lines
  await rejects(updateJobFile(sales, f.id, { cargo_lines: [] }), 'VALIDATION', /at least one/);
});

// ---------------------------------------------------------------- Incoterm details
const needs = (t: string, dir: string, tr = false) => [...incotermNeeds(t, dir, tr).need].sort();
test('the Incoterm decides which details are needed', () => {
  assert.deepEqual(needs('EXW', 'import'), ['delivery_address', 'pickup_address']);
  assert.deepEqual(needs('FCA', 'import'), ['named_place', 'port_of_discharge']);
  assert.deepEqual(needs('FOB', 'import'), ['port_of_discharge', 'port_of_loading']);
  assert.deepEqual(needs('FOB', 'import', true), ['delivery_address', 'port_of_discharge', 'port_of_loading']);
  assert.deepEqual(needs('CIF', 'import'), ['port_of_discharge']);
  assert.deepEqual(needs('DDP', 'import'), ['delivery_address']);
  assert.deepEqual(needs('EXW', 'export'), ['pickup_address']);
  assert.deepEqual(needs('FOB', 'export'), ['pickup_address', 'port_of_loading']);
  assert.deepEqual(needs('CIF', 'export'), ['cargo_value', 'port_of_discharge', 'port_of_loading']);
  assert.deepEqual(needs('DAP', 'cross_trade'), ['delivery_address', 'port_of_discharge', 'port_of_loading']);
  assert.deepEqual(incotermMissing({ incoterm: 'CIF', direction: 'export', port_of_loading: 'Jebel Ali', port_of_discharge: 'Mombasa', cargo_value: 5000 }), ['cargo_value']);
});

test('a new enquiry needs the Incoterm and what it asks for; edits are checked when the term changes', async () => {
  const base = { customer_id: cust, direction: 'import', mode: 'sea_fcl', status: 'enquiry' };
  await rejects(createJobFile(sales, { ...base }), 'VALIDATION', /Incoterm/);
  await assert.rejects(createJobFile(sales, { ...base, incoterm: 'EXW', pickup_address: 'Factory, Ningbo' }),
    (e: any) => { assert.equal(e.code, 'VALIDATION'); assert.match(e.message, /EXW needs: delivery address/); assert.ok(e.details.fields.delivery_address); return true; });
  const f = await createJobFile(sales, { ...base, incoterm: 'EXW', pickup_address: 'Factory, Ningbo', pickup_contact: 'Mr Li +86 138',
    delivery_address: 'Warehouse 4, Al Quoz, Dubai', delivery_contact: 'Ali +971 50' });
  let d = await getJobFile(sales, f.id);
  assert.deepEqual([d.pickup_address, d.delivery_contact], ['Factory, Ningbo', 'Ali +971 50']);
  // switching to CFR needs the port of discharge
  await rejects(updateJobFile(sales, f.id, { incoterm: 'CFR' }), 'VALIDATION', /port of discharge/);
  d = await updateJobFile(sales, f.id, { incoterm: 'CFR', port_of_discharge: 'Jebel Ali' });
  assert.equal(d.incoterm, 'CFR');
  // the delivery address cannot be emptied while transport is ticked
  await updateJobFile(sales, f.id, { needs_transport: true });
  await rejects(updateJobFile(sales, f.id, { delivery_address: '' }), 'VALIDATION', /delivery address/);
  // export CIF needs the cargo value and currency for insurance
  await rejects(createJobFile(sales, { ...base, direction: 'export', incoterm: 'CIF', port_of_loading: 'Jebel Ali', port_of_discharge: 'Mombasa', cargo_value: 1000 }), 'VALIDATION', /cargo value/);
  const x = await createJobFile(sales, { ...base, direction: 'export', incoterm: 'CIF', port_of_loading: 'Jebel Ali', port_of_discharge: 'Mombasa', cargo_value: 1000, cargo_value_currency: 'usd' });
  assert.equal((await getJobFile(sales, x.id)).cargo_value_currency, 'USD');
  // an older enquiry without a term can still be edited (the term is only forced on new ones)
  await q("update job_files set incoterm = null where id = $1", [x.id]);
  await updateJobFile(sales, x.id, { remarks: 'old one', port_of_loading: 'Khalifa' });
});

// ---------------------------------------------------------------- one question: the division (step 4)
test('an enquiry asks only the division; the direction follows it and cannot drift', async () => {
  const base = { customer_id: cust, mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW', pickup_address: 'Factory', delivery_address: 'Warehouse, Dubai' };
  // nothing chosen: the Salesman's own division (Imports) → import
  let f = await createJobFile(sales, { ...base });
  let d = await getJobFile(sales, f.id);
  assert.deepEqual([d.division, d.direction], ['imports', 'import']);
  assert.match(d.enquiry_ref, /IMP/);
  // the Salesman picks Exports for this one → export, Exports in the Ref
  f = await createJobFile(sales, { ...base, division: 'exports' });
  d = await getJobFile(sales, f.id);
  assert.deepEqual([d.division, d.direction], ['exports', 'export']);
  // a direction that contradicts the division is refused
  await rejects(createJobFile(sales, { ...base, division: 'exports', direction: 'import' }), 'VALIDATION', /Exports division handles export/);
  // and it cannot drift later
  await rejects(updateJobFile(sales, f.id, { direction: 'import' }), 'VALIDATION', /direction stays Export/);
});
