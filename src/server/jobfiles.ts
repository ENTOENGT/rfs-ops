/**
 * Job Files — one per shipment (Freight + 3PL, Part A).
 *
 *   job_files            the shipment: parties, route, carrier, BL/AWB, ETD/ETA, cargo, which services it needs
 *   job_file_containers  containers on the shipment
 *   job_file_milestones  the milestone plan: planned and actual date per step
 *   job_file_events      every change (who, when, old → new)
 *
 * Linked work: truck trips and PRO requests with the same Job No. link automatically (database trigger,
 * migration 013); messenger runs link through their truck trip. Each keeps its own screens and rules.
 *
 * A Job File carries NO prices. The quotation it came from (and its rates) stays behind quotes.view.
 *
 * Closing: only when every linked trip, PRO request and messenger run is finished, and each service the
 * file needs (transport, clearance) has at least one finished piece of work behind it. Nothing closes itself.
 */
import { PoolClient } from 'pg';
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, getSetting, notFound, one, q, tx } from './db';
import { jobNoProblem } from '../lib/requestRules';
import { DIRECTIONS, MODES, JF_STATUSES, INCOTERMS, jfStatusName, jfStatusColor, label, milestonePlan, qStatusName, qStatusColor } from '../lib/jobfileRules';
import { normContainer } from './pro';
import { stageName, stageColor, nextAction, divisionName, directionOfDivision, PRE_CONFIRM } from '../lib/commercialRules';
import { isCurrency } from '../lib/currency';
import { FIELD_LABEL, incotermMissing, incotermRequired } from '../lib/incotermRules';
import { CargoLine, cargoTotals, dimsRequired, lineCbm, lineProblem } from '../lib/cargoRules';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE = ['enquiry', 'open', 'booked', 'in_transit', 'arrived', 'delivering'];

// ------------------------------------------------------------ who sees / does what
export const canSeeJobFiles = (a: Actor) =>
  ['jobfiles.view_all', 'jobfiles.view_department', 'jobfiles.view_assigned', 'jobfiles.view_handed_over', 'jobfiles.create', 'jobfiles.edit'].some((p) => a.has(p as any));
/**
 *   jobfiles.view_all         every Job File (Transport, Finance, Customer Service, Warehouse, Super Admin)
 *   jobfiles.view_department  own department's (+ ones they created)
 *   otherwise                 only ones they created
 */
export function jfScope(actor: Actor, params: unknown[], alias = 'f'): string {
  if (actor.has('jobfiles.view_all')) return '';
  params.push(actor.id);
  const me = `$${params.length}`;
  const c = [`${alias}.created_by = ${me}`];
  if (actor.has('jobfiles.view_department') && actor.department_id) { params.push(actor.department_id); c.push(`${alias}.department_id = $${params.length}`); }
  // Part E: Salesman / Coordinator see the shipments they are responsible for
  if (actor.has('jobfiles.view_assigned')) c.push(`${alias}.salesman_id = ${me}`, `${alias}.coordinator_id = ${me}`);
  // Operations works on everything handed over to it
  if (actor.has('jobfiles.view_handed_over')) c.push(`${alias}.stage = 'handed_over'`);
  return ` and (${c.join(' or ')})`;
}

export async function loadFile(actor: Actor, id: string, db?: Db, lock = false) {
  if (!canSeeJobFiles(actor)) throw forbidden();
  if (!isUuid(id)) throw notFound('Job File');
  const p: unknown[] = [id];
  const f = await one(`select f.* from job_files f where f.id = $1 and f.deleted_at is null${jfScope(actor, p)}${lock ? ' for update of f' : ''}`, p, db);
  if (!f) throw notFound('Job File');
  return f;
}
const isOpen = (f: any) => ACTIVE.includes(f.status);
export function canEdit(actor: Actor, f: any) {
  if (actor.isSuperAdmin) return true;
  if (!isOpen(f)) return false;
  return actor.has('jobfiles.edit') || (actor.has('jobfiles.create') && f.created_by === actor.id);
}

