/**
 * Warehouse (3PL) core — migration 015.
 *
 *   warehouses / warehouse_locations   where stock lives (bins; receiving, storage, dispatch, quarantine, damaged areas)
 *   skus                               what is stored; every SKU belongs to one customer (customer-owned stock)
 *   stock_balances                     on hand + reserved per bin / SKU / batch / expiry / condition
 *   inventory_transactions             the ledger: every movement, append-only
 *   grns / grn_lines                   goods receipts: expected → received (good + damaged, batch, expiry, bin)
 *   wh_orders / lines / allocations    outbound: reserve (FEFO) → pick → pack → dispatch, or cancel (releases stock)
 *
 * The one rule that keeps stock honest: on-hand quantities change ONLY in post(), which writes the ledger row and the
 * balance in the same transaction, with the balance row locked. The database refuses negative stock and refuses more
 * reserved than on hand, so even a bug or two people at once can't push stock below zero.
 * Quantities only — stock valuation and accounting entries stay in the ERP.
 */
import { PoolClient } from 'pg';
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, notFound, one, q, tx } from './db';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QTY = /^\d+(\.\d{1,3})?$/;

export const canSeeWarehouse = (a: Actor) =>
  ['warehouse.view', 'warehouse.receive', 'warehouse.move', 'warehouse.dispatch', 'warehouse.adjust', 'warehouse.configure', 'warehouse.orders.create']
    .some((p) => a.has(p as any));
const need = (a: Actor, ...perms: string[]) => { if (!a.isSuperAdmin && !perms.some((p) => a.has(p as any))) throw forbidden(); };
const view = (a: Actor) => { if (!canSeeWarehouse(a)) throw forbidden(); };
const txt = (v: unknown, max = 200) => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  if (t.length > max) throw bad(`Value too long (max ${max} characters)`);
  return t || null;
};
const qty = (v: unknown, label: string, allowZero = false) => {
  const s = String(v ?? '').trim();
  if (!QTY.test(s) || (!allowZero && Number(s) === 0)) throw bad(`${label}: enter a quantity ${allowZero ? 'of 0 or more' : 'above 0'} (up to 3 decimals)`);
  return s;
};
const day = (v: unknown, label: string) => {
  if (v === undefined || v === null || v === '') return null;
  if (!DATE.test(String(v))) throw bad(`${label} is not a valid date`);
  return String(v);
};
async function event(db: Db, actor: Actor, ref: { grn_id?: string; order_id?: string }, title: string, details?: string | null) {
  await db.query('insert into wh_events (grn_id, order_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5,$6)',
    [ref.grn_id ?? null, ref.order_id ?? null, title, details ?? null, actor.id, actor.full_name]);
}

