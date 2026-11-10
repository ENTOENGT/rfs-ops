/**
 * Quotations (Freight + 3PL, Part A).
 *
 * Enquiry → cost estimate + selling rate per line → approval when the margin is below the minimum →
 * sent → accepted (creates the Job File) / not accepted / expired.
 *
 * Commercial confidentiality, enforced here and in the database:
 *   - quotes.* permissions are "commercial": user_has_perm never gives them to Transport, Messenger, PRO or
 *     Warehouse people, whatever their role says.
 *   - Cost rates only with finance.buying.view, selling rates only with finance.selling.view, margin only with
 *     profit view (both sides). A field the user may not see is left out of the response, not blanked.
 *   - Someone without cost view who edits lines keeps the existing cost rates (they cannot overwrite them blind).
 * Nothing here is an invoice: quotations are operational and commercial records only. Billing stays in the ERP.
 */
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, getSetting, notFound, one, q, tx } from './db';
import { fromFils, toFils } from '../lib/finance';
import { SERVICE_TYPES, DIRECTIONS, CHARGE_UNITS, Q_STATUSES, qStatusName, qStatusColor, label } from '../lib/jobfileRules';
import { createJobFile } from './jobfiles';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

export const canSeeQuotes = (a: Actor) => a.has('quotes.view');
/** Department rule, as for Job Files: view_all sees every quotation, otherwise own department + own. */
function qScope(actor: Actor, params: unknown[], alias = 'x'): string {
  if (actor.has('jobfiles.view_all') || actor.isSuperAdmin) return '';
  params.push(actor.id);
  const me = `$${params.length}`;
  const c = [`${alias}.created_by = ${me}`];
  // Part E: Salesman / Coordinator see the quotations of their shipments (not the whole department)
  const own = actor.has('jobfiles.view_assigned') && !actor.has('jobfiles.view_department');
  if (actor.department_id && !own) { params.push(actor.department_id); c.push(`${alias}.department_id = $${params.length}`); }
  if (actor.has('jobfiles.view_assigned'))
    c.push(`${alias}.salesman_id = ${me}`, `exists (select 1 from job_files jf where jf.id = ${alias}.job_file_id and (jf.salesman_id = ${me} or jf.coordinator_id = ${me}))`);
  return ` and (${c.join(' or ')})`;
}
async function load(actor: Actor, id: string, db?: Db, lock = false) {
  if (!canSeeQuotes(actor)) throw forbidden();
  if (!isUuid(id)) throw notFound('Quotation');
  const p: unknown[] = [id];
  const x = await one(`select x.* from quotations x where x.id = $1 and x.deleted_at is null${qScope(actor, p)}${lock ? ' for update of x' : ''}`, p, db);
  if (!x) throw notFound('Quotation');
  return x;
}
async function evt(db: Db, actor: Actor, id: string, title: string, details?: string | null) {
  await db.query('insert into quotation_events (quotation_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)',
    [id, title, details ?? null, actor.id, actor.full_name]);
}
async function refreshSearch(db: Db, id: string) {
  await db.query(`update quotations x set search_text = lower(concat_ws(' ', x.quote_no, x.enquiry_reference, x.origin, x.destination, x.cargo_description, c.name))
    from customers c where x.id = $1 and c.id = x.customer_id`, [id]);
}
const txt = (v: unknown, max = 200) => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  if (t.length > max) throw bad(`Value too long (max ${max} characters)`);
  return t || null;
};
const num = (v: unknown, lbl: string, int = false) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw bad(`${lbl} must be ${int ? 'a whole number' : 'a number'} of 0 or more`);
  return String(v);
};
const money = (v: unknown, lbl: string) => {
  const s = String(v ?? '0').trim() || '0';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad(`${lbl}: enter an amount like 1250 or 1250.50`);
  return s;
};

/** Totals in integer fils: quantity can have decimals (CBM, kg), so each line rounds to the fils once. */
export function quoteTotals(lines: { quantity: string | number; cost_rate: string | number; sell_rate: string | number }[]) {
  let cost = 0, sell = 0;
  const each = lines.map((l) => {
    const qty = Number(l.quantity);
    const c = Math.round(qty * toFils(String(l.cost_rate)));
    const s = Math.round(qty * toFils(String(l.sell_rate)));
    cost += c; sell += s;
    return { cost: fromFils(c), sell: fromFils(s) };
  });
  const margin = sell - cost;
  return { each, cost_total: fromFils(cost), sell_total: fromFils(sell), margin: fromFils(margin),
    margin_pct: sell > 0 ? ((margin / sell) * 100).toFixed(2) : null };
}

/** Show a quotation as this person may see it. */
function present(actor: Actor, x: any, lines: any[]) {
  const { buyingView, sellingView, profitView } = actor.fin;
  const t = quoteTotals(lines);
  const expired = ['approved', 'sent'].includes(x.status) && x.valid_until < today();
  const status = expired ? 'expired' : x.status;
  return {
    ...x, search_text: undefined, status, status_name: qStatusName(status), status_color: qStatusColor(status),
    // a loss quotation (selling below cost) is shown in red — only to people who see the margin
    loss: profitView || (buyingView && sellingView) ? Number(t.margin) < 0 : undefined,
    service_name: label(SERVICE_TYPES, x.service_type), direction_name: label(DIRECTIONS, x.direction),
    lines: lines.map((l, i) => ({
      id: l.id, description: l.description, charge_unit: l.charge_unit, unit_name: label(CHARGE_UNITS, l.charge_unit), quantity: l.quantity,
      ...(buyingView ? { cost_rate: l.cost_rate, cost_amount: t.each[i].cost } : {}),
      ...(sellingView ? { sell_rate: l.sell_rate, sell_amount: t.each[i].sell } : {}),
      ...(profitView ? { margin_type: l.margin_type, margin_value: l.margin_value } : {}),
      ...(buyingView ? { vendor_request_id: l.vendor_request_id } : {}), route_id: l.route_id ?? null,
    })),
    totals: {
      ...(buyingView ? { cost_total: t.cost_total } : {}),
      ...(sellingView ? { sell_total: t.sell_total } : {}),
      ...(profitView ? { margin: t.margin, margin_pct: t.margin_pct } : {}),
    },
  };
}

/** Vendor rates on a Job File that can become cost lines (cost viewers only). */
export async function vendorRatesFor(jobFileId: string) {
  const { markLowest } = await import('./vendorreqs');
  const rows = await q(`select r.id, r.request_no, r.service, r.status, r.quoted_cost, r.currency, r.rate_valid_until, r.vendor_reference, r.description,
      r.rate_group, r.route_id, v.name vendor_name
    from vendor_requests r join vendors v on v.id = r.vendor_id
    where r.job_file_id = $1 and r.quoted_cost is not null and r.status not in ('cancelled') order by r.created_at`, [jobFileId]);
  return markLowest(rows, (r) => r.service === 'rate' ? `route:${r.route_id ?? ''}` : r.rate_group);
}

