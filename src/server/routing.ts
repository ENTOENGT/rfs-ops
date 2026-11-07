/**
 * Part G2 — route options, vessel legs and BL drafts on a shipment.
 *
 * Route options: one enquiry can ask for several loading ports (Shanghai, Ningbo, Shenzhen → Jebel Ali) under the same
 * Enquiry Ref. Each option has its own rate requests and quotation lines; the customer picks one, which is copied onto the
 * shipment and locked. The other options stay for reference. Options can change only until the customer confirms.
 *
 * Vessel: Direct or Via; one line per leg (vessel, voyage, from, to, ETD, ETA). Leg 1 and the last leg's ETA are copied to
 * the shipment. Pending → Received → Verified; a change after verification is recorded and the group is told.
 *
 * BL drafts: each draft is a new version (old ones kept). received → (under review) → sent to customer → either confirmed
 * (locked) or correction required → correction sent to agent → revised draft received → sent again… A change after the
 * customer confirmed needs a reason and starts a new version. The final BL is recorded separately.
 */
import { PoolClient } from 'pg';
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, one, q, tx } from './db';
import { PRE_CONFIRM } from '../lib/commercialRules';
import { BL_WITH_CUSTOMER, blStatusName, routeLabel } from '../lib/routingRules';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const txt = (v: unknown, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const day = (v: unknown, label: string) => {
  if (v === undefined || v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad(`${label} is not a valid date`);
  return String(v);
};
const num = (v: unknown, label: string, int = false) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw bad(`${label} is not a valid number`);
  return n;
};
const iso = (v: any) => v instanceof Date ? v.toISOString().slice(0, 10) : v ?? null;

async function fileFor(actor: Actor, fileId: string, c: Db) {
  const { loadFile, canEdit } = await import('./jobfiles');
  const f = await loadFile(actor, fileId, c, true);
  if (!canEdit(actor, f)) throw forbidden('You cannot change this shipment');
  return f;
}
async function ev(c: Db, actor: Actor, fileId: string, e: Record<string, unknown>) {
  const { event } = await import('./jobfiles');
  await event(c, actor, fileId, e as any);
}
async function tell(c: Db, actor: Actor, fileId: string, evt: string, detail?: string | null) {
  await (await import('./notify')).notifyGroup(c, actor, fileId, evt, detail ?? null);
}

// ------------------------------------------------------------ route options
export async function routesFor(fileId: string, db?: Db) {
  return q(`select r.*, (select count(*)::int from vendor_requests v where v.route_id = r.id and v.status <> 'cancelled') rate_requests
    from enquiry_routes r where r.job_file_id = $1 and r.removed_at is null order by r.option_no`, [fileId], db);
}
/** Option 1 from the shipment's own fields, made the first time a second option is added. */
async function ensureFirst(c: Db, actor: Actor, f: any) {
  const n = await one('select count(*)::int n from enquiry_routes where job_file_id = $1', [f.id], c);
  if (n.n > 0) return;
  const r = await one(`insert into enquiry_routes (job_file_id, option_no, origin_city, pol, destination_city, pod, mode, cargo_description, packages, gross_weight_kg, volume_cbm, created_by)
    values ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [f.id, f.origin, f.port_of_loading, f.destination, f.port_of_discharge, f.mode, f.cargo_description, f.packages, f.gross_weight_kg, f.volume_cbm, actor.id], c);
  // rate requests and quotation lines made before options existed belong to option 1
  await c.query('update vendor_requests set route_id = $2 where job_file_id = $1 and route_id is null', [f.id, r.id]);
  await c.query('update quotation_lines l set route_id = $2 from quotations x where x.id = l.quotation_id and x.job_file_id = $1 and l.route_id is null', [f.id, r.id]);
}
const ROUTE_FIELDS = ['origin_country', 'origin_city', 'pol', 'destination_country', 'destination_city', 'pod', 'final_delivery', 'mode', 'cargo_description', 'notes'];
function routeValues(b: any) {
  const v: Record<string, unknown> = {};
  for (const k of ROUTE_FIELDS) if (b[k] !== undefined) v[k] = txt(b[k], k === 'notes' || k === 'cargo_description' ? 1000 : 120);
  if (b.packages !== undefined) v.packages = num(b.packages, 'Packages', true);
  if (b.gross_weight_kg !== undefined) v.gross_weight_kg = num(b.gross_weight_kg, 'Weight');
  if (b.volume_cbm !== undefined) v.volume_cbm = num(b.volume_cbm, 'Volume');
  if (v.mode && !['sea_fcl', 'sea_lcl', 'air', 'road'].includes(String(v.mode))) throw bad('Choose the mode');
  return v;
}

/**
 * add | update | remove a route option. Allowed until the customer confirms. Removing needs a reason and is refused while a
 * rate request on that option is still open.
 */
export async function routeAction(actor: Actor, fileId: string, b: any) {
  await tx(async (c) => {
    const f = await fileFor(actor, fileId, c);
    if (!PRE_CONFIRM.includes(f.stage ?? '')) throw new ApiError(409, 'ROUTE_LOCKED', 'The customer has confirmed — the chosen route is locked');
    const step = String(b.step ?? '');
    if (step === 'add') {
      await ensureFirst(c, actor, f);
      const v = routeValues(b);
      if (!v.pol && !v.origin_city) throw bad('Enter the loading port or origin city');
      if (!v.pod && !v.destination_city && !f.port_of_discharge && !f.destination) throw bad('Enter the destination');
      // the destination defaults to the enquiry's own
      v.destination_city ??= f.destination; v.pod ??= f.port_of_discharge;
      const next = (await one('select coalesce(max(option_no), 0) + 1 n from enquiry_routes where job_file_id = $1', [fileId], c)).n;
      if (next > 20) throw bad('Up to 20 options');
      const cols = Object.keys(v);
      await c.query(`insert into enquiry_routes (job_file_id, option_no, ${cols.join(', ')}, created_by) values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3})`,
        [fileId, next, ...cols.map((k) => v[k]), actor.id]);
      await ev(c, actor, fileId, { kind: 'edit', title: `Route option ${next} added`, new_value: routeLabel({ option_no: next, ...v }) });
      return;
    }
    if (!isUuid(b.route_id)) throw bad('Choose the option');
    const r = await one('select * from enquiry_routes where id = $1 and job_file_id = $2 and removed_at is null for update', [b.route_id, fileId], c);
    if (!r) throw bad('Option not found');
    if (step === 'update') {
      const v = routeValues(b);
      const changed = Object.entries(v).filter(([k, x]) => String(x ?? '') !== String(r[k] ?? ''));
      if (!changed.length) return;
      await c.query(`update enquiry_routes set ${changed.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [r.id, ...changed.map(([, x]) => x)]);
      await ev(c, actor, fileId, { kind: 'edit', title: `Route option ${r.option_no} changed`, old_value: routeLabel(r), new_value: routeLabel({ ...r, ...v }) });
      return;
    }
    if (step === 'remove') {
      const reason = txt(b.reason, 300);
      if (!reason) throw bad('Say why this option is removed');
      const open = await one(`select count(*)::int n from vendor_requests where route_id = $1 and status in ('requested','quoted','confirmed','in_progress')`, [r.id], c);
      if (open.n) throw new ApiError(409, 'ROUTE_IN_USE', `Option ${r.option_no} has ${open.n} open rate request(s). Cancel them first.`);
      if ((await one('select count(*)::int n from enquiry_routes where job_file_id = $1 and removed_at is null', [fileId], c)).n <= 1) throw bad('The last option cannot be removed');
      await c.query('update enquiry_routes set removed_at = now(), removed_reason = $2 where id = $1', [r.id, reason]);
      await ev(c, actor, fileId, { kind: 'edit', title: `Route option ${r.option_no} removed`, old_value: routeLabel(r), remarks: reason });
      return;
    }
    throw bad('Unknown step');
  });
  const { getJobFile } = await import('./jobfiles');
  return getJobFile(actor, fileId);
}

