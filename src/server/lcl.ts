/**
 * LCL consolidation (Part F, migration 019).
 *
 * A consolidation is one container: one carrier booking, one Master BL, many house shipments (each its own HBL and
 * cargo owner). Own-customer house shipments point to their shipment record, so nothing is typed twice and each
 * one stays traceable on its own. Cargo is received into a warehouse bin (packages / kg / CBM, partly if needed —
 * declared figures are kept and differences recorded), verified, stuffed, sealed and dispatched. When the container
 * departs or arrives, each linked shipment gets that date only where it has no date of its own yet.
 */
import { randomUUID } from 'crypto';
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, notFound, one, q, tx } from './db';
import { fileStore } from './storage';
import { sign, unsign, MAX_BYTES } from './documents';
import { DIVISIONS, divisionName } from '../lib/commercialRules';
import { LCL_STATUS, OWNER_TYPES, LCL_DOC_TYPES, RECEIVING, STUFFING, lclStatusName, receivingName } from '../lib/lclRules';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const txt = (v: unknown, max = 200) => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  if (t.length > max) throw bad(`Value too long (max ${max} characters)`);
  return t || null;
};
const day = (v: unknown, lbl: string) => {
  if (v === undefined || v === null || v === '') return null;
  if (!DATE.test(String(v))) throw bad(`${lbl} is not a valid date`);
  return String(v);
};
const num = (v: unknown, lbl: string, dp: number) => {
  const s = String(v ?? '').trim();
  if (s === '') throw bad(`Enter the ${lbl}`);
  if (!new RegExp(`^\\d+(\\.\\d{1,${dp}})?$`).test(s)) throw bad(`${lbl[0].toUpperCase() + lbl.slice(1)} must be a number (up to ${dp} decimals)`);
  return s;
};
const int = (v: unknown, lbl: string, min = 1) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw bad(`${lbl} must be a whole number${min > 0 ? ' above 0' : ''}`);
  return n;
};

export const canSeeLcl = (a: Actor) => a.isSuperAdmin || ['lcl.view', 'lcl.manage', 'lcl.receive', 'lcl.stuff'].some((p) => a.has(p as any));
const need = (a: Actor, p: 'lcl.manage' | 'lcl.receive' | 'lcl.stuff') => { if (!a.isSuperAdmin && !a.has(p)) throw forbidden(); };

