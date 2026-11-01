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
  if (actor.department_id) { params.push(actor.department_id); return ` and (${alias}.department_id = $${params.length} or ${alias}.created_by = ${me})`; }
  return ` and ${alias}.created_by = ${me}`;
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
    service_name: label(SERVICE_TYPES, x.service_type), direction_name: label(DIRECTIONS, x.direction),
    lines: lines.map((l, i) => ({
      id: l.id, description: l.description, charge_unit: l.charge_unit, unit_name: label(CHARGE_UNITS, l.charge_unit), quantity: l.quantity,
      ...(buyingView ? { cost_rate: l.cost_rate, cost_amount: t.each[i].cost } : {}),
      ...(sellingView ? { sell_rate: l.sell_rate, sell_amount: t.each[i].sell } : {}),
      ...(profitView ? { margin_type: l.margin_type, margin_value: l.margin_value } : {}),
      ...(buyingView ? { vendor_request_id: l.vendor_request_id } : {}),
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
      r.rate_group, v.name vendor_name
    from vendor_requests r join vendors v on v.id = r.vendor_id
    where r.job_file_id = $1 and r.quoted_cost is not null and r.status not in ('cancelled') order by r.created_at`, [jobFileId]);
  return markLowest(rows);
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
  else if (p.status) w += ` and x.status = ${add(p.status)}`;
  if (p.service_type) w += ` and x.service_type = ${add(p.service_type)}`;
  const size = Math.min(Math.max(Number(p.page_size) || 50, 1), 200), page = Math.max(Number(p.page) || 1, 1);
  const rows = await q(`select x.*, c.name customer_name, u.full_name created_by_name, f.job_no, count(*) over() _total
    from quotations x join customers c on c.id = x.customer_id join users u on u.id = x.created_by left join job_files f on f.id = x.job_file_id
    ${w} order by x.created_at desc limit ${size} offset ${(page - 1) * size}`, params);
  const lines = rows.length ? await q('select * from quotation_lines where quotation_id = any($1) order by sort_order', [rows.map((r) => r.id)]) : [];
  return { total: Number(rows[0]?._total ?? 0), page, page_size: size,
    rows: rows.map(({ _total, ...r }) => { const v = present(actor, r, lines.filter((l) => l.quotation_id === r.id)); delete (v as any).lines; return v; }) };
}

// ------------------------------------------------------------ one
export async function getQuotation(actor: Actor, id: string) {
  const x = await load(actor, id);
  const [extra, lines, events] = await Promise.all([
    one(`select c.name customer_name, u.full_name created_by_name, a.full_name approved_by_name, dep.name department_name, f.job_no
       from quotations x join customers c on c.id = x.customer_id join users u on u.id = x.created_by left join users a on a.id = x.approved_by
       left join departments dep on dep.id = x.department_id left join job_files f on f.id = x.job_file_id where x.id = $1`, [id]),
    q('select * from quotation_lines where quotation_id = $1 order by sort_order', [id]),
    q('select title, details, user_name, at from quotation_events where quotation_id = $1 order by at, id', [id]),
  ]);
  const v = present(actor, { ...x, ...extra }, lines);
  const minMargin = Number(await getSetting('quote_min_margin_pct', 10));
  const vendorRates = x.job_file_id && actor.fin.buyingView ? await vendorRatesFor(x.job_file_id) : [];
  const editable = ['draft', 'pending_approval', 'approved'].includes(x.status) && actor.has('quotes.create');
  const rateWarnings = actor.fin.buyingView ? await cheaperWarnings(lines) : [];
  return { ...v, events, min_margin_pct: minMargin, vendor_rates: vendorRates, rate_warnings: rateWarnings,
    can: { edit: editable, submit: x.status === 'draft' && actor.has('quotes.create'),
      approve: x.status === 'pending_approval' && actor.has('quotes.approve'),
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
};
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
    return { description, charge_unit: l.charge_unit, quantity: String(l.quantity).trim(), cost_rate: cost, sell_rate: sell, margin_type, margin_value, vendor_request_id };
  });
}

/** A cost line taken from a vendor rate must come from a vendor request on the same Job File. */
async function validateVendorLines(c: Db, jobFileId: string | null, lines: { vendor_request_id: string | null }[]) {
  const ids = [...new Set(lines.map((l) => l.vendor_request_id).filter((x): x is string => !!x))];
  if (!ids.length) return;
  if (!jobFileId) throw bad('Vendor rates can only be used on a quotation for their own Job No.');
  const ok = await q('select id from vendor_requests where id = any($1) and job_file_id = $2', [ids, jobFileId], c);
  if (ok.length !== ids.length) throw bad('A vendor rate on this quotation belongs to another Job No.');
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
    let dept = actor.department_side === 'operations' ? actor.department_id : null;
    // A quotation belongs to the Job No. of the enquiry (migration 017)
    if (b.job_file_id || b.job_no) {
      const { loadFile } = await import('./jobfiles');
      let fid = b.job_file_id;
      if (!fid) {
        const f = await one(`select id from job_files where upper(btrim(job_no)) = upper(btrim($1)) and deleted_at is null and status <> 'cancelled'`, [b.job_no], c);
        if (!f) throw bad(`No Job File with Job No. ${String(b.job_no).trim()}`);
        fid = f.id;
      }
      const f = await loadFile(actor, fid, c);
      if (['closed', 'cancelled'].includes(f.status)) throw bad(`Job File ${f.job_no} is ${f.status}`);
      if (f.customer_id !== vals.customer_id) throw bad(`Job File ${f.job_no} is for another customer`);
      vals.job_file_id = f.id;
      dept = f.department_id ?? dept;
      await validateVendorLines(c, f.id, lines);
    } else if (lines.some((l) => l.vendor_request_id)) throw bad('Vendor rates can only be used on a quotation for their own Job No.');
    const cols = Object.keys(vals);
    const x = await one(`insert into quotations (quote_no, department_id, created_by, currency${cols.map((k) => ', ' + k).join('')})
      values ('Q-' || nextval('quote_no_seq'), $1, $2, $3${cols.map((_, i) => `, $${i + 4}`).join('')}) returning id, quote_no`,
      [dept, actor.id, await getSetting('currency', 'AED', c), ...cols.map((k) => vals[k])], c);
    for (const [i, l] of lines.entries())
      await c.query(`insert into quotation_lines (quotation_id, sort_order, description, charge_unit, quantity, cost_rate, sell_rate, margin_type, margin_value, vendor_request_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [x.id, i, l.description, l.charge_unit, l.quantity, l.cost_rate, l.sell_rate, l.margin_type, l.margin_value, l.vendor_request_id]);
    await evt(c, actor, x.id, 'Quotation created', `${lines.length} line(s)`);
    if (vals.job_file_id) {
      const { event } = await import('./jobfiles');
      await event(c, actor, vals.job_file_id as string, { kind: 'link', title: `Quotation ${x.quote_no} prepared` });
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
    if (lines) await validateVendorLines(c, x.job_file_id, lines);
    if (sets.length && x.job_file_id && sets.some(([k, v]) => k === 'customer_id' && v !== x.customer_id))
      throw bad('This quotation is on a Job File; its customer is the Job File\'s customer');
    if (sets.length) await c.query(`update quotations set ${sets.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`,
      [id, ...sets.map(([, v]) => v)]);
    if (lines) {
      await c.query('delete from quotation_lines where quotation_id = $1', [id]);
      for (const [i, l] of lines.entries())
        await c.query(`insert into quotation_lines (quotation_id, sort_order, description, charge_unit, quantity, cost_rate, sell_rate, margin_type, margin_value, vendor_request_id)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, i, l.description, l.charge_unit, l.quantity, l.cost_rate, l.sell_rate, l.margin_type, l.margin_value, l.vendor_request_id]);
    }
    // a changed quotation must be checked again before it goes out
    if (x.status !== 'draft') {
      await c.query(`update quotations set status = 'draft', approved_by = null, approved_at = null where id = $1`, [id]);
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
        if (low && !actor.has('quotes.approve')) {
          await set('pending_approval');
          await evt(c, actor, id, 'Sent for approval', `Margin is below the ${min}% minimum`);
          await notifyApprovers(c, actor, x);
        } else {
          await set('approved', ', approved_by = $3, approved_at = now()', [actor.id]);
          await evt(c, actor, id, low ? 'Approved (by an approver, below the minimum margin)' : 'Approved — margin meets the minimum');
        }
        break;
      }
      case 'approve': need('quotes.approve'); from('pending_approval');
        await set('approved', ', approved_by = $3, approved_at = now(), decline_reason = null', [actor.id]);
        await evt(c, actor, id, 'Approved');
        await c.query('insert into notifications (user_id, type, title, quotation_id) values ($1,$2,$3,$4)', [x.created_by, 'quote.approved', `Quotation ${x.quote_no} approved`, id]);
        break;
      case 'reject_approval': {
        need('quotes.approve'); from('pending_approval');
        const reason = txt(b.reason, 500); if (!reason) throw bad('Say why it is not approved');
        await set('draft', ', decline_reason = $3', [reason]);
        await evt(c, actor, id, 'Not approved — back to draft', reason);
        await c.query('insert into notifications (user_id, type, title, quotation_id) values ($1,$2,$3,$4)', [x.created_by, 'quote.rejected', `Quotation ${x.quote_no} was not approved`, id]);
        break;
      }
      case 'send': need('quotes.create'); from('approved');
        if (expired) throw new ApiError(409, 'QUOTE_EXPIRED', 'The rates have expired. Change the validity date and approve again.');
        await set('sent', ', sent_at = now()'); await evt(c, actor, id, 'Marked as sent to the customer', txt(b.note, 300)); break;
      case 'accept': {
        need('quotes.create'); from('approved', 'sent');
        if (expired) throw new ApiError(409, 'QUOTE_EXPIRED', 'The rates have expired. Change the validity date and approve again.');
        if (x.job_file_id) {
          // The enquiry's own Job File goes live — same Job No. from enquiry to closing (migration 017)
          const f = await one('select id, job_no, status from job_files where id = $1 for update', [x.job_file_id], c);
          if (['closed', 'cancelled'].includes(f.status)) throw new ApiError(409, 'QUOTE_STATE', `Job File ${f.job_no} is ${f.status}`);
          const { event } = await import('./jobfiles');
          if (f.status === 'enquiry') await c.query(`update job_files set status = 'open', quotation_id = $2, updated_at = now() where id = $1`, [f.id, id]);
          else await c.query('update job_files set quotation_id = $2, updated_at = now() where id = $1', [f.id, id]);
          await event(c, actor, f.id, { kind: 'status', title: `Quotation ${x.quote_no} accepted by the customer`, field: 'Status',
            old_value: f.status === 'enquiry' ? 'Enquiry / quoting' : null, new_value: f.status === 'enquiry' ? 'Open — shipment confirmed' : null });
          // any other open quotation on the same Job No. is no longer needed
          const others = await q(`update quotations set status = 'cancelled', decline_reason = $3, updated_at = now()
            where job_file_id = $1 and id <> $2 and status in ('draft','pending_approval','approved','sent') returning id`,
            [f.id, id, `${x.quote_no} was accepted instead`], c);
          for (const o of others) await evt(c, actor, o.id, 'Cancelled', `${x.quote_no} was accepted instead`);
          await set('accepted', ', accepted_at = now()');
          await evt(c, actor, id, 'Accepted by the customer', `Job File ${f.job_no} is now open`);
          created = { id: f.id, job_no: f.job_no };
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
    q('select description, charge_unit, quantity, sell_rate from quotation_lines where quotation_id = $1 order by sort_order', [id]),
  ]);
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
    total: t.sell_total, scope: x.scope, exclusions: x.exclusions, terms: x.terms,
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
  const head = add(['Description', 'Charged', 'Qty', `Rate (${d.currency})`, `Amount (${d.currency})`], bold);
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E7C7' } }; c.border = { bottom: { style: 'thin' } }; });
  for (const l of d.lines) {
    const r = add([l.description, l.unit_name, Number(l.quantity), Number(l.rate), Number(l.amount)]);
    r.getCell(3).numFmt = '#,##0.###'; r.getCell(4).numFmt = '#,##0.00'; r.getCell(5).numFmt = '#,##0.00';
  }
  const tot = add(['', '', '', 'Total', Number(d.total)], bold);
  tot.getCell(5).numFmt = '#,##0.00'; tot.getCell(5).border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  add([]);
  if (d.company.quote_vat_note) add([d.company.quote_vat_note], { italic: true });
  for (const [k, v] of [['Scope of service', d.scope], ['Exclusions', d.exclusions], ['Terms and conditions', d.terms]] as const)
    if (v) { add([]); add([k], bold); for (const line of String(v).split('\n')) add([line]); }
  add([]); add([`Prepared by ${d.prepared_by}${d.prepared_by_email && !d.prepared_by_email.endsWith('.local') ? ` (${d.prepared_by_email})` : ''}`]);
  ws.getColumn(1).alignment = { wrapText: true, vertical: 'top' };
  return { body: Buffer.from(await wb.xlsx.writeBuffer()), name: `${d.quote_no}.xlsx` };
}