/** The option a new rate request is for: required when the shipment has more than one. */
export async function routeForRequest(c: Db, fileId: string, routeId: unknown, service: string) {
  const live = await q('select id, option_no from enquiry_routes where job_file_id = $1 and removed_at is null', [fileId], c);
  if (routeId) {
    if (!isUuid(routeId) || !live.some((r) => r.id === routeId)) throw bad('Choose a route option of this shipment');
    return routeId;
  }
  if (live.length > 1 && service === 'rate') throw bad('Choose which route option this rate is for');
  return live[0]?.id ?? null;
}

/** On customer confirmation: the chosen option goes onto the shipment and is locked; returns its label. */
export async function chooseRoute(c: PoolClient, actor: Actor, fileId: string, quoteId: string, routeId: unknown) {
  const used = await q(`select distinct r.* from quotation_lines l join enquiry_routes r on r.id = l.route_id where l.quotation_id = $1 order by r.option_no`, [quoteId], c);
  if (used.length === 0) return null;
  let r = used[0];
  if (used.length > 1) {
    r = used.find((x) => x.id === routeId);
    if (!r) throw new ApiError(400, 'VALIDATION', `Which option did the customer choose? (${used.map((x) => `Option ${x.option_no}`).join(', ')})`, { fields: { route_id: 'Choose the option' } });
  }
  const set: [string, unknown][] = [['origin', r.origin_city], ['port_of_loading', r.pol], ['destination', r.destination_city], ['port_of_discharge', r.pod]];
  if (r.mode) set.push(['mode', r.mode]);
  if (r.cargo_description) set.push(['cargo_description', r.cargo_description]);
  const f = await one('select * from job_files where id = $1', [fileId], c);
  const changes = set.filter(([k, v]) => v !== null && v !== undefined && String(v) !== String(f[k] ?? ''));
  await c.query(`update job_files set selected_route_id = $2${changes.map(([k], i) => `, ${k} = $${i + 3}`).join('')}, updated_at = now() where id = $1`,
    [fileId, r.id, ...changes.map(([, v]) => v)]);
  await c.query('update quotations set selected_route_id = $2 where id = $1', [quoteId, r.id]);
  await ev(c, actor, fileId, { kind: 'edit', title: `Customer chose ${routeLabel(r)}`, field: 'Route', new_value: routeLabel(r),
    remarks: used.length > 1 ? `Other options kept for reference: ${used.filter((x) => x.id !== r.id).map((x) => routeLabel(x)).join('; ')}` : null });
  return routeLabel(r);
}

