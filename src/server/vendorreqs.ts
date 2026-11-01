/**
 * Vendor coordination (migration 016): service requests and bookings with shipping lines, airlines, agents, brokers,
 * transporters. Requested → quoted → confirmed → in progress → completed (with completion evidence), or disputed /
 * cancelled. The vendor's price is a COST: only people who see buying cost see or enter it. No bills or payables here —
 * a completed request is handed to the ERP through the ERP export.
 */
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, notFound, one, q, tx } from './db';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const VR_STATUS: Record<string, [string, string]> = {
  requested: ['Requested', '#B7791F'], quoted: ['Vendor quoted', '#5B6B82'], confirmed: ['Confirmed', '#2B6CB0'], in_progress: ['In progress', '#553C9A'],
  completed: ['Completed', '#22543D'], disputed: ['Disputed', '#C05621'], cancelled: ['Cancelled', '#9B2C2C'],
};
export const VR_SERVICES: Record<string, string> = { rate: 'Rate request (for a quotation)', booking: 'Freight booking', trucking: 'Trucking', customs: 'Customs brokerage', warehousing: 'Warehousing',
  courier: 'Courier', documentation: 'Documentation', other: 'Other' };
// which status can follow which
const NEXT: Record<string, string[]> = {
  requested: ['quoted', 'confirmed', 'cancelled'], quoted: ['confirmed', 'cancelled'], confirmed: ['in_progress', 'completed', 'disputed', 'cancelled'],
  in_progress: ['completed', 'disputed', 'cancelled'], disputed: ['in_progress', 'completed', 'cancelled'], completed: ['disputed'], cancelled: [],
};
export const canSeeVendorRequests = (a: Actor) => a.isSuperAdmin || a.has('vendors.requests') || a.has('vendors.manage');
const txt = (v: unknown, max = 200) => { const t = String(v ?? '').trim(); if (t.length > max) throw bad(`Value too long (max ${max} characters)`); return t || null; };
async function evt(db: Db, actor: Actor, id: string, title: string, details?: string | null) {
  await db.query('insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [id, title, details ?? null, actor.id, actor.full_name]);
}
const money = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad('Enter the amount like 1250 or 1250.50');
  return s;
};
/** Leave the cost out for people who don't see buying cost. */
const present = (a: Actor, r: any) => {
  const out: any = { ...r, status_name: VR_STATUS[r.status][0], status_color: VR_STATUS[r.status][1], service_name: VR_SERVICES[r.service] };
  if (!a.fin.buyingView) delete out.quoted_cost;
  return out;
};

export async function listVendorRequests(actor: Actor, p: Record<string, string>) {
  if (!canSeeVendorRequests(actor)) throw forbidden();
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let w = 'where true';
  if (p.status === 'open') w += ` and r.status in ('requested','quoted','confirmed','in_progress','disputed')`;
  else if (p.status) w += ` and r.status = ${add(p.status)}`;
  for (const [k, col] of Object.entries({ vendor_id: 'r.vendor_id', job_file_id: 'r.job_file_id' }))
    if (p[k]) { if (!isUuid(p[k])) throw bad('Invalid filter'); w += ` and ${col} = ${add(p[k])}`; }
  if (p.q?.trim()) { const v = add('%' + p.q.trim().toLowerCase() + '%'); w += ` and (lower(r.request_no) like ${v} or lower(r.description) like ${v} or lower(v.name) like ${v} or lower(coalesce(f.job_no,'')) like ${v} or lower(coalesce(r.vendor_reference,'')) like ${v})`; }
  const rows = await q(`select r.*, v.name vendor_name, v.vendor_type, f.job_no,
      (r.status in ('requested','quoted','confirmed','in_progress') and r.needed_by < (now() at time zone 'Asia/Dubai')::date) late
    from vendor_requests r join vendors v on v.id = r.vendor_id left join job_files f on f.id = r.job_file_id ${w}
    order by r.status in ('completed','cancelled'), r.needed_by nulls last, r.created_at desc limit 500`, params);
  return rows.map((r) => present(actor, r));
}

