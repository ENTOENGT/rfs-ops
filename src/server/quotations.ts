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
    })),
    totals: {
      ...(buyingView ? { cost_total: t.cost_total } : {}),
      ...(sellingView ? { sell_total: t.sell_total } : {}),
      ...(profitView ? { margin: t.margin, margin_pct: t.margin_pct } : {}),
    },
  };
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
  const editable = ['draft', 'pending_approval', 'approved'].includes(x.status) && actor.has('quotes.create');
  return { ...v, events, min_margin_pct: minMargin,
    can: { edit: editable, submit: x.status === 'draft' && actor.has('quotes.create'),
      approve: x.status === 'pending_approval' && actor.has('quotes.approve'),
      send: x.status === 'approved' && v.status !== 'expired' && actor.has('quotes.create'),
      accept: ['approved', 'sent'].includes(x.status) && v.status !== 'expired' && actor.has('quotes.create') && actor.has('jobfiles.create'),
      decline: ['approved', 'sent'].includes(x.status) && actor.has('quotes.create'),
      cancel: ['draft', 'pending_approval', 'approved', 'sent'].includes(x.status) && actor.has('quotes.create'),
      copy: actor.has('quotes.create') } };
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
function parseLines(actor: Actor, raw: unknown, old: any[]) {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) throw bad('Add at least one charge line');
  if (raw.length > 60) throw bad('Up to 60 lines per quotation');
  return raw.map((l: any, i) => {
    const description = txt(l?.description, 200);
    if (!description) throw bad(`Line ${i + 1}: describe the charge`);
    if (!CHARGE_UNITS.some((u) => u[0] === l.charge_unit)) throw bad(`Line ${i + 1}: choose how it is charged`);
    const qty = Number(l.quantity);
    if (!Number.isFinite(qty) || qty <= 0 || !/^\d+(\.\d{1,3})?$/.test(String(l.quantity).trim())) throw bad(`Line ${i + 1}: quantity must be more than 0 (up to 3 decimals)`);
    // People who can't see a side keep what is already there (matched by line id) — never overwrite blind.
    const prev = old.find((o) => o.id === l.id);
    const cost = actor.fin.buyingView ? money(l.cost_rate, `Line ${i + 1} cost rate`) : prev?.cost_rate ?? '0';
    const sell = actor.fin.sellingView ? money(l.sell_rate, `Line ${i + 1} selling rate`) : prev?.sell_rate ?? '0';
    return { description, charge_unit: l.charge_unit, quantity: String(l.quantity).trim(), cost_rate: cost, sell_rate: sell };
  });
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
    const dept = actor.department_side === 'operations' ? actor.department_id : null;
    const cols = Object.keys(vals);
    const x = await one(`insert into quotations (quote_no, department_id, created_by, currency${cols.map((k) => ', ' + k).join('')})
      values ('Q-' || nextval('quote_no_seq'), $1, $2, $3${cols.map((_, i) => `, $${i + 4}`).join('')}) returning id, quote_no`,
      [dept, actor.id, await getSetting('currency', 'AED', c), ...cols.map((k) => vals[k])], c);
    for (const [i, l] of lines.entries())
      await c.query('insert into quotation_lines (quotation_id, sort_order, description, charge_unit, quantity, cost_rate, sell_rate) values ($1,$2,$3,$4,$5,$6,$7)',
        [x.id, i, l.description, l.charge_unit, l.quantity, l.cost_rate, l.sell_rate]);
    await evt(c, actor, x.id, 'Quotation created', `${lines.length} line(s)`);
    await refreshSearch(c, x.id);
    return { id: x.id, quote_no: x.quote_no };
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
    if (sets.length) await c.query(`update quotations set ${sets.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`,
      [id, ...sets.map(([, v]) => v)]);
    if (lines) {
      await c.query('delete from quotation_lines where quotation_id = $1', [id]);
      for (const [i, l] of lines.entries())
        await c.query('insert into quotation_lines (quotation_id, sort_order, description, charge_unit, quantity, cost_rate, sell_rate) values ($1,$2,$3,$4,$5,$6,$7)',
          [id, i, l.description, l.charge_unit, l.quantity, l.cost_rate, l.sell_rate]);
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
        if (!actor.has('jobfiles.create')) throw forbidden('You need permission to create Job Files to accept a quotation');
        // The accepted quotation becomes a Job File. The Job No. is typed, as everywhere else.
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