export async function event(db: Db, actor: Actor | null, jobFileId: string, e: { kind: string; title: string; field?: string; old_value?: unknown; new_value?: unknown; remarks?: string | null }) {
  const s = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 1000));
  await db.query(`insert into job_file_events (job_file_id, kind, title, field, old_value, new_value, remarks, user_id, user_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [jobFileId, e.kind, e.title, e.field ?? null, s(e.old_value), s(e.new_value), e.remarks ?? null, actor?.id ?? null, actor?.full_name ?? 'System']);
}
export async function refreshJobFileSearch(id: string) { await refreshSearch((await import('./db')).pool(), id); }
async function refreshSearch(db: Db, id: string) {
  await db.query(`update job_files f set search_text = lower(concat_ws(' ', f.job_no, f.enquiry_ref, f.shipping_ref, f.customer_reference, f.shipper, f.consignee, f.origin, f.destination,
      f.port_of_loading, f.port_of_discharge, f.carrier, f.vessel_flight, f.voyage, f.booking_reference, f.mbl_mawb, f.hbl_hawb, c.name,
      (select string_agg(container_no, ' ') from job_file_containers where job_file_id = f.id and deleted_at is null)))
    from customers c where f.id = $1 and c.id = f.customer_id`, [id]);
}
/** Link existing trips / PRO requests / runs that carry this Job No. (or unlink them when the file is cancelled). */
async function relink(db: Db, jobNo: string | null) {
  if (!jobNo) return;
  await db.query(`update transport_requests set job_file_id = null where upper(btrim(job_no)) = upper(btrim($1))`, [jobNo]);
  await db.query(`update pro_requests set job_file_id = null where upper(btrim(job_no)) = upper(btrim($1))`, [jobNo]);
  // runs follow their truck trip
  await db.query(`update messenger_runs m set job_file_id = t.job_file_id from transport_requests t
    where m.job_id = t.id and upper(btrim(t.job_no)) = upper(btrim($1))`, [jobNo]);
}

// ------------------------------------------------------------ validation
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
const num = (v: unknown, lbl: string, int = false) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw bad(`${lbl} must be ${int ? 'a whole number' : 'a number'} of 0 or more`);
  return String(v);
};
const pick = (list: [string, string, ...unknown[]][], lbl: string) => (v: unknown) => {
  if (!list.some((x) => x[0] === v)) throw bad(`Choose ${lbl}`);
  return v as string;
};
const flag = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';

/** Editable fields, with their label (for the history) and how to check them. */
const FIELDS: Record<string, { label: string; parse: (v: unknown) => unknown }> = {
  customer_id: { label: 'Customer', parse: (v) => { if (!isUuid(v)) throw bad('Choose the customer'); return v; } },
  direction: { label: 'Direction', parse: pick(DIRECTIONS, 'import, export, cross-trade or domestic') },
  mode: { label: 'Mode', parse: pick(MODES, 'sea FCL, sea LCL, air or road') },
  needs_clearance: { label: 'Needs customs clearance', parse: flag },
  needs_transport: { label: 'Needs transport', parse: flag },
  needs_warehouse: { label: 'Needs warehouse', parse: flag },
  customer_reference: { label: 'Customer reference', parse: (v) => txt(v, 80) },
  shipper: { label: 'Shipper', parse: (v) => txt(v, 300) }, consignee: { label: 'Consignee', parse: (v) => txt(v, 300) },
  notify_party: { label: 'Notify party', parse: (v) => txt(v, 300) },
  origin: { label: 'Origin', parse: (v) => txt(v, 120) }, destination: { label: 'Destination', parse: (v) => txt(v, 120) },
  port_of_loading: { label: 'Port / airport of loading', parse: (v) => txt(v, 120) },
  port_of_discharge: { label: 'Port / airport of discharge', parse: (v) => txt(v, 120) },
  carrier: { label: 'Shipping line / airline / transporter', parse: (v) => txt(v, 120) },
  vessel_flight: { label: 'Vessel / flight', parse: (v) => txt(v, 80) }, voyage: { label: 'Voyage', parse: (v) => txt(v, 40) },
  booking_reference: { label: 'Carrier booking ref.', parse: (v) => txt(v, 80) },
  mbl_mawb: { label: 'MBL / MAWB', parse: (v) => txt(v, 60) }, hbl_hawb: { label: 'HBL / HAWB', parse: (v) => txt(v, 60) },
  incoterm: { label: 'Incoterm', parse: (v) => { if (v && !INCOTERMS.includes(String(v))) throw bad('Choose an Incoterm'); return v || null; } },
  pickup_address: { label: 'Pickup (loading) address', parse: (v) => txt(v, 500) }, pickup_contact: { label: 'Pickup contact', parse: (v) => txt(v, 160) },
  named_place: { label: 'Handover place', parse: (v) => txt(v, 300) },
  delivery_address: { label: 'Delivery address', parse: (v) => txt(v, 500) }, delivery_contact: { label: 'Delivery contact', parse: (v) => txt(v, 160) },
  cargo_value: { label: 'Cargo value', parse: (v) => num(v, 'Cargo value') },
  cargo_value_currency: { label: 'Cargo value currency', parse: (v) => { const c = String(txt(v, 3) ?? '').toUpperCase(); if (c && !isCurrency(c)) throw bad('Cargo value currency: AED, USD, EUR, INR or CNY'); return c || null; } },
  etd: { label: 'ETD', parse: (v) => day(v, 'ETD') }, eta: { label: 'ETA', parse: (v) => day(v, 'ETA') },
  atd: { label: 'Actual departure', parse: (v) => day(v, 'Actual departure') }, ata: { label: 'Actual arrival', parse: (v) => day(v, 'Actual arrival') },
  packages: { label: 'Packages', parse: (v) => num(v, 'Packages', true) },
  gross_weight_kg: { label: 'Gross weight (kg)', parse: (v) => num(v, 'Gross weight') },
  volume_cbm: { label: 'Volume (CBM)', parse: (v) => num(v, 'Volume') },
  chargeable_weight_kg: { label: 'Chargeable weight (kg)', parse: (v) => num(v, 'Chargeable weight') },
  cargo_description: { label: 'Cargo', parse: (v) => txt(v, 2000) },
  remarks: { label: 'Remarks', parse: (v) => txt(v, 2000) },
};

// ------------------------------------------------------------ documents checklist (migration 016)
const modeGroup = (mode: string) => (mode.startsWith('sea') ? 'sea' : mode);
/** SQL: does Job File `f` still lack a required document (none uploaded and not waived)? Same rule as checklist(). */
export const MISSING_DOCS_SQL = `exists (select 1 from doc_requirements r where r.is_active
  and (r.direction is null or r.direction = f.direction)
  and (r.mode_group is null or r.mode_group = case when f.mode like 'sea%' then 'sea' else f.mode end)
  and (r.needs is null or (r.needs = 'clearance' and f.needs_clearance) or (r.needs = 'transport' and f.needs_transport) or (r.needs = 'warehouse' and f.needs_warehouse))
  and not exists (select 1 from jf_documents d where d.job_file_id = f.id and d.doc_type = r.doc_type and d.deleted_at is null and d.replaced_at is null and d.status <> 'rejected')
  and not exists (select 1 from jf_doc_waivers w where w.job_file_id = f.id and w.doc_type = r.doc_type))`;
/** Which documents this Job File needs, and where each one stands: missing, pending, approved, rejected or waived. */
export async function checklist(f: any, db?: Db) {
  const [reqs, docs, waivers] = await Promise.all([
    q(`select distinct on (doc_type) doc_type, name, sort_order from doc_requirements where is_active
       and (direction is null or direction = $1) and (mode_group is null or mode_group = $2)
       and (needs is null or (needs = 'clearance' and $3) or (needs = 'transport' and $4) or (needs = 'warehouse' and $5))
       order by doc_type, sort_order`, [f.direction, modeGroup(f.mode), f.needs_clearance, f.needs_transport, f.needs_warehouse], db),
    q(`select doc_type, status from jf_documents where job_file_id = $1 and deleted_at is null and replaced_at is null`, [f.id], db),
    q(`select w.doc_type, w.reason, w.waived_at, u.full_name waived_by_name from jf_doc_waivers w left join users u on u.id = w.waived_by where w.job_file_id = $1`, [f.id], db),
  ]);
  return reqs.sort((a, b) => a.sort_order - b.sort_order).map((r) => {
    const w = waivers.find((x) => x.doc_type === r.doc_type);
    const mine = docs.filter((d) => d.doc_type === r.doc_type);
    const status = w ? 'waived' : mine.some((d) => d.status === 'approved') ? 'approved' : mine.some((d) => d.status === 'pending') ? 'pending'
      : mine.some((d) => d.status === 'rejected') ? 'rejected' : 'missing';
    return { doc_type: r.doc_type, name: r.name, status, waiver: w ?? null };
  });
}

// ------------------------------------------------------------ Incoterm details (migration 023)
const INCOTERM_KEYS = ['incoterm', 'direction', 'needs_transport', 'pickup_address', 'named_place', 'port_of_loading', 'port_of_discharge', 'delivery_address', 'cargo_value', 'cargo_value_currency'];
/** The Incoterm decides which addresses the enquiry needs. `optionalTerm`: an old enquiry without a term may stay without one. */
function checkIncoterm(v: Record<string, any>, optionalTerm = false) {
  if (!v.incoterm && incotermRequired(v.direction) && !optionalTerm)
    throw new ApiError(400, 'VALIDATION', 'Choose the Incoterm', { fields: { incoterm: 'Choose the Incoterm' } });
  const miss = incotermMissing(v);
  if (miss.length) throw new ApiError(400, 'VALIDATION', `${v.incoterm} needs: ${miss.map((k) => FIELD_LABEL[k].toLowerCase()).join(', ')}`,
    { fields: Object.fromEntries(miss.map((k) => [k, `Needed for ${v.incoterm}`])) });
}

// ------------------------------------------------------------ cargo lines (migration 023)
/** Check the cargo lines sent from the form. undefined = not sent (leave as is). */
function parseCargo(v: unknown): CargoLine[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw bad('Cargo lines are not in the right shape');
  if (v.length > 200) throw bad('Up to 200 cargo lines');
  return v.map((l: any, i: number) => {
    const p = lineProblem(l);
    if (p) throw new ApiError(400, 'VALIDATION', `Cargo line ${i + 1}: ${p}`, { fields: { cargo_lines: `Line ${i + 1}: ${p}` } });
    return { package_type: l.package_type, package_other: l.package_type === 'Other' ? txt(l.package_other, 40) : null, pieces: Number(l.pieces),
      length: Number(l.length), width: Number(l.width), height: Number(l.height), dim_unit: l.dim_unit, weight_kg: Number(l.weight_kg) };
  });
}
const cargoSummary = (lines: any[]) => lines.length
  ? lines.map((l) => `${l.pieces} ${l.package_type === 'Other' ? l.package_other : l.package_type} ${Number(l.length)}×${Number(l.width)}×${Number(l.height)} ${l.dim_unit}, ${Number(l.weight_kg)} kg`).join('; ')
  : null;
/** Replace the shipment's cargo lines (old ones are kept, marked removed) and write the totals onto the shipment. */
async function saveCargo(db: Db, actor: Actor, fileId: string, lines: CargoLine[], mode: string) {
  await db.query('update job_file_cargo_lines set removed_at = now(), removed_by = $2 where job_file_id = $1 and removed_at is null', [fileId, actor.id]);
  for (const [i, l] of lines.entries())
    await db.query(`insert into job_file_cargo_lines (job_file_id, line_no, package_type, package_other, pieces, length, width, height, dim_unit, weight_kg, cbm, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [fileId, i + 1, l.package_type, l.package_other ?? null, l.pieces, l.length, l.width, l.height, l.dim_unit, l.weight_kg, lineCbm(l), actor.id]);
  if (lines.length) await writeTotals(db, fileId, lines, mode);
}
async function writeTotals(db: Db, fileId: string, lines: Partial<CargoLine>[], mode: string) {
  const t = cargoTotals(lines, mode);
  await db.query(`update job_files set packages = $2, gross_weight_kg = $3, volume_cbm = $4, chargeable_weight_kg = coalesce($5, chargeable_weight_kg), package_type = $6 where id = $1`,
    [fileId, t.packages, t.weight, t.cbm, t.chargeable_kg, t.package_type]);
}
const liveCargo = (id: string, db?: Db) => q(`select id, line_no, package_type, package_other, pieces, length, width, height, dim_unit, weight_kg, cbm
  from job_file_cargo_lines where job_file_id = $1 and removed_at is null order by line_no`, [id], db);