// ------------------------------------------------------------ vessel legs
export async function legsFor(fileId: string, db?: Db) {
  return q('select * from shipment_legs where job_file_id = $1 order by leg_no', [fileId], db);
}
/**
 * save   routing (direct / via) + legs → Vessel details received (a change after verification is recorded and told)
 * verify the details are checked → Vessel details verified
 */
export async function vesselAction(actor: Actor, fileId: string, b: any) {
  await tx(async (c) => {
    const f = await fileFor(actor, fileId, c);
    if (f.status === 'enquiry' && !['customer_confirmed', 'booking_requested', 'booking_confirmed', 'prealert_awaited', 'prealert_received', 'prealert_verified'].includes(f.stage))
      throw new ApiError(409, 'STAGE', 'Vessel details come after the customer confirms');
    if (b.step === 'verify') {
      const legs = await legsFor(fileId, c);
      if (!legs.length || legs.some((l) => !l.vessel || !l.etd || !l.eta)) throw bad('Every leg needs a vessel, ETD and ETA before it can be verified');
      if (f.routing_type === 'via' && legs.length < 2) throw bad('A via shipment needs a line for each vessel leg');
      if (f.vessel_status === 'verified') return;
      await c.query(`update job_files set vessel_status = 'verified', vessel_verified_at = now(), vessel_verified_by = $2 where id = $1`, [fileId, actor.id]);
      await ev(c, actor, fileId, { kind: 'status', title: 'Vessel details verified', new_value: legs.map((l) => `${l.vessel} ${l.voyage ?? ''} ${l.from_port ?? ''}→${l.to_port ?? ''}`.trim()).join(' / ') });
      return;
    }
    if (b.step !== 'save') throw bad('Unknown step');
    const routing = b.routing_type === 'via' ? 'via' : b.routing_type === 'direct' ? 'direct' : null;
    if (!routing) throw bad('Say whether it is direct or via a transshipment port');
    const raw: any[] = Array.isArray(b.legs) ? b.legs : [];
    const legs = raw.filter((l) => l && Object.values(l).some((x) => String(x ?? '').trim())).map((l, i) => ({
      leg_no: i + 1, vessel: txt(l.vessel, 80), voyage: txt(l.voyage, 40), from_port: txt(l.from_port, 80), to_port: txt(l.to_port, 80),
      etd: day(l.etd, `Leg ${i + 1} ETD`), eta: day(l.eta, `Leg ${i + 1} ETA`) }));
    if (!legs.length) throw bad('Enter at least the first vessel');
    if (legs.length > 9) throw bad('Up to 9 legs');
    if (routing === 'direct' && legs.length > 1) throw bad('A direct shipment has one vessel. Choose "Via" for more legs.');
    if (routing === 'via' && legs.length < 2) throw bad('A via shipment has a line for each vessel: add the connecting vessel');
    for (const l of legs) {
      if (!l.vessel) throw bad(`Leg ${l.leg_no}: enter the vessel`);
      if (l.etd && l.eta && l.eta < l.etd) throw bad(`Leg ${l.leg_no}: ETA is before ETD`);
    }
    for (let i = 1; i < legs.length; i++) if (legs[i - 1].eta && legs[i].etd && legs[i].etd! < legs[i - 1].eta!) throw bad(`Leg ${i + 1} leaves before leg ${i} arrives`);
    const old = await legsFor(fileId, c);
    const say = (ls: any[]) => ls.map((l) => `${l.vessel ?? '?'}${l.voyage ? ` ${l.voyage}` : ''} ${l.from_port ?? ''}→${l.to_port ?? ''} (${iso(l.etd) ?? '?'} / ${iso(l.eta) ?? '?'})`).join(' then ');
    const before = say(old), after = say(legs);
    if (before === after && f.routing_type === routing) return;
    await c.query('delete from shipment_legs where job_file_id = $1', [fileId]);   // the legs are the current plan; every version is in the history
    for (const l of legs) await c.query(`insert into shipment_legs (job_file_id, leg_no, vessel, voyage, from_port, to_port, etd, eta, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [fileId, l.leg_no, l.vessel, l.voyage, l.from_port, l.to_port, l.etd, l.eta, actor.id]);
    const first = legs[0], last = legs[legs.length - 1];
    await c.query(`update job_files set routing_type = $2, vessel_status = 'received', vessel_verified_at = null, vessel_verified_by = null,
        vessel_flight = $3, voyage = coalesce($4, voyage), etd = coalesce($5, etd), eta = coalesce($6, eta), updated_at = now() where id = $1`,
      [fileId, routing, first.vessel, first.voyage, first.etd, last.eta]);
    await ev(c, actor, fileId, { kind: 'edit', title: old.length ? 'Vessel details changed' : 'Vessel details received', field: 'Vessel',
      old_value: before || null, new_value: `${routing === 'via' ? 'Via' : 'Direct'}: ${after}`, remarks: txt(b.note, 300) });
    await tell(c, actor, fileId, 'vessel_changed', `${routing === 'via' ? 'via' : 'direct'} — ${after}`);
  });
  const { getJobFile } = await import('./jobfiles');
  return getJobFile(actor, fileId);
}

// ------------------------------------------------------------ BL drafts
export async function blDraftsFor(fileId: string, db?: Db) {
  return q(`select b.*, d.file_name, u.full_name received_by_name, s.full_name sent_by_name, k.full_name confirmed_by_name
    from bl_drafts b join jf_documents d on d.id = b.document_id left join users u on u.id = b.received_by left join users s on s.id = b.sent_by
    left join users k on k.id = b.confirmed_by where b.job_file_id = $1 order by b.version desc`, [fileId], db);
}
/**
 * receive          a draft from the agent / line (uploaded as a document first) → new version
 * review           the Coordinator is checking it
 * send             sent to the customer for confirmation (to whom)
 * correction       the customer asks for corrections (what)
 * correction_sent  the corrections were sent to the agent / line
 * confirm          the customer confirmed this version (evidence) → locked
 * final            the final BL is received (number, document) — recorded on its own
 */
export async function blAction(actor: Actor, fileId: string, b: any) {
  await tx(async (c) => {
    const f = await fileFor(actor, fileId, c);
    if (f.stage && PRE_CONFIRM.includes(f.stage)) throw new ApiError(409, 'STAGE', 'BL drafts come after the customer confirms');
    const cur = await one('select * from bl_drafts where job_file_id = $1 order by version desc limit 1 for update', [fileId], c);
    const set = async (status: string, extra?: string) => {
      await c.query(`update job_files set bl_status = $2, updated_at = now() where id = $1`, [fileId, status]);
      await ev(c, actor, fileId, { kind: 'status', title: blStatusName(status), field: 'BL draft', old_value: blStatusName(f.bl_status), new_value: blStatusName(status), remarks: extra ?? null });
    };
    const docOf = async (id: unknown, label: string) => {
      if (!isUuid(id) || !(await one('select 1 from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null', [id, fileId], c))) throw bad(`Upload the ${label} first`);
      return id;
    };
    switch (b.step) {
      case 'receive': {
        const doc = await docOf(b.document_id, 'BL draft');
        if (await one('select 1 from bl_drafts where document_id = $1', [doc], c)) throw bad('This file is already saved as a BL draft');
        const amend = f.bl_status === 'customer_confirmed';
        const reason = txt(b.amendment_reason, 500);
        if (amend && !(actor.isSuperAdmin || actor.has('commercial.manage'))) throw forbidden('The customer has confirmed the BL draft. Only the Commercials Manager can start an amendment.');
        if (amend && !reason) throw bad('The customer has confirmed the BL draft — say why it is being amended');
        if (cur && !amend && !['correction_required', 'correction_sent'].includes(f.bl_status) && !BL_WITH_CUSTOMER.includes(f.bl_status) && !['received', 'under_review', 'revised_received'].includes(f.bl_status))
          throw bad('A revised draft is expected after a correction request');
        const version = (cur?.version ?? 0) + 1;
        await c.query(`insert into bl_drafts (job_file_id, version, bl_no, document_id, received_by, amendment_reason) values ($1,$2,$3,$4,$5,$6)`,
          [fileId, version, txt(b.bl_no, 60) ?? cur?.bl_no ?? null, doc, actor.id, reason]);
        await set(version === 1 ? 'received' : 'revised_received', `Version ${version}${reason ? ` — amendment: ${reason}` : ''}`);
        await tell(c, actor, fileId, version === 1 ? 'bl_draft_received' : 'bl_revised', `version ${version} received`);
        return;
      }
      case 'review': {
        if (!cur || !['received', 'revised_received'].includes(f.bl_status)) throw bad('There is no new draft to review');
        await c.query('update bl_drafts set reviewed_at = now(), reviewed_by = $2 where id = $1', [cur.id, actor.id]);
        await set('under_review', `Version ${cur.version}`);
        return;
      }
      case 'send': {
        if (!cur || !['received', 'under_review', 'revised_received'].includes(f.bl_status)) throw bad('Receive a draft before sending it to the customer');
        const to = txt(b.sent_to, 300);
        if (!to) throw bad('Say who it was sent to');
        await c.query('update bl_drafts set sent_at = now(), sent_to = $2, sent_by = $3 where id = $1', [cur.id, to, actor.id]);
        const status = cur.version === 1 ? 'sent_to_customer' : 'revised_sent';
        await set(status, `Version ${cur.version} to ${to}`);
        await tell(c, actor, fileId, cur.version === 1 ? 'bl_draft_sent' : 'bl_revised', `version ${cur.version} sent to the customer`);
        return;
      }
      case 'correction': {
        if (!cur || !BL_WITH_CUSTOMER.includes(f.bl_status)) throw bad('Only a draft with the customer can be corrected');
        const notes = txt(b.correction_notes, 2000);
        if (!notes) throw bad('Write the corrections the customer asked for');
        await c.query(`update bl_drafts set customer_reply = 'correction', customer_reply_at = now(), correction_notes = $2 where id = $1`, [cur.id, notes]);
        await set('correction_required', notes);
        await tell(c, actor, fileId, 'bl_correction', notes);
        return;
      }
      case 'correction_sent': {
        if (!cur || f.bl_status !== 'correction_required') throw bad('Record the customer\'s corrections first');
        const to = txt(b.sent_to, 300);
        if (!to) throw bad('Say which agent / carrier it was sent to');
        await c.query('update bl_drafts set correction_sent_at = now(), correction_sent_to = $2 where id = $1', [cur.id, to]);
        await set('correction_sent', `To ${to}`);
        return;
      }
      case 'confirm': {
        if (!cur || !BL_WITH_CUSTOMER.includes(f.bl_status)) throw bad('Only a draft with the customer can be confirmed');
        const note = txt(b.evidence_note, 1000);
        const doc = b.document_id ? await docOf(b.document_id, 'customer\'s confirmation') : null;
        if (!doc && (!note || note.length < 10)) throw bad('Attach the customer\'s confirmation (their email), or write how and when they confirmed');
        await c.query(`update bl_drafts set customer_reply = 'confirmed', customer_reply_at = now(), confirmed_by = $2, confirmation_evidence = $3, confirmation_document_id = $4 where id = $1`,
          [cur.id, actor.id, note, doc]);
        await set('customer_confirmed', `Version ${cur.version}${note ? ` — ${note}` : ''}`);
        await tell(c, actor, fileId, 'bl_confirmed', `version ${cur.version}`);
        return;
      }
      case 'final': {
        if (f.bl_status !== 'customer_confirmed') throw bad('The customer must confirm the BL draft before the final BL is recorded');
        const no = txt(b.bl_no, 60);
        if (!no) throw bad('Enter the final BL number');
        const doc = b.document_id ? await docOf(b.document_id, 'final BL') : null;
        await c.query(`update job_files set final_bl_no = $2, final_bl_received_at = now(), final_bl_document_id = coalesce($3, final_bl_document_id),
          mbl_mawb = coalesce(mbl_mawb, $2), updated_at = now() where id = $1`, [fileId, no, doc]);
        await ev(c, actor, fileId, { kind: 'status', title: 'Final BL received', field: 'Final BL', old_value: f.final_bl_no, new_value: no });
        return;
      }
      default: throw bad('Unknown step');
    }
  });
  const { getJobFile } = await import('./jobfiles');
  return getJobFile(actor, fileId);
}