async function evt(db: Db, actor: Actor, conId: string, e: { title: string; shipment_id?: string | null; field?: string; old_value?: unknown; new_value?: unknown; remarks?: string | null }) {
  const s = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 1000));
  await db.query(`insert into consolidation_events (consolidation_id, shipment_id, title, field, old_value, new_value, remarks, user_id, user_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [conId, e.shipment_id ?? null, e.title, e.field ?? null, s(e.old_value), s(e.new_value), e.remarks ?? null, actor.id, actor.full_name]);
}
async function fileEvent(db: Db, actor: Actor, fileId: string, title: string, newValue?: string | null) {
  await db.query(`insert into job_file_events (job_file_id, kind, title, new_value, user_id, user_name) values ($1,'link',$2,$3,$4,$5)`, [fileId, title, newValue ?? null, actor.id, actor.full_name]);
}
async function refreshSearch(db: Db, id: string) {
  await db.query(`update consolidations c set search_text = lower(concat_ws(' ', c.con_ref, c.mbl_no, c.container_no, c.carrier_booking_id, c.carrier, c.pol, c.pod, c.origin, c.destination,
      (select string_agg(concat_ws(' ', s.hbl_no, s.shipper, s.consignee, cu.name, v.name, f.job_no, f.enquiry_ref, f.shipping_ref), ' ')
         from consolidation_shipments s left join customers cu on cu.id = s.customer_id left join vendors v on v.id = s.partner_vendor_id
         left join job_files f on f.id = s.job_file_id where s.consolidation_id = c.id and s.removed_at is null))) where c.id = $1`, [id]);
}

// ------------------------------------------------------------ list (Consolidation register)
// totals per consolidation (active house shipments only)
const TOTALS = `(select count(*) from consolidation_shipments s where s.consolidation_id = c.id and s.removed_at is null)::int total_hbls,
  (select coalesce(sum(s.packages),0) from consolidation_shipments s where s.consolidation_id = c.id and s.removed_at is null)::int total_packages,
  (select coalesce(sum(s.gross_weight_kg),0) from consolidation_shipments s where s.consolidation_id = c.id and s.removed_at is null) total_weight_kg,
  (select coalesce(sum(s.volume_cbm),0) from consolidation_shipments s where s.consolidation_id = c.id and s.removed_at is null) total_cbm,
  (select count(*) from consolidation_shipments s where s.consolidation_id = c.id and s.removed_at is null and s.receiving_status in ('received','discrepancy'))::int received_hbls,
  (select count(*) from consolidation_shipments s where s.consolidation_id = c.id and s.removed_at is null and s.receiving_status = 'discrepancy')::int discrepancy_hbls,
  (select count(*) from consolidation_shipments s where s.consolidation_id = c.id and s.removed_at is null and s.stuffing_status = 'stuffed')::int stuffed_hbls,
  ct.capacity_cbm, ct.max_payload_kg`;
const shapeCon = (r: any) => {
  const util = r.capacity_cbm ? Math.round((Number(r.total_cbm) / Number(r.capacity_cbm)) * 1000) / 10 : null;
  return { ...r, search_text: undefined, status_name: lclStatusName(r.status), status_color: LCL_STATUS.find((s) => s[0] === r.status)?.[2],
    division_name: divisionName(r.division), utilisation_pct: util,
    receiving_summary: r.total_hbls ? `${r.received_hbls} of ${r.total_hbls} received${r.discrepancy_hbls ? ` (${r.discrepancy_hbls} with differences)` : ''}` : 'No cargo yet',
    stuffing_summary: ['stuffed', 'sealed', 'dispatched', 'departed', 'arrived', 'closed'].includes(r.status) ? `Stuffed (${r.stuffed_hbls} of ${r.total_hbls})`
      : r.status === 'stuffing' ? `Stuffing (${r.stuffed_hbls} of ${r.total_hbls})` : r.status === 'ready' ? 'Ready for stuffing' : 'Not started' };
};
export const LCL_VIEWS: Record<string, string> = {
  active: `c.status not in ('closed','cancelled')`, receiving: `c.status in ('open','ready')`, stuffing: `c.status in ('ready','stuffing','stuffed','sealed')`,
  in_transit: `c.status in ('dispatched','departed')`, arrived: `c.status = 'arrived'`, closed: `c.status = 'closed'`, cancelled: `c.status = 'cancelled'`,
  mbl: `c.mbl_no is not null`, all: 'true',
};
export async function listConsolidations(actor: Actor, p: Record<string, string>) {
  if (!canSeeLcl(actor)) throw forbidden();
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let w = 'where c.deleted_at is null';
  const v = LCL_VIEWS[p.view || 'active']; if (!v) throw bad('Unknown view'); w += ` and (${v})`;
  if (p.status) w += ` and c.status = ${add(p.status)}`;
  if (p.division) w += ` and c.division = ${add(p.division)}`;
  if (p.q?.trim()) w += ` and c.search_text like ${add(`%${p.q.trim().toLowerCase()}%`)}`;
  if (p.from) { day(p.from, 'From'); w += ` and c.etd >= ${add(p.from)}`; }
  if (p.to) { day(p.to, 'To'); w += ` and c.etd <= ${add(p.to)}`; }
  const SORT: Record<string, string> = { con_ref: 'c.con_ref', etd: 'c.etd', eta: 'c.eta', status: 'c.status', container: 'c.container_no', created: 'c.created_at', pod: 'c.pod' };
  const sort = SORT[p.sort] ?? 'c.etd'; const dir = p.dir === 'desc' ? 'desc' : 'asc';
  const size = Math.min(200, Math.max(1, Number(p.page_size) || 50)); const page = Math.max(1, Number(p.page) || 1);
  const rows = await q(`select c.*, ${TOTALS}, count(*) over() _total from consolidations c left join container_types ct on ct.code = c.container_type ${w}
    order by ${sort} ${dir} nulls last, c.created_at desc limit ${size} offset ${(page - 1) * size}`, params);
  return { rows: rows.map(shapeCon), total: Number(rows[0]?._total ?? 0), page, page_size: size };
}

// ------------------------------------------------------------ detail
async function loadCon(id: string, db?: Db, lock = false) {
  if (!isUuid(id)) throw notFound('Consolidation');
  const c = await one(`select * from consolidations where id = $1 and deleted_at is null${lock ? ' for update' : ''}`, [id], db);
  if (!c) throw notFound('Consolidation');
  return c;
}
export async function getConsolidation(actor: Actor, id: string) {
  if (!canSeeLcl(actor)) throw forbidden();
  await loadCon(id);
  const c = shapeCon(await one(`select c.*, ${TOTALS}, w.name warehouse_name, u.full_name created_by_name, sb.full_name stuffed_by_name, cv.name carrier_vendor_name
    from consolidations c left join container_types ct on ct.code = c.container_type left join warehouses w on w.id = c.warehouse_id
    left join users u on u.id = c.created_by left join users sb on sb.id = c.stuffed_by left join vendors cv on cv.id = c.carrier_vendor_id where c.id = $1`, [id]));
  const shipments = await q(`select s.*, cu.name customer_name, pv.name partner_name, f.job_no, f.enquiry_ref, f.shipping_ref, f.status file_status, f.stage file_stage,
      sm.full_name salesman_name, co.full_name coordinator_name, vb.full_name verified_by_name,
      coalesce(r.pk, 0)::int received_packages, coalesce(r.kg, 0) received_weight_kg, coalesce(r.cbm, 0) received_cbm, coalesce(r.n, 0)::int receipt_count,
      (select count(*) from consolidation_documents d where d.shipment_id = s.id and d.deleted_at is null and d.replaced_at is null)::int documents
    from consolidation_shipments s left join customers cu on cu.id = s.customer_id left join vendors pv on pv.id = s.partner_vendor_id
    left join job_files f on f.id = s.job_file_id left join users sm on sm.id = f.salesman_id left join users co on co.id = f.coordinator_id
    left join users vb on vb.id = s.cargo_verified_by
    left join lateral (select sum(packages) pk, sum(weight_kg) kg, sum(volume_cbm) cbm, count(*) n from lcl_receipts where shipment_id = s.id) r on true
    where s.consolidation_id = $1 and s.removed_at is null order by s.created_at`, [id]);
  const receipts = await q(`select r.*, l.code location_code from lcl_receipts r left join warehouse_locations l on l.id = r.location_id
    where r.shipment_id = any($1) order by r.received_at desc`, [shipments.map((s) => s.id)]);
  const removed = await q(`select s.id, s.hbl_no, s.shipper, s.removed_at, s.removed_reason from consolidation_shipments s where s.consolidation_id = $1 and s.removed_at is not null order by s.removed_at`, [id]);
  const documents = await q(`select d.id, d.doc_type, d.file_name, d.version, d.description, d.shipment_id, d.uploaded_at, u.full_name uploaded_by_name, d.replaced_at
    from consolidation_documents d join users u on u.id = d.uploaded_by where d.consolidation_id = $1 and d.deleted_at is null order by d.uploaded_at desc`, [id]);
  const events = await q(`select e.title, e.field, e.old_value, e.new_value, e.remarks, e.user_name, e.at, s.hbl_no
    from consolidation_events e left join consolidation_shipments s on s.id = e.shipment_id where e.consolidation_id = $1 order by e.at, e.id`, [id]);
  const locations = c.warehouse_id ? await q(`select id, code, location_type from warehouse_locations where warehouse_id = $1 and is_active order by location_type <> 'receiving', code`, [c.warehouse_id]) : [];
  const live = !['closed', 'cancelled'].includes(c.status);
  const manage = actor.isSuperAdmin || actor.has('lcl.manage');
  const receive = actor.isSuperAdmin || actor.has('lcl.receive');
  const stuff = actor.isSuperAdmin || actor.has('lcl.stuff');
  const open = ['open', 'ready'].includes(c.status);
  const allVerified = shipments.length > 0 && shipments.every((s) => s.cargo_verified_at || s.stuffing_status === 'shut_out');
  const milestones = [
    ['Booking confirmed', null, c.booking_confirmed_at], ['Cargo receiving deadline', c.receiving_deadline, null], ['Consolidation cut-off', c.cutoff_date, null],
    ['Stuffing', c.stuffing_date, c.stuffed_at], ['Container sealed', null, c.sealed_at], ['Dispatched to port', null, c.dispatched_at],
    ['Departed', c.etd, c.atd], ['Arrived', c.eta, c.ata], ['Closed', null, c.closed_at],
  ].map(([name, planned, actual]) => ({ name, planned, actual }));
  return {
    ...c, shipments, receipts, removed, documents, events, locations, milestones,
    totals: {
      packages: shipments.reduce((t, s) => t + s.packages, 0), weight_kg: shipments.reduce((t, s) => t + Number(s.gross_weight_kg), 0).toFixed(2),
      cbm: shipments.reduce((t, s) => t + Number(s.volume_cbm), 0).toFixed(3),
      received_packages: shipments.reduce((t, s) => t + s.received_packages, 0), received_weight_kg: shipments.reduce((t, s) => t + Number(s.received_weight_kg), 0).toFixed(2),
      received_cbm: shipments.reduce((t, s) => t + Number(s.received_cbm), 0).toFixed(3),
      payload_pct: c.max_payload_kg ? Math.round((shipments.reduce((t, s) => t + Number(s.gross_weight_kg), 0) / Number(c.max_payload_kg)) * 1000) / 10 : null,
    },
    container_types: await q('select code, name, capacity_cbm, max_payload_kg from container_types order by sort_order'),
    warehouses: await q('select id, name from warehouses where is_active order by name'),
    can: {
      edit: manage && live, add: manage && open, remove: manage && ['open', 'ready', 'stuffing'].includes(c.status),
      receive: receive && ['open', 'ready', 'stuffing'].includes(c.status), verify: receive && ['open', 'ready', 'stuffing'].includes(c.status),
      ready: manage && c.status === 'open' && allVerified, reopen: manage && c.status === 'ready',
      start_stuffing: stuff && c.status === 'ready', stuff: stuff && c.status === 'stuffing', complete_stuffing: stuff && c.status === 'stuffing',
      seal: stuff && c.status === 'stuffed', dispatch: stuff && c.status === 'sealed',
      departed: manage && ['sealed', 'dispatched'].includes(c.status), arrived: manage && c.status === 'departed',
      delivered: manage && ['arrived'].includes(c.status), close: manage && c.status === 'arrived',
      cancel: manage && ['open', 'ready', 'stuffing'].includes(c.status), documents: (manage || stuff) && c.status !== 'cancelled',
      booking: manage && live && !c.booking_confirmed_at,
    },
  };
}

// ------------------------------------------------------------ create / edit
const HEAD: Record<string, [string, number | 'date' | 'ref' | 'div' | 'dir' | 'ctype' | 'wh' | 'vendor' | 'container']> = {
  division: ['Division', 'div'], direction: ['Direction', 'dir'], origin: ['Origin', 120], destination: ['Destination', 120],
  pol: ['Port of loading', 120], pod: ['Port of discharge', 120], carrier: ['Shipping line', 120], carrier_vendor_id: ['Shipping line / co-loader (vendor)', 'vendor'],
  carrier_booking_id: ['Carrier booking ID', 60], container_type: ['Container type', 'ctype'], container_no: ['Container no.', 'container'],
  seal_no: ['Seal no.', 40], mbl_no: ['Master BL', 60], etd: ['ETD', 'date'], eta: ['ETA', 'date'], cutoff_date: ['Cut-off date', 'date'],
  receiving_deadline: ['Cargo receiving deadline', 'date'], stuffing_date: ['Stuffing date', 'date'], warehouse_id: ['Warehouse', 'wh'], remarks: ['Remarks', 2000],
};
async function headValues(b: any, db: Db) {
  const out: Record<string, unknown> = {};
  for (const [k, [lbl, kind]] of Object.entries(HEAD)) {
    if (b[k] === undefined) continue;
    const v = b[k] === '' ? null : b[k];
    if (v === null) { out[k] = null; continue; }
    if (typeof kind === 'number') out[k] = txt(v, kind);
    else if (kind === 'date') out[k] = day(v, lbl);
    else if (kind === 'div') { if (!DIVISIONS.some(([d]) => d === v)) throw bad('Choose the division'); out[k] = v; }
    else if (kind === 'dir') { if (!['import', 'export', 'cross_trade'].includes(v)) throw bad('Choose the direction'); out[k] = v; }
    else if (kind === 'ctype') { if (!(await one('select 1 from container_types where code = $1', [v], db))) throw bad('Choose the container type'); out[k] = v; }
    else if (kind === 'wh') { if (!isUuid(v) || !(await one('select 1 from warehouses where id = $1 and is_active', [v], db))) throw bad('Choose the warehouse'); out[k] = v; }
    else if (kind === 'vendor') { if (!isUuid(v) || !(await one('select 1 from vendors where id = $1 and deleted_at is null', [v], db))) throw bad('Choose the shipping line'); out[k] = v; }
    else if (kind === 'container') { const { normContainer } = await import('./pro'); out[k] = normContainer(v); }
  }
  if (out.etd && out.eta && String(out.eta) < String(out.etd)) throw bad('ETA is before ETD');
  return out;
}
function uniqueProblem(e: any): never {
  if (e?.code === '23505') {
    if (String(e.constraint).includes('mbl')) throw new ApiError(409, 'DUPLICATE', 'This Master BL is already on another consolidation');
    if (String(e.constraint).includes('container')) throw new ApiError(409, 'DUPLICATE', 'This container is already on another live consolidation');
    if (String(e.constraint).includes('hbl')) throw new ApiError(409, 'DUPLICATE', 'This HBL number is already used for the same issuer (us or the same partner agent)');
    if (String(e.constraint).includes('file')) throw new ApiError(409, 'DUPLICATE', 'This shipment is already in a live consolidation');
  }
  throw e;
}

export async function createConsolidation(actor: Actor, b: any) {
  need(actor, 'lcl.manage');
  try {
    return await tx(async (c) => {
      const v = await headValues(b, c);
      if (!v.direction) v.direction = 'export';
      if (!v.pol && !v.origin) throw bad('Enter the port of loading or origin');
      if (!v.pod && !v.destination) throw bad('Enter the port of discharge or destination');
      const ref = (await one(`select 'CON-' || to_char(now() at time zone 'Asia/Dubai', 'YY') || '-' || lpad(nextval('consolidation_ref_seq')::text, 5, '0') r`, [], c)).r;
      const cols = Object.keys(v);
      const r = await one(`insert into consolidations (con_ref, created_by${cols.map((k) => `, ${k}`).join('')}) values ($1, $2${cols.map((_, i) => `, $${i + 3}`).join('')}) returning id, con_ref`,
        [ref, actor.id, ...cols.map((k) => v[k])], c);
      await evt(c, actor, r.id, { title: `Consolidation ${ref} created`, new_value: [v.pol ?? v.origin, v.pod ?? v.destination].join(' → ') });
      await refreshSearch(c, r.id);
      return r as { id: string; con_ref: string };
    });
  } catch (e) { return uniqueProblem(e); }
}

export async function updateConsolidation(actor: Actor, id: string, b: any) {
  need(actor, 'lcl.manage');
  try {
    await tx(async (c) => {
      const cur = await loadCon(id, c, true);
      if (['closed', 'cancelled'].includes(cur.status)) throw new ApiError(409, 'CON_STATE', `The consolidation is ${lclStatusName(cur.status).toLowerCase()}`);
      const v = await headValues(b, c);
      if (['stuffed', 'sealed', 'dispatched', 'departed', 'arrived'].includes(cur.status) && 'container_no' in v && v.container_no !== cur.container_no && !txt(b.reason, 300))
        throw bad('The container is already stuffed — give a reason for changing its number');
      const show = (x: unknown) => x instanceof Date ? x.toISOString().slice(0, 10) : x;
      for (const [k, val] of Object.entries(v)) {
        if (String(show(cur[k]) ?? '') === String(val ?? '')) continue;
        await c.query(`update consolidations set ${k} = $2, updated_at = now() where id = $1`, [id, val]);
        await evt(c, actor, id, { title: `${HEAD[k][0]} changed`, field: HEAD[k][0], old_value: show(cur[k]), new_value: val, remarks: txt(b.reason, 300) });
      }
      await refreshSearch(c, id);
    });
  } catch (e) { return uniqueProblem(e); }
  return getConsolidation(actor, id);
}

// ------------------------------------------------------------ house shipments
const SHP_TEXT: Record<string, [string, number]> = { shipper: ['Shipper', 300], consignee: ['Consignee', 300], notify_party: ['Notify party', 300], hbl_no: ['HBL no.', 60],
  cargo_description: ['Cargo', 1000], package_type: ['Package type', 40], dimensions: ['Dimensions', 300], marks: ['Marks and numbers', 500],
  special_handling: ['Special handling', 500], remarks: ['Remarks', 1000] };
function shipmentValues(b: any, partial: boolean) {
  const v: Record<string, unknown> = {};
  for (const [k, [, max]] of Object.entries(SHP_TEXT)) if (b[k] !== undefined) v[k] = txt(b[k], max);
  if (b.packages !== undefined || !partial) v.packages = int(b.packages, 'Packages');
  if (b.gross_weight_kg !== undefined || !partial) v.gross_weight_kg = num(b.gross_weight_kg, 'gross weight (kg)', 2);
  if (b.volume_cbm !== undefined || !partial) v.volume_cbm = num(b.volume_cbm, 'volume (CBM)', 3);
  if (b.expected_arrival !== undefined) v.expected_arrival = day(b.expected_arrival, 'Expected arrival');
  if (!partial && !v.cargo_description) throw bad('Describe the cargo');
  if (typeof v.hbl_no === 'string') v.hbl_no = v.hbl_no.toUpperCase();
  return v;
}

/** Receiving status from what arrived: nothing / some / all (and whether anything differs). */
async function recomputeReceiving(db: Db, shipmentId: string) {
  const s = await one(`select s.packages, s.gross_weight_kg, s.volume_cbm, s.receiving_status, coalesce(sum(r.packages),0)::int pk, coalesce(sum(r.weight_kg),0) kg, coalesce(sum(r.volume_cbm),0) cbm,
      bool_or(r.condition <> 'good') bad from consolidation_shipments s left join lcl_receipts r on r.shipment_id = s.id where s.id = $1 group by s.id`, [shipmentId], db);
  const off = (a: number, b: number) => b > 0 ? Math.abs(a - b) / b > 0.05 : a > 0;
  const status = s.pk === 0 ? 'expected' : s.pk < s.packages ? 'partial'
    : (s.bad || s.pk > s.packages || off(Number(s.kg), Number(s.gross_weight_kg)) || off(Number(s.cbm), Number(s.volume_cbm))) ? 'discrepancy' : 'received';
  if (status !== s.receiving_status) {
    await db.query(`update consolidation_shipments set receiving_status = $2, cargo_verified_at = case when $2 in ('expected','partial') then null else cargo_verified_at end,
      updated_at = now() where id = $1`, [shipmentId, status]);
  }
  return { status, ...s };
}

/** Everything that happens to a consolidation and its house shipments, one action at a time. */
export async function consolidationAction(actor: Actor, id: string, b: any) {
  const action = String(b.action ?? '');
  try {
    await tx(async (c) => {
      const con = await loadCon(id, c, true);
      const st = con.status;
      const must = (...ok: string[]) => { if (!ok.includes(st)) throw new ApiError(409, 'CON_STATE', `Not possible while the consolidation is "${lclStatusName(st)}"`); };
      const shp = async () => {
        if (!isUuid(b.shipment_id)) throw bad('Choose the house shipment');
        const s = await one('select * from consolidation_shipments where id = $1 and consolidation_id = $2 and removed_at is null for update', [b.shipment_id, id], c);
        if (!s) throw notFound('House shipment');
        return s;
      };
      const ref = con.con_ref;
      switch (action) {
        case 'note': { const n = txt(b.note, 2000); if (!n) throw bad('Write the note'); await evt(c, actor, id, { title: 'Note', new_value: n }); break; }
        case 'add_shipment': {
          need(actor, 'lcl.manage'); must('open', 'ready');
          let v: Record<string, unknown>;
          if (b.job_file_id) {
            // own customer: from the shipment record — nothing is typed twice
            // one container carries cargo of different Salesmen / Coordinators: an LCL manager may add any confirmed LCL shipment
            const f = isUuid(b.job_file_id) && await one('select * from job_files where id = $1 and deleted_at is null for update', [b.job_file_id], c);
            if (!f) throw notFound('Shipment');
            if (f.mode !== 'sea_lcl') throw bad(`${f.job_no ?? f.enquiry_ref} is not a Sea LCL shipment`);
            if (['closed', 'cancelled'].includes(f.status)) throw bad(`${f.job_no ?? f.enquiry_ref} is ${f.status}`);
            if (f.stage && !['customer_confirmed', 'booking_requested', 'booking_confirmed', 'prealert_awaited', 'prealert_received', 'prealert_verified', 'handed_over'].includes(f.stage))
              throw bad(`${f.enquiry_ref} is not confirmed by the customer yet`);
            const m = { ...b };
            for (const [k, src] of [['shipper', 'shipper'], ['consignee', 'consignee'], ['notify_party', 'notify_party'], ['hbl_no', 'hbl_hawb'], ['cargo_description', 'cargo_description'],
              ['packages', 'packages'], ['gross_weight_kg', 'gross_weight_kg'], ['volume_cbm', 'volume_cbm']] as const)
              if ((m[k] === undefined || m[k] === '') && f[src] !== null && f[src] !== undefined) m[k] = f[src];
            if (!m.cargo_description) m.cargo_description = 'As per shipment';
            v = { ...shipmentValues(m, false), owner_type: 'own_customer', job_file_id: f.id, customer_id: f.customer_id };
          } else {
            const owner = String(b.owner_type ?? '');
            if (!OWNER_TYPES.some(([k]) => k === owner)) throw bad('Choose whose cargo it is');
            v = { ...shipmentValues(b, false), owner_type: owner };
            if (owner === 'own_customer') {
              if (!isUuid(b.customer_id) || !(await one('select 1 from customers where id = $1 and deleted_at is null', [b.customer_id], c))) throw bad('Choose the customer');
              v.customer_id = b.customer_id;
            }
            if (owner === 'partner_agent') {
              if (!isUuid(b.partner_vendor_id) || !(await one('select 1 from vendors where id = $1 and deleted_at is null', [b.partner_vendor_id], c))) throw bad('Choose the partner agent');
              v.partner_vendor_id = b.partner_vendor_id;
            }
            if (!v.shipper) throw bad('Enter the shipper');
            if (!v.consignee) throw bad('Enter the consignee');
          }
          const cols = Object.keys(v);
          const s = await one(`insert into consolidation_shipments (consolidation_id, created_by${cols.map((k) => `, ${k}`).join('')}) values ($1, $2${cols.map((_, i) => `, $${i + 3}`).join('')}) returning id`,
            [id, actor.id, ...cols.map((k) => v[k])], c);
          const who = v.job_file_id ? (await one('select coalesce(job_no, shipping_ref, enquiry_ref) r from job_files where id = $1', [v.job_file_id], c)).r : String(v.shipper);
          await evt(c, actor, id, { title: `House shipment added: ${v.hbl_no ?? 'no HBL yet'}`, shipment_id: s.id, new_value: `${who} — ${v.packages} pkgs, ${v.gross_weight_kg} kg, ${v.volume_cbm} CBM` });
          if (v.job_file_id) await fileEvent(c, actor, v.job_file_id as string, `Added to LCL consolidation ${ref}`, [con.container_no && `Container ${con.container_no}`, con.mbl_no && `MBL ${con.mbl_no}`].filter(Boolean).join(' · ') || null);
          break;
        }
        case 'update_shipment': {
          need(actor, 'lcl.manage');
          const s = await shp();
          if (!['open', 'ready', 'stuffing', 'stuffed', 'sealed', 'dispatched', 'departed', 'arrived'].includes(st)) must();
          const v = shipmentValues(b, true);
          if (['stuffed', 'sealed', 'dispatched', 'departed', 'arrived'].includes(st) && ['packages', 'gross_weight_kg', 'volume_cbm'].some((k) => k in v))
            throw bad('The container is already stuffed: declared quantities can no longer change (record differences as a note)');
          for (const [k, val] of Object.entries(v)) {
            const old = s[k] instanceof Date ? s[k].toISOString().slice(0, 10) : s[k];
            if (String(old ?? '') === String(val ?? '')) continue;
            await c.query(`update consolidation_shipments set ${k} = $2, updated_at = now() where id = $1`, [s.id, val]);
            const lbl = SHP_TEXT[k]?.[0] ?? { packages: 'Packages', gross_weight_kg: 'Gross weight (kg)', volume_cbm: 'Volume (CBM)', expected_arrival: 'Expected arrival' }[k] ?? k;
            await evt(c, actor, id, { title: `${lbl} changed (${s.hbl_no ?? 'house shipment'})`, shipment_id: s.id, field: lbl, old_value: old, new_value: val });
          }
          if (['packages', 'gross_weight_kg', 'volume_cbm'].some((k) => k in v)) await recomputeReceiving(c, s.id);
          break;
        }
        case 'remove_shipment': {
          need(actor, 'lcl.manage'); must('open', 'ready', 'stuffing');
          const s = await shp();
          if (s.stuffing_status === 'stuffed') throw bad('This cargo is already in the container — unload it first (mark shut out is not possible once stuffed)');
          const reason = txt(b.reason, 500); if (!reason) throw bad('Say why it is removed');
          await c.query('update consolidation_shipments set removed_at = now(), removed_by = $2, removed_reason = $3 where id = $1', [s.id, actor.id, reason]);
          await evt(c, actor, id, { title: `House shipment removed: ${s.hbl_no ?? s.shipper ?? ''}`, shipment_id: s.id, remarks: reason });
          if (s.job_file_id) await fileEvent(c, actor, s.job_file_id, `Removed from LCL consolidation ${ref}`, reason);
          break;
        }
        case 'receive': {
          need(actor, 'lcl.receive'); must('open', 'ready', 'stuffing');
          const s = await shp();
          const packages = int(b.packages, 'Packages received', 0);
          const weight = b.weight_kg === undefined || b.weight_kg === '' ? '0' : num(b.weight_kg, 'weight received (kg)', 2);
          const cbm = b.volume_cbm === undefined || b.volume_cbm === '' ? '0' : num(b.volume_cbm, 'CBM received', 3);
          if (packages === 0 && Number(weight) === 0 && Number(cbm) === 0) throw bad('Enter what was received (packages, weight or CBM)');
          const condition = String(b.condition ?? 'good');
          if (!['good', 'damaged', 'wet', 'short', 'other'].includes(condition)) throw bad('Choose the cargo condition');
          const note = txt(b.damage_note, 1000);
          if (condition !== 'good' && !note) throw bad('Describe the damage or shortage');
          let loc: string | null = null;
          if (b.location_id) {
            const l = isUuid(b.location_id) && await one('select warehouse_id from warehouse_locations where id = $1 and is_active', [b.location_id], c);
            if (!l) throw bad('Choose the warehouse location');
            if (con.warehouse_id && l.warehouse_id !== con.warehouse_id) throw bad('That location is in another warehouse');
            loc = b.location_id;
          }
          await c.query(`insert into lcl_receipts (shipment_id, inward_ref, packages, weight_kg, volume_cbm, condition, damage_note, location_id, remarks, received_by, received_by_name, received_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()))`,
            [s.id, txt(b.inward_ref, 60), packages, weight, cbm, condition, note, loc, txt(b.remarks, 500), actor.id, actor.full_name, b.received_at || null]);
          const r = await recomputeReceiving(c, s.id);
          await evt(c, actor, id, { title: `Cargo received for ${s.hbl_no ?? s.shipper ?? 'house shipment'}: ${packages} pkgs`, shipment_id: s.id,
            new_value: `Total ${r.pk} of ${s.packages} pkgs, ${Number(r.kg).toFixed(2)} of ${s.gross_weight_kg} kg, ${Number(r.cbm).toFixed(3)} of ${s.volume_cbm} CBM — ${receivingName(r.status)}`,
            remarks: condition !== 'good' ? `${condition}: ${note}` : null });
          if (s.job_file_id) await fileEvent(c, actor, s.job_file_id, `LCL cargo received at the warehouse (${ref})`, `${r.pk} of ${s.packages} pkgs — ${receivingName(r.status)}`);
          break;
        }
        case 'verify_cargo': {
          need(actor, 'lcl.receive'); must('open', 'ready', 'stuffing');
          const s = await shp();
          if (!['received', 'discrepancy'].includes(s.receiving_status)) throw bad('All packages must be received before the cargo can be verified');
          if (s.receiving_status === 'discrepancy' && !txt(b.note, 500)) throw bad('There are differences — say how they were settled before verifying');
          await c.query('update consolidation_shipments set cargo_verified_at = now(), cargo_verified_by = $2, updated_at = now() where id = $1', [s.id, actor.id]);
          await evt(c, actor, id, { title: `Cargo verified: ${s.hbl_no ?? s.shipper ?? ''}`, shipment_id: s.id, remarks: txt(b.note, 500) });
          break;
        }
        case 'ready': {
          need(actor, 'lcl.manage'); must('open');
          const left = await q(`select coalesce(hbl_no, shipper) n from consolidation_shipments where consolidation_id = $1 and removed_at is null and cargo_verified_at is null`, [id], c);
          const total = await one('select count(*)::int n from consolidation_shipments where consolidation_id = $1 and removed_at is null', [id], c);
          if (!total.n) throw bad('Add house shipments first');
          if (left.length) throw bad(`Cargo not yet verified: ${left.map((x) => x.n).join(', ')}`);
          await c.query(`update consolidations set status = 'ready', updated_at = now() where id = $1`, [id]);
          await evt(c, actor, id, { title: 'Ready for stuffing', field: 'Status', old_value: lclStatusName(st), new_value: lclStatusName('ready') });
          break;
        }
        case 'reopen': {
          need(actor, 'lcl.manage'); must('ready');
          await c.query(`update consolidations set status = 'open', updated_at = now() where id = $1`, [id]);
          await evt(c, actor, id, { title: 'Reopened for more cargo', remarks: txt(b.reason, 300) });
          break;
        }
        case 'booking_confirmed': {
          need(actor, 'lcl.manage');
          const bk = txt(b.carrier_booking_id, 60) ?? con.carrier_booking_id;
          if (!bk) throw bad('Enter the carrier booking ID');
          await c.query('update consolidations set carrier_booking_id = $2, booking_confirmed_at = now(), updated_at = now() where id = $1', [id, bk]);
          await evt(c, actor, id, { title: `Carrier booking confirmed — ${bk}` });
          break;
        }
        case 'start_stuffing': {
          need(actor, 'lcl.stuff'); must('ready');
          await c.query(`update consolidations set status = 'stuffing', stuffing_started_at = now(), updated_at = now() where id = $1`, [id]);
          await evt(c, actor, id, { title: 'Stuffing started', field: 'Status', old_value: lclStatusName(st), new_value: lclStatusName('stuffing') });
          break;
        }
        case 'stuff_shipment': {
          need(actor, 'lcl.stuff'); must('stuffing');
          const s = await shp();
          const result = String(b.result ?? 'stuffed');
          if (!['stuffed', 'shut_out', 'pending'].includes(result)) throw bad('Choose stuffed or shut out');
          if (result === 'shut_out' && !txt(b.reason, 500)) throw bad('Say why the cargo is shut out');
          if (result === 'stuffed' && !s.cargo_verified_at) throw bad('Verify the cargo first');
          await c.query('update consolidation_shipments set stuffing_status = $2, updated_at = now() where id = $1', [s.id, result]);
          await evt(c, actor, id, { title: result === 'stuffed' ? `Stuffed: ${s.hbl_no ?? s.shipper}` : result === 'shut_out' ? `Shut out: ${s.hbl_no ?? s.shipper}` : `Back to pending: ${s.hbl_no ?? s.shipper}`,
            shipment_id: s.id, remarks: txt(b.reason, 500) });
          if (s.job_file_id && result !== 'pending') await fileEvent(c, actor, s.job_file_id, result === 'stuffed' ? `Stuffed in container ${con.container_no ?? ''} (${ref})` : `Shut out of consolidation ${ref}`, txt(b.reason, 500));
          break;
        }
        case 'complete_stuffing': {
          need(actor, 'lcl.stuff'); must('stuffing');
          const { normContainer } = await import('./pro');
          const cont = b.container_no ? normContainer(b.container_no) : con.container_no;
          if (!cont) throw bad('Enter the container number');
          const open = await q(`select coalesce(hbl_no, shipper) n from consolidation_shipments where consolidation_id = $1 and removed_at is null and stuffing_status = 'pending'`, [id], c);
          if (open.length) throw bad(`Mark each house shipment stuffed or shut out first: ${open.map((x) => x.n).join(', ')}`);
          const n = await one(`select count(*)::int n from consolidation_shipments where consolidation_id = $1 and removed_at is null and stuffing_status = 'stuffed'`, [id], c);
          if (!n.n) throw bad('Nothing was stuffed');
          const sd = day(b.stuffing_date, 'Stuffing date');
          await c.query(`update consolidations set status = 'stuffed', container_no = $2, stuffed_at = now(), stuffed_by = $3, stuffing_date = coalesce($4, stuffing_date, (now() at time zone 'Asia/Dubai')::date),
            updated_at = now() where id = $1`, [id, cont, actor.id, sd]);
          await evt(c, actor, id, { title: `Stuffing completed — container ${cont}`, field: 'Status', old_value: lclStatusName(st), new_value: lclStatusName('stuffed'), remarks: txt(b.note, 500) });
          break;
        }
        case 'seal': {
          need(actor, 'lcl.stuff'); must('stuffed');
          const seal = txt(b.seal_no, 40); if (!seal) throw bad('Enter the seal number');
          await c.query(`update consolidations set status = 'sealed', seal_no = $2, sealed_at = now(), updated_at = now() where id = $1`, [id, seal.toUpperCase()]);
          await evt(c, actor, id, { title: `Container sealed — seal ${seal.toUpperCase()}`, field: 'Status', old_value: lclStatusName(st), new_value: lclStatusName('sealed') });
          break;
        }
        case 'dispatch': {
          need(actor, 'lcl.stuff'); must('sealed');
          await c.query(`update consolidations set status = 'dispatched', dispatched_at = now(), updated_at = now() where id = $1`, [id]);
          await evt(c, actor, id, { title: 'Container dispatched to the port', field: 'Status', old_value: lclStatusName(st), new_value: lclStatusName('dispatched'), remarks: txt(b.note, 500) });
          break;
        }
        case 'departed': case 'arrived': {
          need(actor, 'lcl.manage');
          if (action === 'departed') must('sealed', 'dispatched'); else must('departed');
          const when = day(b.date, action === 'departed' ? 'Departure date' : 'Arrival date') ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
          const col = action === 'departed' ? 'atd' : 'ata';
          await c.query(`update consolidations set status = $2, ${col} = $3::date, updated_at = now() where id = $1`, [id, action, when]);
          await evt(c, actor, id, { title: action === 'departed' ? `Container departed ${when}` : `Container arrived ${when}`, field: 'Status', old_value: lclStatusName(st), new_value: lclStatusName(action) });
          // two levels: each linked shipment gets the date only where it has none of its own
          const linked = await q(`select s.id, s.job_file_id from consolidation_shipments s where s.consolidation_id = $1 and s.removed_at is null and s.stuffing_status = 'stuffed' and s.job_file_id is not null`, [id], c);
          let filled = 0;
          for (const l of linked) {
            const f = await one(`select ${col} v from job_files where id = $1`, [l.job_file_id], c);
            const m = await one(`select id, actual_at from job_file_milestones where job_file_id = $1 and code = $2`, [l.job_file_id, action], c);
            const changed: string[] = [];
            if (!f.v) { await c.query(`update job_files set ${col} = $2, updated_at = now() where id = $1`, [l.job_file_id, when]); changed.push(col.toUpperCase()); }
            if (m && !m.actual_at) { await c.query(`update job_file_milestones set actual_at = ($2::date + time '12:00') at time zone 'Asia/Dubai', remarks = coalesce(remarks, $3), updated_at = now(), updated_by = $4 where id = $1`, [m.id, when, `From consolidation ${ref}`, actor.id]); changed.push('milestone'); }
            await fileEvent(c, actor, l.job_file_id, `${action === 'departed' ? 'Departed' : 'Arrived'} ${when} — LCL consolidation ${ref}`,
              changed.length ? `Filled: ${changed.join(', ')}` : 'Own dates already recorded — not changed');
            if (changed.length) filled++;
          }
          if (linked.length) await evt(c, actor, id, { title: `${linked.length} linked shipment(s) updated`, new_value: `${filled} had no date yet; others kept their own` });
          break;
        }
        case 'delivered': {
          need(actor, 'lcl.manage'); must('arrived', 'closed');
          const s = await shp();
          await c.query(`update consolidation_shipments set delivery_status = 'delivered', delivered_at = coalesce($2::timestamptz, now()), updated_at = now() where id = $1`, [s.id, b.delivered_at || null]);
          await evt(c, actor, id, { title: `Delivered: ${s.hbl_no ?? s.consignee ?? ''}`, shipment_id: s.id, remarks: txt(b.note, 500) });
          break;
        }
        case 'close': {
          need(actor, 'lcl.manage'); must('arrived');
          await c.query(`update consolidations set status = 'closed', closed_at = now(), updated_at = now() where id = $1`, [id]);
          await evt(c, actor, id, { title: 'Consolidation closed', field: 'Status', old_value: lclStatusName(st), new_value: lclStatusName('closed'), remarks: txt(b.note, 500) });
          break;
        }
        case 'cancel': {
          need(actor, 'lcl.manage'); must('open', 'ready', 'stuffing');
          const reason = txt(b.reason, 500); if (!reason) throw bad('Say why the consolidation is cancelled');
          const live = await q(`update consolidation_shipments set removed_at = now(), removed_by = $2, removed_reason = $3 where consolidation_id = $1 and removed_at is null returning job_file_id`,
            [id, actor.id, `Consolidation cancelled: ${reason}`], c);
          await c.query(`update consolidations set status = 'cancelled', cancel_reason = $2, updated_at = now() where id = $1`, [id, reason]);
          await evt(c, actor, id, { title: 'Consolidation cancelled', field: 'Status', old_value: lclStatusName(st), new_value: lclStatusName('cancelled'), remarks: reason });
          for (const l of live) if (l.job_file_id) await fileEvent(c, actor, l.job_file_id, `LCL consolidation ${ref} cancelled — needs a new consolidation`, reason);
          break;
        }
        default: throw bad('Unknown action');
      }
      await refreshSearch(c, id);
    });
  } catch (e) { return uniqueProblem(e); }
  return getConsolidation(actor, id);
}

// ------------------------------------------------------------ documents (MBL / HBL drafts and finals, stuffing report…)
const FILE_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'message/rfc822': 'eml', 'application/vnd.ms-outlook': 'msg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
export async function requestConUpload(actor: Actor, id: string, b: any) {
  if (!actor.isSuperAdmin && !actor.has('lcl.manage') && !actor.has('lcl.stuff')) throw forbidden();
  const con = await loadCon(id);
  if (con.status === 'cancelled') throw new ApiError(409, 'CON_STATE', 'The consolidation is cancelled');
  const mime = String(b.mime_type ?? '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!FILE_TYPES[mime]) throw bad('Upload a PDF, image, Excel, Word or saved email file');
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) throw bad('The file is empty');
  if (size > MAX_BYTES) throw bad('Files can be up to 10 MB');
  if (!LCL_DOC_TYPES.some(([k]) => k === b.doc_type)) throw bad('Choose the document type');
  if (b.shipment_id && !(isUuid(b.shipment_id) && await one('select 1 from consolidation_shipments where id = $1 and consolidation_id = $2 and removed_at is null', [b.shipment_id, id])))
    throw bad('Choose the house shipment');
  if (b.replaces_id && !(isUuid(b.replaces_id) && await one('select 1 from consolidation_documents where id = $1 and consolidation_id = $2 and replaced_at is null and deleted_at is null', [b.replaces_id, id])))
    throw bad('The document to replace was not found');
  const name = String(b.file_name ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || `document.${FILE_TYPES[mime]}`;
  const key = `consolidations/${id}/${randomUUID()}.${FILE_TYPES[mime]}`;
  const upload = await fileStore().createUpload(key, mime);
  const ticket = sign({ con: id, key, name, mime, uid: actor.id, doc_type: b.doc_type, shipment_id: b.shipment_id || null, replaces_id: b.replaces_id || null,
    description: String(b.description ?? '').trim().slice(0, 300) || null, exp: Date.now() + 3600_000 });
  return { upload, ticket };
}
export async function confirmConUpload(actor: Actor, id: string, b: any) {
  const t = unsign(b.ticket);
  if (t.con !== id || t.uid !== actor.id) throw forbidden('This upload belongs to someone else');
  const info = await fileStore().stat(t.key);
  if (!info) throw new ApiError(409, 'UPLOAD_MISSING', 'The file did not arrive. Please try again.');
  if (info.size > MAX_BYTES) { await fileStore().remove(t.key); throw bad('Files can be up to 10 MB'); }
  await tx(async (c) => {
    let version = 1;
    if (t.replaces_id) {
      const old = await one('update consolidation_documents set replaced_at = now() where id = $1 and replaced_at is null returning version', [t.replaces_id], c);
      if (!old) throw new ApiError(409, 'DOC_STATE', 'That document was already replaced');
      version = old.version + 1;
    }
    await c.query(`insert into consolidation_documents (consolidation_id, shipment_id, doc_type, file_name, storage_path, mime_type, size_bytes, version, replaces_id, description, uploaded_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, t.shipment_id, t.doc_type, t.name, t.key, t.mime, info.size, version, t.replaces_id, t.description, actor.id]);
    await evt(c, actor, id, { title: `${LCL_DOC_TYPES.find(([k]) => k === t.doc_type)?.[1]} uploaded${version > 1 ? ` (version ${version})` : ''}`, shipment_id: t.shipment_id, new_value: t.name });
  });
  return getConsolidation(actor, id);
}
export async function conDocumentUrl(actor: Actor, id: string, docId: string) {
  if (!canSeeLcl(actor)) throw forbidden();
  const d = isUuid(docId) && await one('select storage_path, file_name from consolidation_documents where id = $1 and consolidation_id = $2 and deleted_at is null', [docId, id]);
  if (!d) throw notFound('Document');
  return { url: await fileStore().downloadUrl(d.storage_path, d.file_name, false) };
}