// ------------------------------------------------------------ create
/** Create a Job File. `c` lets a quotation create it inside its own transaction. */
export async function createJobFile(actor: Actor, b: any, c?: PoolClient, from?: { quotation_id: string }): Promise<{ id: string; job_no: string; enquiry_ref: string }> {
  if (!actor.has('jobfiles.create')) throw forbidden();
  // Part E: an enquiry has no Job No. yet — it gets one from the ERP at handover. A direct (already confirmed) job needs it now.
  const enquiry = b.status === 'enquiry' && !from;
  const p = enquiry ? null : jobNoProblem(b.job_no);
  if (p) throw new ApiError(400, 'VALIDATION', p, { fields: { job_no: p } });
  const jobNo = enquiry ? null : String(b.job_no).trim();
  const fields: Record<string, string> = {};
  const vals: Record<string, unknown> = {};
  // Step 4: an enquiry asks only the division; the direction comes from it (the Salesman's division when they have one)
  if (enquiry && !b.direction && b.division) b = { ...b, direction: directionOfDivision(b.division) ?? undefined };
  if (enquiry && !b.direction && !b.division && actor.division) b = { ...b, direction: directionOfDivision(actor.division) ?? undefined };
  for (const k of ['customer_id', 'direction', 'mode'])
    if (b[k] === undefined || b[k] === null || b[k] === '') fields[k] = `Choose the ${FIELDS[k].label.toLowerCase()}`;
  if (Object.keys(fields).length) throw new ApiError(400, 'VALIDATION', 'Please fill in the highlighted fields', { fields });
  for (const [k, def] of Object.entries(FIELDS)) if (b[k] !== undefined) vals[k] = def.parse(b[k]);
  if (vals.etd && vals.eta && String(vals.eta) < String(vals.etd)) throw bad('ETA is before ETD');
  if (enquiry) checkIncoterm(vals);
  const cargo = parseCargo(b.cargo_lines) ?? [];
  if (enquiry && dimsRequired(vals.mode as string) && !cargo.length)
    throw new ApiError(400, 'VALIDATION', 'Add the cargo dimensions (at least one line)', { fields: { cargo_lines: 'Add at least one line: packages, size and weight' } });

  const run = async (db: PoolClient) => {
    if (!(await one('select 1 from customers where id = $1 and deleted_at is null', [vals.customer_id], db))) throw bad('Customer not found');
    const cm = await import('./commercial');
    await cm.assertCustomerAllowed(actor, vals.customer_id as string, db);
    if (jobNo) {
      const dup = await one(`select id, status from job_files where upper(btrim(job_no)) = upper($1) and deleted_at is null and status <> 'cancelled'`, [jobNo], db);
      if (dup) throw new ApiError(409, 'JOB_FILE_EXISTS', `Job No. ${jobNo} already has a Job File. Open it instead of creating a second one.`, { id: dup.id });
    }
    // Responsible Salesman, Assigned Coordinator (from the Salesman's mapping) and division — kept apart from Created By
    const people = enquiry || b.salesman_id ? await cm.resolvePeople(actor, b, vals.customer_id as string, vals.direction as string, db)
      : { salesman_id: actor.role_code === 'sales' ? actor.id : null, coordinator_id: actor.role_code === 'coordinator' ? actor.id : null, division: actor.division };
    if (enquiry) {
      if (!people.division) throw new ApiError(400, 'VALIDATION', 'Choose the division', { fields: { division: 'Choose the division' } });
      const dir = directionOfDivision(people.division);   // the direction always matches the division
      if (b.direction && b.direction !== dir)
        throw new ApiError(400, 'VALIDATION', `The ${divisionName(people.division)} division handles ${DIRECTIONS.find(([c]) => c === dir)?.[1].toLowerCase()} enquiries — choose the right division`,
          { fields: { division: 'Does not match the direction' } });
      vals.direction = dir;
    }
    Object.assign(vals, people, { enquiry_ref: await cm.newRef(db, 'ENQ', people.division), stage: enquiry ? 'enquiry' : 'handed_over' });
    // the words after the [ENQ] tag in every email subject — fixed now, so the email thread keeps one subject
    const place = (a: unknown, b: unknown) => String(a ?? '').trim() || String(b ?? '').trim();
    const from0 = place(vals.origin, vals.port_of_loading), to0 = place(vals.destination, vals.port_of_discharge);
    vals.email_topic = from0 && to0 ? `${from0} to ${to0}` : from0 || to0 || null;
    if (!enquiry) Object.assign(vals, { handed_over_at: new Date(), handed_over_by: actor.id });
    let deptId: string | null = actor.department_side === 'operations' ? actor.department_id : null;
    if (!deptId && b.department_id) {
      const d = isUuid(b.department_id) ? await one(`select id from departments where id = $1 and side = 'operations' and is_active`, [b.department_id], db) : null;
      if (!d) throw bad('Choose an operations department');
      deptId = d.id;
    }
    // An enquiry starts the Job File before any quotation (migration 017): same Job No. from enquiry to closing
    vals.status = enquiry ? 'enquiry' : 'open';
    const cols = Object.keys(vals);
    const f = await one(`insert into job_files (job_no, department_id, created_by, quotation_id${cols.map((k) => ', ' + k).join('')})
      values ($1, $2, $3, $4${cols.map((_, i) => `, $${i + 5}`).join('')}) returning id, job_no, enquiry_ref, direction, mode, needs_clearance, needs_transport, needs_warehouse, status`,
      [jobNo, deptId, actor.id, from?.quotation_id ?? null, ...cols.map((k) => vals[k])], db);
    const plan = milestonePlan(f.direction, f.mode, { clearance: f.needs_clearance, transport: f.needs_transport, warehouse: f.needs_warehouse });
    for (const [i, [code, name]] of plan.entries())
      await db.query('insert into job_file_milestones (job_file_id, code, name, sort_order) values ($1,$2,$3,$4)', [f.id, code, name, (i + 1) * 10]);
    if (cargo.length) await saveCargo(db, actor, f.id, cargo, f.mode);
    const conts = Array.isArray(b.containers) ? b.containers.filter((k: any) => String(k?.container_no ?? '').trim()) : [];
    for (const k of conts)
      await db.query('insert into job_file_containers (job_file_id, container_no, size_type, seal_no) values ($1,$2,$3,$4) on conflict do nothing',
        [f.id, normContainer(k.container_no), txt(k.size_type, 10), txt(k.seal_no, 30)]);
    await relink(db, jobNo);
    const linked = await one(`select (select count(*) from transport_requests where job_file_id = $1)::int trips,
      (select count(*) from pro_requests where job_file_id = $1)::int pro`, [f.id], db);
    const who = await one(`select (select full_name from users where id = $1) s, (select full_name from users where id = $2) k`, [people.salesman_id, people.coordinator_id], db);
    await event(db, actor, f.id, { kind: 'created', title: from ? 'Job File created from an accepted quotation' : f.status === 'enquiry' ? `Enquiry ${f.enquiry_ref} received` : 'Job File created',
      new_value: [who.s && `Salesman ${who.s}`, who.k && `Coordinator ${who.k}`, people.division && divisionName(people.division),
        linked.trips + linked.pro ? `Linked ${linked.trips} truck trip(s) and ${linked.pro} PRO request(s) with the same Job No.` : null].filter(Boolean).join(' · ') || null });
    await refreshSearch(db, f.id);
    if (enquiry) await (await import('./notify')).notifyGroup(db, actor, f.id, 'new_enquiry');
    return { id: f.id as string, job_no: f.job_no as string, enquiry_ref: f.enquiry_ref as string };
  };
  return c ? run(c) : tx(run);
}