// ------------------------------------------------------------ the posting function (the only way stock changes)
interface StockKey { warehouse_id: string; location_id: string; sku_id: string; customer_id: string; batch_no: string; expiry_date: string | null; condition: string }
interface PostMeta { kind: string; source_type: 'grn' | 'move' | 'adjustment' | 'order'; source_id?: string | null; reference?: string | null; reason?: string | null }
/** Add (or with a negative delta, take) stock at one bin/SKU/batch/expiry/condition, and write the ledger row. */
async function post(c: PoolClient, actor: Actor, k: StockKey, delta: string, m: PostMeta): Promise<{ balance_id: string; balance_after: string }> {
  if (Number(delta) === 0) throw bad('Quantity cannot be 0');
  await c.query(`insert into stock_balances (warehouse_id, location_id, sku_id, customer_id, batch_no, expiry_date, condition)
    values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (location_id, sku_id, batch_no, (coalesce(expiry_date, '0001-01-01'::date)), condition) do nothing`,
    [k.warehouse_id, k.location_id, k.sku_id, k.customer_id, k.batch_no, k.expiry_date, k.condition]);
  const b = await one(`select id, qty_on_hand, qty_reserved from stock_balances where location_id = $1 and sku_id = $2 and batch_no = $3
    and coalesce(expiry_date, '0001-01-01'::date) = coalesce($4::date, '0001-01-01'::date) and condition = $5 for update`,
    [k.location_id, k.sku_id, k.batch_no, k.expiry_date, k.condition], c);
  // friendly message first; the database constraint is the real guarantee
  const after = await one<{ ok: boolean; v: string }>('select ($1::numeric + $2::numeric) >= $3::numeric ok, ($1::numeric + $2::numeric)::text v',
    [b.qty_on_hand, delta, m.kind === 'dispatch' ? 0 : b.qty_reserved], c);
  if (!after!.ok) throw new ApiError(409, 'NOT_ENOUGH_STOCK', `Not enough stock: ${Number(b.qty_on_hand) - Number(b.qty_reserved)} available here.`);
  const u = await one(`update stock_balances set qty_on_hand = qty_on_hand + $2::numeric, updated_at = now() where id = $1 returning qty_on_hand`, [b.id, delta], c);
  await c.query(`insert into inventory_transactions (warehouse_id, location_id, sku_id, customer_id, batch_no, expiry_date, condition, qty_change, balance_after,
      kind, source_type, source_id, reference, reason, user_id, user_name)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [k.warehouse_id, k.location_id, k.sku_id, k.customer_id, k.batch_no, k.expiry_date, k.condition, delta, u.qty_on_hand,
     m.kind, m.source_type, m.source_id ?? null, m.reference ?? null, m.reason ?? null, actor.id, actor.full_name]);
  return { balance_id: b.id, balance_after: u.qty_on_hand };
}

// ------------------------------------------------------------ setup: warehouses, bins, SKUs
export async function warehouseConfig(actor: Actor) {
  view(actor);
  const [warehouses, locations] = await Promise.all([
    q(`select w.*, (select count(*)::int from warehouse_locations l where l.warehouse_id = w.id and l.is_active) bins from warehouses w order by w.code`),
    q(`select l.id, l.warehouse_id, l.code, l.zone, l.location_type, l.is_active,
        (select coalesce(sum(qty_on_hand), 0) from stock_balances b where b.location_id = l.id) qty
       from warehouse_locations l order by l.warehouse_id, l.location_type <> 'storage', l.code`),
  ]);
  return { warehouses, locations, can: { configure: actor.isSuperAdmin || actor.has('warehouse.configure') } };
}
export async function saveWarehouse(actor: Actor, b: any) {
  need(actor, 'warehouse.configure');
  const code = txt(b.code, 20)?.toUpperCase(), name = txt(b.name, 120);
  if (!code || !/^[A-Z0-9-]+$/.test(code)) throw bad('Warehouse code: letters, numbers and - only');
  if (!name) throw bad('Enter the warehouse name');
  await tx(async (c) => {
    if (b.id) {
      if (!isUuid(b.id)) throw bad('Choose the warehouse');
      await c.query('update warehouses set code = $2, name = $3, address = $4, is_active = $5 where id = $1', [b.id, code, name, txt(b.address, 300), b.is_active !== false]);
    } else {
      const w = await one('insert into warehouses (code, name, address) values ($1,$2,$3) returning id', [code, name, txt(b.address, 300)], c);
      for (const [lc, z, t] of [['RECEIVING', 'Dock', 'receiving'], ['DISPATCH', 'Dock', 'dispatch'], ['QUARANTINE', 'Hold', 'quarantine'], ['DAMAGED', 'Hold', 'damaged']])
        await c.query('insert into warehouse_locations (warehouse_id, code, zone, location_type) values ($1,$2,$3,$4)', [w.id, lc, z, t]);
    }
  });
  return warehouseConfig(actor);
}
/** Add bins: a list ("A-01-01, A-01-02") or a range ("A-01-01 to A-01-20"). Or switch one bin on/off / change its type. */
export async function saveLocations(actor: Actor, b: any) {
  need(actor, 'warehouse.configure');
  const TYPES = ['receiving', 'storage', 'dispatch', 'quarantine', 'damaged'];
  await tx(async (c) => {
    if (b.id) {
      if (!isUuid(b.id)) throw bad('Choose the bin');
      const l = await one('select l.*, (select coalesce(sum(qty_on_hand),0) from stock_balances s where s.location_id = l.id) qty from warehouse_locations l where l.id = $1', [b.id], c);
      if (!l) throw notFound('Bin');
      if (b.is_active === false && Number(l.qty) > 0) throw bad(`Bin ${l.code} still holds stock. Move it out first.`);
      if (b.location_type && !TYPES.includes(b.location_type)) throw bad('Choose the bin type');
      await c.query('update warehouse_locations set is_active = $2, location_type = coalesce($3, location_type), zone = coalesce($4, zone) where id = $1',
        [b.id, b.is_active !== false, b.location_type ?? null, txt(b.zone, 40)]);
      return;
    }
    if (!isUuid(b.warehouse_id) || !(await one('select 1 from warehouses where id = $1', [b.warehouse_id], c))) throw bad('Choose the warehouse');
    const type = b.location_type ?? 'storage';
    if (!TYPES.includes(type)) throw bad('Choose the bin type');
    const raw = String(b.codes ?? '').trim().toUpperCase();
    let codes: string[] = [];
    const range = raw.match(/^([A-Z0-9-]*?)(\d+)\s+TO\s+([A-Z0-9-]*?)(\d+)$/);
    if (range && range[1] === range[3]) {
      const [from, to, width] = [Number(range[2]), Number(range[4]), range[2].length];
      if (to < from || to - from > 499) throw bad('A range can add up to 500 bins at a time');
      for (let n = from; n <= to; n++) codes.push(range[1] + String(n).padStart(width, '0'));
    } else codes = raw.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);
    if (!codes.length) throw bad('Enter bin codes, e.g. A-01-01, A-01-02 or A-01-01 to A-01-20');
    for (const code of codes) if (!/^[A-Z0-9-]{1,30}$/.test(code)) throw bad(`Bin "${code}": letters, numbers and - only`);
    for (const code of codes)
      await c.query(`insert into warehouse_locations (warehouse_id, code, zone, location_type) values ($1,$2,$3,$4) on conflict do nothing`,
        [b.warehouse_id, code, txt(b.zone, 40), type]);
  });
  return warehouseConfig(actor);
}

export async function listSkus(actor: Actor, p: Record<string, string>) {
  view(actor);
  const params: unknown[] = [];
  let w = 'where true';
  if (p.customer_id) { if (!isUuid(p.customer_id)) throw bad('Invalid filter'); params.push(p.customer_id); w += ` and s.customer_id = $${params.length}`; }
  if (p.q?.trim()) { params.push('%' + p.q.trim().toLowerCase() + '%'); w += ` and (lower(s.sku_code) like $${params.length} or lower(s.name) like $${params.length} or s.barcode = $${params.length + 1})`; params.push(p.q.trim()); }
  if (p.active !== 'all') w += ' and s.is_active';
  return q(`select s.*, c.name customer_name, (select coalesce(sum(qty_on_hand),0) from stock_balances b where b.sku_id = s.id) on_hand
    from skus s join customers c on c.id = s.customer_id ${w} order by c.name, s.sku_code limit 1000`, params);
}
export async function saveSku(actor: Actor, b: any) {
  need(actor, 'warehouse.configure');
  const code = txt(b.sku_code, 60), name = txt(b.name, 200);
  if (!code) throw bad('Enter the SKU code');
  if (!name) throw bad('Enter the product name');
  const uom = b.uom ?? 'piece';
  if (!['piece', 'carton', 'pallet', 'kg', 'litre', 'set'].includes(uom)) throw bad('Choose the unit');
  const upc = b.units_per_carton === '' || b.units_per_carton == null ? null : Number(b.units_per_carton);
  if (upc !== null && (!Number.isInteger(upc) || upc < 1)) throw bad('Units per carton must be a whole number');
  return tx(async (c) => {
    if (b.id) {
      if (!isUuid(b.id)) throw bad('Choose the SKU');
      const s = await one('select * from skus where id = $1', [b.id], c);
      if (!s) throw notFound('SKU');
      // the owner can't change once there is stock or history (it would move stock between customers)
      if (b.customer_id && b.customer_id !== s.customer_id && await one('select 1 from inventory_transactions where sku_id = $1 limit 1', [b.id], c))
        throw bad('This SKU already has stock history; its customer cannot change.');
      await c.query(`update skus set customer_id = $2, sku_code = $3, name = $4, barcode = $5, uom = $6, units_per_carton = $7,
        track_batch = $8, track_expiry = $9, is_active = $10 where id = $1`,
        [b.id, b.customer_id ?? s.customer_id, code, name, txt(b.barcode, 60), uom, upc, !!b.track_batch, !!b.track_expiry, b.is_active !== false]);
      return { id: b.id };
    }
    if (!isUuid(b.customer_id) || !(await one('select 1 from customers where id = $1 and deleted_at is null', [b.customer_id], c))) throw bad('Choose the customer who owns this stock');
    if (await one('select 1 from skus where customer_id = $1 and upper(btrim(sku_code)) = upper($2)', [b.customer_id, code], c))
      throw new ApiError(409, 'DUPLICATE', `SKU ${code} already exists for this customer`);
    return one(`insert into skus (customer_id, sku_code, name, barcode, uom, units_per_carton, track_batch, track_expiry) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [b.customer_id, code, name, txt(b.barcode, 60), uom, upc, !!b.track_batch, !!b.track_expiry], c);
  });
}

