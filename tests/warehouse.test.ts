/** Migration 015 — warehouse core: receipts, bins, ledger, FEFO reservation, pick/pack/dispatch, cancel, no negative stock. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import * as wh from '../src/server/warehouse';
import { runReport } from '../src/server/reports';
import { createJobFile } from '../src/server/jobfiles';

let admin: Actor, mgr: Actor, op: Actor, ops: Actor, transport: Actor, custA: string, custB: string, whId: string;
let bins: Record<string, string> = {};
let skuDates: string, skuPlain: string, skuB: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
/** The ledger must always add up to the balances. */
async function ledgerMatchesBalances() {
  const bad = await q(`select b.id from stock_balances b where b.qty_on_hand <> coalesce((select sum(t.qty_change) from inventory_transactions t
    where t.location_id = b.location_id and t.sku_id = b.sku_id and t.batch_no = b.batch_no
      and coalesce(t.expiry_date,'0001-01-01') = coalesce(b.expiry_date,'0001-01-01') and t.condition = b.condition), 0)`);
  assert.equal(bad.length, 0, 'every balance equals the sum of its ledger rows');
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  mgr = await mkUser(admin, 'WhMgr', 'warehouse_manager');
  op = await mkUser(admin, 'Picker', 'warehouse_operator');
  ops = await mkUser(admin, 'Opsy', 'operations_manager', 'sea_import');
  transport = await mkUser(admin, 'Trans', 'transport');
  custA = (await createMaster(ops, 'customers', { name: 'Arabian Taste' })).id;
  custB = (await createMaster(ops, 'customers', { name: 'Naturo' })).id;
  whId = (await one(`select id from warehouses where code = 'WH1'`)).id;
});

test('Setup: bins by list or range; SKUs belong to one customer; only managers configure', async () => {
  await rejects(wh.saveLocations(op, { warehouse_id: whId, codes: 'A-01' }), 'FORBIDDEN');
  let cfg = await wh.saveLocations(mgr, { warehouse_id: whId, codes: 'A-01-01 to A-01-03', zone: 'A' });
  cfg = await wh.saveLocations(mgr, { warehouse_id: whId, codes: 'B-01, B-02' });
  for (const l of cfg.locations) bins[l.code] = l.id;
  assert.ok(['A-01-01', 'A-01-02', 'A-01-03', 'B-01', 'B-02', 'RECEIVING', 'DAMAGED', 'QUARANTINE'].every((c) => bins[c]));
  await rejects(wh.saveLocations(mgr, { warehouse_id: whId, codes: 'A 1' }), 'VALIDATION');
  skuDates = (await wh.saveSku(mgr, { customer_id: custA, sku_code: 'AT-DATES-1KG', name: 'Ajwa dates 1kg', uom: 'carton', track_batch: true, track_expiry: true }))!.id;
  skuPlain = (await wh.saveSku(mgr, { customer_id: custA, sku_code: 'AT-TALBINA', name: 'Talbina 500g' }))!.id;
  skuB = (await wh.saveSku(mgr, { customer_id: custB, sku_code: 'NT-BAR', name: 'Fruit bar' }))!.id;
  await rejects(wh.saveSku(mgr, { customer_id: custA, sku_code: 'at-dates-1kg ', name: 'dup' }), 'DUPLICATE');
  await rejects(wh.saveSku(op, { customer_id: custA, sku_code: 'X', name: 'X' }), 'FORBIDDEN');
});

