/**
 * ERP export (migration 016). The ERP stays the system of record for invoices and accounts; RFS Ops only hands it
 * finished operational work to bill or pay:
 *   trip      completed truck trips          (customer, route, selling ex VAT, transport cost)
 *   pro       completed PRO requests         (customer, BL, containers, clearance charges paid — to re-bill)
 *   grn       received goods receipts        (customer, quantities in — handling in)
 *   dispatch  dispatched outbound orders     (customer, quantities out, packages — handling out)
 *   vendor    completed vendor requests      (vendor, cost — for the ERP's payables)
 *
 * No ERP API is assumed: the export is a CSV / Excel file in one fixed layout. Each record gets a stable external
 * reference (RFSOPS-…) and can only be in one live export (database unique index), so the same work is never sent
 * twice. The ERP result is typed back: the batch is confirmed with the ERP's reference, or single lines are marked
 * rejected with a reason — a rejected line becomes ready again, so nothing completed is ever silently lost.
 */
import { Actor } from './auth';
import { ApiError, bad, forbidden, getSetting, notFound, one, q, tx } from './db';

const UUID = /^[0-9a-f-]{36}$/i;
export const ERP_TYPES: Record<string, string> = { trip: 'Truck trip', pro: 'Customs clearance (PRO)', grn: 'Goods received', dispatch: 'Goods dispatched', vendor: 'Vendor service (cost)' };
const COLS: [string, string][] = [['external_ref', 'External reference'], ['type', 'Type'], ['date', 'Date'], ['customer', 'Customer / vendor'],
  ['job_no', 'Job No.'], ['reference', 'Our reference'], ['description', 'Description'], ['quantity', 'Quantity'], ['unit', 'Unit'],
  ['selling_amount', 'Selling amount (ex VAT)'], ['cost_amount', 'Cost amount'], ['currency', 'Currency']];
const canView = (a: Actor) => a.isSuperAdmin || a.has('erp.view') || a.has('erp.export');
const canExport = (a: Actor) => a.isSuperAdmin || a.has('erp.export');
const notExported = (type: string, idCol: string) => `not exists (select 1 from erp_items e where e.source_type = '${type}' and e.source_id = ${idCol} and e.status <> 'rejected')`;