// ------------------------------------------------------------ list
export const VIEWS: Record<string, { label: string; sql: string }> = {
  enquiry: { label: 'Commercial (not handed over)', sql: `f.status = 'enquiry'` },
  open: { label: 'Open', sql: `f.status in ('open','booked','in_transit','arrived','delivering')` },
  arriving: { label: 'Arriving in 7 days', sql: `f.status in ('open','booked','in_transit') and f.ata is null
    and f.eta between (now() at time zone 'Asia/Dubai')::date and (now() at time zone 'Asia/Dubai')::date + 7` },
  late: { label: 'Past ETA, not arrived', sql: `f.status in ('open','booked','in_transit') and f.ata is null and f.eta < (now() at time zone 'Asia/Dubai')::date` },
  needs_clearance: { label: 'Clearance not started', sql: `f.status in ('open','booked','in_transit','arrived','delivering') and f.needs_clearance
    and not exists (select 1 from pro_requests r where r.job_file_id = f.id and r.deleted_at is null and r.status_code <> 'cancelled')` },
  needs_transport: { label: 'Transport not requested', sql: `f.status in ('open','booked','in_transit','arrived','delivering') and f.needs_transport
    and not exists (select 1 from transport_requests t where t.job_file_id = f.id and t.deleted_at is null and t.status_code <> 'cancelled')` },
  missing_docs: { label: 'Documents missing', sql: `f.status in ('open','booked','in_transit','arrived','delivering') and ${MISSING_DOCS_SQL}` },
  closed: { label: 'Closed', sql: `f.status = 'closed'` },
};
/** Commercial views (Part E) — used by the Commercials lists and dashboard, not shown as Job File tiles. */
export const COMMERCIAL_VIEWS: Record<string, string> = {
  c_all: `(f.stage <> 'handed_over' or f.confirmed_at is not null or f.salesman_id is not null)`,
  c_open: `f.stage not in ('handed_over','lost','cancelled')`,
  c_enquiry: `f.stage = 'enquiry'`, c_rates: `f.stage = 'rates_requested'`, c_quoting: `f.stage in ('rates_received','quotation_draft')`,
  c_approval: `f.stage = 'pending_approval'`, c_sent: `f.stage = 'sent_to_customer'`, c_confirmed: `f.stage = 'customer_confirmed'`,
  c_booking: `f.stage = 'booking_requested'`, c_prealert: `f.stage in ('booking_confirmed','prealert_awaited','prealert_received')`,
  c_prealert_received: `f.stage = 'prealert_received'`, c_awaiting_job: `f.stage = 'prealert_verified'`,
  c_handed_over: `f.stage = 'handed_over' and f.handed_over_at is not null`, c_lost: `f.stage in ('lost','cancelled')`,
  // UI redesign: dashboard and Bookings menu views (Part G2 data)
  c_pending_quotes: `f.stage in ('rates_requested','rates_received','quotation_draft','pending_approval')`,
  c_active: `f.stage in ('customer_confirmed','booking_requested','booking_confirmed','prealert_awaited','prealert_received','prealert_verified')`,
  c_vessel_pending: `f.stage in ('booking_confirmed','prealert_awaited','prealert_received','prealert_verified') and f.mode <> 'road' and f.vessel_status <> 'verified'`,
  c_bl_customer: `f.bl_status in ('sent_to_customer','revised_sent') and f.stage not in ('lost','cancelled')`,
  c_bl_correction: `f.bl_status in ('correction_required','correction_sent','revised_received') and f.stage not in ('lost','cancelled')`,
  c_cust_pending: `(f.stage = 'sent_to_customer' or f.bl_status in ('sent_to_customer','revised_sent'))`,
};
function filterSql(actor: Actor, p: Record<string, string>, params: unknown[]) {
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const like = (v: string) => add('%' + v.trim().toLowerCase().replace(/[%_\\]/g, '\\$&') + '%');
  let w = `where f.deleted_at is null` + jfScope(actor, params);
  if (p.q?.trim()) w += ` and f.search_text like ${like(p.q)}`;
  if (p.job_no?.trim()) w += ` and (lower(f.job_no) like ${like(p.job_no)} or lower(f.enquiry_ref) like $${params.length} or lower(f.shipping_ref) like $${params.length})`;
  for (const [k, col] of Object.entries({ customer_id: 'f.customer_id', department_id: 'f.department_id' }))
    if (p[k]) { if (!isUuid(p[k])) throw bad('Invalid filter'); w += ` and ${col} = ${add(p[k])}`; }
  if (p.status) w += ` and f.status = any(${add(p.status.split(','))})`;
  if (p.direction) w += ` and f.direction = ${add(p.direction)}`;
  if (p.mode) w += ` and f.mode = ${add(p.mode)}`;
  for (const [k, sql] of [['from', 'f.created_at::date >='], ['to', 'f.created_at::date <=']] as const)
    if (p[k]) { if (!DATE.test(p[k])) throw bad('Invalid date'); w += ` and ${sql} ${add(p[k])}`; }
  if (p.view) { const v = VIEWS[p.view]?.sql ?? COMMERCIAL_VIEWS[p.view]; if (!v) throw bad('Unknown view'); w += ` and (${v})`; }
  for (const [k, col] of Object.entries({ salesman_id: 'f.salesman_id', coordinator_id: 'f.coordinator_id' }))
    if (p[k]) { if (p[k] === 'me') w += ` and ${col} = ${add(actor.id)}`; else { if (!isUuid(p[k])) throw bad('Invalid filter'); w += ` and ${col} = ${add(p[k])}`; } }
  if (p.mine === '1') w += ` and f.created_by = ${add(actor.id)}`;
  if (p.assigned === '1') w += ` and (f.coordinator_id = ${add(actor.id)} or f.salesman_id = $${params.length})`;
  if (p.division) w += ` and f.division = ${add(p.division)}`;
  if (p.stage) w += ` and f.stage = any(${add(p.stage.split(','))})`;
  return w;
}
const LIST_COLS = `f.id, f.job_no, f.enquiry_ref, f.shipping_ref, f.stage, f.division, f.updated_at, f.handed_over_at,
  sm.full_name salesman_name, co.full_name coordinator_name, f.direction, f.mode, f.status, f.needs_clearance, f.needs_transport, f.needs_warehouse,
  f.origin, f.destination, f.port_of_loading, f.port_of_discharge, f.carrier, f.mbl_mawb, f.hbl_hawb, f.etd, f.eta, f.atd, f.ata,
  f.created_at, f.closed_at, c.name customer_name, dep.name department_name, u.full_name created_by_name,
  (select string_agg(k.container_no, ', ' order by k.container_no) from job_file_containers k where k.job_file_id = f.id and k.deleted_at is null) container_list,
  (select count(*)::int from transport_requests t where t.job_file_id = f.id and t.deleted_at is null and t.status_code <> 'cancelled') trips,
  (select count(*)::int from pro_requests r where r.job_file_id = f.id and r.deleted_at is null and r.status_code <> 'cancelled') pro_requests,
  (f.status in ('open','booked','in_transit') and f.ata is null and f.eta < (now() at time zone 'Asia/Dubai')::date) late`;