let grnId: string;
test('Goods receipt: expected → received; batch/expiry required when tracked; damaged goes to DAMAGED; ledger written', async () => {
  const jf = await createJobFile(ops, { job_no: 'SI-WH-1', customer_id: custA, direction: 'import', mode: 'sea_fcl', needs_warehouse: true });
  await rejects(wh.createGrn(mgr, { warehouse_id: whId, customer_id: custA, lines: [{ sku_id: skuB, expected_qty: '5' }] }), 'VALIDATION', /another customer/);
  const g = await wh.createGrn(op, { warehouse_id: whId, customer_id: custA, job_no: 'si-wh-1', reference: 'MSCU1234566',
    lines: [{ sku_id: skuDates, expected_qty: '100' }, { sku_id: skuPlain, expected_qty: '50' }] });
  grnId = g.id;
  assert.match(g.grn_no, /^GRN-\d+$/);
  let d = await wh.getGrn(op, grnId);
  assert.equal(d.job_no, 'SI-WH-1'); assert.equal(d.job_file_id, jf.id);
  const [l1, l2] = d.lines;
  await rejects(wh.receiveGrn(op, grnId, { lines: [{ id: l1.id, received_qty: '60', location_id: bins['A-01-01'] }] }), 'VALIDATION', /batch/);
  // two batches of dates arrive in one container — receive the first one here, the second through a second receipt below
  d = await wh.receiveGrn(op, grnId, { lines: [
    { id: l1.id, received_qty: '58', damaged_qty: '2', batch_no: 'B-OLD', expiry_date: D(40), location_id: bins['A-01-01'] },
    { id: l2.id, received_qty: '48', location_id: bins['A-01-02'] }] });
  assert.equal(d.status, 'received'); assert.equal(d.discrepancies, 2, 'dates 60 of 100 (this batch only), talbina 48 of 50');
  await rejects(wh.receiveGrn(op, grnId, { lines: [] }), 'GRN_CLOSED');
  const g2 = await wh.createGrn(op, { warehouse_id: whId, customer_id: custA, lines: [{ sku_id: skuDates, expected_qty: '40' }] });
  const d2 = await wh.getGrn(op, g2.id);
  await wh.receiveGrn(op, g2.id, { lines: [{ id: d2.lines[0].id, received_qty: '40', batch_no: 'B-NEW', expiry_date: D(200), location_id: bins['A-01-03'] }] });
  const s = await wh.stockList(ops, { customer_id: custA });
  const pick = (code: string, batch: string, cond = 'good') => s.rows.find((r: any) => r.sku_code === code && r.batch_no === batch && r.condition === cond);
  assert.equal(pick('AT-DATES-1KG', 'B-OLD').qty_on_hand, '58.000');
  assert.equal(pick('AT-DATES-1KG', 'B-OLD', 'damaged').location_code, 'DAMAGED');
  assert.equal(pick('AT-DATES-1KG', 'B-NEW').qty_on_hand, '40.000');
  await ledgerMatchesBalances();
});

test('Moves: put-away between bins; reserved stock cannot move; condition change needs a manager and a reason', async () => {
  const s = await wh.stockList(op, { sku_id: skuPlain });
  const bal = s.rows[0];
  await rejects(wh.moveStock(op, { balance_id: bal.id, qty: '49', to_location_id: bins['B-01'] }), 'NOT_ENOUGH_STOCK');
  await wh.moveStock(op, { balance_id: bal.id, qty: '8', to_location_id: bins['B-01'] });
  const after = (await wh.stockList(op, { sku_id: skuPlain })).rows;
  assert.deepEqual(after.map((r: any) => [r.location_code, r.qty_on_hand]).sort(), [['A-01-02', '40.000'], ['B-01', '8.000']]);
  const b01 = after.find((r: any) => r.location_code === 'B-01');
  await rejects(wh.moveStock(op, { balance_id: b01.id, qty: '1', to_location_id: bins['QUARANTINE'] }), 'FORBIDDEN', /manager/);
  await rejects(wh.moveStock(mgr, { balance_id: b01.id, qty: '1', to_location_id: bins['QUARANTINE'] }), 'VALIDATION', /why/);
  await wh.moveStock(mgr, { balance_id: b01.id, qty: '1', to_location_id: bins['QUARANTINE'], reason: 'Torn packaging' });
  assert.ok((await wh.stockList(op, { condition: 'quarantine' })).rows.some((r: any) => r.sku_code === 'AT-TALBINA' && r.qty_on_hand === '1.000'));
  await ledgerMatchesBalances();
});