// ------------------------------------------------------------ stock on hand, moves, adjustments
export async function stockList(actor: Actor, p: Record<string, string>) {
  view(actor);
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let w = 'where b.qty_on_hand > 0';
  for (const [k, col] of Object.entries({ warehouse_id: 'b.warehouse_id', customer_id: 'b.customer_id', location_id: 'b.location_id', sku_id: 'b.sku_id' }))
    if (p[k]) { if (!isUuid(p[k])) throw bad('Invalid filter'); w += ` and ${col} = ${add(p[k])}`; }
  if (p.condition) w += ` and b.condition = ${add(p.condition)}`;
  if (p.q?.trim()) { const v = add('%' + p.q.trim().toLowerCase() + '%'); w += ` and (lower(s.sku_code) like ${v} or lower(s.name) like ${v} or lower(b.batch_no) like ${v} or lower(l.code) like ${v} or s.barcode = ${add(p.q.trim())})`; }
  if (p.expiring_days) { const n = Number(p.expiring_days); if (!Number.isInteger(n) || n < 0) throw bad('Invalid filter');
    w += ` and b.expiry_date is not null and b.expiry_date <= (now() at time zone 'Asia/Dubai')::date + ${n}`; }
  const rows = await q(`select b.id, b.warehouse_id, w.code warehouse_code, b.location_id, l.code location_code, l.location_type, b.sku_id, s.sku_code, s.name sku_name, s.uom,
      b.customer_id, c.name customer_name, b.batch_no, b.expiry_date, b.condition, b.qty_on_hand, b.qty_reserved, (b.qty_on_hand - b.qty_reserved) qty_available,
      b.first_received_at, (b.expiry_date is not null and b.expiry_date < (now() at time zone 'Asia/Dubai')::date) expired
    from stock_balances b join skus s on s.id = b.sku_id join warehouse_locations l on l.id = b.location_id join warehouses w on w.id = b.warehouse_id
    join customers c on c.id = b.customer_id ${w} order by c.name, s.sku_code, b.expiry_date nulls last, l.code limit 2000`, params);
  return { rows, can: { move: actor.isSuperAdmin || actor.has('warehouse.move'), adjust: actor.isSuperAdmin || actor.has('warehouse.adjust') } };
}

/** Put-away / bin-to-bin move, optionally changing condition (good ↔ damaged / quarantine needs adjust rights). Reserved stock stays put. */
export async function moveStock(actor: Actor, b: any) {
  need(actor, 'warehouse.move', 'warehouse.adjust');
  if (!isUuid(b.balance_id)) throw bad('Choose the stock to move');
  const amount = qty(b.qty, 'Quantity');
  await tx(async (c) => {
    const s = await one('select * from stock_balances where id = $1 for update', [b.balance_id], c);
    if (!s) throw notFound('Stock');
    const toLoc = isUuid(b.to_location_id) ? b.to_location_id : s.location_id;
    const loc = await one('select id, warehouse_id, code, location_type, is_active from warehouse_locations where id = $1', [toLoc], c);
    if (!loc || !loc.is_active) throw bad('Choose an active bin to move to');
    if (loc.warehouse_id !== s.warehouse_id) throw bad('Moves between warehouses are not in this version — dispatch and receive instead');
    const toCond = b.to_condition ?? (loc.location_type === 'damaged' ? 'damaged' : loc.location_type === 'quarantine' ? 'quarantine' : s.condition);
    if (!['good', 'damaged', 'quarantine'].includes(toCond)) throw bad('Choose the condition');
    if (toCond !== s.condition && !actor.isSuperAdmin && !actor.has('warehouse.adjust')) throw forbidden('Only a warehouse manager can change the condition of stock');
    if (toLoc === s.location_id && toCond === s.condition) throw bad('Choose a different bin or condition');
    if (Number(amount) > Number(s.qty_on_hand) - Number(s.qty_reserved))
      throw new ApiError(409, 'NOT_ENOUGH_STOCK', `Only ${Number(s.qty_on_hand) - Number(s.qty_reserved)} can move here (the rest is reserved for orders).`);
    const reason = txt(b.reason, 300);
    if (toCond !== s.condition && !reason) throw bad('Say why the condition changes');
    const key = { warehouse_id: s.warehouse_id, sku_id: s.sku_id, customer_id: s.customer_id, batch_no: s.batch_no, expiry_date: s.expiry_date };
    const cond = toCond !== s.condition;
    const ref = `${cond ? 'Condition' : 'Move'} → ${loc.code}`;
    await post(c, actor, { ...key, location_id: s.location_id, condition: s.condition }, '-' + amount, { kind: cond ? 'condition_out' : 'move_out', source_type: 'move', reference: ref, reason });
    await post(c, actor, { ...key, location_id: toLoc, condition: toCond }, amount, { kind: cond ? 'condition_in' : 'move_in', source_type: 'move', reference: ref, reason });
  });
  return stockList(actor, { sku_id: '' });
}

