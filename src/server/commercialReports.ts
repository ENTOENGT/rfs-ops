/**
 * Commercial reports (migration 024): Salesman performance, Coordinator performance, Enquiry tracking and Shipments by type.
 * Every row goes through the same scope as the Enquiries list (a Salesman / Coordinator sees only their own enquiries),
 * the period is the date the enquiry was opened, and money columns (shown in the company currency, converted with the
 * exchange rates in Settings) are dropped by the report engine for anyone who may not see selling prices or profit.
 */
import { Actor } from './auth';
import { q } from './db';
import { jfScope } from './jobfiles';
import { stageName, divisionName } from '../lib/commercialRules';
import { fxRate } from '../lib/currency';

/** The shipment types on the monthly sheet. */
export const SHIPMENT_TYPES = ['FCL Export', 'FCL Import', 'Air Export', 'Air Import', 'LCL Export', 'LCL Import', 'Cross Trade', 'Road Freight', 'Courier', 'Others'];
export function shipmentType(direction: string | null, mode: string | null) {
  if (mode === 'courier') return 'Courier';
  if (mode === 'other') return 'Others';
  if (mode === 'road') return 'Road Freight';
  if (direction === 'cross_trade') return 'Cross Trade';
  const m = mode === 'sea_fcl' ? 'FCL' : mode === 'sea_lcl' ? 'LCL' : mode === 'air' ? 'Air' : null;
  const d = direction === 'export' ? 'Export' : direction === 'import' ? 'Import' : null;
  return m && d ? `${m} ${d}` : 'Others';
}

const CONFIRMED = ['customer_confirmed', 'booking_requested', 'booking_confirmed', 'prealert_awaited', 'prealert_received', 'prealert_verified', 'handed_over'];
const OPEN = ['enquiry', 'rates_requested', 'rates_received', 'quotation_draft', 'pending_approval', 'sent_to_customer', ...CONFIRMED.slice(0, -1)];
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);

/** The enquiries in the period that this person may see, with what each report needs. */
async function enquiries(actor: Actor, p: Record<string, string>) {
  const params: unknown[] = [p.from, p.to];
  let w = `f.deleted_at is null and f.enquiry_ref is not null
    and (f.created_at at time zone 'Asia/Dubai')::date between $1 and $2${jfScope(actor, params)}`;
  const add = (sql: string, v: unknown) => { params.push(v); w += ` and ${sql.replace('?', `$${params.length}`)}`; };
  if (p.division) add('f.division = ?', p.division);
  if (p.mode) add('f.mode = ?', p.mode);
  if (p.customer_id) add('f.customer_id = ?', p.customer_id);
  if (p.salesman_id) add('f.salesman_id = ?', p.salesman_id);
  if (p.coordinator_id) add('f.coordinator_id = ?', p.coordinator_id);
  if (p.stage) add('f.stage = ?', p.stage);
  if (p.q?.trim()) add('f.search_text like ?', '%' + p.q.trim().toLowerCase() + '%');
  return q(`select f.id, f.enquiry_ref, f.shipping_ref, f.job_no, f.created_at, f.division, f.direction, f.mode, f.stage, f.cancel_reason,
      f.handed_over_at, f.updated_at, f.salesman_id, f.coordinator_id, c.name customer_name,
      coalesce(sm.full_name, '(no Salesman)') salesman_name, coalesce(co.full_name, '(no Coordinator)') coordinator_name,
      concat_ws(' → ', coalesce(f.port_of_loading, f.origin), coalesce(f.port_of_discharge, f.destination)) route,
      (select min(x.sent_at) from quotations x where x.job_file_id = f.id and x.deleted_at is null and x.sent_at is not null) first_sent,
      (select count(*)::int from vendor_requests v where v.job_file_id = f.id and v.status <> 'cancelled') rate_requests,
      (select count(*)::int from vendor_requests v where v.job_file_id = f.id and v.received_at is not null) rates_received,
      (select avg(extract(epoch from (v.received_at - v.created_at)) / 86400) from vendor_requests v where v.job_file_id = f.id and v.received_at is not null) agent_days,
      (case when f.bl_status in ('correction_required', 'correction_sent') then 1 else 0 end) bl_corrections,
      f.volume_cbm, f.gross_weight_kg, f.chargeable_weight_kg,
      (select count(*)::int from job_file_containers k where k.job_file_id = f.id and k.deleted_at is null) containers,
      (select coalesce(sum(case when k.size_type like '20%' then 1 when k.size_type is null then 0 else 2 end), 0)::int
         from job_file_containers k where k.job_file_id = f.id and k.deleted_at is null) teu,
      qa.quote_no, qa.currency, qa.sell, qa.cost, qa.status quote_status
    from job_files f join customers c on c.id = f.customer_id
      left join users sm on sm.id = f.salesman_id left join users co on co.id = f.coordinator_id
      left join lateral (
        select x.quote_no, x.currency, x.status,
          sum(l.quantity * l.sell_rate) filter (where l.route_id is null or x.selected_route_id is null or l.route_id = x.selected_route_id) sell,
          sum(l.quantity * l.cost_rate) filter (where l.route_id is null or x.selected_route_id is null or l.route_id = x.selected_route_id) cost
        from quotations x left join quotation_lines l on l.quotation_id = x.id
        where x.job_file_id = f.id and x.deleted_at is null
        group by x.id order by (x.status = 'accepted') desc, x.sent_at desc nulls last, x.created_at desc limit 1) qa on true
    where ${w} order by f.created_at desc`, params);
}

