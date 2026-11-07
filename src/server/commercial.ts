/**
 * Commercials Department (Part E, migration 018).
 *
 * One shipment record (job_files) from enquiry to handover, with three numbers:
 *   Enquiry Ref  ENQ-26-00001   made when the enquiry is opened
 *   Shipping Ref SR-26-00001    made when the customer confirms the quotation
 *   Job No.      from the ERP   typed when the operational job is created (after the pre-alert is verified)
 *
 * People: Responsible Salesman, Assigned Coordinator (from the Salesman's mapping) and Created By are kept apart.
 * Customers: a Salesman sees the customers they own; a Coordinator those of the Salesmen mapped to them.
 * Stage moves forward with the work (rates → quotation → approval → sent → confirmed → booking → pre-alert →
 * handover); every move is written to the shipment's history.
 */
import { PoolClient } from 'pg';
import { Actor } from './auth';
import { ApiError, audit, bad, Db, forbidden, notFound, one, q, tx } from './db';
import { STAGE_ORDER, PRE_CONFIRM, stageName, DIVISIONS, PREALERT_CHECKS } from '../lib/commercialRules';
import { jobNoProblem } from '../lib/requestRules';

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

// ------------------------------------------------------------ numbers
/** Division code in the Enquiry Ref (decision D1): ENQ-IMP-26-00012. */
export const DIVISION_CODES: Record<string, string> = { imports: 'IMP', exports: 'EXP', cross_trade: 'CTR' };
export async function newRef(db: Db, kind: 'ENQ' | 'SR', division?: string | null) {
  const seq = kind === 'ENQ' ? 'enquiry_ref_seq' : 'shipping_ref_seq';
  const mid = kind === 'ENQ' && division && DIVISION_CODES[division] ? `${DIVISION_CODES[division]}-` : '';
  return (await one(`select '${kind}-${mid}' || to_char(now() at time zone 'Asia/Dubai', 'YY') || '-' || lpad(nextval('${seq}')::text, 5, '0') r`, [], db)).r as string;
}