/** Stock count correction: set the counted quantity. Manager only, reason required, never below what is reserved. */
export async function adjustStock(actor: Actor, b: any) {
  need(actor, 'warehouse.adjust');
  if (!isUuid(b.balance_id)) throw bad('Choose the stock to adjust');
  const counted = qty(b.counted_qty, 'Counted quantity', true);
  const reason = txt(b.reason, 300);
  if (!reason) throw bad('Say why the stock is adjusted (e.g. cycle count, found, lost)');
  await tx(async (c) => {
    const s = await one('select * from stock_balances where id = $1 for update', [b.balance_id], c);
    if (!s) throw notFound('Stock');
    if (Number(counted) < Number(s.qty_reserved))
      throw new ApiError(409, 'RESERVED_STOCK', `${Number(s.qty_reserved)} of this stock is reserved for orders. Cancel or change those orders first.`);
    const delta = (await one<{ d: string }>('select ($1::numeric - $2::numeric)::text d', [counted, s.qty_on_hand], c))!.d;
    if (Number(delta) === 0) throw bad('The counted quantity is the same as the system — nothing to adjust');
    await post(c, actor, { warehouse_id: s.warehouse_id, location_id: s.location_id, sku_id: s.sku_id, customer_id: s.customer_id,
      batch_no: s.batch_no, expiry_date: s.expiry_date, condition: s.condition }, delta, { kind: 'adjust', source_type: 'adjustment', reference: 'Stock count', reason });
  });
  return { ok: true };
}

export async function stockLedger(actor: Actor, p: Record<string, string>) {
  view(actor);
  const params: unknown[] = [];
  let w = 'where true';
  for (const [k, col] of Object.entries({ sku_id: 't.sku_id', customer_id: 't.customer_id', warehouse_id: 't.warehouse_id', location_id: 't.location_id' }))
    if (p[k]) { if (!isUuid(p[k])) throw bad('Invalid filter'); params.push(p[k]); w += ` and ${col} = $${params.length}`; }
  return q(`select t.*, s.sku_code, s.name sku_name, l.code location_code from inventory_transactions t join skus s on s.id = t.sku_id
    join warehouse_locations l on l.id = t.location_id ${w} order by t.at desc, t.id desc limit 500`, params);
}

// ------------------------------------------------------------ goods receipts (GRN)
async function loadGrn(id: string, db?: Db, lock = false) {
  if (!isUuid(id)) throw notFound('Receipt');
  const g = await one(`select g.* from grns g where g.id = $1${lock ? ' for update' : ''}`, [id], db);
  if (!g) throw notFound('Receipt');
  return g;
}
export async function listGrns(actor: Actor, p: Record<string, string>) {
  view(actor);
  const params: unknown[] = [];
  let w = 'where true';
  if (p.status) { params.push(p.status); w += ` and g.status = $${params.length}`; }
  for (const [k, col] of Object.entries({ warehouse_id: 'g.warehouse_id', customer_id: 'g.customer_id' }))
    if (p[k]) { if (!isUuid(p[k])) throw bad('Invalid filter'); params.push(p[k]); w += ` and ${col} = $${params.length}`; }
  if (p.q?.trim()) { params.push('%' + p.q.trim().toLowerCase() + '%'); w += ` and (lower(g.grn_no) like $${params.length} or lower(coalesce(g.reference,'')) like $${params.length} or lower(coalesce(g.supplier,'')) like $${params.length} or lower(coalesce(f.job_no,'')) like $${params.length})`; }
  return q(`select g.id, g.grn_no, g.status, g.expected_date, g.received_at, g.supplier, g.reference, c.name customer_name, w.code warehouse_code, f.job_no,
      (select coalesce(sum(expected_qty),0) from grn_lines where grn_id = g.id) expected_qty,
      (select coalesce(sum(coalesce(received_qty,0) + coalesce(damaged_qty,0)),0) from grn_lines where grn_id = g.id) received_qty
    from grns g join customers c on c.id = g.customer_id join warehouses w on w.id = g.warehouse_id left join job_files f on f.id = g.job_file_id
    ${w} order by g.status = 'expected' desc, g.created_at desc limit 500`, params);
}
export async function getGrn(actor: Actor, id: string) {
  view(actor);
  const g = await loadGrn(id);
  const [extra, lines, events] = await Promise.all([
    one(`select c.name customer_name, w.code warehouse_code, w.name warehouse_name, f.job_no, u.full_name created_by_name, r.full_name received_by_name
       from grns g join customers c on c.id = g.customer_id join warehouses w on w.id = g.warehouse_id left join job_files f on f.id = g.job_file_id
       join users u on u.id = g.created_by left join users r on r.id = g.received_by where g.id = $1`, [id]),
    q(`select gl.*, s.sku_code, s.name sku_name, s.uom, s.track_batch, s.track_expiry, l.code location_code from grn_lines gl join skus s on s.id = gl.sku_id
       left join warehouse_locations l on l.id = gl.location_id where gl.grn_id = $1 order by gl.sort_order`, [id]),
    q('select title, details, user_name, at from wh_events where grn_id = $1 order by at, id', [id]),
  ]);
  const short = lines.filter((l) => l.received_qty !== null && Number(l.received_qty) + Number(l.damaged_qty ?? 0) !== Number(l.expected_qty));
  return { ...g, ...extra, lines, events, discrepancies: short.length,
    can: { receive: g.status === 'expected' && (actor.isSuperAdmin || actor.has('warehouse.receive')),
      cancel: g.status === 'expected' && (actor.isSuperAdmin || actor.has('warehouse.receive')) } };
}
export async function createGrn(actor: Actor, b: any) {
  need(actor, 'warehouse.receive');
  if (!isUuid(b.warehouse_id)) throw bad('Choose the warehouse');
  if (!isUuid(b.customer_id)) throw bad('Choose the customer who owns the goods');
  const lines = Array.isArray(b.lines) ? b.lines.filter((l: any) => l?.sku_id) : [];
  if (!lines.length) throw bad('Add at least one SKU');
  return tx(async (c) => {
    if (!(await one('select 1 from warehouses where id = $1 and is_active', [b.warehouse_id], c))) throw bad('Choose an active warehouse');
    let jobFileId: string | null = null;
    if (b.job_no?.trim()) {
      const f = await one(`select id from job_files where upper(btrim(job_no)) = upper(btrim($1)) and deleted_at is null and status <> 'cancelled'`, [b.job_no], c);
      if (!f) throw bad(`No Job File with Job No. ${String(b.job_no).trim()}`);
      jobFileId = f.id;
    }
    const g = await one(`insert into grns (grn_no, warehouse_id, customer_id, job_file_id, supplier, reference, expected_date, remarks, created_by)
      values ('GRN-' || nextval('grn_no_seq'), $1,$2,$3,$4,$5,$6,$7,$8) returning id, grn_no`,
      [b.warehouse_id, b.customer_id, jobFileId, txt(b.supplier, 120), txt(b.reference, 80), day(b.expected_date, 'Expected date'), txt(b.remarks, 1000), actor.id], c);
    for (const [i, l] of lines.entries()) {
      const s = isUuid(l.sku_id) ? await one('select customer_id from skus where id = $1 and is_active', [l.sku_id], c) : null;
      if (!s) throw bad(`Line ${i + 1}: choose an active SKU`);
      if (s.customer_id !== b.customer_id) throw bad(`Line ${i + 1}: that SKU belongs to another customer`);
      await c.query('insert into grn_lines (grn_id, sku_id, expected_qty, sort_order) values ($1,$2,$3,$4)', [g.id, l.sku_id, qty(l.expected_qty, `Line ${i + 1}`, true), i]);
    }
    await event(c, actor, { grn_id: g.id }, 'Receipt expected', `${lines.length} SKU line(s)`);
    return g;
  });
}
/**
 * Receive: per line the good quantity goes into the chosen bin, the damaged quantity into the warehouse's DAMAGED area.
 * Batch / expiry are required when the SKU tracks them. A difference from the expected quantity is allowed and shown.
 */