// ------------------------------------------------------------ house shipment register (HBL register, pending receiving…)
const SHP_FROM = `from consolidation_shipments s join consolidations c on c.id = s.consolidation_id and c.deleted_at is null
  left join customers cu on cu.id = s.customer_id left join vendors pv on pv.id = s.partner_vendor_id left join job_files f on f.id = s.job_file_id
  left join users sm on sm.id = f.salesman_id left join users co on co.id = f.coordinator_id
  left join lateral (select sum(packages) pk, sum(weight_kg) kg, sum(volume_cbm) cbm from lcl_receipts where shipment_id = s.id) r on true`;
const SHP_COLS = `s.id, s.consolidation_id, s.owner_type, s.hbl_no, s.shipper, s.consignee, s.cargo_description, s.packages, s.gross_weight_kg, s.volume_cbm,
  s.receiving_status, s.stuffing_status, s.delivery_status, s.delivered_at, s.expected_arrival, s.special_handling, s.cargo_verified_at, s.job_file_id,
  c.con_ref, c.mbl_no, c.container_no, c.status con_status, c.etd, c.eta, c.atd, c.ata, c.pol, c.pod, c.carrier,
  coalesce(cu.name, pv.name, s.shipper) owner_name, cu.name customer_name, pv.name partner_name, f.job_no, f.enquiry_ref, f.shipping_ref, f.status file_status,
  sm.full_name salesman_name, co.full_name coordinator_name, coalesce(r.pk,0)::int received_packages, coalesce(r.kg,0) received_weight_kg, coalesce(r.cbm,0) received_cbm`;