// ------------------------------------------------------------ stage
async function jfEvent(db: Db, actor: Actor | null, fileId: string, e: { kind: string; title: string; field?: string; old_value?: unknown; new_value?: unknown; remarks?: string | null }) {
  const s = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 1000));
  await db.query(`insert into job_file_events (job_file_id, kind, title, field, old_value, new_value, remarks, user_id, user_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [fileId, e.kind, e.title, e.field ?? null, s(e.old_value), s(e.new_value), e.remarks ?? null, actor?.id ?? null, actor?.full_name ?? 'System']);
}
/**
 * Move the shipment's commercial stage. Normally only forward; `back` lets quotation work move it back while the
 * customer has not confirmed yet (e.g. a quotation returned for revision). Lost / cancelled can come at any time
 * before handover. Nothing moves after handover.
 */
export async function setStage(db: Db, actor: Actor | null, fileId: string, to: string, opts: { back?: boolean; note?: string | null } = {}) {
  const f = await one('select stage from job_files where id = $1', [fileId], db);
  if (!f) return;
  const cur = f.stage ?? 'enquiry';
  if (cur === to || ['handed_over', 'lost', 'cancelled'].includes(cur)) return;
  const ci = STAGE_ORDER.indexOf(cur), ti = STAGE_ORDER.indexOf(to);
  const ending = ['lost', 'cancelled'].includes(to);
  if (!ending) {
    if (ti < ci && !(opts.back && PRE_CONFIRM.includes(cur) && PRE_CONFIRM.includes(to))) return;
  }
  await db.query('update job_files set stage = $2, updated_at = now() where id = $1', [fileId, to]);
  await jfEvent(db, actor, fileId, { kind: 'status', title: `Stage: ${stageName(to)}`, field: 'Stage', old_value: stageName(cur), new_value: stageName(to), remarks: opts.note ?? null });
  // the handling group hears about the step forward (a quotation sent back for work is told by the quotation itself)
  const { STAGE_EVENTS, notifyGroup } = await import('./notify');
  if (STAGE_EVENTS[to] && (ending || ti > ci)) await notifyGroup(db, actor, fileId, STAGE_EVENTS[to], opts.note ?? null);
}

// ------------------------------------------------------------ customers: who may use which
export const restrictedCustomers = (a: Actor) =>
  !a.isSuperAdmin && !a.has('customers.view_all') && ['sales', 'coordinator', 'agent_coordinator'].includes(a.role_code);
/**
 * SQL for the customers this person may pick: their own (Salesman), their mapped Salesmen's (Coordinator), and
 * customers nobody owns yet (the first enquiry makes its Salesman the owner). Everyone else: all customers.
 */
export function customerScopeSql(a: Actor, params: unknown[], alias = 'c') {
  if (!restrictedCustomers(a)) return '';
  if (a.role_code === 'agent_coordinator') return ' and false';
  params.push(a.id);
  const me = `$${params.length}`;
  return ` and (not exists (select 1 from customer_salesmen o where o.customer_id = ${alias}.id and o.removed_at is null)
    or exists (select 1 from customer_salesmen o join users s on s.id = o.user_id where o.customer_id = ${alias}.id and o.removed_at is null
      and (o.user_id = ${me} or s.coordinator_id = ${me})))`;
}
export async function assertCustomerAllowed(a: Actor, customerId: string, db?: Db) {
  const p: unknown[] = [customerId];
  const c = await one(`select c.id from customers c where c.id = $1 and c.deleted_at is null${customerScopeSql(a, p)}`, p, db);
  if (!c) throw bad('Customer not found, or it belongs to another Salesman');
}
/** The Salesman must own the customer; a customer nobody owns yet gets this Salesman as its main owner. */
async function claimCustomer(db: Db, actor: Actor, customerId: string, salesmanId: string) {
  const owners = await q('select user_id from customer_salesmen where customer_id = $1 and removed_at is null', [customerId], db);
  if (!owners.length) {
    await db.query('insert into customer_salesmen (customer_id, user_id, is_main, created_by) values ($1,$2,true,$3) on conflict do nothing', [customerId, salesmanId, actor.id]);
    const n = await one('select (select name from customers where id = $1) c, (select full_name from users where id = $2) s', [customerId, salesmanId], db);
    await audit(db, actor, { entity_type: 'customer', entity_id: customerId, action: 'Customer owner set', field: 'Salesman', new_value: `${n.s} (main) — first enquiry for ${n.c}` });
    return;
  }
  if (owners.some((o) => o.user_id === salesmanId) || actor.has('commercial.manage') || actor.isSuperAdmin) return;
  const s = await one('select full_name from users where id = $1', [salesmanId], db);
  throw bad(`${s?.full_name ?? 'This Salesman'} is not a Salesman of this customer. Ask the Commercials Manager to add them.`);
}
/** A Salesman who creates a customer becomes its main owner. */
export async function ownNewCustomer(db: Db, actor: Actor, customerId: string) {
  if (actor.role_code !== 'sales') return;
  await db.query('insert into customer_salesmen (customer_id, user_id, is_main, created_by) values ($1,$2,true,$2) on conflict do nothing', [customerId, actor.id]);
}

export async function customerOwners(actor: Actor, customerId: string) {
  if (!isUuid(customerId)) throw notFound('Customer');
  if (restrictedCustomers(actor)) await assertCustomerAllowed(actor, customerId);
  return {
    owners: await q(`select o.user_id, u.full_name, u.division, o.is_main, o.created_at from customer_salesmen o join users u on u.id = o.user_id
      where o.customer_id = $1 and o.removed_at is null order by o.is_main desc, u.full_name`, [customerId]),
    salesmen: actor.has('commercial.manage') || actor.isSuperAdmin ? await q(`select u.id, u.full_name, u.division from users u join roles r on r.id = u.role_id
      where r.code = 'sales' and u.is_active and u.deleted_at is null order by u.full_name`) : [],
    can_manage: actor.has('commercial.manage') || actor.isSuperAdmin,
  };
}
/** Commercials Manager: set the Salesmen of a customer (one main). Removed owners are kept with who and when. */
export async function setCustomerOwners(actor: Actor, customerId: string, b: any) {
  if (!actor.has('commercial.manage') && !actor.isSuperAdmin) throw forbidden();
  if (!isUuid(customerId)) throw notFound('Customer');
  const list: { user_id: string; is_main: boolean }[] = Array.isArray(b.owners) ? b.owners.map((o: any) => ({ user_id: o.user_id, is_main: !!o.is_main })) : [];
  if (list.some((o) => !isUuid(o.user_id))) throw bad('Choose the Salesmen');
  if (list.length && list.filter((o) => o.is_main).length !== 1) throw bad('Mark one Salesman as the main owner');
  if (new Set(list.map((o) => o.user_id)).size !== list.length) throw bad('A Salesman is listed twice');
  await tx(async (c) => {
    if (!(await one('select 1 from customers where id = $1 and deleted_at is null', [customerId], c))) throw notFound('Customer');
    const ok = await q(`select u.id from users u join roles r on r.id = u.role_id where u.id = any($1) and r.code = 'sales' and u.deleted_at is null`, [list.map((o) => o.user_id)], c);
    if (ok.length !== list.length) throw bad('Owners must be Salesmen');
    const before = await q(`select o.user_id, o.is_main, u.full_name from customer_salesmen o join users u on u.id = o.user_id where o.customer_id = $1 and o.removed_at is null`, [customerId], c);
    const fmt = (l: any[]) => l.map((o) => o.full_name + (o.is_main ? ' (main)' : '')).sort().join(', ') || 'none';
    await c.query('update customer_salesmen set removed_at = now(), removed_by = $2 where customer_id = $1 and removed_at is null', [customerId, actor.id]);
    for (const o of list)
      await c.query('insert into customer_salesmen (customer_id, user_id, is_main, created_by) values ($1,$2,$3,$4)', [customerId, o.user_id, o.is_main, actor.id]);
    const after = await q(`select o.user_id, o.is_main, u.full_name from customer_salesmen o join users u on u.id = o.user_id where o.customer_id = $1 and o.removed_at is null`, [customerId], c);
    if (fmt(before) !== fmt(after))
      await audit(c, actor, { entity_type: 'customer', entity_id: customerId, action: 'Customer owners changed', field: 'Salesmen', old_value: fmt(before), new_value: fmt(after) });
  });
  return customerOwners(actor, customerId);
}

// ------------------------------------------------------------ enquiry: Salesman, Coordinator, division
/**
 * Salesman opens it  → they are the Responsible Salesman; the Coordinator comes from their mapping.
 * Coordinator opens it → they choose the Responsible Salesman; the Coordinator is that Salesman's mapped one.
 * Manager / others   → may choose both. Division: the Salesman's, unless a manager picks another.
 */
export async function resolvePeople(actor: Actor, b: any, customerId: string, direction: string | undefined, db: Db) {
  let salesmanId: string | null = actor.role_code === 'sales' ? actor.id : (b.salesman_id || null);
  if (!salesmanId && actor.role_code === 'coordinator')
    throw new ApiError(400, 'VALIDATION', 'Choose the responsible Salesman', { fields: { salesman_id: 'Choose the responsible Salesman' } });
  let s: any = null;
  if (salesmanId) {
    if (!isUuid(salesmanId)) throw bad('Choose the Salesman');
    s = await one(`select u.id, u.full_name, u.division, u.coordinator_id from users u join roles r on r.id = u.role_id
      where u.id = $1 and r.code = 'sales' and u.is_active and u.deleted_at is null`, [salesmanId], db);
    if (!s) throw bad('The responsible Salesman must be an active user with the Salesman role');
    if (actor.role_code === 'coordinator' && s.coordinator_id && s.coordinator_id !== actor.id && !actor.has('commercial.manage')) {
      // allowed: the enquiry still goes to the Salesman's own Coordinator
    }
    await claimCustomer(db, actor, customerId, salesmanId);
  }
  let coordinatorId: string | null = s?.coordinator_id ?? (actor.role_code === 'coordinator' ? actor.id : null);
  if (b.coordinator_id && (actor.has('commercial.manage') || actor.isSuperAdmin)) {
    if (!isUuid(b.coordinator_id) || !(await one(`select 1 from users u join roles r on r.id = u.role_id where u.id = $1 and r.code = 'coordinator' and u.is_active and u.deleted_at is null`, [b.coordinator_id], db)))
      throw bad('Choose an active Coordinator');
    coordinatorId = b.coordinator_id;
  }
  if (actor.role_code === 'sales' && !coordinatorId)
    throw bad('No Coordinator is mapped to you yet. Ask the Commercials Manager to assign one.');
  const fromDirection = direction === 'import' ? 'imports' : direction === 'export' ? 'exports' : direction === 'cross_trade' ? 'cross_trade' : null;
  let division: string | null = s?.division ?? actor.division ?? fromDirection;
  if (b.division && (actor.has('commercial.manage') || actor.isSuperAdmin || !s?.division)) {
    if (!DIVISIONS.some(([d]) => d === b.division)) throw bad('Choose the division');
    division = b.division;
  }
  return { salesman_id: salesmanId, coordinator_id: coordinatorId, division };
}

/** Commercials Manager: change the Salesman and / or Coordinator on a shipment before handover. Both old and new people are told. */
export async function reassignPeople(actor: Actor, fileId: string, b: any) {
  if (!actor.isSuperAdmin && !actor.has('commercial.manage')) throw forbidden('Only the Commercials Manager can reassign');
  const reason = txt(b.reason, 500);
  if (!reason) throw bad('Say why it is reassigned');
  await tx(async (c) => {
    const { loadFile } = await import('./jobfiles');
    const f = await loadFile(actor, fileId, c, true);
    if (f.stage === 'handed_over' || ['lost', 'cancelled'].includes(f.stage)) throw new ApiError(409, 'STAGE', 'Only a shipment that is not handed over can be reassigned');
    const pick = async (id: unknown, role: string, label: string) => {
      if (!id) return null;
      if (!isUuid(id) || !(await one(`select 1 from users u join roles r on r.id = u.role_id where u.id = $1 and r.code = $2 and u.is_active and u.deleted_at is null`, [id, role], c)))
        throw bad(`Choose an active ${label}`);
      return id as string;
    };
    const sm = b.salesman_id === undefined ? f.salesman_id : await pick(b.salesman_id, 'sales', 'Salesman');
    const co = b.coordinator_id === undefined ? f.coordinator_id : await pick(b.coordinator_id, 'coordinator', 'Coordinator');
    if (sm === f.salesman_id && co === f.coordinator_id) throw bad('Nothing changed');
    const name = async (id: string | null) => id ? (await one('select full_name from users where id = $1', [id], c))?.full_name : null;
    await c.query('update job_files set salesman_id = $2, coordinator_id = $3, updated_at = now() where id = $1', [fileId, sm, co]);
    if (sm !== f.salesman_id) await jfEvent(c, actor, fileId, { kind: 'edit', title: 'Salesman changed', field: 'Salesman', old_value: await name(f.salesman_id), new_value: await name(sm), remarks: reason });
    if (co !== f.coordinator_id) await jfEvent(c, actor, fileId, { kind: 'edit', title: 'Coordinator changed', field: 'Coordinator', old_value: await name(f.coordinator_id), new_value: await name(co), remarks: reason });
    if (sm) await claimCustomer(c, actor, f.customer_id, sm);
    await (await import('./notify')).notifyGroup(c, actor, fileId, 'assigned', reason, { also: [f.salesman_id, f.coordinator_id] });
  });
  const { getJobFile, refreshJobFileSearch } = await import('./jobfiles');
  await refreshJobFileSearch(fileId);
  return getJobFile(actor, fileId);
}

// ------------------------------------------------------------ booking
async function fileFor(actor: Actor, fileId: string, c: PoolClient) {
  const { loadFile, canEdit } = await import('./jobfiles');
  const f = await loadFile(actor, fileId, c, true);
  if (!canEdit(actor, f)) throw forbidden('You cannot change this shipment');
  return f;
}
/** After the customer confirms: send the booking to the agent / carrier whose rate was chosen. */
export async function requestBooking(actor: Actor, fileId: string, b: any) {
  if (!actor.isSuperAdmin && !actor.has('vendors.requests')) throw forbidden();
  await tx(async (c) => {
    const f = await fileFor(actor, fileId, c);
    if (!['customer_confirmed', 'booking_requested'].includes(f.stage)) throw new ApiError(409, 'STAGE', 'A booking can be sent once the customer has confirmed');
    if (!isUuid(b.rate_request_id)) throw bad('Choose the rate to book');
    const r = await one(`select r.*, v.name vendor_name from vendor_requests r join vendors v on v.id = r.vendor_id
      where r.id = $1 and r.job_file_id = $2 and r.service = 'rate' and r.status <> 'cancelled'`, [b.rate_request_id, fileId], c);
    if (!r) throw bad('Choose a rate on this shipment');
    // Part G2: only a rate for the option the customer chose can be booked
    if (f.selected_route_id && r.route_id && r.route_id !== f.selected_route_id) throw bad('This rate is for a route option the customer did not choose');
    const open = f.booking_vendor_request_id && await one(`select request_no from vendor_requests where id = $1 and status not in ('cancelled')`, [f.booking_vendor_request_id], c);
    if (open) throw new ApiError(409, 'BOOKING_OPEN', `Booking ${open.request_no} is already open. Cancel it first to book with another vendor.`);
    const { createVendorRequest, vendorRequestAction } = await import('./vendorreqs');
    const instructions = txt(b.description, 2000) ?? `Please book as per your rate ${r.request_no}${r.vendor_reference ? ` (your ref. ${r.vendor_reference})` : ''}.`;
    const made = await createVendorRequest(actor, { vendor_id: r.vendor_id, service: 'booking', job_file_id: fileId, description: instructions,
      needed_by: b.needed_by || undefined, rate_source: r.rate_source ?? undefined, route_id: r.route_id ?? undefined }, c);
    await c.query('update vendor_requests set rate_request_id = $2, quoted_cost = $3, currency = $4 where id = $1', [made.id, r.id, r.quoted_cost, r.currency]);
    await c.query('update job_files set booking_vendor_request_id = $2 where id = $1', [fileId, made.id]);
    // the chosen rate is confirmed (a dearer choice is noted there)
    if (['requested', 'quoted'].includes(r.status)) await vendorRequestAction(actor, r.id, { status: 'confirmed', vendor_reference: r.vendor_reference ?? undefined, note: `Booked: ${made.request_no}` }, c);
    await jfEvent(c, actor, fileId, { kind: 'link', title: `Booking ${made.request_no} sent to ${r.vendor_name}`, new_value: `From rate ${r.request_no}` });
    await setStage(c, actor, fileId, 'booking_requested');
  });
  const { getJobFile } = await import('./jobfiles');
  return getJobFile(actor, fileId);
}

/** The agent / carrier confirmed the booking: record the details, then wait for the pre-alert. */
export async function confirmBooking(actor: Actor, fileId: string, b: any) {
  await tx(async (c) => {
    const f = await fileFor(actor, fileId, c);
    if (f.stage !== 'booking_requested' || !f.booking_vendor_request_id) throw new ApiError(409, 'STAGE', 'Send the booking request first');
    const ref = txt(b.booking_reference, 80);
    if (!ref) throw bad('Enter the carrier booking reference');
    const set: Record<string, unknown> = { booking_reference: ref, carrier: txt(b.carrier, 120), vessel_flight: txt(b.vessel_flight, 80),
      voyage: txt(b.voyage, 40), etd: day(b.etd, 'ETD'), eta: day(b.eta, 'ETA'),
      // Part G2: the rest of the booking confirmation
      booking_confirmed_on: day(b.booking_confirmed_on, 'Confirmation date'), port_of_loading: txt(b.port_of_loading, 80), port_of_discharge: txt(b.port_of_discharge, 80),
      booked_equipment: txt(b.booked_equipment, 120), routing_type: b.routing_type === 'via' ? 'via' : b.routing_type === 'direct' ? 'direct' : null };
    if (set.etd && set.eta && String(set.eta) < String(set.etd)) throw bad('ETA is before ETD');
    if (b.document_id && !(isUuid(b.document_id) && await one('select 1 from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null', [b.document_id, fileId], c)))
      throw bad('Upload the booking confirmation to the shipment first');
    const labels: Record<string, string> = { booking_reference: 'Carrier booking ref.', carrier: 'Shipping line / airline', vessel_flight: 'Vessel / flight', voyage: 'Voyage', etd: 'ETD', eta: 'ETA',
      booking_confirmed_on: 'Booking confirmed on', port_of_loading: 'Port of loading', port_of_discharge: 'Port of discharge', booked_equipment: 'Containers booked', routing_type: 'Direct / via' };
    for (const [k, v] of Object.entries(set)) {
      if (v === null) continue;
      const old = f[k] instanceof Date ? f[k].toISOString().slice(0, 10) : f[k];
      if (String(old ?? '') === String(v)) continue;
      await c.query(`update job_files set ${k} = $2, updated_at = now() where id = $1`, [fileId, v]);
      await jfEvent(c, actor, fileId, { kind: 'edit', title: `${labels[k]} changed`, field: labels[k], old_value: old, new_value: v });
    }
    const vr = await one('select status, request_no from vendor_requests where id = $1', [f.booking_vendor_request_id], c);
    if (['requested', 'quoted'].includes(vr.status)) {
      await c.query(`update vendor_requests set status = 'confirmed', vendor_reference = $2, confirmed_at = now(), updated_at = now() where id = $1`, [f.booking_vendor_request_id, ref]);
      await c.query('insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)',
        [f.booking_vendor_request_id, 'Status: Confirmed', `Booking confirmed — ${ref}`, actor.id, actor.full_name]);
    }
    // the expected vessel becomes leg 1 until the vessel details are confirmed
    if (set.vessel_flight && !(await one('select 1 from shipment_legs where job_file_id = $1', [fileId], c))) {
      await c.query(`insert into shipment_legs (job_file_id, leg_no, vessel, voyage, from_port, to_port, etd, eta, updated_by) values ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
        [fileId, set.vessel_flight, set.voyage, set.port_of_loading ?? f.port_of_loading, set.routing_type === 'via' ? null : set.port_of_discharge ?? f.port_of_discharge, set.etd, set.eta, actor.id]);
      await c.query(`update job_files set vessel_status = 'received' where id = $1 and vessel_status = 'pending'`, [fileId]);
    }
    await (await import('./notify')).notifyGroup(c, actor, fileId, 'booking_confirmed', ref);
    if (set.vessel_flight && String(set.vessel_flight) !== String(f.vessel_flight ?? '')) await (await import('./notify')).notifyGroup(c, actor, fileId, 'vessel_changed', [set.vessel_flight, set.voyage].filter(Boolean).join(' '));
    const expected = day(b.prealert_expected, 'Pre-alert expected date');
    await c.query(`insert into prealerts (job_file_id, expected_date, created_by) values ($1,$2,$3)
      on conflict (job_file_id) do update set expected_date = coalesce(excluded.expected_date, prealerts.expected_date), updated_at = now()`, [fileId, expected, actor.id]);
    await jfEvent(c, actor, fileId, { kind: 'status', title: `Booking confirmed — ${ref}`, new_value: expected ? `Pre-alert expected ${expected}` : null, remarks: txt(b.note, 500) });
    await setStage(c, actor, fileId, 'prealert_awaited');
  });
  const { getJobFile } = await import('./jobfiles');
  return getJobFile(actor, fileId);
}