const LIST_FROM = `from job_files f join customers c on c.id = f.customer_id left join departments dep on dep.id = f.department_id join users u on u.id = f.created_by
  left join users sm on sm.id = f.salesman_id left join users co on co.id = f.coordinator_id`;
const shape = (r: any) => ({ ...r, direction_name: label(DIRECTIONS, r.direction), mode_name: label(MODES, r.mode),
  status_name: jfStatusName(r.status), status_color: jfStatusColor(r.status),
  stage_name: stageName(r.stage), stage_color: stageColor(r.stage), next_action: nextAction(r.stage), division_name: divisionName(r.division) });

export async function listJobFiles(actor: Actor, p: Record<string, string>) {
  if (!canSeeJobFiles(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = filterSql(actor, p, params);
  const size = Math.min(Math.max(Number(p.page_size) || 50, 1), 200), page = Math.max(Number(p.page) || 1, 1);
  const SORT: Record<string, string> = { job_no: 'upper(f.job_no)', enquiry_ref: 'f.enquiry_ref', eta: 'f.eta', etd: 'f.etd', customer: 'c.name', created: 'f.created_at',
    updated: 'f.updated_at', stage: 'f.stage', salesman: 'sm.full_name', coordinator: 'co.full_name', division: 'f.division', origin: 'f.origin', destination: 'f.destination' };
  const sort = SORT[p.sort ?? ''] ?? `case when f.status in ('closed','cancelled') then 1 else 0 end, f.eta nulls last, f.created_at desc`;
  const rows = await q(`select ${LIST_COLS}, count(*) over() _total ${LIST_FROM} ${where}
    order by ${sort} ${SORT[p.sort ?? ''] ? (p.dir === 'desc' ? 'desc' : 'asc') : ''}, f.job_no limit ${size} offset ${(page - 1) * size}`, params);
  return { total: Number(rows[0]?._total ?? 0), page, page_size: size, rows: rows.map(({ _total, ...r }) => shape(r)) };
}
export async function jobFileTiles(actor: Actor, p: Record<string, string>) {
  if (!canSeeJobFiles(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = filterSql(actor, { ...p, view: '' }, params);
  const c = await one(`select ${Object.entries(VIEWS).map(([k, v]) => `count(*) filter (where ${v.sql})::int ${k}`).join(', ')} ${LIST_FROM} ${where}`, params);
  return Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, count: c![key] }));
}

// ------------------------------------------------------------ one Job File
async function linkedWork(id: string, db?: Db) {
  const [trips, pro, runs] = await Promise.all([
    q(`select t.id, t.job_number, t.job_no, t.required_date, t.pickup_name, t.delivery_name, t.pod_status, t.status_code,
        s.name status_name, s.color status_color, s.stage from transport_requests t join job_statuses s on s.code = t.status_code
       where t.job_file_id = $1 and t.deleted_at is null order by t.created_at`, [id], db),
    q(`select r.id, r.request_no, r.job_no, r.required_date, r.uae_location, r.status_code, s.name status_name, s.color status_color, s.stage
       from pro_requests r join pro_statuses s on s.code = r.status_code where r.job_file_id = $1 and r.deleted_at is null order by r.created_at`, [id], db),
    q(`select m.id, m.run_number, m.status, m.required_date, m.documents, m.to_name from messenger_runs m
       where m.job_file_id = $1 and m.deleted_at is null order by m.created_at`, [id], db),
  ]);
  return { trips, pro, runs };
}
/** What still stops this Job File from closing (empty = it can close). */
export function closureBlockers(f: any, w: { trips: any[]; pro: any[]; runs: any[] }, docs: { name: string; status: string }[] = []): string[] {
  const out: string[] = [];
  for (const d of docs) if (!['approved', 'waived'].includes(d.status))
    out.push(`Document "${d.name}" is ${d.status === 'pending' ? 'waiting for approval' : d.status}`);
  for (const t of w.trips) if (!['closed', 'cancelled'].includes(t.stage)) out.push(`Truck trip ${t.job_number} is still "${t.status_name}"`);
  for (const r of w.pro) if (!['done', 'cancelled'].includes(r.stage)) out.push(`PRO request ${r.request_no} is still "${r.status_name}"`);
  for (const m of w.runs) if (!['delivered', 'cancelled'].includes(m.status)) out.push(`Messenger run ${m.run_number} is not finished (${m.status})`);
  if (f.needs_transport && !w.trips.some((t) => t.stage === 'closed')) out.push('Transport is needed, but no truck trip is completed');
  if (f.needs_clearance && !w.pro.some((r) => r.stage === 'done')) out.push('Customs clearance is needed, but no PRO request is completed');
  return out;
}

export async function getJobFile(actor: Actor, id: string) {
  const f = await loadFile(actor, id);
  const [extra, containers, milestones, events, work] = await Promise.all([
    one(`select c.name customer_name, c.service_instructions, dep.name department_name, u.full_name created_by_name, cb.full_name closed_by_name,
       sm.full_name salesman_name, co.full_name coordinator_name, cf.full_name confirmed_by_name, ho.full_name handed_over_by_name
       from job_files f join customers c on c.id = f.customer_id left join departments dep on dep.id = f.department_id
       join users u on u.id = f.created_by left join users cb on cb.id = f.closed_by left join users sm on sm.id = f.salesman_id
       left join users co on co.id = f.coordinator_id left join users cf on cf.id = f.confirmed_by left join users ho on ho.id = f.handed_over_by where f.id = $1`, [id]),
    q(`select id, container_no, size_type, seal_no from job_file_containers where job_file_id = $1 and deleted_at is null order by container_no`, [id]),
    q(`select m.id, m.code, m.name, m.planned_date, m.actual_at, m.remarks, u.full_name updated_by_name from job_file_milestones m
       left join users u on u.id = m.updated_by where m.job_file_id = $1 order by m.sort_order`, [id]),
    q(`select id, kind, title, field, old_value, new_value, remarks, user_name, at from job_file_events where job_file_id = $1 order by at, id`, [id]),
    linkedWork(id),
  ]);
  // The quotation (and its rates) only for people who may see quotations
  const quotation = f.quotation_id && actor.has('quotes.view')
    ? await one('select id, quote_no, status from quotations where id = $1', [f.quotation_id]) : null;
  // Enquiry side (migration 017): every quotation and vendor request on this Job No.
  const quotations = actor.has('quotes.view') ? await q(`select id, quote_no, status, valid_until, created_at, version_no, salesman_decision from quotations
    where job_file_id = $1 and deleted_at is null order by created_at`, [id]) : null;
  const seeVendors = actor.isSuperAdmin || actor.has('vendors.requests') || actor.has('vendors.manage') || actor.has('quotes.view');
  // requests sent to several vendors for the same rate share a rate_group; the lowest valid price is marked (cost viewers only)
  const { markLowest } = await import('./vendorreqs');
  const vendorRequests = seeVendors ? markLowest(await q(`select r.id, r.request_no, r.service, r.status, r.description, r.quoted_cost, r.currency, r.rate_valid_until,
      r.vendor_reference, r.rate_group, r.vendor_id, r.rate_source, r.transit_days, r.free_days, r.routing, r.carrier, r.etd rate_etd, r.rate_version,
      r.assigned_to, r.received_at, r.route_id, v.name vendor_name from vendor_requests r join vendors v on v.id = r.vendor_id where r.job_file_id = $1
      order by coalesce(r.rate_group, r.id), r.quoted_cost nulls last, r.created_at`, [id]), (r) => r.service === 'rate' ? `route:${r.route_id ?? ''}` : r.rate_group)
      .map((r) => (actor.fin.buyingView ? r : { ...r, quoted_cost: undefined, lowest: undefined })) : null;
  const docsRequired = (await getSetting('jobfile_docs_required_to_close', true)) !== false;
  const docList = await checklist(f);
  const documents = await q(`select d.id, d.doc_type, d.file_name, d.mime_type, d.size_bytes, d.version, d.replaced_at, d.issue_date, d.expiry_date,
      d.description, d.status, d.review_note, d.reviewed_at, d.created_at, u.full_name uploaded_by_name, r.full_name reviewed_by_name
    from jf_documents d left join users u on u.id = d.uploaded_by left join users r on r.id = d.reviewed_by
    where d.job_file_id = $1 and d.deleted_at is null
      -- saved emails and their attachments are listed on the Emails panel instead (Part G1)
      and d.email_id is null and not exists (select 1 from email_messages e where e.document_id = d.id)
    order by d.doc_type, d.created_at`, [id]);
  const blockers = closureBlockers(f, work, docsRequired ? docList : []);
  const edit = canEdit(actor, f);
  const prealert = await one(`select p.*, u.full_name verified_by_name from prealerts p left join users u on u.id = p.verified_by where p.job_file_id = $1`, [id]);
  const booking = f.booking_vendor_request_id ? await one(`select r.id, r.request_no, r.status, r.vendor_reference, v.name vendor_name from vendor_requests r
    join vendors v on v.id = r.vendor_id where r.id = $1`, [f.booking_vendor_request_id]) : null;
  const commercial = f.enquiry_ref !== null;
  const lcl = f.mode === 'sea_lcl' ? await (await import('./lcl')).lclForFile(id) : null;
  // Customer Service is retired (Part G1): old cases on this shipment stay visible, read-only
  const oldCases = await q(`select id, case_no, subject, status, created_at from cs_cases where job_file_id = $1 order by created_at`, [id]);
  // Part G2: route options, vessel legs, BL drafts
  const rt = await import('./routing');
  const [routes, legs, blDrafts, cargoLines] = await Promise.all([rt.routesFor(id), rt.legsFor(id), rt.blDraftsFor(id), liveCargo(id)]);
  return {
    ...shape({ ...f, ...extra }), search_text: undefined, quotation_id: quotation ? f.quotation_id : undefined, quotation,
    prealert, booking, lcl, old_cases: oldCases, cargo_lines: cargoLines, routes, legs, bl_drafts: blDrafts, email_subject: (await import('./emails')).threadSubject({ ...f, ...extra }), containers, milestones, events, ...work, checklist: docList, documents, docs_required_to_close: docsRequired,
    quotations: quotations?.map((x) => ({ ...x, status_name: qStatusName(x.status), status_color: qStatusColor(x.status) })) ?? null, vendor_requests: vendorRequests,
    closure: { can_close: blockers.length === 0, blockers,
      warnings: milestones.filter((m) => !m.actual_at).map((m) => `Milestone "${m.name}" has no actual date`) },
    can: { edit, status: edit, close: (actor.isSuperAdmin || actor.has('jobfiles.close')) && f.status !== 'cancelled',
      request_transport: actor.has('jobs.create') && isOpen(f), request_pro: actor.has('pro.create') && isOpen(f),
      quote: actor.has('quotes.create') && isOpen(f) && (!commercial || PRE_CONFIRM.includes(f.stage) || f.stage === 'handed_over'),
      ask_vendor: (actor.isSuperAdmin || actor.has('vendors.requests')) && isOpen(f),
      book: edit && (actor.isSuperAdmin || actor.has('vendors.requests')) && ['customer_confirmed', 'booking_requested'].includes(f.stage),
      confirm_booking: edit && f.stage === 'booking_requested',
      prealert: edit && ['booking_confirmed', 'prealert_awaited', 'prealert_received'].includes(f.stage),
      handover: edit && f.status === 'enquiry' && (actor.isSuperAdmin || actor.has('jobfiles.handover'))
        && (f.stage === 'prealert_verified' || ((actor.isSuperAdmin || actor.has('commercial.manage')) && ['customer_confirmed', 'booking_requested', 'booking_confirmed', 'prealert_awaited', 'prealert_received'].includes(f.stage))),
      lost: edit && PRE_CONFIRM.includes(f.stage) && f.status === 'enquiry',
      upload: edit, approve_docs: (actor.isSuperAdmin || actor.has('documents.approve')) && f.status !== 'cancelled' },
  };
}

// ------------------------------------------------------------ changes
export async function updateJobFile(actor: Actor, id: string, b: any) {
  await tx(async (c) => {
    const f = await loadFile(actor, id, c, true);
    if (!canEdit(actor, f)) throw forbidden(isOpen(f) ? 'You cannot change this Job File' : `This Job File is ${jfStatusName(f.status).toLowerCase()}`);
    const changes: [string, unknown][] = [];
    for (const [k, def] of Object.entries(FIELDS)) {
      if (b[k] === undefined) continue;
      const v = def.parse(b[k]);
      const old = f[k] === null || f[k] === undefined ? null : f[k];
      if (String(old ?? '') !== String(v ?? '') && !(typeof v === 'string' && old !== null && Number(old) === Number(v) && v !== '' && !isNaN(Number(v))))
        changes.push([k, v]);
    }
    const next = { ...f, ...Object.fromEntries(changes) };
    if (f.status === 'enquiry' && f.division && changes.some(([k, v]) => k === 'direction' && v !== directionOfDivision(f.division)))
      throw new ApiError(400, 'VALIDATION', `This enquiry is in the ${divisionName(f.division)} division (it is in the Enquiry Ref), so its direction stays ${DIRECTIONS.find(([c]) => c === directionOfDivision(f.division))?.[1]}.`,
        { fields: { direction: 'Follows the division' } });
    if (next.etd && next.eta && String(next.eta) < String(next.etd)) throw bad('ETA is before ETD');
    // Incoterm details (migration 023): checked at enquiry stage when the term or one of its fields is changed
    if (f.status === 'enquiry' && changes.some(([k]) => INCOTERM_KEYS.includes(k))) checkIncoterm(next, f.incoterm == null);
    // cargo lines (migration 023): when the shipment has lines, its totals always come from them
    const cargo = parseCargo(b.cargo_lines);
    const oldCargo = await liveCargo(id, c);
    if (cargo && !cargo.length && oldCargo.length && f.status === 'enquiry' && dimsRequired(next.mode))
      throw new ApiError(400, 'VALIDATION', 'Keep at least one cargo line', { fields: { cargo_lines: 'Keep at least one line: packages, size and weight' } });
    const cargoChanged = cargo !== undefined && cargoSummary(cargo) !== cargoSummary(oldCargo);
    const lines = cargoChanged ? cargo! : oldCargo;
    if (lines.length) for (const k of ['packages', 'gross_weight_kg', 'volume_cbm', 'chargeable_weight_kg']) {
      const i = changes.findIndex(([x]) => x === k); if (i >= 0) changes.splice(i, 1);
    }
    if (cargoChanged) {
      await saveCargo(c, actor, id, cargo!, next.mode);
      await event(c, actor, id, { kind: 'edit', title: 'Cargo dimensions changed', field: 'Cargo', old_value: cargoSummary(oldCargo), new_value: cargoSummary(cargo!) });
    } else if (lines.length && changes.some(([k]) => k === 'mode')) await writeTotals(c, id, lines, next.mode);
    if (!changes.length) { if (cargoChanged) await refreshSearch(c, id); return; }
    if (changes.some(([k]) => k === 'customer_id') && !(await one('select 1 from customers where id = $1 and deleted_at is null', [next.customer_id], c)))
      throw bad('Customer not found');
    await c.query(`update job_files set ${changes.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`,
      [id, ...changes.map(([, v]) => v)]);
    for (const [k, v] of changes) {
      const show = async (x: unknown) => k === 'customer_id' ? (await one('select name from customers where id = $1', [x], c))?.name
        : k === 'direction' ? label(DIRECTIONS, x as string) : k === 'mode' ? label(MODES, x as string)
        : typeof x === 'boolean' ? (x ? 'Yes' : 'No') : x;
      await event(c, actor, id, { kind: 'edit', title: `${FIELDS[k].label} changed`, field: FIELDS[k].label, old_value: await show(f[k]), new_value: await show(v) });
    }
    await refreshSearch(c, id);
  });
  return getJobFile(actor, id);
}

export async function setJobFileStatus(actor: Actor, id: string, b: any) {
  const to = String(b.status ?? '');
  if (!JF_STATUSES.some((s) => s[0] === to)) throw bad('Choose a status');
  await tx(async (c) => {
    const f = await loadFile(actor, id, c, true);
    if (f.status === to) return;
    if (f.status === 'cancelled') throw new ApiError(409, 'JOB_FILE_CANCELLED', 'This Job File is cancelled. Create a new one if the shipment goes ahead.');
    const closer = actor.isSuperAdmin || actor.has('jobfiles.close');
    if (to === 'closed' || to === 'cancelled' || f.status === 'closed') { if (!closer) throw forbidden('Only people who close Job Files can do this'); }
    else if (!canEdit(actor, f)) throw forbidden('You cannot change this Job File');
    let note: string | null = null;
    if (f.status === 'enquiry' && to !== 'cancelled' && to !== 'closed')
      throw new ApiError(409, 'JOB_FILE_ENQUIRY', 'A shipment still in Commercials goes live when the operational job is created (Job No. from the ERP), after the pre-alert is verified.');
    if (to === 'closed' && f.status === 'enquiry')
      throw new ApiError(409, 'JOB_FILE_ENQUIRY', 'This is still an enquiry. Accept a quotation (or set it to Open) first, or cancel it if the customer did not go ahead.');
    if (to === 'closed') {
      const docsRequired = (await getSetting('jobfile_docs_required_to_close', true, c)) !== false;
      const blockers = closureBlockers(f, await linkedWork(id, c), docsRequired ? await checklist(f, c) : []);
      if (blockers.length) throw new ApiError(409, 'JOB_FILE_NOT_READY', 'This Job File cannot close yet: ' + blockers.join('; '), { blockers });
      await c.query(`update job_files set status = 'closed', closed_at = now(), closed_by = $2, updated_at = now() where id = $1`, [id, actor.id]);
    } else if (to === 'cancelled') {
      const reason = txt(b.reason, 500);
      if (!reason) throw bad('Give a reason for cancelling');
      const w = await linkedWork(id, c);
      const open = [...w.trips.filter((t) => !['closed', 'cancelled'].includes(t.stage)).map((t) => t.job_number),
        ...w.pro.filter((r) => !['done', 'cancelled'].includes(r.stage)).map((r) => r.request_no)];
      if (open.length) throw new ApiError(409, 'JOB_FILE_HAS_OPEN_WORK', `Cancel or finish the linked work first: ${open.join(', ')}`, { open });
      await c.query(`update job_files set status = 'cancelled', cancel_reason = $2, updated_at = now(),
        stage = case when stage is null or stage = 'handed_over' then stage else 'cancelled' end where id = $1`, [id, reason]);
      await relink(c, f.job_no);   // the Job No. is free again; linked records let go of this file
      note = reason;
    } else {
      // between the active steps, or reopening a closed file
      await c.query(`update job_files set status = $2, closed_at = null, closed_by = null, updated_at = now() where id = $1`, [id, to]);
      if (f.status === 'closed') note = txt(b.reason, 500) ?? 'Reopened';
    }
    await event(c, actor, id, { kind: 'status', title: `Status: ${jfStatusName(to)}`, field: 'Status', old_value: jfStatusName(f.status), new_value: note ?? jfStatusName(to) });
  });
  return getJobFile(actor, id);
}

export async function saveJobFileContainer(actor: Actor, id: string, b: any) {
  await tx(async (c) => {
    const f = await loadFile(actor, id, c, true);
    if (!canEdit(actor, f)) throw forbidden('You cannot change this Job File');
    if (b.remove) {
      if (!isUuid(b.container_id)) throw bad('Choose the container');
      const k = await one('update job_file_containers set deleted_at = now() where id = $1 and job_file_id = $2 and deleted_at is null returning container_no', [b.container_id, id], c);
      if (!k) throw notFound('Container');
      await event(c, actor, id, { kind: 'container', title: `Container ${k.container_no} removed` });
    } else {
      const no = normContainer(b.container_no);
      const exists = await one('select 1 from job_file_containers where job_file_id = $1 and container_no = $2 and deleted_at is null', [id, no], c);
      if (exists) throw bad(`Container ${no} is already on this Job File`);
      await c.query('insert into job_file_containers (job_file_id, container_no, size_type, seal_no) values ($1,$2,$3,$4)',
        [id, no, txt(b.size_type, 10), txt(b.seal_no, 30)]);
      await event(c, actor, id, { kind: 'container', title: `Container ${no} added`, new_value: [b.size_type, b.seal_no && `seal ${b.seal_no}`].filter(Boolean).join(', ') });
    }
    await refreshSearch(c, id);
  });
  return getJobFile(actor, id);
}

export async function saveMilestone(actor: Actor, id: string, b: any) {
  await tx(async (c) => {
    const f = await loadFile(actor, id, c, true);
    if (!canEdit(actor, f)) throw forbidden('You cannot change this Job File');
    if (!isUuid(b.milestone_id)) throw bad('Choose the milestone');
    const m = await one('select * from job_file_milestones where id = $1 and job_file_id = $2', [b.milestone_id, id], c);
    if (!m) throw notFound('Milestone');
    const planned = b.planned_date !== undefined ? day(b.planned_date, 'Planned date') : m.planned_date;
    let actual = m.actual_at;
    if (b.done === true) actual = b.actual_at ? new Date(b.actual_at) : new Date();
    if (b.done === false) actual = null;
    if (actual && isNaN(new Date(actual).getTime())) throw bad('Actual date is not valid');
    if (actual && new Date(actual).getTime() > Date.now() + 5 * 60000) throw bad('The actual date cannot be in the future');
    const remarks = b.remarks !== undefined ? txt(b.remarks, 500) : m.remarks;
    await c.query('update job_file_milestones set planned_date = $2, actual_at = $3, remarks = $4, updated_by = $5, updated_at = now() where id = $1',
      [m.id, planned, actual, remarks, actor.id]);
    const what = b.done === true ? 'done' : b.done === false ? 'marked not done' : 'updated';
    await event(c, actor, id, { kind: 'milestone', title: `Milestone "${m.name}" ${what}`,
      new_value: [planned && `planned ${planned}`, actual && `actual ${new Date(actual).toISOString().slice(0, 16).replace('T', ' ')}`, remarks].filter(Boolean).join(' · ') });
    // the departure / arrival steps fill the actual dates on the file
    const d = actual ? new Date(actual).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }) : null;
    if (m.code === 'departed') await c.query('update job_files set atd = $2 where id = $1', [id, d]);
    if (m.code === 'arrived') await c.query('update job_files set ata = $2 where id = $1', [id, d]);
  });
  return getJobFile(actor, id);
}