export async function receiveGrn(actor: Actor, id: string, b: any) {
  need(actor, 'warehouse.receive');
  await tx(async (c) => {
    const g = await loadGrn(id, c, true);
    if (g.status !== 'expected') throw new ApiError(409, 'GRN_CLOSED', `This receipt is already ${g.status}`);
    const lines = await q('select gl.*, s.track_batch, s.track_expiry, s.sku_code from grn_lines gl join skus s on s.id = gl.sku_id where gl.grn_id = $1 order by sort_order', [id], c);
    const input: any[] = Array.isArray(b.lines) ? b.lines : [];
    const damagedLoc = await one(`select id from warehouse_locations where warehouse_id = $1 and location_type = 'damaged' and is_active order by code limit 1`, [g.warehouse_id], c);
    let total = 0;
    for (const l of lines) {
      const x = input.find((v) => v.id === l.id) ?? {};
      const n = `${l.sku_code}`;
      const good = qty(x.received_qty ?? '0', `${n} received`, true), dmg = qty(x.damaged_qty ?? '0', `${n} damaged`, true);
      const batch = txt(x.batch_no, 60) ?? '';
      const expiry = day(x.expiry_date, `${n} expiry date`);
      if (Number(good) + Number(dmg) > 0) {
        if (l.track_batch && !batch) throw bad(`${n}: enter the batch / lot number`);
        if (l.track_expiry && !expiry) throw bad(`${n}: enter the expiry date`);
      }
      let locId: string | null = null;
      if (Number(good) > 0) {
        const loc = isUuid(x.location_id) ? await one('select id, warehouse_id, location_type, is_active from warehouse_locations where id = $1', [x.location_id], c) : null;
        if (!loc || !loc.is_active || loc.warehouse_id !== g.warehouse_id) throw bad(`${n}: choose a bin in this warehouse`);
        locId = loc.id;
        const cond = loc.location_type === 'quarantine' ? 'quarantine' : loc.location_type === 'damaged' ? 'damaged' : 'good';
        await post(c, actor, { warehouse_id: g.warehouse_id, location_id: loc.id, sku_id: l.sku_id, customer_id: g.customer_id, batch_no: batch, expiry_date: expiry, condition: cond },
          good, { kind: 'receipt', source_type: 'grn', source_id: id, reference: g.grn_no });
      }
      if (Number(dmg) > 0) {
        if (!damagedLoc) throw bad('This warehouse has no DAMAGED area. Add one in Warehouse → Setup.');
        await post(c, actor, { warehouse_id: g.warehouse_id, location_id: damagedLoc.id, sku_id: l.sku_id, customer_id: g.customer_id, batch_no: batch, expiry_date: expiry, condition: 'damaged' },
          dmg, { kind: 'receipt', source_type: 'grn', source_id: id, reference: g.grn_no, reason: 'Received damaged' });
      }
      total += Number(good) + Number(dmg);
      await c.query('update grn_lines set received_qty = $2, damaged_qty = $3, batch_no = $4, expiry_date = $5, location_id = $6, remarks = $7 where id = $1',
        [l.id, good, dmg, batch || null, expiry, locId, txt(x.remarks, 300)]);
    }
    if (total === 0) throw bad('Nothing received — enter the quantities, or cancel the receipt');
    await c.query(`update grns set status = 'received', received_by = $2, received_at = now() where id = $1`, [id, actor.id]);
    const diff = lines.filter((l) => { const x = input.find((v) => v.id === l.id) ?? {}; return Number(x.received_qty ?? 0) + Number(x.damaged_qty ?? 0) !== Number(l.expected_qty); });
    await event(c, actor, { grn_id: id }, 'Goods received', diff.length ? `${diff.length} line(s) differ from the expected quantity` : 'All quantities as expected');
  });
  return getGrn(actor, id);
}
export async function cancelGrn(actor: Actor, id: string, b: any) {
  need(actor, 'warehouse.receive');
  const reason = txt(b.reason, 300);
  if (!reason) throw bad('Give a reason');
  await tx(async (c) => {
    const g = await loadGrn(id, c, true);
    if (g.status !== 'expected') throw new ApiError(409, 'GRN_CLOSED', 'Only an expected receipt can be cancelled. Received stock is corrected by a stock adjustment.');
    await c.query(`update grns set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, reason]);
    await event(c, actor, { grn_id: id }, 'Receipt cancelled', reason);
  });
  return getGrn(actor, id);
}

// ------------------------------------------------------------ outbound orders
async function loadOrder(id: string, db?: Db, lock = false) {
  if (!isUuid(id)) throw notFound('Order');
  const o = await one(`select * from wh_orders where id = $1${lock ? ' for update' : ''}`, [id], db);
  if (!o) throw notFound('Order');
  return o;
}
export async function listOrders(actor: Actor, p: Record<string, string>) {
  view(actor);
  const params: unknown[] = [];
  let w = 'where true';
  if (p.status === 'open') w += ` and o.status not in ('dispatched','cancelled')`;
  else if (p.status) { params.push(p.status); w += ` and o.status = $${params.length}`; }
  for (const [k, col] of Object.entries({ warehouse_id: 'o.warehouse_id', customer_id: 'o.customer_id' }))
    if (p[k]) { if (!isUuid(p[k])) throw bad('Invalid filter'); params.push(p[k]); w += ` and ${col} = $${params.length}`; }
  if (p.q?.trim()) { params.push('%' + p.q.trim().toLowerCase() + '%'); w += ` and (lower(o.order_no) like $${params.length} or lower(coalesce(o.customer_reference,'')) like $${params.length} or lower(o.ship_to_name) like $${params.length})`; }
  return q(`select o.id, o.order_no, o.status, o.required_date, o.customer_reference, o.ship_to_name, o.dispatched_at, o.created_at, c.name customer_name, w.code warehouse_code,
      (select count(*)::int from wh_order_lines where order_id = o.id) lines,
      (select coalesce(sum(qty),0) from wh_order_lines where order_id = o.id) qty,
      (select coalesce(sum(a.qty),0) from wh_allocations a join wh_order_lines ol on ol.id = a.order_line_id where ol.order_id = o.id) reserved
    from wh_orders o join customers c on c.id = o.customer_id join warehouses w on w.id = o.warehouse_id ${w}
    order by o.status in ('dispatched','cancelled'), o.required_date nulls last, o.created_at desc limit 500`, params);
}
export async function getOrder(actor: Actor, id: string) {
  view(actor);
  const o = await loadOrder(id);
  const [extra, lines, allocs, events] = await Promise.all([
    one(`select c.name customer_name, w.code warehouse_code, w.name warehouse_name, f.job_no, u.full_name created_by_name,
        pk.full_name picked_by_name, pa.full_name packed_by_name, d.full_name dispatched_by_name
       from wh_orders o join customers c on c.id = o.customer_id join warehouses w on w.id = o.warehouse_id left join job_files f on f.id = o.job_file_id
       join users u on u.id = o.created_by left join users pk on pk.id = o.picked_by left join users pa on pa.id = o.packed_by
       left join users d on d.id = o.dispatched_by where o.id = $1`, [id]),
    q(`select ol.id, ol.sku_id, ol.qty, s.sku_code, s.name sku_name, s.uom,
        (select coalesce(sum(a.qty),0) from wh_allocations a where a.order_line_id = ol.id) reserved,
        (select coalesce(sum(b.qty_on_hand - b.qty_reserved),0) from stock_balances b where b.sku_id = ol.sku_id and b.warehouse_id = $2 and b.condition = 'good'
          and (b.expiry_date is null or b.expiry_date >= (now() at time zone 'Asia/Dubai')::date)) available
       from wh_order_lines ol join skus s on s.id = ol.sku_id where ol.order_id = $1 order by ol.sort_order`, [id, o.warehouse_id]),
    q(`select a.id, a.order_line_id, a.qty, b.batch_no, b.expiry_date, l.code location_code, s.sku_code from wh_allocations a
       join stock_balances b on b.id = a.balance_id join warehouse_locations l on l.id = b.location_id join skus s on s.id = b.sku_id
       join wh_order_lines ol on ol.id = a.order_line_id where ol.order_id = $1 order by l.code, s.sku_code`, [id]),
    q('select title, details, user_name, at from wh_events where order_id = $1 order by at, id', [id]),
  ]);
  const ops = actor.isSuperAdmin || actor.has('warehouse.dispatch');
  const creator = actor.isSuperAdmin || actor.has('warehouse.orders.create');
  const short = lines.filter((l) => Number(l.reserved) < Number(l.qty));
  return { ...o, ...extra, lines, picks: allocs, events, short_lines: short.length,
    can: { reserve: ['open', 'reserved'].includes(o.status) && (ops || creator) && short.length > 0,
      pick: o.status === 'reserved' && ops, pack: o.status === 'picked' && ops, dispatch: o.status === 'packed' && ops,
      cancel: !['dispatched', 'cancelled'].includes(o.status) && (ops || creator) } };
}
export async function createOrder(actor: Actor, b: any) {
  need(actor, 'warehouse.orders.create', 'warehouse.dispatch');
  if (!isUuid(b.warehouse_id)) throw bad('Choose the warehouse');
  if (!isUuid(b.customer_id)) throw bad('Choose the customer');
  const shipTo = txt(b.ship_to_name, 200);
  if (!shipTo) throw bad('Enter who it is going to');
  const lines = Array.isArray(b.lines) ? b.lines.filter((l: any) => l?.sku_id) : [];
  if (!lines.length) throw bad('Add at least one SKU');
  return tx(async (c) => {
    let jobFileId: string | null = null;
    if (b.job_no?.trim()) {
      const f = await one(`select id from job_files where upper(btrim(job_no)) = upper(btrim($1)) and deleted_at is null and status <> 'cancelled'`, [b.job_no], c);
      if (!f) throw bad(`No Job File with Job No. ${String(b.job_no).trim()}`);
      jobFileId = f.id;
    }
    const o = await one(`insert into wh_orders (order_no, warehouse_id, customer_id, job_file_id, customer_reference, ship_to_name, ship_to_address, ship_to_contact,
        ship_to_phone, required_date, remarks, created_by)
      values ('WO-' || nextval('wh_order_no_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, order_no`,
      [b.warehouse_id, b.customer_id, jobFileId, txt(b.customer_reference, 80), shipTo, txt(b.ship_to_address, 500), txt(b.ship_to_contact, 120),
       txt(b.ship_to_phone, 40), day(b.required_date, 'Required date'), txt(b.remarks, 1000), actor.id], c);
    for (const [i, l] of lines.entries()) {
      const s = isUuid(l.sku_id) ? await one('select customer_id from skus where id = $1', [l.sku_id], c) : null;
      if (!s) throw bad(`Line ${i + 1}: choose a SKU`);
      if (s.customer_id !== b.customer_id) throw bad(`Line ${i + 1}: that SKU belongs to another customer`);
      await c.query('insert into wh_order_lines (order_id, sku_id, qty, sort_order) values ($1,$2,$3,$4)', [o.id, l.sku_id, qty(l.qty, `Line ${i + 1}`), i]);
    }
    await event(c, actor, { order_id: o.id }, 'Order received', `${lines.length} line(s)`);
    return o;
  });
}
/**
 * Reserve stock for the order, earliest expiry first (FEFO), then oldest stock first. Only good, unexpired stock.
 * Not enough stock → refused with what is short, unless allow_partial (the rest stays open as a backorder).
 */
export async function reserveOrder(actor: Actor, id: string, b: any) {
  need(actor, 'warehouse.dispatch', 'warehouse.orders.create');
  await tx(async (c) => {
    const o = await loadOrder(id, c, true);
    if (!['open', 'reserved'].includes(o.status)) throw new ApiError(409, 'ORDER_STATE', `The order is already ${o.status}`);
    const lines = await q(`select ol.*, s.sku_code, (select coalesce(sum(qty),0) from wh_allocations where order_line_id = ol.id) reserved
      from wh_order_lines ol join skus s on s.id = ol.sku_id where ol.order_id = $1 order by ol.sort_order`, [id], c);
    const short: string[] = [];
    const plan: { line: string; balance: string; qty: string }[] = [];
    for (const l of lines) {
      let left = Number(l.qty) - Number(l.reserved);
      if (left <= 0) continue;
      const rows = await q(`select id, (qty_on_hand - qty_reserved) avail from stock_balances
        where sku_id = $1 and warehouse_id = $2 and condition = 'good' and qty_on_hand > qty_reserved
          and (expiry_date is null or expiry_date >= (now() at time zone 'Asia/Dubai')::date)
        order by expiry_date nulls last, first_received_at, id for update`, [l.sku_id, o.warehouse_id], c);
      for (const r of rows) {
        if (left <= 0) break;
        const take = Math.min(left, Number(r.avail));
        plan.push({ line: l.id, balance: r.id, qty: String(Math.round(take * 1000) / 1000) });
        left = Math.round((left - take) * 1000) / 1000;
      }
      if (left > 0) short.push(`${l.sku_code}: ${left} short`);
    }
    if (short.length && !b.allow_partial)
      throw new ApiError(409, 'NOT_ENOUGH_STOCK', `Not enough stock: ${short.join('; ')}. Reserve what there is and keep the rest open?`, { short });
    if (!plan.length) throw new ApiError(409, 'NOT_ENOUGH_STOCK', 'No stock available to reserve', { short });
    for (const p of plan) {
      await c.query('update stock_balances set qty_reserved = qty_reserved + $2::numeric, updated_at = now() where id = $1', [p.balance, p.qty]);
      await c.query('insert into wh_allocations (order_line_id, balance_id, qty) values ($1,$2,$3)', [p.line, p.balance, p.qty]);
    }
    await c.query(`update wh_orders set status = 'reserved', updated_at = now() where id = $1`, [id]);
    await event(c, actor, { order_id: id }, 'Stock reserved', short.length ? `Backorder: ${short.join('; ')}` : 'All lines fully reserved');
  });
  return getOrder(actor, id);
}
export async function pickOrder(actor: Actor, id: string) {
  need(actor, 'warehouse.dispatch');
  await tx(async (c) => {
    const o = await loadOrder(id, c, true);
    if (o.status !== 'reserved') throw new ApiError(409, 'ORDER_STATE', 'Reserve the stock first');
    await c.query(`update wh_orders set status = 'picked', picked_by = $2, picked_at = now(), updated_at = now() where id = $1`, [id, actor.id]);
    await event(c, actor, { order_id: id }, 'Picked');
  });
  return getOrder(actor, id);
}
export async function packOrder(actor: Actor, id: string, b: any) {
  need(actor, 'warehouse.dispatch');
  const pk = Number(b.packages);
  if (!Number.isInteger(pk) || pk < 1) throw bad('Enter the number of packages');
  const wt = b.gross_weight_kg === '' || b.gross_weight_kg == null ? null : Number(b.gross_weight_kg);
  if (wt !== null && (!Number.isFinite(wt) || wt < 0)) throw bad('Weight must be a number');
  await tx(async (c) => {
    const o = await loadOrder(id, c, true);
    if (o.status !== 'picked') throw new ApiError(409, 'ORDER_STATE', 'Pick the order first');
    await c.query(`update wh_orders set status = 'packed', packages = $2, gross_weight_kg = $3, packed_by = $4, packed_at = now(), updated_at = now() where id = $1`, [id, pk, wt, actor.id]);
    await event(c, actor, { order_id: id }, 'Packed', `${pk} package(s)${wt !== null ? `, ${wt} kg` : ''}`);
  });
  return getOrder(actor, id);
}
/** Dispatch: the reserved stock leaves — ledger rows written, on hand and reserved both go down. */
export async function dispatchOrder(actor: Actor, id: string, b: any) {
  need(actor, 'warehouse.dispatch');
  const ref = txt(b.dispatch_reference, 120);
  if (!ref) throw bad('Enter how it left: vehicle, courier AWB or transport request no.');
  await tx(async (c) => {
    const o = await loadOrder(id, c, true);
    if (o.status !== 'packed') throw new ApiError(409, 'ORDER_STATE', 'Pack the order first');
    const allocs = await q(`select a.id, a.qty, b.* , b.id balance_id from wh_allocations a join stock_balances b on b.id = a.balance_id
      join wh_order_lines ol on ol.id = a.order_line_id where ol.order_id = $1 order by b.id for update of b`, [id], c);
    if (!allocs.length) throw bad('Nothing reserved on this order');
    for (const a of allocs) {
      await c.query('update stock_balances set qty_reserved = qty_reserved - $2::numeric where id = $1', [a.balance_id, a.qty]);
      await post(c, actor, { warehouse_id: a.warehouse_id, location_id: a.location_id, sku_id: a.sku_id, customer_id: a.customer_id,
        batch_no: a.batch_no, expiry_date: a.expiry_date, condition: a.condition }, '-' + a.qty, { kind: 'dispatch', source_type: 'order', source_id: id, reference: o.order_no });
    }
    await c.query(`update wh_orders set status = 'dispatched', dispatch_reference = $2, dispatched_by = $3, dispatched_at = now(), updated_at = now() where id = $1`, [id, ref, actor.id]);
    await event(c, actor, { order_id: id }, 'Dispatched', ref);
  });
  return getOrder(actor, id);
}
/** Cancel before dispatch: every reservation is released. */
export async function cancelOrder(actor: Actor, id: string, b: any) {
  need(actor, 'warehouse.dispatch', 'warehouse.orders.create');
  const reason = txt(b.reason, 300);
  if (!reason) throw bad('Give a reason');
  await tx(async (c) => {
    const o = await loadOrder(id, c, true);
    if (['dispatched', 'cancelled'].includes(o.status)) throw new ApiError(409, 'ORDER_STATE', `The order is already ${o.status}`);
    const allocs = await q(`select a.id, a.balance_id, a.qty from wh_allocations a join wh_order_lines ol on ol.id = a.order_line_id where ol.order_id = $1`, [id], c);
    for (const a of allocs) await c.query('update stock_balances set qty_reserved = qty_reserved - $2::numeric where id = $1', [a.balance_id, a.qty]);
    await c.query('delete from wh_allocations where id = any($1)', [allocs.map((a) => a.id)]);
    await c.query(`update wh_orders set status = 'cancelled', cancel_reason = $2, updated_at = now() where id = $1`, [id, reason]);
    await event(c, actor, { order_id: id }, 'Cancelled', `${reason}${allocs.length ? ' — reserved stock released' : ''}`);
  });
  return getOrder(actor, id);
}

// ------------------------------------------------------------ reports
export async function warehouseReport(actor: Actor, def: any, cols: any[], colsOut: any[], p: Record<string, string>, opts: { all?: boolean }) {
  view(actor);
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const ids = (alias: string) => {
    let w = '';
    for (const k of ['warehouse_id', 'customer_id']) if (p[k]) { if (!isUuid(p[k])) throw bad('Invalid filter'); w += ` and ${alias}.${k} = ${add(p[k])}`; }
    return w;
  };
  const period = (col: string) => (p.from && p.to ? ` and (${col} at time zone 'Asia/Dubai')::date between ${add(p.from)} and ${add(p.to)}` : '');
  let sql = '';
  switch (def.key) {
    case 'wh_stock': sql = `select c.name customer_name, w.code warehouse_code, l.code location_code, s.sku_code, s.name sku_name, s.uom, b.batch_no, b.expiry_date,
        b.condition, b.qty_on_hand, b.qty_reserved, (b.qty_on_hand - b.qty_reserved) qty_available
      from stock_balances b join skus s on s.id = b.sku_id join warehouse_locations l on l.id = b.location_id join warehouses w on w.id = b.warehouse_id
      join customers c on c.id = b.customer_id where b.qty_on_hand > 0${ids('b')}${p.q ? ` and (lower(s.sku_code) like ${add('%' + p.q.toLowerCase() + '%')} or lower(s.name) like $${params.length})` : ''}
      order by c.name, s.sku_code, l.code`; break;
    case 'wh_expiry': sql = `select c.name customer_name, w.code warehouse_code, l.code location_code, s.sku_code, s.name sku_name, b.batch_no, b.expiry_date,
        (b.expiry_date - (now() at time zone 'Asia/Dubai')::date) days_left, b.qty_on_hand
      from stock_balances b join skus s on s.id = b.sku_id join warehouse_locations l on l.id = b.location_id join warehouses w on w.id = b.warehouse_id
      join customers c on c.id = b.customer_id where b.qty_on_hand > 0 and b.expiry_date is not null
        and b.expiry_date <= (now() at time zone 'Asia/Dubai')::date + ${add(Number(p.days) || 90)}::int${ids('b')} order by b.expiry_date, c.name`; break;
    case 'wh_ledger': sql = `select t.at, c.name customer_name, w.code warehouse_code, l.code location_code, s.sku_code, s.name sku_name, t.batch_no, t.condition,
        t.kind, t.qty_change, t.balance_after, t.reference, t.reason, t.user_name
      from inventory_transactions t join skus s on s.id = t.sku_id join warehouse_locations l on l.id = t.location_id join warehouses w on w.id = t.warehouse_id
      join customers c on c.id = t.customer_id where true${ids('t')}${period('t.at')} order by t.at desc, t.id desc`; break;
    case 'wh_grn': sql = `select g.grn_no, g.received_at, c.name customer_name, w.code warehouse_code, f.job_no, g.supplier, g.reference, s.sku_code, s.name sku_name,
        gl.expected_qty, gl.received_qty, gl.damaged_qty, (coalesce(gl.received_qty,0) + coalesce(gl.damaged_qty,0) - gl.expected_qty) difference, gl.batch_no, gl.expiry_date
      from grn_lines gl join grns g on g.id = gl.grn_id join skus s on s.id = gl.sku_id join customers c on c.id = g.customer_id join warehouses w on w.id = g.warehouse_id
      left join job_files f on f.id = g.job_file_id where g.status = 'received'${ids('g')}${period('g.received_at')} order by g.received_at desc, g.grn_no, gl.sort_order`; break;
    case 'wh_dispatch': sql = `select o.order_no, o.dispatched_at, c.name customer_name, w.code warehouse_code, o.customer_reference, o.ship_to_name, s.sku_code, s.name sku_name,
        ol.qty, o.packages, o.dispatch_reference
      from wh_order_lines ol join wh_orders o on o.id = ol.order_id join skus s on s.id = ol.sku_id join customers c on c.id = o.customer_id join warehouses w on w.id = o.warehouse_id
      where o.status = 'dispatched'${ids('o')}${period('o.dispatched_at')} order by o.dispatched_at desc, o.order_no, ol.sort_order`; break;
    default: throw bad('Unknown report');
  }
  const size = opts.all ? 50000 : Math.min(Math.max(Number(p.page_size) || 100, 1), 500), page = opts.all ? 1 : Math.max(Number(p.page) || 1, 1);
  const rows = await q(`select x.*, count(*) over() _total from (${sql}) x limit ${size} offset ${(page - 1) * size}`, params);
  const KIND: Record<string, string> = { receipt: 'Received', move_out: 'Moved out', move_in: 'Moved in', adjust: 'Adjustment', condition_out: 'Condition change (out)',
    condition_in: 'Condition change (in)', dispatch: 'Dispatched' };
  const shaped = rows.map(({ _total, ...r }) => Object.fromEntries(cols.map((col: any) => [col.key, col.key === 'kind' ? KIND[r.kind] ?? r.kind : r[col.key]])));
  return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped, totals: null,
    total: Number(rows[0]?._total ?? 0), page, page_size: size, filters: p };
}