/** One message per cost line whose vendor rate is dearer than another vendor's rate for the same request. */
async function cheaperWarnings(lines: { vendor_request_id?: string | null; description?: string }[], db?: Db) {
  const { cheaperRateWarning } = await import('./vendorreqs');
  const out: string[] = [];
  for (const l of lines) {
    if (!l.vendor_request_id) continue;
    const w = await cheaperRateWarning(l.vendor_request_id, db);
    if (w) out.push(`"${l.description}": ${w}`);
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------ list
export async function listQuotations(actor: Actor, p: Record<string, string>) {
  if (!canSeeQuotes(actor)) throw forbidden();
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let w = `where x.deleted_at is null` + qScope(actor, params);
  if (p.q?.trim()) w += ` and x.search_text like ${add('%' + p.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&') + '%')}`;
  if (p.customer_id) { if (!isUuid(p.customer_id)) throw bad('Invalid filter'); w += ` and x.customer_id = ${add(p.customer_id)}`; }
  if (p.status === 'expired') w += ` and x.status in ('approved','sent') and x.valid_until < ${add(today())}`;
  else if (p.status === 'open') w += ` and x.status in ('draft','pending_approval','approved','sent')`;
  else if (p.status && !['confirmed', 'closed_out'].includes(p.status)) w += ` and x.status = ${add(p.status)}`;
  if (p.service_type) w += ` and x.service_type = ${add(p.service_type)}`;
  // UI redesign: date range on the quotation date
  for (const [k, op] of [['from', '>='], ['to', '<=']] as const)
    if (p[k]) { if (!/^\d{4}-\d{2}-\d{2}$/.test(p[k])) throw bad('Invalid date'); w += ` and (x.created_at at time zone 'Asia/Dubai')::date ${op} ${add(p[k])}`; }
  if (p.my_approval === '1') w += ` and x.status = 'pending_approval' and x.salesman_decision is null and x.salesman_id = ${add(actor.id)}`;
  if (p.job_file_id) { if (!isUuid(p.job_file_id)) throw bad('Invalid filter'); w += ` and x.job_file_id = ${add(p.job_file_id)}`; }
  if (p.status === 'confirmed') w += ` and x.status = 'accepted'`;
  if (p.status === 'closed_out') w += ` and (x.status in ('rejected','cancelled') or (x.status in ('approved','sent') and x.valid_until < ${add(today())}))`;
  const size = Math.min(Math.max(Number(p.page_size) || 50, 1), 200), page = Math.max(Number(p.page) || 1, 1);
  const rows = await q(`select x.*, c.name customer_name, u.full_name created_by_name, f.job_no, f.enquiry_ref, f.shipping_ref, sm.full_name salesman_name, count(*) over() _total
    from quotations x join customers c on c.id = x.customer_id join users u on u.id = x.created_by left join job_files f on f.id = x.job_file_id
    left join users sm on sm.id = x.salesman_id
    ${w} order by x.created_at desc limit ${size} offset ${(page - 1) * size}`, params);
  const lines = rows.length ? await q('select * from quotation_lines where quotation_id = any($1) order by sort_order', [rows.map((r) => r.id)]) : [];
  return { total: Number(rows[0]?._total ?? 0), page, page_size: size,
    rows: rows.map(({ _total, ...r }) => { const v = present(actor, r, lines.filter((l) => l.quotation_id === r.id)); delete (v as any).lines; return v; }) };
}

// ------------------------------------------------------------ one
export async function getQuotation(actor: Actor, id: string) {
  const x = await load(actor, id);
  const [extra, lines, events] = await Promise.all([
    one(`select c.name customer_name, u.full_name created_by_name, a.full_name approved_by_name, dep.name department_name, f.job_no, f.enquiry_ref, f.shipping_ref, f.stage file_stage,
       sm.full_name salesman_name, sd.full_name salesman_decided_by_name, tt.name terms_template_name
       from quotations x join customers c on c.id = x.customer_id join users u on u.id = x.created_by left join users a on a.id = x.approved_by
       left join departments dep on dep.id = x.department_id left join job_files f on f.id = x.job_file_id
       left join users sm on sm.id = x.salesman_id left join users sd on sd.id = x.salesman_decided_by
       left join quote_term_templates tt on tt.id = x.terms_template_id where x.id = $1`, [id]),
    q('select * from quotation_lines where quotation_id = $1 order by sort_order', [id]),
    q('select title, details, user_name, at from quotation_events where quotation_id = $1 order by at, id', [id]),
  ]);
  const v = present(actor, { ...x, ...extra }, lines);
  // Part G2: the route options of the shipment, and a selling total per option used on this quotation
  const routes = x.job_file_id ? await q('select id, option_no, origin_city, pol, destination_city, pod, mode from enquiry_routes where job_file_id = $1 and removed_at is null order by option_no', [x.job_file_id]) : [];
  const options = routes.filter((r) => lines.some((l) => l.route_id === r.id)).map((r) => {
    const t = quoteTotals(lines.filter((l) => l.route_id === r.id));
    return { ...r, ...(actor.fin.sellingView ? { sell_total: t.sell_total } : {}), ...(actor.fin.buyingView && actor.fin.sellingView ? { margin: t.margin } : {}) };
  });
  const minMargin = Number(await getSetting('quote_min_margin_pct', 10));
  const vendorRates = x.job_file_id && actor.fin.buyingView ? await vendorRatesFor(x.job_file_id) : [];
  const editable = ['draft', 'pending_approval', 'approved'].includes(x.status) && actor.has('quotes.create');
  const rateWarnings = actor.fin.buyingView ? await cheaperWarnings(lines) : [];
  const versions = await q('select version_no, reason, made_by_name, at from quotation_versions where quotation_id = $1 order by version_no desc, id desc', [id]);
  const responses = await q('select version_no, response, note, document_id, user_name, at from quotation_responses where quotation_id = $1 order by at desc, id desc', [id]);
  const pending = x.status === 'pending_approval';
  const salesmanTurn = pending && !!x.salesman_id && !x.salesman_decision;
  return { ...v, events, versions, responses, min_margin_pct: minMargin, vendor_rates: vendorRates, rate_warnings: rateWarnings, routes, options,
    approvals: { salesman: x.salesman_id ? (x.salesman_decision ?? (pending ? 'waiting' : null)) : null,
      manager: x.needs_manager ? (x.approved_by && pending ? 'approved' : pending ? 'waiting' : null) : null },
    can: { edit: editable, submit: x.status === 'draft' && actor.has('quotes.create'),
      salesman_approve: salesmanTurn && actor.has('quotes.salesman_approve') && (x.salesman_id === actor.id || actor.has('commercial.manage') || actor.isSuperAdmin),
      approve: pending && actor.has('quotes.approve') && (x.needs_manager || !x.salesman_id) && !(x.needs_manager && x.approved_by),
      revise: ['approved', 'sent'].includes(x.status) && actor.has('quotes.create'),
      respond: ['sent', 'approved'].includes(x.status) && actor.has('quotes.create'),
      send: x.status === 'approved' && v.status !== 'expired' && actor.has('quotes.create'),
      accept: ['approved', 'sent'].includes(x.status) && v.status !== 'expired' && actor.has('quotes.create') && (!!x.job_file_id || actor.has('jobfiles.create')),
      decline: ['approved', 'sent'].includes(x.status) && actor.has('quotes.create'),
      cancel: ['draft', 'pending_approval', 'approved', 'sent'].includes(x.status) && actor.has('quotes.create'),
      copy: actor.has('quotes.create'),
      customer_copy: ['approved', 'sent', 'accepted'].includes(x.status) && (x.status === 'accepted' || v.status !== 'expired') && actor.fin.sellingView } };
}

// ------------------------------------------------------------ create / edit
const HEAD: Record<string, (v: unknown) => unknown> = {
  customer_id: (v) => { if (!isUuid(v)) throw bad('Choose the customer'); return v; },
  service_type: (v) => { if (!SERVICE_TYPES.some((s) => s[0] === v)) throw bad('Choose the service'); return v; },
  direction: (v) => { if (!DIRECTIONS.some((s) => s[0] === v)) throw bad('Choose import, export, cross-trade or domestic'); return v; },
  enquiry_reference: (v) => txt(v, 80), origin: (v) => txt(v, 120), destination: (v) => txt(v, 120),
  cargo_description: (v) => txt(v, 2000), packages: (v) => num(v, 'Packages', true), gross_weight_kg: (v) => num(v, 'Gross weight'),
  volume_cbm: (v) => num(v, 'Volume'), chargeable_weight_kg: (v) => num(v, 'Chargeable weight'),
  valid_until: (v) => { if (!DATE.test(String(v ?? ''))) throw bad('Choose the date the rates are valid until'); return v; },
  scope: (v) => txt(v, 3000), exclusions: (v) => txt(v, 3000), terms: (v) => txt(v, 3000),
  additional_remarks: (v) => txt(v, 3000), payment_terms: (v) => txt(v, 3000),
};
const TERM_KEYS = ['scope', 'exclusions', 'terms', 'additional_remarks', 'payment_terms'];
/** Did the person change the template's text for this quotation? (shown as "from template X, changed") */
const termsDiffer = (q0: any, t: any) => TERM_KEYS.some((k) => String(q0[k] ?? '').trim() !== String(t[k] ?? '').trim());
/**
 * Selling rate from cost + margin, to the fils.
 *   percent: selling = cost ÷ (1 − margin%)  → the margin is that % of the selling price (cost 1000, 20% → 1250)
 *   amount : selling = cost + margin         (cost 1000, 250 → 1250)
 */
export function sellFromMargin(cost: string, type: 'percent' | 'amount', value: string): string {
  const c = toFils(cost);
  if (type === 'amount') return fromFils(c + toFils(value));
  const pct = Number(value);
  return fromFils(Math.round(c / (1 - pct / 100)));
}
function parseLines(actor: Actor, raw: unknown, old: any[]) {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) throw bad('Add at least one charge line');
  if (raw.length > 60) throw bad('Up to 60 lines per quotation');
  return raw.map((l: any, i) => {
    const n = `Line ${i + 1}`;
    const description = txt(l?.description, 200);
    if (!description) throw bad(`${n}: describe the charge`);
    if (!CHARGE_UNITS.some((u) => u[0] === l.charge_unit)) throw bad(`${n}: choose how it is charged`);
    const qty = Number(l.quantity);
    if (!Number.isFinite(qty) || qty <= 0 || !/^\d+(\.\d{1,3})?$/.test(String(l.quantity).trim())) throw bad(`${n}: quantity must be more than 0 (up to 3 decimals)`);
    // People who can't see a side keep what is already there (matched by line id) — never overwrite blind.
    const prev = old.find((o) => o.id === l.id);
    const cost = actor.fin.buyingView ? money(l.cost_rate, `${n} cost rate`) : prev?.cost_rate ?? '0';
    let sell = actor.fin.sellingView ? money(l.sell_rate, `${n} selling rate`) : prev?.sell_rate ?? '0';
    // Margin: only someone who sees both cost and selling can use it (it reveals one from the other)
    let margin_type: string | null = prev?.margin_type ?? null, margin_value: string | null = prev?.margin_value ?? null;
    const canMargin = actor.fin.buyingView && actor.fin.sellingView;
    if (canMargin && l.margin_type !== undefined) {
      if (!l.margin_type) { margin_type = null; margin_value = null; }
      else {
        if (!['percent', 'amount'].includes(l.margin_type)) throw bad(`${n}: margin is a % or an amount`);
        const v = String(l.margin_value ?? '').trim();
        if (!/^\d+(\.\d{1,2})?$/.test(v)) throw bad(`${n}: enter the margin, e.g. 15 or 250.50`);
        if (l.margin_type === 'percent' && Number(v) >= 100) throw bad(`${n}: margin % must be below 100`);
        margin_type = l.margin_type; margin_value = v;
      }
    } else if (!canMargin && margin_type && actor.fin.sellingView && prev && money(l.sell_rate, `${n} selling rate`) !== prev.sell_rate) {
      // someone without cost view typed a new selling rate: it is no longer "cost + margin"
      margin_type = null; margin_value = null;
    }
    if (margin_type) sell = sellFromMargin(cost, margin_type as any, margin_value!);
    const vendor_request_id = typeof l.vendor_request_id === 'string' && UUID.test(l.vendor_request_id) ? l.vendor_request_id : prev?.vendor_request_id ?? null;
    // Part G2: which route option the charge belongs to (checked against the shipment's options in validateVendorLines)
    const route_id = typeof l.route_id === 'string' && UUID.test(l.route_id) ? l.route_id : l.route_id === null || l.route_id === '' ? null : prev?.route_id ?? null;
    return { description, charge_unit: l.charge_unit, quantity: String(l.quantity).trim(), cost_rate: cost, sell_rate: sell, margin_type, margin_value, vendor_request_id, route_id };
  });
}

/** A cost line taken from a vendor rate must come from a vendor request on the same Job File. */
async function validateVendorLines(c: Db, jobFileId: string | null, lines: { vendor_request_id: string | null; route_id?: string | null }[]) {
  const ids = [...new Set(lines.map((l) => l.vendor_request_id).filter((x): x is string => !!x))];
  if (ids.length && !jobFileId) throw bad('Vendor rates can only be used on a quotation for their own Job No.');
  const ok = ids.length ? await q('select id, route_id from vendor_requests where id = any($1) and job_file_id = $2', [ids, jobFileId], c) : [];
  if (ok.length !== ids.length) throw bad('A vendor rate on this quotation belongs to another Job No.');
  // Part G2: route options — a line takes its rate's option; with several options every line must say which one, and
  // a rate is never used under another option (rates for different loading ports are not mixed)
  const routes = jobFileId ? await q('select id, option_no from enquiry_routes where job_file_id = $1 and removed_at is null', [jobFileId], c) : [];
  for (const [i, l] of lines.entries()) {
    const rate = ok.find((r) => r.id === l.vendor_request_id);
    if (rate?.route_id && !l.route_id) l.route_id = rate.route_id;
    if (rate?.route_id && l.route_id !== rate.route_id) throw bad(`Line ${i + 1}: this rate is for another route option`);
    if (l.route_id && !routes.some((r) => r.id === l.route_id)) throw bad(`Line ${i + 1}: choose a route option of this shipment`);
    if (!l.route_id && routes.length > 1) throw bad(`Line ${i + 1}: choose which route option the charge is for`);
    if (!l.route_id && routes.length === 1) l.route_id = routes[0].id;
  }
}

export async function createQuotation(actor: Actor, b: any) {
  if (!actor.has('quotes.create')) throw forbidden();
  if (!b.valid_until) b.valid_until = new Date(Date.now() + Number(await getSetting('quote_validity_days', 14)) * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const vals: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  for (const k of ['customer_id', 'service_type']) if (!b[k]) fields[k] = k === 'customer_id' ? 'Choose the customer' : 'Choose the service';
  if (Object.keys(fields).length) throw new ApiError(400, 'VALIDATION', 'Please fill in the highlighted fields', { fields });
  for (const [k, parse] of Object.entries(HEAD)) if (b[k] !== undefined) vals[k] = parse(b[k]);
  if (String(vals.valid_until) < today()) throw bad('The validity date has already passed');
  const lines = parseLines(actor, b.lines ?? [], []);
  if (!lines) throw bad('Add at least one charge line');
  return tx(async (c) => {
    if (!(await one('select 1 from customers where id = $1 and deleted_at is null', [vals.customer_id], c))) throw bad('Customer not found');
    const cm = await import('./commercial');
    await cm.assertCustomerAllowed(actor, vals.customer_id as string, c);
    let dept = actor.department_side === 'operations' ? actor.department_id : null;
    vals.salesman_id = actor.role_code === 'sales' ? actor.id : null;
    // A quotation belongs to the Job No. of the enquiry (migration 017)
    if (b.job_file_id || b.job_no) {
      const { loadFile } = await import('./jobfiles');
      let fid = b.job_file_id;
      if (!fid) {
        const f = await one(`select id from job_files where (upper(btrim(job_no)) = upper(btrim($1)) or upper(enquiry_ref) = upper(btrim($1)))
          and deleted_at is null and status <> 'cancelled'`, [b.job_no], c);
        if (!f) throw bad(`No shipment with Job No. / Enquiry Ref ${String(b.job_no).trim()}`);
        fid = f.id;
      }
      const f = await loadFile(actor, fid, c);
      const ref = f.job_no ?? f.enquiry_ref;
      if (['closed', 'cancelled'].includes(f.status)) throw bad(`Shipment ${ref} is ${f.status}`);
      if (f.customer_id !== vals.customer_id) throw bad(`Shipment ${ref} is for another customer`);
      if (f.stage && !['enquiry', 'rates_requested', 'rates_received', 'quotation_draft', 'pending_approval', 'sent_to_customer', 'handed_over'].includes(f.stage))
        throw new ApiError(409, 'STAGE', `The customer has already confirmed ${ref}. Revise the accepted quotation instead.`);
      vals.job_file_id = f.id;
      vals.salesman_id = f.salesman_id ?? vals.salesman_id;
      dept = f.department_id ?? dept;
      await validateVendorLines(c, f.id, lines);
    } else if (lines.some((l) => l.vendor_request_id)) throw bad('Vendor rates can only be used on a quotation for their own Job No.');
    else for (const l of lines) l.route_id = null;
    // Part G1: default Scope, Exclusions and Terms — the best matching template fills what was left empty
    const { pickTerms } = await import('./templates');
    const division = vals.job_file_id ? (await one('select division from job_files where id = $1', [vals.job_file_id], c))?.division : actor.division;
    const tpl = await pickTerms({ division: division ?? null, service_type: vals.service_type as string, customer_id: vals.customer_id as string }, c);
    if (tpl) {
      const chosen = isUuid(b.terms_template_id) && b.terms_template_id === tpl.template_id;
      for (const k of TERM_KEYS) if (!chosen && (vals[k] === undefined || vals[k] === null)) vals[k] = (tpl as any)[k] || null;
      vals.terms_template_id = tpl.template_id;
      vals.terms_edited = termsDiffer(vals, tpl);
    }
    const cols = Object.keys(vals);
    const x = await one(`insert into quotations (quote_no, department_id, created_by, currency${cols.map((k) => ', ' + k).join('')})
      values ('Q-' || nextval('quote_no_seq'), $1, $2, $3${cols.map((_, i) => `, $${i + 4}`).join('')}) returning id, quote_no`,
      [dept, actor.id, await getSetting('currency', 'AED', c), ...cols.map((k) => vals[k])], c);
    for (const [i, l] of lines.entries())
      await c.query(`insert into quotation_lines (quotation_id, sort_order, description, charge_unit, quantity, cost_rate, sell_rate, margin_type, margin_value, vendor_request_id, route_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [x.id, i, l.description, l.charge_unit, l.quantity, l.cost_rate, l.sell_rate, l.margin_type, l.margin_value, l.vendor_request_id, l.route_id]);
    await evt(c, actor, x.id, 'Quotation created', `${lines.length} line(s)`);
    if (vals.job_file_id) {
      const { event } = await import('./jobfiles');
      await event(c, actor, vals.job_file_id as string, { kind: 'link', title: `Quotation ${x.quote_no} prepared` });
      await cm.setStage(c, actor, vals.job_file_id as string, 'quotation_draft', { back: true });
    }
    const warnings = await cheaperWarnings(lines, c);
    for (const w of warnings) await evt(c, actor, x.id, 'Dearer vendor rate used', w);
    await refreshSearch(c, x.id);
    return { id: x.id, quote_no: x.quote_no, warnings };
  });
}

export async function updateQuotation(actor: Actor, id: string, b: any) {
  if (!actor.has('quotes.create')) throw forbidden();
  await tx(async (c) => {
    const x = await load(actor, id, c, true);
    if (!['draft', 'pending_approval', 'approved'].includes(x.status))
      throw new ApiError(409, 'QUOTE_LOCKED', `This quotation is ${qStatusName(x.status).toLowerCase()}. Make a copy to change it.`);
    const sets: [string, unknown][] = [];
    for (const [k, parse] of Object.entries(HEAD)) if (b[k] !== undefined) sets.push([k, parse(b[k])]);
    const old = await q('select * from quotation_lines where quotation_id = $1 order by sort_order', [id], c);
    const lines = parseLines(actor, b.lines, old);
    if (lines) { await validateVendorLines(c, x.job_file_id, lines); if (!x.job_file_id) for (const l of lines) l.route_id = null; }
    if (sets.length && x.job_file_id && sets.some(([k, v]) => k === 'customer_id' && v !== x.customer_id))
      throw bad('This quotation is on a Job File; its customer is the Job File\'s customer');
    if (x.terms_template_id && sets.some(([k]) => TERM_KEYS.includes(k))) {
      const t = await one('select * from quote_term_templates where id = $1', [x.terms_template_id], c);
      if (t) sets.push(['terms_edited', termsDiffer({ ...x, ...Object.fromEntries(sets) }, t)]);
    }
    if (sets.length) await c.query(`update quotations set ${sets.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`,
      [id, ...sets.map(([, v]) => v)]);
    if (lines) {
      await c.query('delete from quotation_lines where quotation_id = $1', [id]);
      for (const [i, l] of lines.entries())
        await c.query(`insert into quotation_lines (quotation_id, sort_order, description, charge_unit, quantity, cost_rate, sell_rate, margin_type, margin_value, vendor_request_id, route_id)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, i, l.description, l.charge_unit, l.quantity, l.cost_rate, l.sell_rate, l.margin_type, l.margin_value, l.vendor_request_id, l.route_id]);
    }
    // a changed quotation must be checked again before it goes out
    if (x.status !== 'draft') {
      await c.query(`update quotations set status = 'draft', approved_by = null, approved_at = null, salesman_decision = null, salesman_decided_by = null,
        salesman_decided_at = null, needs_manager = false where id = $1`, [id]);
      if (x.job_file_id) { const { setStage } = await import('./commercial'); await setStage(c, actor, x.job_file_id, 'quotation_draft', { back: true }); }
      await evt(c, actor, id, 'Changed — back to draft', 'Send it for approval again before it goes to the customer');
    } else await evt(c, actor, id, 'Quotation changed');
    await refreshSearch(c, id);
  });
  return getQuotation(actor, id);
}

// ------------------------------------------------------------ workflow
async function notifyApprovers(db: Db, actor: Actor, x: any) {
  const users = await q<{ id: string }>(`select u.id from users u join roles r on r.id = u.role_id where u.is_active and u.deleted_at is null
    and r.code <> 'super_admin' and u.id <> $1 and user_has_perm(u.id, 'quotes.approve')
    and (u.department_id = $2 or user_has_perm(u.id, 'jobfiles.view_all'))`, [actor.id, x.department_id], db);
  for (const u of users)
    await db.query('insert into notifications (user_id, type, title, quotation_id) values ($1,$2,$3,$4)',
      [u.id, 'quote.approval', `Quotation ${x.quote_no} needs approval`, x.id]);
}

/** Keep the quotation as it stands (header, lines, totals) — at approval, revision and customer confirmation. */
async function snapshot(db: Db, actor: Actor, x: any, reason: string) {
  const lines = await q('select description, charge_unit, quantity, cost_rate, sell_rate, margin_type, margin_value, vendor_request_id, route_id from quotation_lines where quotation_id = $1 order by sort_order', [x.id], db);
  const head = Object.fromEntries(Object.keys(HEAD).map((k) => [k, x[k]]));
  await db.query(`insert into quotation_versions (quotation_id, version_no, reason, snapshot, made_by, made_by_name) values ($1,$2,$3,$4,$5,$6)`,
    [x.id, x.version_no ?? 1, reason, JSON.stringify({ ...head, quote_no: x.quote_no, currency: x.currency, lines, totals: quoteTotals(lines) }), actor.id, actor.full_name]);
}
async function notify(db: Db, userId: string | null, type: string, title: string, quotationId: string) {
  if (userId) await db.query('insert into notifications (user_id, type, title, quotation_id) values ($1,$2,$3,$4)', [userId, type, title, quotationId]);
}

export async function quotationAction(actor: Actor, id: string, b: any) {
  const action = String(b.action ?? '');
  let created: { id: string; job_no: string } | null = null;
  await tx(async (c) => {
    const x = await load(actor, id, c, true);
    const lines = await q('select * from quotation_lines where quotation_id = $1 order by sort_order', [id], c);
    const expired = ['approved', 'sent'].includes(x.status) && x.valid_until < today();
    const need = (p: 'quotes.create' | 'quotes.approve') => { if (!actor.has(p)) throw forbidden(); };
    const from = (...s: string[]) => { if (!s.includes(x.status)) throw new ApiError(409, 'QUOTE_STATE', `Not possible while the quotation is "${qStatusName(expired ? 'expired' : x.status)}"`); };
    const set = (status: string, extra = '', params: unknown[] = []) =>
      c.query(`update quotations set status = $2${extra}, updated_at = now() where id = $1`, [id, status, ...params]);
    switch (action) {
      case 'submit': {
        need('quotes.create'); from('draft');
        if (!lines.length) throw bad('Add at least one charge line');
        const t = quoteTotals(lines);
        if (Number(t.sell_total) <= 0) throw bad('Enter the selling rates first');
        const min = Number(await getSetting('quote_min_margin_pct', 10));
        const low = t.margin_pct === null || Number(t.margin_pct) < min;
        const lossNote = Number(t.margin) < 0 ? ' — LOSS: selling is below cost' : '';
        // Part E: a quotation prepared by someone else goes to the responsible Salesman; a low margin also to a manager
        const needSalesman = !!x.salesman_id && x.salesman_id !== actor.id;
        const needManager = low && !actor.has('quotes.approve');
        if (needSalesman || needManager) {
          await set('pending_approval', `, needs_manager = $3, salesman_decision = $4, salesman_decided_by = $5, salesman_decided_at = $6,
            approved_by = null, approved_at = null`, [needManager, needSalesman ? null : x.salesman_id ? 'approved' : null,
            needSalesman || !x.salesman_id ? null : actor.id, needSalesman || !x.salesman_id ? null : new Date()]);
          await evt(c, actor, id, 'Sent for approval', [needSalesman && 'to the Salesman', needManager && `to a manager (margin below the ${min}% minimum)`].filter(Boolean).join(' and ') + lossNote);
          if (needSalesman) await notify(c, x.salesman_id, 'quote.approval', `Quotation ${x.quote_no} needs your approval${lossNote ? ' (LOSS)' : ''}`, id);
          if (needManager) await notifyApprovers(c, actor, x);
          if (x.job_file_id) { const { setStage } = await import('./commercial'); await setStage(c, actor, x.job_file_id, 'pending_approval'); }
        } else {
          await set('approved', ', approved_by = $3, approved_at = now()', [actor.id]);
          await evt(c, actor, id, low ? 'Approved (by an approver, below the minimum margin)' + lossNote : 'Approved — margin meets the minimum');
          await snapshot(c, actor, { ...x, status: 'approved' }, 'approved');
        }
        break;
      }
      case 'salesman_approve': case 'salesman_reject': case 'salesman_return': {
        from('pending_approval');
        if (!x.salesman_id || x.salesman_decision) throw new ApiError(409, 'QUOTE_STATE', 'The Salesman has already decided');
        const onBehalf = x.salesman_id !== actor.id;
        if (!actor.has('quotes.salesman_approve') || (onBehalf && !actor.has('commercial.manage') && !actor.isSuperAdmin))
          throw forbidden('Only the responsible Salesman (or the Commercials Manager) can decide');
        const by = onBehalf ? ' (on behalf of the Salesman)' : '';
        const reason = txt(b.reason, 500);
        if (action !== 'salesman_approve' && !reason) throw bad(action === 'salesman_reject' ? 'Say why it is rejected' : 'Say what has to change');
        const decision = action === 'salesman_approve' ? 'approved' : action === 'salesman_reject' ? 'rejected' : 'returned';
        await c.query('update quotations set salesman_decision = $2, salesman_decided_by = $3, salesman_decided_at = now(), salesman_note = $4 where id = $1', [id, decision, actor.id, reason]);
        if (x.job_file_id) await (await import('./notify')).notifyGroup(c, actor, x.job_file_id, decision === 'approved' ? 'quotation_approved' : decision === 'returned' ? 'quotation_returned' : 'quotation_rejected',
          `${x.quote_no} by the Salesman${reason ? `: ${reason}` : ''}`, { quotationId: id, also: [x.created_by] });
        const { setStage } = await import('./commercial');
        if (decision === 'approved') {
          if (!x.needs_manager || x.approved_by) {
            await set('approved', x.approved_by ? '' : ', approved_by = $3, approved_at = now()', x.approved_by ? [] : [actor.id]);
            await evt(c, actor, id, 'Approved by the Salesman' + by, reason);
            await snapshot(c, actor, x, 'approved');
            await notify(c, x.created_by, 'quote.approved', `Quotation ${x.quote_no} approved — send it to the customer`, id);
            if (x.job_file_id) await setStage(c, actor, x.job_file_id, 'quotation_draft', { back: true });
          } else await evt(c, actor, id, 'Approved by the Salesman' + by + ' — waiting for a manager (low margin)', reason);
        } else if (decision === 'returned') {
          await set('draft', ', decline_reason = $3, approved_by = null, approved_at = null', [reason]);
          await evt(c, actor, id, 'Returned for revision by the Salesman' + by, reason);
          await notify(c, x.created_by, 'quote.returned', `Quotation ${x.quote_no} returned for revision`, id);
          if (x.job_file_id) await setStage(c, actor, x.job_file_id, 'quotation_draft', { back: true });
        } else {
          await set('cancelled', ', decline_reason = $3', [`Rejected by the Salesman: ${reason}`]);
          await evt(c, actor, id, 'Rejected by the Salesman' + by, reason);
          await notify(c, x.created_by, 'quote.rejected', `Quotation ${x.quote_no} was rejected by the Salesman`, id);
          if (x.job_file_id) await setStage(c, actor, x.job_file_id, 'rates_received', { back: true });
        }
        break;
      }
      case 'approve': need('quotes.approve'); from('pending_approval');
        if (x.salesman_id && !x.salesman_decision) {
          // manager approved the margin; the Salesman still has to approve
          if (!x.needs_manager) throw new ApiError(409, 'QUOTE_STATE', 'This quotation waits for the Salesman, not a manager');
          await c.query('update quotations set approved_by = $2, approved_at = now() where id = $1', [id, actor.id]);
          await evt(c, actor, id, 'Approved by a manager (low margin) — waiting for the Salesman');
          break;
        }
        await set('approved', ', approved_by = $3, approved_at = now(), decline_reason = null', [actor.id]);
        await evt(c, actor, id, 'Approved');
        if (x.job_file_id) await (await import('./notify')).notifyGroup(c, actor, x.job_file_id, 'quotation_approved', x.quote_no, { quotationId: id, also: [x.created_by] });
        await snapshot(c, actor, x, 'approved');
        await c.query('insert into notifications (user_id, type, title, quotation_id) values ($1,$2,$3,$4)', [x.created_by, 'quote.approved', `Quotation ${x.quote_no} approved`, id]);
        if (x.job_file_id) { const { setStage } = await import('./commercial'); await setStage(c, actor, x.job_file_id, 'quotation_draft', { back: true }); }
        break;
      case 'reject_approval': {
        need('quotes.approve'); from('pending_approval');
        const reason = txt(b.reason, 500); if (!reason) throw bad('Say why it is not approved');
        await set('draft', ', decline_reason = $3, salesman_decision = null, salesman_decided_by = null, salesman_decided_at = null, approved_by = null, approved_at = null', [reason]);
        await evt(c, actor, id, 'Not approved — back to draft', reason);
        if (x.job_file_id) await (await import('./notify')).notifyGroup(c, actor, x.job_file_id, 'quotation_returned', `${x.quote_no} not approved by a manager: ${reason}`, { quotationId: id, also: [x.created_by] });
        if (x.job_file_id) { const { setStage } = await import('./commercial'); await setStage(c, actor, x.job_file_id, 'quotation_draft', { back: true }); }
        await c.query('insert into notifications (user_id, type, title, quotation_id) values ($1,$2,$3,$4)', [x.created_by, 'quote.rejected', `Quotation ${x.quote_no} was not approved`, id]);
        break;
      }
      case 'send': need('quotes.create'); from('approved');
        if (expired) throw new ApiError(409, 'QUOTE_EXPIRED', 'The rates have expired. Change the validity date and approve again.');
        await set('sent', ', sent_at = now()'); await evt(c, actor, id, 'Marked as sent to the customer', txt(b.note, 300));
        if (x.job_file_id) { const { setStage } = await import('./commercial'); await setStage(c, actor, x.job_file_id, 'sent_to_customer', { back: true }); }
        break;
      case 'revise': {
        // the customer asked for changes (or rates moved): keep this version, open the next one as a draft
        need('quotes.create'); from('approved', 'sent');
        const reason = txt(b.reason, 500); if (!reason) throw bad('Say why the quotation is revised');
        await snapshot(c, actor, x, 'revised');
        if (b.customer_asked) await c.query(`insert into quotation_responses (quotation_id, version_no, response, note, user_id, user_name) values ($1,$2,'revision_requested',$3,$4,$5)`,
          [id, x.version_no, reason, actor.id, actor.full_name]);
        await set('draft', `, version_no = version_no + 1, approved_by = null, approved_at = null, salesman_decision = null, salesman_decided_by = null,
          salesman_decided_at = null, needs_manager = false, sent_at = null`);
        await evt(c, actor, id, `Revised — version ${x.version_no + 1} opened`, reason);
        if (x.job_file_id) { const { setStage } = await import('./commercial'); await setStage(c, actor, x.job_file_id, 'quotation_draft', { back: true }); }
        break;
      }
      case 'response': {
        // what the customer said (no change of status): a note, no reply yet, asked for changes
        need('quotes.create'); from('approved', 'sent');
        const response = String(b.response ?? '');
        if (!['note', 'no_reply', 'revision_requested'].includes(response)) throw bad('Choose what the customer said');
        const note = txt(b.note, 1000); if (!note && response !== 'no_reply') throw bad('Write what the customer said');
        if (b.document_id && !(isUuid(b.document_id) && x.job_file_id && await one('select 1 from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null', [b.document_id, x.job_file_id], c)))
          throw bad('Upload the customer\'s email to the shipment first');
        await c.query(`insert into quotation_responses (quotation_id, version_no, response, note, document_id, user_id, user_name) values ($1,$2,$3,$4,$5,$6,$7)`,
          [id, x.version_no, response, note, b.document_id || null, actor.id, actor.full_name]);
        await evt(c, actor, id, 'Customer response recorded', [response === 'no_reply' ? 'No reply yet' : response === 'revision_requested' ? 'Asked for changes' : 'Note', note].filter(Boolean).join(': '));
        if (x.job_file_id && response !== 'no_reply') await (await import('./notify')).notifyGroup(c, actor, x.job_file_id, 'customer_response', response === 'revision_requested' ? 'asked for changes' : note, { quotationId: id });
        break;
      }
      case 'accept': {
        need('quotes.create'); from('approved', 'sent');
        if (expired) throw new ApiError(409, 'QUOTE_EXPIRED', 'The rates have expired. Change the validity date and approve again.');
        if (x.job_file_id) {
          // Part E: the customer confirms → Shipping Ref is made, the approved version is kept, the shipment moves to booking.
          // It goes live (Job No. from the ERP) only after the pre-alert is verified.
          const f = await one('select id, job_no, enquiry_ref, shipping_ref, status, stage from job_files where id = $1 for update', [x.job_file_id], c);
          const ref = f.job_no ?? f.enquiry_ref;
          if (['closed', 'cancelled'].includes(f.status)) throw new ApiError(409, 'QUOTE_STATE', `Shipment ${ref} is ${f.status}`);
          const note = txt(b.evidence_note, 1000);
          if (b.document_id && !(isUuid(b.document_id) && await one('select 1 from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null', [b.document_id, f.id], c)))
            throw bad('Upload the customer\'s confirmation to the shipment first');
          if (!b.document_id && (!note || note.length < 10)) throw bad('Attach the customer\'s confirmation (their email), or write how and when they confirmed');
          const { event } = await import('./jobfiles');
          const { newRef, setStage } = await import('./commercial');
          const commercial = f.status === 'enquiry';
          const sr = f.shipping_ref ?? (commercial ? await newRef(c, 'SR') : null);
          await c.query(`update job_files set quotation_id = $2, shipping_ref = coalesce(shipping_ref, $3), confirmed_at = coalesce(confirmed_at, now()),
            confirmed_by = coalesce(confirmed_by, $4), updated_at = now() where id = $1`, [f.id, id, sr, actor.id]);
          await c.query(`insert into quotation_responses (quotation_id, version_no, response, note, document_id, user_id, user_name) values ($1,$2,'accepted',$3,$4,$5,$6)`,
            [id, x.version_no, note, b.document_id || null, actor.id, actor.full_name]);
          await snapshot(c, actor, x, 'confirmed by the customer');
          await event(c, actor, f.id, { kind: 'status', title: `Quotation ${x.quote_no} v${x.version_no} confirmed by the customer`,
            field: commercial && !f.shipping_ref ? 'Shipping Ref' : undefined, new_value: commercial && !f.shipping_ref ? sr : null,
            remarks: note ?? (b.document_id ? 'Confirmation attached' : null) });
          // Part G2: several route options → the customer's choice goes onto the shipment and is locked
          const chosen = await (await import('./routing')).chooseRoute(c, actor, f.id, id, b.route_id);
          if (chosen) await evt(c, actor, id, 'Route option chosen by the customer', chosen);
          if (commercial) await setStage(c, actor, f.id, 'customer_confirmed');
          // any other open quotation on the same Job No. is no longer needed
          const others = await q(`update quotations set status = 'cancelled', decline_reason = $3, updated_at = now()
            where job_file_id = $1 and id <> $2 and status in ('draft','pending_approval','approved','sent') returning id`,
            [f.id, id, `${x.quote_no} was accepted instead`], c);
          for (const o of others) await evt(c, actor, o.id, 'Cancelled', `${x.quote_no} was accepted instead`);
          await set('accepted', ', accepted_at = now()');
          await evt(c, actor, id, 'Confirmed by the customer', commercial ? `Shipping Ref ${sr}` : `Job No. ${f.job_no}`);
          created = { id: f.id, job_no: f.job_no, shipping_ref: sr } as any;
          break;
        }
        if (!actor.has('jobfiles.create')) throw forbidden('You need permission to create Job Files to accept a quotation');
        // A quotation made without a Job File becomes one now. The Job No. is typed, as everywhere else.
        const mode = ['sea_fcl', 'sea_lcl', 'air', 'road'].includes(x.service_type) ? x.service_type : (b.mode || null);
        created = await createJobFile(actor, {
          job_no: b.job_no, customer_id: x.customer_id, direction: x.direction, mode,
          department_id: x.department_id, origin: x.origin, destination: x.destination, cargo_description: x.cargo_description,
          packages: x.packages, gross_weight_kg: x.gross_weight_kg, volume_cbm: x.volume_cbm, chargeable_weight_kg: x.chargeable_weight_kg,
          needs_clearance: x.service_type === 'customs' || x.service_type === 'door_to_door' || !!b.needs_clearance,
          needs_transport: ['transport', 'door_to_door'].includes(x.service_type) || !!b.needs_transport,
          needs_warehouse: x.service_type === 'warehousing' || !!b.needs_warehouse,
          customer_reference: x.enquiry_reference,
        }, c, { quotation_id: id });
        await set('accepted', ', accepted_at = now(), job_file_id = $3', [created!.id]);
        await evt(c, actor, id, 'Accepted by the customer', `Job File ${created!.job_no} created`);
        break;
      }
      case 'decline': {
        need('quotes.create'); from('approved', 'sent');
        const reason = txt(b.reason, 500); if (!reason) throw bad('Say why the customer did not accept');
        await set('rejected', ', decline_reason = $3', [reason]); await evt(c, actor, id, 'Not accepted by the customer', reason); break;
      }
      case 'cancel': {
        need('quotes.create'); from('draft', 'pending_approval', 'approved', 'sent');
        const reason = txt(b.reason, 500); if (!reason) throw bad('Give a reason');
        await set('cancelled', ', decline_reason = $3', [reason]); await evt(c, actor, id, 'Cancelled', reason); break;
      }
      default: throw bad('Unknown action');
    }
  });
  if (created) return { ...(await getQuotation(actor, id)), created_job_file: created };
  return getQuotation(actor, id);
}

/** Start a new draft from an existing quotation (e.g. after it expired or the customer asked for changes). */
export async function copyQuotation(actor: Actor, id: string) {
  if (!actor.has('quotes.create')) throw forbidden();
  const x = await load(actor, id);
  const lines = await q('select * from quotation_lines where quotation_id = $1 order by sort_order', [id]);
  const fresh = await createQuotation(actor, {
    ...Object.fromEntries(Object.keys(HEAD).filter((k) => k !== 'valid_until').map((k) => [k, x[k]])),
    job_file_id: x.job_file_id && !(await one(`select 1 from job_files where id = $1 and status in ('closed','cancelled')`, [x.job_file_id])) ? x.job_file_id : undefined,
    // keep both sides as they were, even if this person can't see one of them
    lines: lines.map((l) => ({ ...l, id: undefined })),
  });
  if (!actor.fin.buyingView || !actor.fin.sellingView) {
    // createQuotation zeroed the side this person can't see — put the original values back
    await tx(async (c) => {
      const mine = await q('select id, sort_order from quotation_lines where quotation_id = $1 order by sort_order', [fresh.id], c);
      for (const [i, l] of lines.entries())
        await c.query(`update quotation_lines set ${!actor.fin.buyingView ? 'cost_rate = $2' : 'sell_rate = $2'} where id = $1`,
          [mine[i].id, !actor.fin.buyingView ? l.cost_rate : l.sell_rate]);
    });
  }
  await tx(async (c) => evt(c, actor, fresh.id, 'Copied', `From ${x.quote_no}`));
  return fresh;
}

export { Q_STATUSES };

// ------------------------------------------------------------ customer copy (print / PDF / Excel)
const CUSTOMER_READY = ['approved', 'sent', 'accepted'];
/**
 * What the customer receives: selling rates and totals only — never cost, margin or internal notes, whoever asks.
 * Only an approved (or sent / accepted) quotation that has not expired can go out, so a low-margin draft can't be sent by mistake.
 */
export async function customerCopy(actor: Actor, id: string, how: 'print' | 'excel' = 'print') {
  if (!actor.fin.sellingView) throw forbidden('You need to see selling prices to print a quotation');
  const x = await load(actor, id);
  if (!CUSTOMER_READY.includes(x.status))
    throw new ApiError(409, 'QUOTE_NOT_READY', `Only an approved quotation can go to the customer. This one is "${qStatusName(x.status)}".`);
  if (x.status !== 'accepted' && x.valid_until < today())
    throw new ApiError(409, 'QUOTE_EXPIRED', 'The rates have expired. Change the validity date and approve again before sending.');
  const [extra, lines] = await Promise.all([
    one(`select c.name customer_name, c.address customer_address, c.trn customer_trn, c.contact_person customer_contact, u.full_name prepared_by, u.email prepared_by_email
       from quotations x join customers c on c.id = x.customer_id join users u on u.id = x.created_by where x.id = $1`, [id]),
    q('select description, charge_unit, quantity, sell_rate, route_id from quotation_lines where quotation_id = $1 order by sort_order', [id]),
  ]);
  // Part G2: one section per route option (with its own total)
  const routes = x.job_file_id ? await q('select id, option_no, origin_city, pol, destination_city, pod from enquiry_routes where job_file_id = $1 order by option_no', [x.job_file_id]) : [];
  const used = routes.filter((r) => lines.some((l) => l.route_id === r.id));
  const company: Record<string, string> = {};
  for (const k of ['company_name', 'company_address', 'company_phone', 'company_email', 'company_trn', 'quote_vat_note'])
    company[k] = String(await getSetting(k, ''));
  const t = quoteTotals(lines.map((l) => ({ ...l, cost_rate: '0' })));
  await tx(async (c) => evt(c, actor, id, how === 'excel' ? 'Customer copy downloaded (Excel)' : 'Customer copy opened for print / PDF'));
  return {
    company, quote_no: x.quote_no, date: new Date(x.approved_at ?? x.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }),
    valid_until: x.valid_until, currency: x.currency, status: x.status,
    customer: { name: extra.customer_name, address: extra.customer_address, trn: extra.customer_trn, contact: extra.customer_contact },
    enquiry_reference: x.enquiry_reference, service_name: label(SERVICE_TYPES, x.service_type), direction_name: label(DIRECTIONS, x.direction),
    origin: x.origin, destination: x.destination, cargo_description: x.cargo_description, packages: x.packages,
    gross_weight_kg: x.gross_weight_kg, volume_cbm: x.volume_cbm, chargeable_weight_kg: x.chargeable_weight_kg,
    lines: lines.map((l, i) => ({ description: l.description, unit_name: label(CHARGE_UNITS, l.charge_unit), quantity: l.quantity,
      rate: l.sell_rate, amount: t.each[i].sell })),
    total: t.sell_total, scope: x.scope, exclusions: x.exclusions, terms: x.terms, additional_remarks: x.additional_remarks, payment_terms: x.payment_terms,
    options: used.length > 1 ? used.map((r) => {
      const mine = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.route_id === r.id);
      return { option_no: r.option_no, pol: r.pol ?? r.origin_city, pod: r.pod ?? r.destination_city, selected: x.selected_route_id === r.id,
        lines: mine.map(({ l, i }) => ({ description: l.description, unit_name: label(CHARGE_UNITS, l.charge_unit), quantity: l.quantity, rate: l.sell_rate, amount: t.each[i].sell })),
        total: quoteTotals(mine.map(({ l }) => ({ ...l, cost_rate: '0' }))).sell_total };
    }) : null,
    prepared_by: extra.prepared_by, prepared_by_email: extra.prepared_by_email,
  };
}