/** Everything finished and not yet in a live export — same layout as the file. */
async function ready(types: string[] = Object.keys(ERP_TYPES), ids?: string[]) {
  const cur = String(await getSetting('currency', 'AED'));
  const only = (col: string) => (ids ? ` and ${col} = any($1::uuid[])` : '');
  const p = ids ? [ids] : [];
  const out: any[] = [];
  if (types.includes('trip')) for (const r of await q(`select t.id, t.job_number, t.job_no, t.required_date, t.pickup_name, t.delivery_name, c.name customer,
      (select coalesce(sum(amount),0) from job_revenue_lines where job_id = t.id) - coalesce(jc.discount, 0) selling,
      (select coalesce(sum(amount),0) from job_cost_lines where job_id = t.id) cost, vt.name vehicle_type
    from transport_requests t join customers c on c.id = t.customer_id left join job_commercials jc on jc.job_id = t.id
    left join vehicle_types vt on vt.id = t.requested_vehicle_type_id
    where t.deleted_at is null and t.status_code = 'completed' and ${notExported('trip', 't.id')}${only('t.id')} order by t.required_date`, p))
    out.push({ source_type: 'trip', source_id: r.id, external_ref: `RFSOPS-TRIP-${r.job_number}`, type: ERP_TYPES.trip, date: r.required_date, customer: r.customer,
      job_no: r.job_no, reference: r.job_number, description: `Transport ${r.pickup_name} → ${r.delivery_name}${r.vehicle_type ? ` (${r.vehicle_type})` : ''}`,
      quantity: '1', unit: 'trip', selling_amount: Number(r.selling).toFixed(2), cost_amount: Number(r.cost).toFixed(2), currency: cur });
  if (types.includes('pro')) for (const r of await q(`select r.id, r.request_no, r.job_no, r.bl_number, r.completed_at, c.name customer,
      (select count(*) from pro_containers k where k.request_id = r.id and k.deleted_at is null)::int containers,
      (select coalesce(sum(amount),0) from pro_charges g where g.request_id = r.id and g.deleted_at is null and not g.is_estimate) charges
    from pro_requests r join customers c on c.id = r.customer_id where r.deleted_at is null and r.status_code = 'completed'
      and ${notExported('pro', 'r.id')}${only('r.id')} order by r.completed_at`, p))
    out.push({ source_type: 'pro', source_id: r.id, external_ref: `RFSOPS-PRO-${r.request_no}`, type: ERP_TYPES.pro, date: String(new Date(r.completed_at).toISOString()).slice(0, 10),
      customer: r.customer, job_no: r.job_no, reference: r.request_no, description: `Customs clearance, BL ${r.bl_number}`,
      quantity: String(r.containers || 1), unit: r.containers ? 'container' : 'shipment', selling_amount: '', cost_amount: Number(r.charges).toFixed(2), currency: cur });
  if (types.includes('grn')) for (const r of await q(`select g.id, g.grn_no, g.received_at, c.name customer, f.job_no, w.code warehouse,
      (select coalesce(sum(coalesce(received_qty,0) + coalesce(damaged_qty,0)),0) from grn_lines where grn_id = g.id) qty
    from grns g join customers c on c.id = g.customer_id join warehouses w on w.id = g.warehouse_id left join job_files f on f.id = g.job_file_id
    where g.status = 'received' and ${notExported('grn', 'g.id')}${only('g.id')} order by g.received_at`, p))
    out.push({ source_type: 'grn', source_id: r.id, external_ref: `RFSOPS-GRN-${r.grn_no}`, type: ERP_TYPES.grn, date: new Date(r.received_at).toISOString().slice(0, 10),
      customer: r.customer, job_no: r.job_no ?? '', reference: r.grn_no, description: `Goods received into ${r.warehouse}`,
      quantity: String(Number(r.qty)), unit: 'units', selling_amount: '', cost_amount: '', currency: cur });
  if (types.includes('dispatch')) for (const r of await q(`select o.id, o.order_no, o.dispatched_at, o.packages, o.customer_reference, c.name customer, f.job_no,
      (select coalesce(sum(qty),0) from wh_order_lines where order_id = o.id) qty
    from wh_orders o join customers c on c.id = o.customer_id left join job_files f on f.id = o.job_file_id
    where o.status = 'dispatched' and ${notExported('dispatch', 'o.id')}${only('o.id')} order by o.dispatched_at`, p))
    out.push({ source_type: 'dispatch', source_id: r.id, external_ref: `RFSOPS-WO-${r.order_no}`, type: ERP_TYPES.dispatch, date: new Date(r.dispatched_at).toISOString().slice(0, 10),
      customer: r.customer, job_no: r.job_no ?? '', reference: r.order_no, description: `Order dispatched${r.customer_reference ? ` (PO ${r.customer_reference})` : ''}, ${r.packages ?? 0} package(s)`,
      quantity: String(Number(r.qty)), unit: 'units', selling_amount: '', cost_amount: '', currency: cur });
  if (types.includes('vendor')) for (const r of await q(`select r.id, r.request_no, r.completed_at, r.service, r.description, r.quoted_cost, r.currency, r.vendor_reference,
      v.name vendor, f.job_no from vendor_requests r join vendors v on v.id = r.vendor_id left join job_files f on f.id = r.job_file_id
    where r.status = 'completed' and ${notExported('vendor', 'r.id')}${only('r.id')} order by r.completed_at`, p))
    out.push({ source_type: 'vendor', source_id: r.id, external_ref: `RFSOPS-VR-${r.request_no}`, type: ERP_TYPES.vendor, date: new Date(r.completed_at).toISOString().slice(0, 10),
      customer: r.vendor, job_no: r.job_no ?? '', reference: r.vendor_reference ? `${r.request_no} / ${r.vendor_reference}` : r.request_no,
      description: r.description.slice(0, 200), quantity: '1', unit: 'service', selling_amount: '', cost_amount: r.quoted_cost === null ? '' : Number(r.quoted_cost).toFixed(2), currency: r.currency });
  return out;
}

export async function erpOverview(actor: Actor) {
  if (!canView(actor)) throw forbidden();
  const items = await ready();
  const batches = await q(`select b.*, u.full_name created_by_name, cu.full_name confirmed_by_name,
      (select count(*) filter (where status = 'rejected')::int from erp_items where batch_id = b.id) rejected
    from erp_batches b join users u on u.id = b.created_by left join users cu on cu.id = b.confirmed_by order by b.created_at desc limit 100`);
  const counts = await one(`select count(*) filter (where status = 'exported')::int exported, count(*) filter (where status = 'confirmed')::int confirmed,
    count(*) filter (where status = 'rejected')::int rejected from erp_items`);
  return { ready: items, ready_by_type: Object.fromEntries(Object.keys(ERP_TYPES).map((k) => [k, items.filter((i) => i.source_type === k).length])),
    batches, counts, types: ERP_TYPES, can: { export: canExport(actor) } };
}