// ------------------------------------------------------------ pre-alert
/**
 * expected   set or move the expected date / follow-up
 * receive    the pre-alert arrived: file + what it says
 * correction something is wrong: ask the agent / line to correct it (follow-up date)
 * verify     every applicable check ticked → the details go onto the shipment
 */
export async function prealertAction(actor: Actor, fileId: string, b: any) {
  const action = String(b.action ?? '');
  await tx(async (c) => {
    const f = await fileFor(actor, fileId, c);
    if (!['booking_confirmed', 'prealert_awaited', 'prealert_received', 'prealert_verified'].includes(f.stage))
      throw new ApiError(409, 'STAGE', 'The pre-alert comes after the booking is confirmed');
    let p = await one('select * from prealerts where job_file_id = $1 for update', [fileId], c);
    if (!p) p = await one('insert into prealerts (job_file_id, created_by) values ($1,$2) returning *', [fileId, actor.id], c);
    if (p.status === 'verified' && action !== 'expected') throw new ApiError(409, 'PREALERT_VERIFIED', 'The pre-alert is already verified');
    const air = f.mode === 'air';
    switch (action) {
      case 'expected': {
        const exp = day(b.expected_date, 'Expected date'), fu = day(b.follow_up_date, 'Follow-up date');
        await c.query('update prealerts set expected_date = coalesce($2, expected_date), follow_up_date = $3, updated_at = now() where id = $1', [p.id, exp, fu]);
        await jfEvent(c, actor, fileId, { kind: 'note', title: 'Pre-alert follow-up', new_value: [exp && `expected ${exp}`, fu && `follow up ${fu}`].filter(Boolean).join(' · ') || null, remarks: txt(b.note, 500) });
        break;
      }
      case 'receive': {
        if (b.document_id && !(isUuid(b.document_id) && await one('select 1 from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null', [b.document_id, fileId], c)))
          throw bad('Upload the pre-alert file to this shipment first');
        const source = b.source && ['shipping_line', 'airline', 'agent', 'other'].includes(b.source) ? b.source : null;
        const vals = [txt(b.vessel_flight, 80), txt(b.voyage, 40), txt(b.containers, 1000), txt(b.mbl_mawb, 60), txt(b.hbl_hawb, 60), day(b.etd, 'ETD'), day(b.eta, 'ETA')];
        await c.query(`update prealerts set status = 'received', received_at = coalesce(received_at, now()), source = coalesce($2, source), document_id = coalesce($3, document_id),
          vessel_flight = $4, voyage = $5, containers = $6, mbl_mawb = $7, hbl_hawb = $8, etd = $9, eta = $10,
          check_vessel = false, check_voyage = false, check_containers = false, check_bl = false, check_etd = false, check_eta = false,
          correction_note = null, updated_at = now() where id = $1`, [p.id, source, b.document_id || null, ...vals]);
        await jfEvent(c, actor, fileId, { kind: 'status', title: p.status === 'correction' ? 'Corrected pre-alert received' : 'Pre-alert received',
          new_value: [vals[0], vals[1] && `voy. ${vals[1]}`, vals[3] && `MBL/MAWB ${vals[3]}`, vals[4] && `HBL/HAWB ${vals[4]}`, vals[5] && `ETD ${vals[5]}`, vals[6] && `ETA ${vals[6]}`].filter(Boolean).join(' · ') || null });
        await setStage(c, actor, fileId, 'prealert_received');
        break;
      }
      case 'correction': {
        if (p.status !== 'received') throw new ApiError(409, 'PREALERT_STATE', 'Record the pre-alert first');
        const note = txt(b.note, 1000);
        if (!note) throw bad('Say what has to be corrected');
        const fu = day(b.follow_up_date, 'Follow-up date');
        await c.query(`update prealerts set status = 'correction', correction_note = $2, follow_up_date = $3, updated_at = now() where id = $1`, [p.id, note, fu]);
        await jfEvent(c, actor, fileId, { kind: 'status', title: 'Pre-alert correction requested', new_value: note, remarks: fu ? `Follow up ${fu}` : null });
        break;
      }
      case 'verify': {
        if (p.status !== 'received') throw new ApiError(409, 'PREALERT_STATE', p.status === 'correction' ? 'Waiting for the corrected pre-alert' : 'Record the pre-alert first');
        const needed = PREALERT_CHECKS.filter(([k]) => !(air && (k === 'check_voyage' || k === 'check_containers')));
        const missing = needed.filter(([k]) => b[k] !== true).map(([, n]) => n);
        if (missing.length) throw bad(`Check these against the booking first: ${missing.join(', ')}`);
        await c.query(`update prealerts set status = 'verified', ${needed.map(([k]) => `${k} = true`).join(', ')}, verified_by = $2, verified_at = now(), updated_at = now() where id = $1`, [p.id, actor.id]);
        // the verified details go onto the shipment, each change in its history
        const map: [string, string, unknown][] = [['vessel_flight', 'Vessel / flight', p.vessel_flight], ['voyage', 'Voyage', p.voyage],
          ['mbl_mawb', 'MBL / MAWB', p.mbl_mawb], ['hbl_hawb', 'HBL / HAWB', p.hbl_hawb], ['etd', 'ETD', p.etd], ['eta', 'ETA', p.eta]];
        for (const [k, lbl, raw] of map) {
          const v = raw instanceof Date ? raw.toISOString().slice(0, 10) : raw;
          const old = f[k] instanceof Date ? f[k].toISOString().slice(0, 10) : f[k];
          if (!v || String(old ?? '') === String(v)) continue;
          await c.query(`update job_files set ${k} = $2, updated_at = now() where id = $1`, [fileId, v]);
          await jfEvent(c, actor, fileId, { kind: 'edit', title: `${lbl} from pre-alert`, field: lbl, old_value: old, new_value: v });
        }
        if (p.containers) {
          const { normContainer } = await import('./pro');
          for (const raw of String(p.containers).split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
            let no: string; try { no = normContainer(raw.split(/\s+/)[0]); } catch { continue; }
            const ins = await one('insert into job_file_containers (job_file_id, container_no) values ($1,$2) on conflict do nothing returning id', [fileId, no], c);
            if (ins) await jfEvent(c, actor, fileId, { kind: 'container', title: `Container ${no} added from pre-alert` });
          }
        }
        await jfEvent(c, actor, fileId, { kind: 'status', title: 'Pre-alert verified', new_value: needed.map(([, n]) => n).join(', ') + ' checked' });
        await setStage(c, actor, fileId, 'prealert_verified');
        break;
      }
      default: throw bad('Unknown action');
    }
  });
  const { getJobFile } = await import('./jobfiles');
  return getJobFile(actor, fileId);
}