/** The same customer copy as an Excel file (selling only). */
export async function customerExcel(actor: Actor, id: string) {
  const d = await customerCopy(actor, id, 'excel');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = d.company.company_name || 'Quotation';
  const ws = wb.addWorksheet('Quotation', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 46 }, { width: 16 }, { width: 10 }, { width: 16 }, { width: 18 }];
  const bold = { bold: true };
  const add = (vals: unknown[], font?: any) => { const r = ws.addRow(vals); if (font) r.font = font; return r; };
  add([d.company.company_name], { bold: true, size: 16 });
  for (const k of ['company_address', 'company_phone', 'company_email']) if (d.company[k]) add([d.company[k]]);
  if (d.company.company_trn) add([`TRN: ${d.company.company_trn}`]);
  add([]);
  add(['QUOTATION'], { bold: true, size: 14 });
  const kv = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== '') { const r = add([k, v]); r.getCell(1).font = bold; } };
  kv('Quotation no.', d.quote_no); kv('Date', d.date); kv('Valid until', d.valid_until);
  kv('Customer', d.customer.name); kv('Attention', d.customer.contact); kv('Customer TRN', d.customer.trn); kv('Your reference', d.enquiry_reference);
  kv('Service', `${d.service_name} (${d.direction_name})`); kv('Route', [d.origin, d.destination].filter(Boolean).join(' → '));
  kv('Cargo', [d.cargo_description, d.packages && `${d.packages} packages`, d.gross_weight_kg && `${Number(d.gross_weight_kg)} kg`,
    d.volume_cbm && `${Number(d.volume_cbm)} CBM`, d.chargeable_weight_kg && `chargeable ${Number(d.chargeable_weight_kg)} kg`].filter(Boolean).join(', '));
  add([]);
  // Part G2: one block per route option, each with its own total
  for (const o of d.options ?? [{ option_no: null, pol: null, pod: null, lines: d.lines, total: d.total }]) {
    if (o.option_no) add([`Option ${o.option_no}: ${[o.pol, o.pod].filter(Boolean).join(' → ')}`], bold);
    const head = add(['Description', 'Charged', 'Qty', `Rate (${d.currency})`, `Amount (${d.currency})`], bold);
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E7C7' } }; c.border = { bottom: { style: 'thin' } }; });
    for (const l of o.lines) {
      const r = add([l.description, l.unit_name, Number(l.quantity), Number(l.rate), Number(l.amount)]);
      r.getCell(3).numFmt = '#,##0.###'; r.getCell(4).numFmt = '#,##0.00'; r.getCell(5).numFmt = '#,##0.00';
    }
    const tot = add(['', '', '', o.option_no ? `Option ${o.option_no} total` : 'Total', Number(o.total)], bold);
    tot.getCell(5).numFmt = '#,##0.00'; tot.getCell(5).border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    add([]);
  }
  if (d.company.quote_vat_note) add([d.company.quote_vat_note], { italic: true });
  for (const [k, v] of [['Scope of service', d.scope], ['Exclusions', d.exclusions], ['Terms and conditions', d.terms], ['Payment / commercial conditions', d.payment_terms], ['Additional remarks', d.additional_remarks]] as const)
    if (v) { add([]); add([k], bold); for (const line of String(v).split('\n')) add([line]); }
  add([]); add([`Prepared by ${d.prepared_by}${d.prepared_by_email && !d.prepared_by_email.endsWith('.local') ? ` (${d.prepared_by_email})` : ''}`]);
  ws.getColumn(1).alignment = { wrapText: true, vertical: 'top' };
  return { body: Buffer.from(await wb.xlsx.writeBuffer()), name: `${d.quote_no}.xlsx` };
}