let orderId: string;
test('Outbound order: FEFO reservation, short stock refused unless partial, pick → pack → dispatch reduces stock', async () => {
  await rejects(wh.createOrder(transport, { warehouse_id: whId, customer_id: custA, ship_to_name: 'X', lines: [{ sku_id: skuDates, qty: '1' }] }), 'FORBIDDEN');
  await rejects(wh.createOrder(ops, { warehouse_id: whId, customer_id: custA, ship_to_name: 'Carrefour DC', lines: [{ sku_id: skuB, qty: '1' }] }), 'VALIDATION', /another customer/);
  const o = await wh.createOrder(ops, { warehouse_id: whId, customer_id: custA, ship_to_name: 'Carrefour DC', customer_reference: 'PO-778',
    lines: [{ sku_id: skuDates, qty: '70' }, { sku_id: skuPlain, qty: '100' }] });
  orderId = o.id;
  const e: any = await wh.reserveOrder(op, orderId, {}).catch((x) => x);
  assert.equal(e.code, 'NOT_ENOUGH_STOCK');
  assert.deepEqual(e.details.short, ['AT-TALBINA: 53 short'], 'quarantined and damaged stock never counts');
  let d = await wh.reserveOrder(op, orderId, { allow_partial: true });
  assert.equal(d.status, 'reserved'); assert.equal(d.short_lines, 1);
  // FEFO: the 58 from the batch expiring first, then 12 from the later batch
  const dates = d.picks.filter((p: any) => p.sku_code === 'AT-DATES-1KG').map((p: any) => [p.batch_no, p.qty]);
  assert.deepEqual(dates, [['B-OLD', '58.000'], ['B-NEW', '12.000']]);
  // reserved stock is no longer available to anyone else
  const avail = (await wh.stockList(op, { sku_id: skuDates, condition: 'good' })).rows.reduce((s: number, r: any) => s + Number(r.qty_available), 0);
  assert.equal(avail, 28);
  await rejects(wh.dispatchOrder(op, orderId, { dispatch_reference: 'TRK 1' }), 'ORDER_STATE');
  await rejects(wh.pickOrder(ops, orderId), 'FORBIDDEN');
  await wh.pickOrder(op, orderId);
  await rejects(wh.packOrder(op, orderId, { packages: 0 }), 'VALIDATION');
  await wh.packOrder(op, orderId, { packages: 6, gross_weight_kg: '510' });
  await rejects(wh.dispatchOrder(op, orderId, {}), 'VALIDATION', /vehicle/);
  d = await wh.dispatchOrder(op, orderId, { dispatch_reference: 'Truck D 12345' });
  assert.equal(d.status, 'dispatched');
  const left = (await wh.stockList(op, { sku_id: skuDates, condition: 'good' })).rows;
  assert.deepEqual(left.map((r: any) => [r.batch_no, r.qty_on_hand, r.qty_reserved]), [['B-NEW', '28.000', '0.000']], 'B-OLD is gone, nothing left reserved');
  await ledgerMatchesBalances();
});

test('Cancelling an order releases its reservation', async () => {
  const o = await wh.createOrder(ops, { warehouse_id: whId, customer_id: custA, ship_to_name: 'Lulu', lines: [{ sku_id: skuDates, qty: '20' }] });
  await wh.reserveOrder(ops, o.id, {});
  assert.equal((await one(`select sum(qty_reserved) r from stock_balances where sku_id = $1`, [skuDates])).r, '20.000');
  await rejects(wh.cancelOrder(op, o.id, {}), 'VALIDATION', /reason/);
  const d = await wh.cancelOrder(ops, o.id, { reason: 'Customer cancelled PO' });
  assert.equal(d.status, 'cancelled');
  assert.equal((await one(`select sum(qty_reserved) r from stock_balances where sku_id = $1`, [skuDates])).r, '0.000');
});