export async function addJobFileNote(actor: Actor, id: string, b: any) {
  const body = txt(b.body, 2000);
  if (!body) throw bad('Write the note');
  await tx(async (c) => {
    await loadFile(actor, id, c);
    await event(c, actor, id, { kind: 'note', title: 'Note', new_value: body });
  });
  return getJobFile(actor, id);
}

// ------------------------------------------------------------ report: Job File register
export async function jobFileReport(actor: Actor, def: any, cols: any[], colsOut: any[], p: Record<string, string>, opts: { all?: boolean }) {
  if (!canSeeJobFiles(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = filterSql(actor, p, params);
  const size = opts.all ? 50000 : Math.min(Math.max(Number(p.page_size) || 50, 1), 500), page = opts.all ? 1 : Math.max(Number(p.page) || 1, 1);
  const SORT: Record<string, string> = { job_no: 'upper(f.job_no)', customer_name: 'c.name', etd: 'f.etd', eta: 'f.eta', created_at: 'f.created_at' };
  const sort = SORT[p.sort ?? ''] ? `${SORT[p.sort!]} ${p.dir === 'desc' ? 'desc' : 'asc'} nulls last` : 'f.created_at desc';
  const rows = await q(`select ${LIST_COLS}, count(*) over() _total ${LIST_FROM} ${where} order by ${sort}, f.job_no limit ${size} offset ${(page - 1) * size}`, params);
  const shaped = rows.map(({ _total, ...r }) => {
    const s = shape(r);
    const services = [r.needs_clearance && 'Clearance', r.needs_transport && 'Transport', r.needs_warehouse && 'Warehouse'].filter(Boolean).join(', ');
    return Object.fromEntries(cols.map((col: any) => [col.key, col.key === 'services' ? services || '—' : col.key === 'route'
      ? [r.port_of_loading ?? r.origin, r.port_of_discharge ?? r.destination].filter(Boolean).join(' → ') || '—' : (s as any)[col.key]]));
  });
  return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped, totals: null,
    total: Number(rows[0]?._total ?? 0), page, page_size: size, filters: p };
}