/** Put the chosen ready records (or all of the chosen types) into a new export. Records exported meanwhile by someone else are skipped. */
export async function createBatch(actor: Actor, b: any) {
  if (!canExport(actor)) throw forbidden();
  const types = (Array.isArray(b.types) ? b.types : Object.keys(ERP_TYPES)).filter((t: string) => ERP_TYPES[t]);
  const ids = Array.isArray(b.source_ids) ? b.source_ids.filter((x: unknown) => typeof x === 'string' && UUID.test(x)) : undefined;
  return tx(async (c) => {
    const items = await ready(types, ids);
    if (!items.length) throw new ApiError(409, 'NOTHING_READY', 'Nothing is waiting to go to the ERP');
    const batch = await one(`insert into erp_batches (batch_no, created_by, note) values ('ERP-' || nextval('erp_batch_no_seq'), $1, $2) returning id, batch_no`,
      [actor.id, String(b.note ?? '').trim().slice(0, 300) || null], c);
    let n = 0;
    for (const it of items) {
      // the unique index refuses a record already in a live export (two people exporting at once): skip it
      const r = await c.query(`insert into erp_items (batch_id, source_type, source_id, external_ref, payload) values ($1,$2,$3,$4,$5)
        on conflict (source_type, source_id) where status <> 'rejected' do nothing`, [batch.id, it.source_type, it.source_id, it.external_ref, JSON.stringify(it)]);
      n += r.rowCount ?? 0;
    }
    if (!n) throw new ApiError(409, 'NOTHING_READY', 'Everything chosen was already exported');
    await c.query('update erp_batches set record_count = $2 where id = $1', [batch.id, n]);
    return { id: batch.id, batch_no: batch.batch_no, record_count: n };
  });
}

export async function getBatch(actor: Actor, id: string) {
  if (!canView(actor)) throw forbidden();
  if (!UUID.test(id)) throw notFound('Export');
  const b = await one('select b.*, u.full_name created_by_name from erp_batches b join users u on u.id = b.created_by where b.id = $1', [id]);
  if (!b) throw notFound('Export');
  const items = await q('select id, source_type, external_ref, status, reject_reason, payload from erp_items where batch_id = $1 order by source_type, external_ref', [id]);
  return { ...b, items, can: { export: canExport(actor) } };
}

/** The ERP result: confirm the whole export (with the ERP's reference) and/or reject single lines with a reason. */
export async function batchAction(actor: Actor, id: string, b: any) {
  if (!canExport(actor)) throw forbidden();
  await tx(async (c) => {
    const batch = await one('select * from erp_batches where id = $1 for update', [id], c);
    if (!batch) throw notFound('Export');
    if (b.what === 'reject') {
      if (!UUID.test(String(b.item_id ?? ''))) throw bad('Choose the line');
      const reason = String(b.reason ?? '').trim().slice(0, 300);
      if (!reason) throw bad('Write why the ERP rejected it');
      const r = await c.query(`update erp_items set status = 'rejected', reject_reason = $3 where id = $1 and batch_id = $2 and status <> 'rejected'`, [b.item_id, id, reason]);
      if (!r.rowCount) throw notFound('Line');
      await c.query(`update erp_batches set status = 'partly_rejected' where id = $1`, [id]);
    } else if (b.what === 'confirm') {
      const ref = String(b.erp_reference ?? '').trim().slice(0, 80);
      if (!ref) throw bad("Type the ERP's import / journal reference");
      await c.query(`update erp_items set status = 'confirmed' where batch_id = $1 and status = 'exported'`, [id]);
      await c.query(`update erp_batches set status = case when exists (select 1 from erp_items where batch_id = $1 and status = 'rejected') then 'partly_rejected' else 'confirmed' end,
        erp_reference = $2, confirmed_by = $3, confirmed_at = now() where id = $1`, [id, ref, actor.id]);
    } else throw bad('Unknown action');
  });
  return getBatch(actor, id);
}

/** The export file: CSV (UTF-8, Excel-safe) or Excel, always the same columns. */
export async function batchFile(actor: Actor, id: string, format: string) {
  const b = await getBatch(actor, id);
  const rows = b.items.filter((i: any) => i.status !== 'rejected').map((i: any) => i.payload);
  if (format === 'csv') {
    const esc = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [COLS.map(([, l]) => esc(l)).join(','), ...rows.map((r: any) => COLS.map(([k]) => esc(r[k])).join(','))];
    return { body: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), type: 'text/csv; charset=utf-8', name: `${b.batch_no}.csv` };
  }
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(b.batch_no);
  ws.columns = COLS.map(([k, l]) => ({ header: l, key: k, width: k === 'description' ? 44 : k === 'external_ref' ? 26 : 16 }));
  for (const r of rows) ws.addRow({ ...r, quantity: r.quantity === '' ? null : Number(r.quantity),
    selling_amount: r.selling_amount === '' ? null : Number(r.selling_amount), cost_amount: r.cost_amount === '' ? null : Number(r.cost_amount) });
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const k of ['selling_amount', 'cost_amount']) ws.getColumn(k).numFmt = '#,##0.00';
  return { body: Buffer.from(await wb.xlsx.writeBuffer()), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: `${b.batch_no}.xlsx` };
}