async function toCompany(rows: any[]) {
  const fx = Object.fromEntries((await q(`select key, value from settings where key like 'fx\\_%'`)).map((r) => [String(r.key).slice(3), r.value === null ? null : Number(r.value)]));
  const company = String((await q(`select value from settings where key = 'currency'`))[0]?.value ?? 'AED').replace(/"/g, '');
  return rows.map((r) => {
    const x = r.currency ? fxRate(r.currency, company, fx) : null;
    return { ...r, sell_c: r.sell != null && x ? Number(r.sell) * x : null, cost_c: r.cost != null && x ? Number(r.cost) * x : null };
  });
}
const won = (r: any) => CONFIRMED.includes(r.stage);
const quoted = (r: any) => !!r.first_sent || won(r) || r.stage === 'sent_to_customer';
const daysToQuote = (r: any) => (r.first_sent ? (new Date(r.first_sent).getTime() - new Date(r.created_at).getTime()) / 86400000 : null);
const money = (v: number) => Math.round(v * 100) / 100;
const sum = (rs: any[], k: string) => rs.reduce((s, r) => s + Number(r[k] ?? 0), 0);
/** "Price ×3; Transit time ×1" — why enquiries were not confirmed (lost / cancelled, with the reason typed). */
function reasons(rs: any[]) {
  const m = new Map<string, number>();
  for (const r of rs.filter((x) => x.stage === 'lost' || x.stage === 'cancelled')) {
    const k = String(r.cancel_reason ?? '').trim() || (r.stage === 'lost' ? 'No reason given' : 'Cancelled');
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join('; ') || null;
}
/** Volume of a set of enquiries: CBM, tonnes, containers / TEU. */
const volume = (rs: any[]) => ({ cbm: Math.round(sum(rs, 'volume_cbm') * 1000) / 1000, tonnes: Math.round(sum(rs, 'gross_weight_kg') / 10) / 100,
  containers: sum(rs, 'containers'), teu: sum(rs, 'teu') });

function finish(def: any, cols: any[], colsOut: any[], rows: any[], p: Record<string, string>, opts: { all?: boolean }, totals: any = null) {
  if (p.sort && cols.some((c: any) => c.key === p.sort)) {
    const k = p.sort, dir = p.dir === 'asc' ? 1 : -1, c = cols.find((x: any) => x.key === k);
    rows = [...rows].sort((a, b) => dir * (c.type === 'text' ? String(a[k] ?? '').localeCompare(String(b[k] ?? '')) : Number(a[k] ?? -1e15) - Number(b[k] ?? -1e15)));
  }
  const size = opts.all || def.kind !== 'commercial_rows' ? Math.max(rows.length, 1) : 50;
  const page = Math.max(1, Number(p.page) || 1);
  const keys = new Set(cols.map((c: any) => c.key));
  const strip = (r: any) => Object.fromEntries(Object.entries(r).filter(([k]) => keys.has(k)));
  return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut,
    rows: rows.slice((page - 1) * size, page * size).map(strip), totals: totals ? strip(totals) : null, total: rows.length, page, page_size: size,
    filters: Object.fromEntries(Object.entries(p).filter(([k, v]) => v && !['page', 'sort', 'dir', 'format', 'all'].includes(k))) };
}

export async function commercialReport(actor: Actor, def: any, cols: any[], colsOut: any[], p: Record<string, string>, opts: { all?: boolean }) {
  const all = await toCompany(await enquiries(actor, p));

  if (def.key === 'enquiry_tracking') {
    const now = Date.now();
    const rows = all.map((r) => ({
      enquiry_ref: r.enquiry_ref, created_at: r.created_at, division_name: divisionName(r.division), type: shipmentType(r.direction, r.mode),
      customer_name: r.customer_name, salesman_name: r.salesman_name, coordinator_name: r.coordinator_name, route: r.route,
      stage_name: stageName(r.stage), days_open: OPEN.includes(r.stage) ? Math.floor((now - new Date(r.created_at).getTime()) / 86400000) : null,
      days_to_quote: daysToQuote(r) === null ? null : Math.round(daysToQuote(r)! * 10) / 10, rate_requests: r.rate_requests,
      quote_no: r.quote_no, quote_total: r.sell_c === null ? null : money(r.sell_c), quote_profit: r.sell_c === null || r.cost_c === null ? null : money(r.sell_c - r.cost_c),
      volume_cbm: r.volume_cbm === null ? null : Number(r.volume_cbm), weight_kg: r.gross_weight_kg === null ? null : Number(r.gross_weight_kg),
      containers: r.containers || null,
      result: won(r) ? (r.stage === 'handed_over' ? 'Won — handed over' : 'Won') : r.stage === 'lost' ? `Lost${r.cancel_reason ? `: ${r.cancel_reason}` : ''}` : r.stage === 'cancelled' ? 'Cancelled' : 'Open',
      job_no: r.job_no && r.job_no !== r.enquiry_ref ? r.job_no : null, handed_over_at: r.handed_over_at,
    }));
    return finish({ ...def, kind: 'commercial_rows' }, cols, colsOut, rows, p, opts);
  }

  if (def.key === 'shipment_types') {
    const by = new Map(SHIPMENT_TYPES.map((t) => [t, [] as any[]]));
    for (const r of all) by.get(shipmentType(r.direction, r.mode))!.push(r);
    const line = (label: string, rs: any[]) => {
      const w = rs.filter(won), l = rs.filter((r) => r.stage === 'lost');
      const v = volume(w);
      return { type: label, enquiries: rs.length, quoted: rs.filter(quoted).length, confirmed: w.length, confirmed_pct: pct(w.length, rs.length),
        not_confirmed: rs.filter((r) => r.stage === 'lost' || r.stage === 'cancelled').length, lost_reasons: reasons(rs),
        won_cbm: v.cbm, won_tonnes: v.tonnes, won_teu: v.teu, handed_over: rs.filter((r) => r.stage === 'handed_over').length,
        lost: l.length, open: rs.filter((r) => OPEN.includes(r.stage) && !won(r)).length, win_pct: pct(w.length, w.length + l.length),
        won_sales: money(w.reduce((s, r) => s + (r.sell_c ?? 0), 0)), won_profit: money(w.reduce((s, r) => s + ((r.sell_c ?? 0) - (r.cost_c ?? 0)), 0)) };
    };
    const rows = SHIPMENT_TYPES.map((t) => line(t, by.get(t)!));
    return finish(def, cols, colsOut, rows, { ...p, sort: '' }, opts, line('Total', all));
  }

  // Salesman / Coordinator performance: one row per person
  const who = def.key === 'salesman_performance' ? 'salesman' : 'coordinator';
  const groups = new Map<string, any[]>();
  for (const r of all) { const k = r[`${who}_name`]; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const line = (name: string, rs: any[]) => {
    const w = rs.filter(won), l = rs.filter((r) => r.stage === 'lost'), qd = rs.filter(quoted);
    const dq = rs.map(daysToQuote).filter((x): x is number => x !== null);
    const ad = rs.map((r) => (r.agent_days === null ? null : Number(r.agent_days))).filter((x): x is number => x !== null);
    const v = volume(w), nc = rs.filter((r) => r.stage === 'lost' || r.stage === 'cancelled');
    return { name, enquiries: rs.length, confirmed_pct: pct(w.length, rs.length), not_confirmed: nc.length, lost_reasons: reasons(rs),
      won_cbm: v.cbm, won_tonnes: v.tonnes, won_containers: v.containers, won_teu: v.teu, rate_requests: rs.reduce((s, r) => s + r.rate_requests, 0), rates_received: rs.reduce((s, r) => s + r.rates_received, 0),
      agent_days: avg(ad), quoted: qd.length, days_to_quote: avg(dq),
      waiting_customer: rs.filter((r) => r.stage === 'sent_to_customer').length,
      waiting_approval: rs.filter((r) => r.stage === 'pending_approval').length,
      confirmed: w.length, booking_open: rs.filter((r) => ['customer_confirmed', 'booking_requested'].includes(r.stage)).length,
      bl_corrections: rs.reduce((s, r) => s + r.bl_corrections, 0), handed_over: rs.filter((r) => r.stage === 'handed_over').length,
      lost: l.length, open: rs.filter((r) => OPEN.includes(r.stage) && !won(r)).length,
      conversion_pct: pct(w.length, qd.length), win_pct: pct(w.length, w.length + l.length),
      won_sales: money(w.reduce((s, r) => s + (r.sell_c ?? 0), 0)), won_profit: money(w.reduce((s, r) => s + ((r.sell_c ?? 0) - (r.cost_c ?? 0)), 0)),
      margin_pct: (() => { const s = w.reduce((a, r) => a + (r.sell_c ?? 0), 0); return s ? Math.round(((s - w.reduce((a, r) => a + (r.cost_c ?? 0), 0)) / s) * 1000) / 10 : null; })() };
  };
  let rows = [...groups.entries()].map(([n, rs]) => line(n, rs));
  if (!p.sort) rows = rows.sort((a, b) => b.enquiries - a.enquiries);
  return finish(def, cols, colsOut, rows, p, opts, line('Total', all));
}