// ------------------------------------------------------------ operational job + handover
/**
 * After the pre-alert is verified: type the Job No. from the ERP. The same record becomes the operational job —
 * no second record, the Job No. can't be used twice, and trips / PRO requests with that Job No. link to it.
 * A Commercials Manager can do it without a verified pre-alert (e.g. a road job with no pre-alert), with a reason.
 */
export async function createOperationalJob(actor: Actor, fileId: string, b: any) {
  if (!actor.isSuperAdmin && !actor.has('jobfiles.handover')) throw forbidden();
  const p = jobNoProblem(b.job_no);
  if (p) throw new ApiError(400, 'VALIDATION', p, { fields: { job_no: p } });
  const jobNo = String(b.job_no).trim();
  await tx(async (c) => {
    const f = await fileFor(actor, fileId, c);
    if (f.stage === 'handed_over' || f.status !== 'enquiry') throw new ApiError(409, 'ALREADY_HANDED_OVER', `This shipment already has Job No. ${f.job_no}`);
    const skip = txt(b.skip_prealert_reason, 500);
    if (f.stage !== 'prealert_verified') {
      if (!(actor.isSuperAdmin || actor.has('commercial.manage'))) throw new ApiError(409, 'STAGE', 'Verify the pre-alert first');
      if (!['customer_confirmed', 'booking_requested', 'booking_confirmed', 'prealert_awaited', 'prealert_received'].includes(f.stage))
        throw new ApiError(409, 'STAGE', 'The customer has not confirmed this shipment');
      if (!skip) throw bad('Say why the job is created before the pre-alert is verified');
    }
    // Decision D3: Exports and Cross Trade need the customer's BL draft confirmation first; a manager can override with a reason
    const { BL_BEFORE_HANDOVER } = await import('../lib/routingRules');
    const blOverride = txt(b.bl_override_reason, 500);
    if (BL_BEFORE_HANDOVER.includes(f.division) && f.bl_status !== 'customer_confirmed') {
      if (!(actor.isSuperAdmin || actor.has('commercial.manage'))) throw new ApiError(409, 'BL_NOT_CONFIRMED', 'The customer must confirm the BL draft before handover (Exports and Cross Trade). A Commercials Manager can override with a reason.');
      if (!blOverride) throw new ApiError(400, 'VALIDATION', 'The BL draft is not confirmed by the customer — say why the job is handed over anyway', { fields: { bl_override_reason: 'Reason needed' } });
    }
    const dup = await one(`select id, enquiry_ref from job_files where upper(btrim(job_no)) = upper($1) and deleted_at is null and status <> 'cancelled' and id <> $2`, [jobNo, fileId], c);
    if (dup) throw new ApiError(409, 'JOB_FILE_EXISTS', `Job No. ${jobNo} is already used (${dup.enquiry_ref ?? 'another shipment'}).`, { id: dup.id });
    const notes = txt(b.notes, 2000);
    await c.query(`update job_files set job_no = $2, status = 'open', stage = 'handed_over', handed_over_at = now(), handed_over_by = $3, handover_notes = $4,
      handover_override_reason = $5, updated_at = now() where id = $1`, [fileId, jobNo, actor.id, notes, BL_BEFORE_HANDOVER.includes(f.division) && f.bl_status !== 'customer_confirmed' ? blOverride : null]);
    if (BL_BEFORE_HANDOVER.includes(f.division) && f.bl_status !== 'customer_confirmed')
      await jfEvent(c, actor, fileId, { kind: 'status', title: 'Handed over before the customer confirmed the BL draft', remarks: blOverride });
    await jfEvent(c, actor, fileId, { kind: 'status', title: `Operational job created — Job No. ${jobNo}`, field: 'Job No.', old_value: null, new_value: jobNo, remarks: skip ? `Before pre-alert verification: ${skip}` : null });
    await jfEvent(c, actor, fileId, { kind: 'status', title: 'Handed over to Operations', field: 'Stage', old_value: stageName(f.stage), new_value: stageName('handed_over'), remarks: notes });
    await (await import('./notify')).notifyGroup(c, actor, fileId, 'handed_over', `Job No. ${jobNo}`);
    // trips / PRO requests already typed with this Job No. link now
    await c.query(`update transport_requests set job_file_id = null where upper(btrim(job_no)) = upper(btrim($1))`, [jobNo]);
    await c.query(`update pro_requests set job_file_id = null where upper(btrim(job_no)) = upper(btrim($1))`, [jobNo]);
    await c.query(`update messenger_runs m set job_file_id = t.job_file_id from transport_requests t where m.job_id = t.id and upper(btrim(t.job_no)) = upper(btrim($1))`, [jobNo]);
  });
  const { getJobFile, refreshJobFileSearch } = await import('./jobfiles');
  await refreshJobFileSearch(fileId);
  return getJobFile(actor, fileId);
}