export const SHP_VIEWS: Record<string, string> = {
  all: `s.removed_at is null`, hbl: `s.removed_at is null and s.hbl_no is not null`,
  pending_receiving: `s.removed_at is null and s.receiving_status in ('expected','partial') and c.status in ('open','ready','stuffing')`,
  discrepancy: `s.removed_at is null and s.receiving_status = 'discrepancy'`,
  to_verify: `s.removed_at is null and s.receiving_status in ('received','discrepancy') and s.cargo_verified_at is null and c.status in ('open','ready','stuffing')`,
  undelivered: `s.removed_at is null and s.delivery_status = 'pending' and c.status in ('arrived','closed')`,
};
const shapeShp = (r: any) => ({ ...r, owner_type_name: OWNER_TYPES.find(([k]) => k === r.owner_type)?.[1], receiving_name: receivingName(r.receiving_status),
  stuffing_name: STUFFING.find(([k]) => k === r.stuffing_status)?.[1], con_status_name: lclStatusName(r.con_status),
  outstanding_packages: Math.max(0, r.packages - r.received_packages) });
export async function listHouseShipments(actor: Actor, p: Record<string, string>) {
  if (!canSeeLcl(actor)) throw forbidden();
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const v = SHP_VIEWS[p.view || 'all']; if (!v) throw bad('Unknown view');
  let w = `where ${v}`;
  if (p.q?.trim()) { const like = add(`%${p.q.trim().toLowerCase()}%`); w += ` and (lower(concat_ws(' ', s.hbl_no, s.shipper, s.consignee, c.con_ref, c.mbl_no, c.container_no, cu.name, pv.name, f.job_no, f.enquiry_ref)) like ${like})`; }
  if (p.owner_type) w += ` and s.owner_type = ${add(p.owner_type)}`;
  if (p.consolidation_id) { if (!isUuid(p.consolidation_id)) throw bad('Invalid filter'); w += ` and s.consolidation_id = ${add(p.consolidation_id)}`; }
  const size = Math.min(200, Math.max(1, Number(p.page_size) || 50)); const page = Math.max(1, Number(p.page) || 1);
  const rows = await q(`select ${SHP_COLS}, count(*) over() _total ${SHP_FROM} ${w} order by c.etd nulls last, c.con_ref, s.created_at limit ${size} offset ${(page - 1) * size}`, params);
  return { rows: rows.map(shapeShp), total: Number(rows[0]?._total ?? 0), page, page_size: size };
}