test('Stock can never go negative — not even with two people dispatching at the same moment', async () => {
  const mk = async () => {
    const o = await wh.createOrder(ops, { warehouse_id: whId, customer_id: custA, ship_to_name: 'Race', lines: [{ sku_id: skuDates, qty: '20' }] });
    return o.id;
  };
  const [a, b] = [await mk(), await mk()];
  // both try to reserve 20 of the 28 left at the same time: only one can win
  const results = await Promise.allSettled([wh.reserveOrder(op, a, {}), wh.reserveOrder(mgr, b, {})]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((results.find((r) => r.status === 'rejected') as any).reason.code, 'NOT_ENOUGH_STOCK');
  // and the database itself refuses a negative balance, whatever the app does
  await assert.rejects(q(`update stock_balances set qty_on_hand = -1 where sku_id = $1`, [skuDates]), /sb_no_negative|sb_reserved_ok/);
  await assert.rejects(q(`update inventory_transactions set qty_change = 999 where sku_id = $1`, [skuDates]), /append-only/);
  await ledgerMatchesBalances();
});

test('Stock count adjustment: manager only, reason required, never below what is reserved', async () => {
  const bal = (await wh.stockList(mgr, { sku_id: skuDates, condition: 'good' })).rows[0];   // 28 on hand, 20 reserved by the race winner
  await rejects(wh.adjustStock(op, { balance_id: bal.id, counted_qty: '27', reason: 'count' }), 'FORBIDDEN');
  await rejects(wh.adjustStock(mgr, { balance_id: bal.id, counted_qty: '27' }), 'VALIDATION', /why/);
  await rejects(wh.adjustStock(mgr, { balance_id: bal.id, counted_qty: '19', reason: 'count' }), 'RESERVED_STOCK');
  await wh.adjustStock(mgr, { balance_id: bal.id, counted_qty: '27', reason: 'Cycle count — 1 carton missing' });
  const led = await wh.stockLedger(mgr, { sku_id: skuDates });
  assert.ok(led.some((t: any) => t.kind === 'adjust' && t.qty_change === '-1.000' && t.reason === 'Cycle count — 1 carton missing' && t.user_name === 'WhMgr'));
  await ledgerMatchesBalances();
});

test('Warehouse reports: stock on hand, expiry, ledger, GRN and dispatch registers; not for people without warehouse access', async () => {
  const P = { from: D(-1), to: D(1) };
  const stock = await runReport(mgr, 'wh_stock', { customer_id: custA });
  assert.ok(stock.rows.some((r: any) => r.sku_code === 'AT-DATES-1KG' && r.qty_available === '7.000'));
  const exp = await runReport(mgr, 'wh_expiry', { days: '90' });
  assert.deepEqual(exp.rows.map((r: any) => [r.batch_no, r.location_code, r.qty_on_hand]), [['B-OLD', 'DAMAGED', '2.000']],
    'good B-OLD stock was dispatched; only the 2 damaged cartons remain; B-NEW expires in 200 days');
  assert.ok((await runReport(mgr, 'wh_expiry', { days: '365' })).rows.some((r: any) => r.batch_no === 'B-NEW'));
  const grn = await runReport(mgr, 'wh_grn', P);
  assert.ok(grn.rows.some((r: any) => r.sku_code === 'AT-DATES-1KG' && r.difference === '-40.000' && r.damaged_qty === '2.000'));
  assert.ok(grn.rows.some((r: any) => r.sku_code === 'AT-TALBINA' && r.difference === '-2.000'));
  assert.ok((await runReport(mgr, 'wh_dispatch', P)).rows.some((r: any) => r.dispatch_reference === 'Truck D 12345'));
  assert.ok((await runReport(mgr, 'wh_ledger', P)).rows.some((r: any) => r.kind === 'Dispatched'));
  const noWh = await mkUser(admin, 'Driverish', 'messenger', 'messengers');
  await rejects(wh.stockList(noWh, {}), 'FORBIDDEN');
});