export async function getVendorRequest(actor: Actor, id: string) {
  if (!canSeeVendorRequests(actor)) throw forbidden();
  if (!isUuid(id)) throw notFound('Request');
  const r = await one(`select r.*, v.name vendor_name, v.vendor_type, v.contact_person vendor_contact, v.contact_number vendor_phone, v.email vendor_email,
      f.job_no, u.full_name created_by_name from vendor_requests r join vendors v on v.id = r.vendor_id left join job_files f on f.id = r.job_file_id
      join users u on u.id = r.created_by where r.id = $1`, [id]);
  if (!r) throw notFound('Request');
  const events = await q('select title, details, user_name, at from vendor_request_events where request_id = $1 order by at, id', [id]);
  // Same request sent to other vendors: compare (cost viewers only)
  const compare = r.rate_group && actor.fin.buyingView ? await rateGroup(r.rate_group) : null;
  const cheaper = actor.fin.buyingView ? await cheaperRateWarning(id) : null;
  return { ...present(actor, r), events, compare, cheaper_warning: cheaper, next: NEXT[r.status], can: { update: actor.isSuperAdmin || actor.has('vendors.requests'), cost: actor.fin.buyingView } };
}

/**
 * Create a request. For a rate request the same enquiry can go to several vendors at once (vendor_ids): one request per
 * vendor, all in one rate_group, so their prices are compared side by side. `same_as` adds another vendor to an
 * existing group (same Job No., service and description).
 */
export async function createVendorRequest(actor: Actor, b: any) {
  if (!actor.isSuperAdmin && !actor.has('vendors.requests')) throw forbidden();
  return tx(async (c) => {
    let fileId: string | null = null, group: string | null = null;
    if (b.same_as !== undefined) {
      if (!isUuid(b.same_as)) throw bad('Request not found');
      const src = await one('select * from vendor_requests where id = $1', [b.same_as], c);
      if (!src) throw notFound('Request');
      b = { ...b, service: src.service, description: b.description?.trim() ? b.description : src.description, needed_by: b.needed_by ?? src.needed_by?.toISOString?.().slice(0, 10) ?? src.needed_by };
      fileId = src.job_file_id;
      group = src.rate_group ?? src.id;
      if (!src.rate_group) await c.query('update vendor_requests set rate_group = $1 where id = $1', [src.id]);
    }
    const vendorIds: string[] = Array.isArray(b.vendor_ids) ? [...new Set(b.vendor_ids as string[])] : b.vendor_id ? [b.vendor_id] : [];
    if (!vendorIds.length || !vendorIds.every(isUuid)) throw bad('Choose the vendor');
    if (vendorIds.length > 10) throw bad('Up to 10 vendors at a time');
    if (!VR_SERVICES[b.service]) throw bad('Choose the service');
    if (vendorIds.length > 1 && b.service !== 'rate') throw bad('Several vendors at once is for rate requests');
    const description = txt(b.description, 2000);
    if (!description) throw bad('Describe what the vendor must do');
    if (b.needed_by && !/^\d{4}-\d{2}-\d{2}$/.test(b.needed_by)) throw bad('Needed-by date is not valid');
    if (b.rate_valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(b.rate_valid_until)) throw bad('Rate validity date is not valid');
    const okVendors = await q('select id from vendors where id = any($1) and deleted_at is null and is_active', [vendorIds], c);
    if (okVendors.length !== vendorIds.length) throw bad('Choose active vendors');
    if (group) {
      const dup = await one('select v.name from vendor_requests r join vendors v on v.id = r.vendor_id where r.rate_group = $1 and r.vendor_id = any($2) and r.status <> \'cancelled\'', [group, vendorIds], c);
      if (dup) throw bad(`${dup.name} has already been asked for this rate`);
    } else if (b.job_no?.trim()) {
      const f = await one(`select id from job_files where upper(btrim(job_no)) = upper(btrim($1)) and deleted_at is null and status <> 'cancelled'`, [b.job_no], c);
      if (!f) throw bad(`No Job File with Job No. ${String(b.job_no).trim()}`);
      fileId = f.id;
    }
    const cost = vendorIds.length === 1 && b.quoted_cost !== undefined && b.quoted_cost !== '' && actor.fin.buyingView ? money(b.quoted_cost) : null;
    const currency = String((await one(`select value from settings where key = 'currency'`, [], c))?.value ?? 'AED');
    if (!group && vendorIds.length > 1) group = (await one('select gen_random_uuid() id', [], c)).id;
    const made: { id: string; request_no: string }[] = [];
    for (const vid of vendorIds) {
      const r = await one(`insert into vendor_requests (request_no, vendor_id, job_file_id, department_id, service, description, needed_by, quoted_cost, currency, created_by, rate_valid_until, rate_group)
        values ('VR-' || nextval('vendor_request_no_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, request_no`,
        [vid, fileId, actor.department_side === 'operations' ? actor.department_id : null, b.service, description, b.needed_by || null, cost,
         currency, actor.id, b.rate_valid_until || null, group], c);
      await evt(c, actor, r.id, 'Request created', VR_SERVICES[b.service] + (group ? ' — sent to several vendors for comparison' : ''));
      made.push(r);
    }
    return { id: made[0].id, request_no: made[0].request_no, ids: made.map((m) => m.id), request_nos: made.map((m) => m.request_no), rate_group: group };
  });
}