/** House shipments of a confirmed LCL shipment record that can be added to a consolidation (pick list). */
export async function lclCandidates(actor: Actor, p: Record<string, string>) {
  need(actor, 'lcl.manage');
  const params: unknown[] = [];
  let w = `where f.deleted_at is null and f.mode = 'sea_lcl' and f.status not in ('closed','cancelled')
    and (f.stage is null or f.stage not in ('enquiry','rates_requested','rates_received','quotation_draft','pending_approval','sent_to_customer','lost','cancelled'))
    and not exists (select 1 from consolidation_shipments s where s.job_file_id = f.id and s.removed_at is null)`;
  if (p.q?.trim()) { params.push(`%${p.q.trim().toLowerCase()}%`); w += ` and f.search_text like $${params.length}`; }
  return q(`select f.id, f.job_no, f.enquiry_ref, f.shipping_ref, f.port_of_loading, f.port_of_discharge, f.origin, f.destination, f.packages, f.gross_weight_kg, f.volume_cbm,
      f.hbl_hawb, c.name customer_name from job_files f join customers c on c.id = f.customer_id ${w} order by f.created_at desc limit 50`, params);
}

/** The LCL part of a shipment page: which consolidation / container / MBL / HBL it sits in. */
export async function lclForFile(fileId: string, db?: Db) {
  return one(`select s.id shipment_id, s.hbl_no, s.receiving_status, s.stuffing_status, s.delivery_status, c.id, c.con_ref, c.mbl_no, c.container_no, c.status, c.etd, c.eta, c.atd, c.ata
    from consolidation_shipments s join consolidations c on c.id = s.consolidation_id where s.job_file_id = $1 and s.removed_at is null`, [fileId], db);
}