/** Lost (customer went elsewhere / no reply) before confirmation: closes the commercial side, with a reason. */
export async function markLost(actor: Actor, fileId: string, b: any) {
  const reason = txt(b.reason, 500);
  if (!reason) throw bad('Say why the shipment was lost');
  await tx(async (c) => {
    const f = await fileFor(actor, fileId, c);
    if (!PRE_CONFIRM.includes(f.stage)) throw new ApiError(409, 'STAGE', 'Only an enquiry that is not yet confirmed can be marked lost');
    await setStage(c, actor, fileId, 'lost', { note: reason });
    const open = await q(`update quotations set status = 'cancelled', decline_reason = $2, updated_at = now() where job_file_id = $1
      and status in ('draft','pending_approval','approved','sent') returning id`, [fileId, `Enquiry lost: ${reason}`], c);
    for (const o of open) await c.query('insert into quotation_events (quotation_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [o.id, 'Cancelled', `Enquiry lost: ${reason}`, actor.id, actor.full_name]);
    await c.query(`update job_files set status = 'cancelled', cancel_reason = $2, updated_at = now() where id = $1`, [fileId, `Lost: ${reason}`]);
  });
  const { getJobFile } = await import('./jobfiles');
  return getJobFile(actor, fileId);
}

// ------------------------------------------------------------ overview (dashboard)
export const COMMERCIAL_TILES: [string, string, string][] = [
  ['c_enquiry', 'New enquiries', `f.stage = 'enquiry'`],
  ['c_rates', 'Pending agent rates', `f.stage = 'rates_requested'`],
  ['c_quoting', 'Rates in, quotation to make', `f.stage in ('rates_received','quotation_draft')`],
  ['c_approval', 'Quotations pending approval', `f.stage = 'pending_approval'`],
  ['c_sent', 'Quotations with customers', `f.stage = 'sent_to_customer'`],
  ['c_confirmed', 'Customer confirmed — book', `f.stage = 'customer_confirmed'`],
  ['c_booking', 'Booking pending', `f.stage = 'booking_requested'`],
  ['c_prealert', 'Pre-alert pending', `f.stage in ('booking_confirmed','prealert_awaited','prealert_received')`],
  ['c_awaiting_job', 'Awaiting job creation', `f.stage = 'prealert_verified'`],
  ['c_handed_over', 'Handed over (30 days)', `f.stage = 'handed_over' and f.handed_over_at > now() - interval '30 days'`],
];
export async function commercialOverview(actor: Actor, p: Record<string, string>) {
  const { jfScope, canSeeJobFiles } = await import('./jobfiles');
  if (!canSeeJobFiles(actor)) throw forbidden();
  const params: unknown[] = [];
  // shipments that went through Commercials (not jobs Operations opened directly)
  let w = `where f.deleted_at is null and (f.stage <> 'handed_over' or f.confirmed_at is not null or f.salesman_id is not null)` + jfScope(actor, params);
  if (p.division) { if (!DIVISIONS.some(([d]) => d === p.division)) throw bad('Unknown division'); params.push(p.division); w += ` and f.division = $${params.length}`; }
  const tiles = await one(`select ${COMMERCIAL_TILES.map(([k, , sql]) => `count(*) filter (where ${sql})::int ${k}`).join(', ')} from job_files f ${w}`, params);
  const byDivision = await q(`select coalesce(f.division, 'none') division, count(*) filter (where f.stage not in ('handed_over','lost','cancelled'))::int open,
      count(*) filter (where f.stage = 'handed_over')::int handed_over, count(*) filter (where f.stage = 'lost')::int lost
    from job_files f ${w} group by 1 order by 1`, params);
  const byPerson = async (col: string) => q(`select u.id, u.full_name, count(*) filter (where f.stage not in ('handed_over','lost','cancelled'))::int open,
      count(*) filter (where f.stage = 'pending_approval')::int pending_approval, count(*) filter (where f.stage = 'handed_over')::int handed_over
    from job_files f join users u on u.id = f.${col} ${w} group by u.id, u.full_name order by open desc, u.full_name limit 50`, params);
  const mine = await one(`select count(*)::int n from quotations x where x.status = 'pending_approval' and x.deleted_at is null and x.salesman_id = $1 and x.salesman_decision is null`, [actor.id]);
  const agent = actor.has('rates.agent_coordination') ? await one(`select count(*)::int n from vendor_requests where assigned_to = $1 and status = 'requested'`, [actor.id]) : null;
  return {
    tiles: COMMERCIAL_TILES.map(([key, label]) => ({ key, label, count: tiles[key] })),
    by_division: byDivision, by_salesman: await byPerson('salesman_id'), by_coordinator: await byPerson('coordinator_id'),
    my_approvals: mine.n, my_agent_requests: agent?.n ?? null,
  };
}