/**
 * The prices in one rate group, lowest first, with "lowest" marked. Only priced, not cancelled, still-valid rates count.
 * Cost viewers only (callers check).
 */
export async function rateGroup(group: string, db?: Db) {
  const rows = await q(`select r.id, r.request_no, r.status, r.quoted_cost, r.currency, r.rate_valid_until, r.vendor_reference, r.vendor_id, v.name vendor_name,
      (r.rate_valid_until is not null and r.rate_valid_until < (now() at time zone 'Asia/Dubai')::date) expired
    from vendor_requests r join vendors v on v.id = r.vendor_id where r.rate_group = $1
    order by r.quoted_cost is null, r.status = 'cancelled', r.quoted_cost, v.name`, [group], db);
  const live = rows.filter((r) => r.quoted_cost !== null && r.status !== 'cancelled' && !r.expired);
  const low = live.length ? Math.min(...live.map((r) => Number(r.quoted_cost))) : null;
  return rows.map((r) => ({ ...r, lowest: low !== null && live.includes(r) && Number(r.quoted_cost) === low }));
}

/** Mark the lowest valid price in each rate group of a list of requests (rows need id, rate_group, quoted_cost, status, rate_valid_until). */
export function markLowest<T extends Record<string, any>>(rows: T[]): (T & { lowest: boolean; group_size: number })[] {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const valid = (r: T) => r.quoted_cost !== null && r.quoted_cost !== undefined && r.status !== 'cancelled'
    && !(r.rate_valid_until && String(r.rate_valid_until).slice(0, 10) < today);
  return rows.map((r) => {
    const same = r.rate_group ? rows.filter((x) => x.rate_group === r.rate_group) : [r];
    const live = same.filter(valid);
    const low = live.length ? Math.min(...live.map((x) => Number(x.quoted_cost))) : null;
    return { ...r, group_size: same.length, lowest: same.length > 1 && valid(r) && Number(r.quoted_cost) === low };
  });
}

/** If a cheaper valid rate exists in the same group, the message to show; otherwise null. */
export async function cheaperRateWarning(requestId: string, db?: Db): Promise<string | null> {
  const r = await one('select rate_group, quoted_cost from vendor_requests where id = $1', [requestId], db);
  if (!r?.rate_group || r.quoted_cost === null) return null;
  const best = (await rateGroup(r.rate_group, db)).find((x) => x.lowest);
  if (!best || best.id === requestId || Number(best.quoted_cost) >= Number(r.quoted_cost)) return null;
  const chosen = await one('select r.request_no, v.name from vendor_requests r join vendors v on v.id = r.vendor_id where r.id = $1', [requestId], db);
  return `${best.vendor_name} quoted less for the same request: ${best.currency} ${best.quoted_cost} (${best.request_no}) against ${chosen.name} ${best.currency} ${Number(r.quoted_cost).toFixed(2)} (${chosen.request_no}).`;
}

