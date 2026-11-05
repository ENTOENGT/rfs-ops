/** Part F (migration 019) — LCL consolidation: one container, one MBL, many house shipments with their own HBL and owner. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import * as lcl from '../src/server/lcl';

let admin: Actor, coord: Actor, wh: Actor, sales: Actor, transport: Actor;
let cust: string, cust2: string, agentA: string, agentB: string, whId: string, locId: string, f1: string, f2: string, enq: string, con: string;
let own1: string, own2: string, partner: string, other: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
const act = (a: Actor, b: any) => lcl.consolidationAction(a, con, b);

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  coord = await mkUser(admin, 'Cora Coord', 'coordinator');
  wh = await mkUser(admin, 'Walt Warehouse', 'warehouse_operator');
  sales = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: coord.id });
  transport = await mkUser(admin, 'Tara Trans', 'transport_manager');
  cust = (await createMaster(admin, 'customers', { name: 'Desert Retail' })).id;
  cust2 = (await createMaster(admin, 'customers', { name: 'Gulf Foods' })).id;
  agentA = (await createMaster(admin, 'vendors', { name: 'Shanghai Partner', vendor_type: 'overseas_agent' })).id;
  agentB = (await createMaster(admin, 'vendors', { name: 'Mumbai Partner', vendor_type: 'overseas_agent' })).id;
  whId = (await one(`insert into warehouses (code, name) values ('JA1','Jebel Ali WH') returning id`)).id;
  locId = (await one(`insert into warehouse_locations (warehouse_id, code, location_type) values ($1,'RCV-01','receiving') returning id`, [whId])).id;
  // two confirmed LCL shipments (handed over) and one still at enquiry
  f1 = (await createJobFile(admin, { job_no: 'EXP-L1', customer_id: cust, direction: 'export', mode: 'sea_lcl', shipper: 'Desert Retail', consignee: 'Buyer A',
    cargo_description: 'Dates, 40 cartons', packages: 40, gross_weight_kg: '800', volume_cbm: '4.5', hbl_hawb: 'RFS-HBL-001', salesman_id: sales.id })).id;
  f2 = (await createJobFile(admin, { job_no: 'EXP-L2', customer_id: cust2, direction: 'export', mode: 'sea_lcl', cargo_description: 'Spices', packages: 10, gross_weight_kg: '300', volume_cbm: '1.2' })).id;
  enq = (await createJobFile(sales, { customer_id: cust, direction: 'export', mode: 'sea_lcl', status: 'enquiry' })).id;
});

test('1. Create a consolidation: one container, booking and MBL; only LCL managers', async () => {
  await rejects(lcl.createConsolidation(wh, { pol: 'Jebel Ali', pod: 'Hamburg' }), 'FORBIDDEN');
  await rejects(lcl.listConsolidations(sales, {}), 'FORBIDDEN');
  const c = await lcl.createConsolidation(coord, { division: 'exports', direction: 'export', pol: 'Jebel Ali', pod: 'Hamburg', carrier: 'MSC', carrier_booking_id: 'MSCBK1',
    container_type: '20GP', mbl_no: 'MEDUJA0001', etd: D(10), eta: D(30), cutoff_date: D(6), receiving_deadline: D(5), stuffing_date: D(7), warehouse_id: whId });
  con = c.id;
  assert.match(c.con_ref, /^CON-\d{2}-\d{5}$/);
  const d = await lcl.getConsolidation(coord, con);
  assert.deepEqual([d.status, d.status_name, d.capacity_cbm, d.total_hbls], ['open', 'Receiving cargo', '33.20', 0]);
  // the same MBL can't be on two consolidations
  await rejects(lcl.createConsolidation(coord, { pol: 'Jebel Ali', pod: 'Antwerp', mbl_no: 'meduja0001' }), 'DUPLICATE', /Master BL/);
});

test('2. House shipments: own customers from their shipment record, partner agents and others by hand; HBL unique per issuer', async () => {
  await rejects(act(coord, { action: 'add_shipment', job_file_id: enq }), 'VALIDATION', /not confirmed/);
  await act(coord, { action: 'add_shipment', job_file_id: f1 });
  await act(coord, { action: 'add_shipment', job_file_id: f2, hbl_no: 'RFS-HBL-002' });
  const d = await lcl.getConsolidation(coord, con);
  const s1 = d.shipments.find((s: any) => s.job_file_id === f1);
  own1 = s1.id; own2 = d.shipments.find((s: any) => s.job_file_id === f2).id;
  assert.deepEqual([s1.hbl_no, s1.shipper, s1.consignee, s1.packages, s1.gross_weight_kg, s1.volume_cbm, s1.salesman_name, s1.job_no],
    ['RFS-HBL-001', 'Desert Retail', 'Buyer A', 40, '800.00', '4.500', 'Sam Sales', 'EXP-L1'], 'taken from the shipment record');
  assert.ok((await getJobFile(admin, f1)).events.some((e: any) => e.title === `Added to LCL consolidation ${d.con_ref}`));
  // a shipment record sits in one live consolidation only
  const other2 = await lcl.createConsolidation(coord, { pol: 'Jebel Ali', pod: 'Rotterdam' });
  await rejects(lcl.consolidationAction(coord, other2.id, { action: 'add_shipment', job_file_id: f1 }), 'DUPLICATE', /already in a live consolidation/);
  // partner agent: needs the agent; shipper / consignee stay on the house shipment, no customer record is made
  const customers = Number((await one('select count(*) n from customers')).n);
  await rejects(act(coord, { action: 'add_shipment', owner_type: 'partner_agent', shipper: 'X', consignee: 'Y', cargo_description: 'Textiles', packages: 5, gross_weight_kg: '100', volume_cbm: '1' }), 'VALIDATION', /partner agent/);
  await act(coord, { action: 'add_shipment', owner_type: 'partner_agent', partner_vendor_id: agentA, hbl_no: 'SHA-100', shipper: 'Ningbo Textiles', consignee: 'Hamburg GmbH',
    cargo_description: 'Textiles', packages: 20, gross_weight_kg: '500', volume_cbm: '3', special_handling: 'Keep dry', expected_arrival: D(3) });
  assert.equal(Number((await one('select count(*) n from customers')).n), customers);
  // HBL: same number for the same issuer is refused; another partner may use it
  await rejects(act(coord, { action: 'add_shipment', owner_type: 'partner_agent', partner_vendor_id: agentA, hbl_no: 'sha-100', shipper: 'A', consignee: 'B', cargo_description: 'x', packages: 1, gross_weight_kg: '1', volume_cbm: '0.1' }), 'DUPLICATE', /HBL/);
  await act(coord, { action: 'add_shipment', owner_type: 'partner_agent', partner_vendor_id: agentB, hbl_no: 'SHA-100', shipper: 'Mumbai Exports', consignee: 'Hamburg Imports', cargo_description: 'Rice', packages: 8, gross_weight_kg: '400', volume_cbm: '1.5' });
  await act(coord, { action: 'add_shipment', owner_type: 'other', shipper: 'Walk-in Trader', consignee: 'Berlin Shop', cargo_description: 'Handicrafts', packages: 4, gross_weight_kg: '60', volume_cbm: '0.8' });
  const d2 = await lcl.getConsolidation(coord, con);
  partner = d2.shipments.find((s: any) => s.partner_vendor_id === agentA).id;
  other = d2.shipments.find((s: any) => s.owner_type === 'other').id;
  const mumbai = d2.shipments.find((s: any) => s.partner_vendor_id === agentB).id;
  await act(coord, { action: 'remove_shipment', shipment_id: mumbai, reason: 'Moved to next week' });
  const d3 = await lcl.getConsolidation(coord, con);
  assert.deepEqual([d3.total_hbls, d3.totals.packages, d3.totals.cbm, d3.utilisation_pct, d3.removed.length], [4, 74, '9.500', 28.6, 1]);
});

test('3. Receiving: partial stays partial, declared figures kept, differences recorded; only verified cargo can be stuffed', async () => {
  await rejects(act(coord, { action: 'receive', shipment_id: own1, packages: 10 }), 'FORBIDDEN');   // Coordinators don't receive
  await act(wh, { action: 'receive', shipment_id: own1, packages: 25, weight_kg: '500', volume_cbm: '2.8', location_id: locId, inward_ref: 'IN-1' });
  let s = (await lcl.getConsolidation(wh, con)).shipments.find((x: any) => x.id === own1);
  assert.deepEqual([s.receiving_status, s.received_packages, s.packages], ['partial', 25, 40]);
  await rejects(act(wh, { action: 'verify_cargo', shipment_id: own1 }), 'VALIDATION', /All packages/);
  await act(wh, { action: 'receive', shipment_id: own1, packages: 15, weight_kg: '300', volume_cbm: '1.7', location_id: locId });
  s = (await lcl.getConsolidation(wh, con)).shipments.find((x: any) => x.id === own1);
  assert.equal(s.receiving_status, 'received');
  await act(wh, { action: 'verify_cargo', shipment_id: own1 });
  // damage: needs a note, makes a discrepancy, verification needs to say how it was settled
  await rejects(act(wh, { action: 'receive', shipment_id: partner, packages: 20, weight_kg: '500', volume_cbm: '3', condition: 'damaged' }), 'VALIDATION', /Describe/);
  await act(wh, { action: 'receive', shipment_id: partner, packages: 20, weight_kg: '500', volume_cbm: '3', condition: 'damaged', damage_note: '2 cartons torn' });
  s = (await lcl.getConsolidation(wh, con)).shipments.find((x: any) => x.id === partner);
  assert.equal(s.receiving_status, 'discrepancy');
  await rejects(act(wh, { action: 'verify_cargo', shipment_id: partner }), 'VALIDATION', /differences/);
  await act(wh, { action: 'verify_cargo', shipment_id: partner, note: 'Agent agreed, re-taped' });
  await act(wh, { action: 'receive', shipment_id: other, packages: 4, weight_kg: '60', volume_cbm: '0.8' });
  await act(wh, { action: 'verify_cargo', shipment_id: other });
  await rejects(act(coord, { action: 'ready' }), 'VALIDATION', /not yet verified/);    // own2 not received
  // a location from another warehouse is refused
  const wh2 = (await one(`insert into warehouses (code, name) values ('DXB2','Al Quoz') returning id`)).id;
  const loc2 = (await one(`insert into warehouse_locations (warehouse_id, code) values ($1,'A-01') returning id`, [wh2])).id;
  await rejects(act(wh, { action: 'receive', shipment_id: own2, packages: 1, location_id: loc2 }), 'VALIDATION', /another warehouse/);
  await act(wh, { action: 'receive', shipment_id: own2, packages: 10, weight_kg: '300', volume_cbm: '1.2' });
  await act(wh, { action: 'verify_cargo', shipment_id: own2 });
  await act(coord, { action: 'ready' });
});

test('4. Stuffing → seal → dispatch; departure fills each linked shipment only where it has no date; arrival, delivery, close', async () => {
  await act(wh, { action: 'start_stuffing' });
  await act(wh, { action: 'stuff_shipment', shipment_id: own1, result: 'stuffed' });
  await act(wh, { action: 'stuff_shipment', shipment_id: partner, result: 'stuffed' });
  await act(wh, { action: 'stuff_shipment', shipment_id: other, result: 'stuffed' });
  await rejects(act(wh, { action: 'complete_stuffing', container_no: 'MSCU1234565' }), 'VALIDATION', /stuffed or shut out/);
  await rejects(act(wh, { action: 'stuff_shipment', shipment_id: own2, result: 'shut_out' }), 'VALIDATION', /why/);
  await act(wh, { action: 'stuff_shipment', shipment_id: own2, result: 'shut_out', reason: 'No space, next box' });
  await rejects(act(wh, { action: 'complete_stuffing' }), 'VALIDATION', /container number/);
  await act(wh, { action: 'complete_stuffing', container_no: 'mscu 1234565' });
  await act(wh, { action: 'seal', seal_no: 'sl778899' });
  await act(wh, { action: 'dispatch' });
  let d = await lcl.getConsolidation(coord, con);
  assert.deepEqual([d.status, d.container_no, d.seal_no, d.stuffed_by_name], ['dispatched', 'MSCU1234565', 'SL778899', 'Walt Warehouse']);
  // EXP-L1 already has its own departure date — kept
  await q(`update job_files set atd = $2 where id = $1`, [f1, D(-1)]);
  await act(coord, { action: 'departed', date: D(0) });
  const g1 = await getJobFile(admin, f1);
  assert.equal(g1.atd, D(-1), 'own date not overwritten');
  assert.ok(g1.events.some((e: any) => e.title.startsWith(`Departed ${D(0)} — LCL consolidation`) && e.new_value === 'Filled: milestone'));
  assert.equal((await getJobFile(admin, f2)).atd, null, 'shut-out cargo is not departed');
  await act(coord, { action: 'arrived', date: D(20) });
  assert.equal((await getJobFile(admin, f1)).ata, D(20), 'no own arrival date yet → filled');
  await act(coord, { action: 'delivered', shipment_id: partner });
  await act(coord, { action: 'close' });
  d = await lcl.getConsolidation(coord, con);
  assert.equal(d.status, 'closed');
  assert.equal(d.shipments.find((s: any) => s.id === partner).delivery_status, 'delivered');
  assert.equal((await getJobFile(admin, f1)).lcl.con_ref, d.con_ref, 'the shipment page shows its consolidation');
});

test('5. Registers and the 14 reports; history is locked; Transport sees nothing', async () => {
  const h = await lcl.listHouseShipments(coord, { view: 'hbl' });
  assert.deepEqual(h.rows.map((r: any) => r.hbl_no).sort(), ['RFS-HBL-001', 'RFS-HBL-002', 'SHA-100']);
  assert.equal((await lcl.listHouseShipments(coord, { q: 'hamburg gmbh' })).total, 1);
  for (const [key] of lcl.LCL_REPORTS) {
    const r = await lcl.lclReport(coord, key, {});
    assert.ok(r.columns.length > 3 && Array.isArray(r.rows), key);
  }
  const util = await lcl.lclReport(coord, 'utilisation', {});
  assert.equal(util.rows.find((r: any) => r.mbl_no === 'MEDUJA0001').utilisation_pct, 28.6);
  const dmg = await lcl.lclReport(coord, 'shortage_damage', {});
  assert.deepEqual(dmg.rows.map((r: any) => r.hbl_no), ['SHA-100']);
  assert.match(dmg.rows[0].notes, /2 cartons torn/);
  const sw = await lcl.lclReport(coord, 'salesman_wise', {});
  assert.ok(sw.rows.some((r: any) => r.name === 'Sam Sales' && r.shipments === 1));
  await assert.rejects(q(`update consolidation_events set title = 'x' where consolidation_id = $1`, [con]), /history/);
  await assert.rejects(q(`delete from lcl_receipts where shipment_id = $1`, [own1]), /history/);
  await rejects(lcl.getConsolidation(transport, con), 'FORBIDDEN');
});

test('6. Cancel before stuffing frees the shipments for another consolidation', async () => {
  const c = await lcl.createConsolidation(coord, { pol: 'Jebel Ali', pod: 'Genoa' });
  await lcl.consolidationAction(coord, c.id, { action: 'add_shipment', job_file_id: enq }).catch(() => null);
  const f3 = (await createJobFile(admin, { job_no: 'EXP-L3', customer_id: cust, direction: 'export', mode: 'sea_lcl', cargo_description: 'Tiles', packages: 3, gross_weight_kg: '900', volume_cbm: '2' })).id;
  await lcl.consolidationAction(coord, c.id, { action: 'add_shipment', job_file_id: f3 });
  await rejects(lcl.consolidationAction(coord, c.id, { action: 'cancel' }), 'VALIDATION', /why/);
  await lcl.consolidationAction(coord, c.id, { action: 'cancel', reason: 'Booking rolled' });
  const c2 = await lcl.createConsolidation(coord, { pol: 'Jebel Ali', pod: 'Genoa' });
  await lcl.consolidationAction(coord, c2.id, { action: 'add_shipment', job_file_id: f3 });
  assert.ok((await getJobFile(admin, f3)).events.some((e: any) => /cancelled — needs a new consolidation/.test(e.title)));
});