// ------------------------------------------------------------ the 14 reports
type Report = { title: string; columns: { key: string; label: string; num?: boolean }[]; rows: any[] };
export const LCL_REPORTS: [string, string][] = [
  ['consolidation_register', 'Consolidation register'], ['container_shipments', 'Container-wise shipment register'], ['mbl_register', 'Master BL register'],
  ['hbl_register', 'House BL register'], ['owner_wise', 'Cargo owner-wise report'], ['salesman_wise', 'Salesman-wise LCL shipments'],
  ['agent_wise', 'Agent-wise LCL shipments'], ['pending_receiving', 'Pending cargo receiving'], ['shortage_damage', 'Cargo shortage / damage'],
  ['weight_cbm', 'Consolidation weight and CBM'], ['stuffing_status', 'Stuffing status'], ['utilisation', 'Container utilisation'],
  ['departure_arrival', 'Departure and arrival tracking'], ['hbl_delivery', 'HBL-wise delivery status'],
];
export async function lclReport(actor: Actor, key: string, p: Record<string, string>): Promise<Report> {
  if (!canSeeLcl(actor)) throw forbidden();
  const title = LCL_REPORTS.find(([k]) => k === key)?.[1];
  if (!title) throw bad('Unknown report');
  const params: unknown[] = [];
  let cw = `c.deleted_at is null and c.status <> 'cancelled'`;
  if (p.from) { day(p.from, 'From'); params.push(p.from); cw += ` and c.etd >= $${params.length}`; }
  if (p.to) { day(p.to, 'To'); params.push(p.to); cw += ` and c.etd <= $${params.length}`; }
  if (p.division) { params.push(p.division); cw += ` and c.division = $${params.length}`; }
  const col = (k: string, label: string, n = false) => ({ key: k, label, num: n });
  const shp = (extra: string, order = 'c.etd nulls last, c.con_ref, s.created_at') =>
    q(`select ${SHP_COLS} ${SHP_FROM} where s.removed_at is null and ${cw} ${extra} order by ${order}`, params).then((r) => r.map(shapeShp));
  const cons = () => q(`select c.*, ${TOTALS} from consolidations c left join container_types ct on ct.code = c.container_type where ${cw} order by c.etd nulls last, c.con_ref`, params).then((r) => r.map(shapeCon));
  const d = (v: any) => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : '';
  switch (key) {
    case 'consolidation_register': return { title, columns: [col('con_ref', 'Consolidation'), col('division_name', 'Division'), col('pol', 'POL'), col('pod', 'POD'), col('carrier', 'Carrier'),
      col('carrier_booking_id', 'Booking ID'), col('container_no', 'Container'), col('mbl_no', 'MBL'), col('total_hbls', 'HBLs', true), col('total_packages', 'Packages', true),
      col('total_weight_kg', 'Weight kg', true), col('total_cbm', 'CBM', true), col('receiving_summary', 'Receiving'), col('stuffing_summary', 'Stuffing'), col('etd', 'ETD'), col('eta', 'ETA'), col('status_name', 'Status')],
      rows: (await cons()).map((r) => ({ ...r, etd: d(r.etd), eta: d(r.eta) })) };
    case 'container_shipments': return { title, columns: [col('container_no', 'Container'), col('con_ref', 'Consolidation'), col('hbl_no', 'HBL'), col('owner_name', 'Cargo owner'),
      col('shipper', 'Shipper'), col('consignee', 'Consignee'), col('packages', 'Packages', true), col('gross_weight_kg', 'Weight kg', true), col('volume_cbm', 'CBM', true),
      col('receiving_name', 'Receiving'), col('stuffing_name', 'Stuffing')], rows: await shp('', 'c.container_no nulls last, c.con_ref, s.created_at') };
    case 'mbl_register': return { title, columns: [col('mbl_no', 'MBL'), col('con_ref', 'Consolidation'), col('carrier', 'Carrier'), col('carrier_booking_id', 'Booking ID'),
      col('container_no', 'Container'), col('pol', 'POL'), col('pod', 'POD'), col('total_hbls', 'HBLs', true), col('hbls', 'House BLs'), col('etd', 'ETD'), col('status_name', 'Status')],
      rows: await Promise.all((await cons()).filter((r) => r.mbl_no).map(async (r) => ({ ...r, etd: d(r.etd),
        hbls: (await q('select hbl_no from consolidation_shipments where consolidation_id = $1 and removed_at is null and hbl_no is not null order by hbl_no', [r.id])).map((x) => x.hbl_no).join(', ') }))) };
    case 'hbl_register': return { title, columns: [col('hbl_no', 'HBL'), col('mbl_no', 'MBL'), col('con_ref', 'Consolidation'), col('container_no', 'Container'), col('owner_type_name', 'Owner type'),
      col('owner_name', 'Cargo owner'), col('shipper', 'Shipper'), col('consignee', 'Consignee'), col('job_no', 'Job No.'), col('packages', 'Packages', true), col('volume_cbm', 'CBM', true), col('con_status_name', 'Status')],
      rows: await shp('and s.hbl_no is not null', 's.hbl_no') };
    case 'owner_wise': case 'salesman_wise': case 'agent_wise': {
      const g = key === 'owner_wise' ? `coalesce(cu.name, pv.name, s.shipper, '—')` : key === 'salesman_wise' ? `coalesce(sm.full_name, '—')` : `pv.name`;
      const extra = key === 'salesman_wise' ? `and s.owner_type = 'own_customer'` : key === 'agent_wise' ? `and s.owner_type = 'partner_agent'` : '';
      const rows = await q(`select ${g} name, count(*)::int shipments, count(distinct s.consolidation_id)::int containers, sum(s.packages)::int packages,
          sum(s.gross_weight_kg) weight, sum(s.volume_cbm) cbm, count(*) filter (where s.receiving_status = 'discrepancy')::int discrepancies
        ${SHP_FROM} where s.removed_at is null and ${cw} ${extra} group by 1 order by sum(s.volume_cbm) desc`, params);
      return { title, columns: [col('name', key === 'owner_wise' ? 'Cargo owner' : key === 'salesman_wise' ? 'Salesman' : 'Partner agent'), col('shipments', 'House shipments', true),
        col('containers', 'Containers', true), col('packages', 'Packages', true), col('weight', 'Weight kg', true), col('cbm', 'CBM', true), col('discrepancies', 'With differences', true)], rows };
    }
    case 'pending_receiving': return { title, columns: [col('con_ref', 'Consolidation'), col('hbl_no', 'HBL'), col('owner_name', 'Cargo owner'), col('shipper', 'Shipper'),
      col('expected_arrival', 'Expected'), col('packages', 'Declared pkgs', true), col('received_packages', 'Received pkgs', true), col('outstanding_packages', 'Outstanding', true),
      col('receiving_name', 'Status'), col('receiving_deadline', 'Receiving deadline')],
      rows: (await q(`select ${SHP_COLS}, c.receiving_deadline ${SHP_FROM} where s.removed_at is null and ${cw} and s.receiving_status in ('expected','partial') and c.status in ('open','ready','stuffing')
        order by c.receiving_deadline nulls last, s.expected_arrival nulls last`, params)).map(shapeShp).map((r) => ({ ...r, expected_arrival: d(r.expected_arrival), receiving_deadline: d(r.receiving_deadline) })) };
    case 'shortage_damage': {
      const rows = await q(`select c.con_ref, s.hbl_no, coalesce(cu.name, pv.name, s.shipper) owner_name, s.packages, s.gross_weight_kg, s.volume_cbm,
          coalesce(r.pk,0)::int received_packages, coalesce(r.kg,0) received_weight_kg, coalesce(r.cbm,0) received_cbm, s.receiving_status,
          (select string_agg(x.condition || ': ' || coalesce(x.damage_note,''), '; ') from lcl_receipts x where x.shipment_id = s.id and x.condition <> 'good') notes
        ${SHP_FROM} where s.removed_at is null and ${cw} and (s.receiving_status = 'discrepancy' or exists (select 1 from lcl_receipts x where x.shipment_id = s.id and x.condition <> 'good'))
        order by c.con_ref`, params);
      return { title, columns: [col('con_ref', 'Consolidation'), col('hbl_no', 'HBL'), col('owner_name', 'Cargo owner'), col('packages', 'Declared pkgs', true), col('received_packages', 'Received pkgs', true),
        col('gross_weight_kg', 'Declared kg', true), col('received_weight_kg', 'Received kg', true), col('volume_cbm', 'Declared CBM', true), col('received_cbm', 'Received CBM', true), col('notes', 'Damage / shortage')], rows };
    }
    case 'weight_cbm': {
      const rows = await q(`select c.con_ref, c.container_no, c.status, sum(s.packages)::int packages, sum(s.gross_weight_kg) weight, sum(s.volume_cbm) cbm,
          sum(coalesce(r.pk,0))::int received_packages, sum(coalesce(r.kg,0)) received_weight_kg, sum(coalesce(r.cbm,0)) received_cbm
        from consolidations c left join consolidation_shipments s on s.consolidation_id = c.id and s.removed_at is null
        left join lateral (select sum(packages) pk, sum(weight_kg) kg, sum(volume_cbm) cbm from lcl_receipts where shipment_id = s.id) r on true
        where ${cw} group by c.id order by c.etd nulls last, c.con_ref`, params);
      return { title, columns: [col('con_ref', 'Consolidation'), col('container_no', 'Container'), col('packages', 'Declared pkgs', true), col('received_packages', 'Received pkgs', true),
        col('weight', 'Declared kg', true), col('received_weight_kg', 'Received kg', true), col('cbm', 'Declared CBM', true), col('received_cbm', 'Received CBM', true)],
        rows: rows.map((r) => ({ ...r, status: lclStatusName(r.status) })) };
    }
    case 'stuffing_status': return { title, columns: [col('con_ref', 'Consolidation'), col('container_no', 'Container'), col('stuffing_date', 'Stuffing date'), col('total_hbls', 'HBLs', true),
      col('stuffed_hbls', 'Stuffed', true), col('receiving_summary', 'Receiving'), col('stuffing_summary', 'Stuffing'), col('seal_no', 'Seal'), col('status_name', 'Status')],
      rows: (await cons()).map((r) => ({ ...r, stuffing_date: d(r.stuffing_date) })) };
    case 'utilisation': return { title, columns: [col('con_ref', 'Consolidation'), col('container_no', 'Container'), col('container_type', 'Type'), col('total_cbm', 'CBM', true),
      col('capacity_cbm', 'Capacity CBM', true), col('utilisation_pct', 'Used %', true), col('total_weight_kg', 'Weight kg', true), col('max_payload_kg', 'Max payload kg', true), col('status_name', 'Status')],
      rows: await cons() };
    case 'departure_arrival': return { title, columns: [col('con_ref', 'Consolidation'), col('container_no', 'Container'), col('carrier', 'Carrier'), col('pol', 'POL'), col('pod', 'POD'),
      col('etd', 'ETD'), col('atd', 'Departed'), col('dep_delay', 'Departure delay (days)', true), col('eta', 'ETA'), col('ata', 'Arrived'), col('arr_delay', 'Arrival delay (days)', true), col('status_name', 'Status')],
      rows: (await cons()).map((r) => {
        const diff = (a: any, b: any) => a && b ? Math.round((new Date(d(a)).getTime() - new Date(d(b)).getTime()) / 86400000) : null;
        return { ...r, etd: d(r.etd), atd: d(r.atd), eta: d(r.eta), ata: d(r.ata), dep_delay: diff(r.atd, r.etd), arr_delay: diff(r.ata, r.eta) };
      }) };
    case 'hbl_delivery': return { title, columns: [col('hbl_no', 'HBL'), col('con_ref', 'Consolidation'), col('consignee', 'Consignee'), col('owner_name', 'Cargo owner'), col('job_no', 'Job No.'),
      col('ata', 'Arrived'), col('delivery_status', 'Delivery'), col('delivered_at', 'Delivered on'), col('con_status_name', 'Container status')],
      rows: (await shp('and s.stuffing_status <> \'shut_out\'', 's.delivery_status, c.ata nulls last')).map((r) => ({ ...r, ata: d(r.ata), delivered_at: d(r.delivered_at),
        delivery_status: r.delivery_status === 'delivered' ? 'Delivered' : 'Pending' })) };
  }
  throw bad('Unknown report');
}
void RECEIVING;

/** Lists for the forms: container types, warehouses. */
export async function lclOptions(actor: Actor) {
  if (!canSeeLcl(actor)) throw forbidden();
  return {
    container_types: await q('select code, name, capacity_cbm, max_payload_kg from container_types order by sort_order'),
    warehouses: await q('select id, name from warehouses where is_active order by name'),
  };
}