/** Status changes and notes. Quote → cost (cost viewers); confirm → vendor's reference; complete → evidence note; dispute / cancel → reason. */
export async function vendorRequestAction(actor: Actor, id: string, b: any) {
  if (!actor.isSuperAdmin && !actor.has('vendors.requests')) throw forbidden();
  await tx(async (c) => {
    const r = await one('select * from vendor_requests where id = $1 for update', [id], c);
    if (!r) throw notFound('Request');
    if (b.what === 'note') {
      const note = txt(b.note, 2000); if (!note) throw bad('Write the note');
      await evt(c, actor, id, 'Note', note); return;
    }
    const to = String(b.status ?? '');
    if (!VR_STATUS[to]) throw bad('Choose the status');
    if (!NEXT[r.status].includes(to)) throw new ApiError(409, 'VR_STATE', `A request can't go from "${VR_STATUS[r.status][0]}" to "${VR_STATUS[to][0]}"`);
    const sets: string[] = ['status = $2', 'updated_at = now()'];
    const params: unknown[] = [id, to];
    const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    let detail: string | null = null;
    if (b.vendor_reference !== undefined) put('vendor_reference', txt(b.vendor_reference, 80));
    if (b.rate_valid_until !== undefined) {
      if (b.rate_valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(b.rate_valid_until)) throw bad('Rate validity date is not valid');
      put('rate_valid_until', b.rate_valid_until || null);
    }
    if (b.quoted_cost !== undefined && b.quoted_cost !== '') {
      if (!actor.fin.buyingView) throw forbidden('Only people who see cost can enter the vendor price');
      put('quoted_cost', money(b.quoted_cost));
    }
    if (to === 'quoted' && !actor.fin.buyingView && r.quoted_cost === null) throw bad('Someone who sees cost must enter the vendor price');
    if (to === 'confirmed') { sets.push('confirmed_at = now()'); detail = txt(b.vendor_reference, 80) ? `Vendor ref. ${String(b.vendor_reference).trim()}` : null; }
    if (to === 'completed') {
      const note = txt(b.note, 2000);
      if (!note) throw bad('Write what was done and the proof (e.g. BL released, delivery note no.)');
      put('completion_note', note); sets.push('completed_at = now()'); detail = note;
    }
    if (to === 'disputed') { const note = txt(b.note, 2000); if (!note) throw bad('Describe the problem'); put('issue_note', note); detail = note; }
    if (to === 'cancelled') { const note = txt(b.note, 500); if (!note) throw bad('Give a reason'); put('cancel_reason', note); detail = note; }
    await c.query(`update vendor_requests set ${sets.join(', ')} where id = $1`, params);
    await evt(c, actor, id, `Status: ${VR_STATUS[to][0]}`, detail);
    // Choosing a vendor who is not the cheapest for the same request is allowed, but it is recorded
    if (to === 'confirmed') {
      const w = await cheaperRateWarning(id, c);
      if (w) await evt(c, actor, id, 'Chosen although another vendor quoted less', w);
    }
  });
  return getVendorRequest(actor, id);
}

/** Vendor performance: requests, completed, on time (completed by the needed-by date), disputes, average days to complete. */
export async function vendorReport(actor: Actor, def: any, cols: any[], colsOut: any[], p: Record<string, string>, opts: { all?: boolean }) {
  if (!canSeeVendorRequests(actor)) throw forbidden();
  const params: unknown[] = [];
  let w = 'where true';
  if (p.from && p.to) { params.push(p.from, p.to); w += ` and (r.created_at at time zone 'Asia/Dubai')::date between $1 and $2`; }
  const rows = await q(`select v.name vendor_name, v.vendor_type, count(r.id)::int requests,
      count(*) filter (where r.status = 'completed')::int completed,
      count(*) filter (where r.status = 'completed' and r.needed_by is not null and (r.completed_at at time zone 'Asia/Dubai')::date <= r.needed_by)::int on_time,
      count(*) filter (where r.status = 'completed' and r.needed_by is not null and (r.completed_at at time zone 'Asia/Dubai')::date > r.needed_by)::int late,
      count(*) filter (where r.status = 'disputed' or r.issue_note is not null)::int disputes,
      count(*) filter (where r.status = 'cancelled')::int cancelled,
      round(avg(extract(epoch from (r.completed_at - r.created_at)) / 86400) filter (where r.status = 'completed'), 1) avg_days
    from vendors v join vendor_requests r on r.vendor_id = v.id ${w} group by v.id, v.name, v.vendor_type order by requests desc, v.name`, params);
  const TYPES: Record<string, string> = { shipping_line: 'Shipping line', airline: 'Airline', freight_agent: 'Freight agent', customs_broker: 'Customs broker',
    transporter: 'Transporter', warehouse: 'Warehouse', courier: 'Courier', other: 'Other' };
  const shaped = rows.map((r) => Object.fromEntries(cols.map((col: any) => [col.key, col.key === 'vendor_type' ? TYPES[r.vendor_type]
    : col.key === 'on_time_pct' ? (r.on_time + r.late ? ((r.on_time / (r.on_time + r.late)) * 100).toFixed(2) : null) : r[col.key]])));
  return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped, totals: null, total: rows.length, page: 1, page_size: rows.length, filters: p };
}
