/**
 * Release K step 9 — "My performance": every user's own numbers for a period, by week (up to 3 months) or by month, with the
 * measures that fit their team. Managers open the same page for anyone in their team. Prices and profit only for those who may see them.
 */
import { Actor } from './auth';
import { ApiError, forbidden, notFound, one, q } from './db';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const round = (n: number | null, d = 1) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const money = (n: number) => Math.round(n * 100) / 100;
const OPS_DEPTS = ['sea_import', 'sea_export', 'air_import', 'air_export', 'lcl', 'cross_trade', 'operations', 'ecom', 'warehouse'];

type Card = { key: string; label: string; value: number | string | null; hint?: string; money?: boolean; tone?: 'ok' | 'warn' | 'danger' };
export type Kind = 'commercial' | 'cs' | 'ops' | 'docs' | 'transport' | 'general';
export const KIND_NAMES: Record<Kind, string> = { commercial: 'Commercials', cs: 'Customer Service', ops: 'Operations', docs: 'Documentation', transport: 'Transport', general: 'General' };

/** Which kind of measures fit this person. */
export function kindOf(u: { role_code: string; dept_code: string | null; dept_side: string | null }): Kind {
  if (['sales', 'coordinator', 'commercials_manager', 'agent_coordinator'].includes(u.role_code) || u.dept_code === 'commercial') return 'commercial';
  if (u.dept_code === 'customer_service') return 'cs';
  if (u.dept_code === 'documentations') return 'docs';
  if (u.dept_side === 'transport' || u.dept_side === 'messenger' || ['driver', 'dispatcher', 'transport', 'transport_manager'].includes(u.role_code)) return 'transport';
  if (u.dept_code && OPS_DEPTS.includes(u.dept_code)) return 'ops';
  return 'general';
}

/** Whose numbers the viewer may open: their own; their team (any level); their department (department managers); everyone (Super Admin). */
async function canView(viewer: Actor, target: any) {
  if (target.id === viewer.id || viewer.isSuperAdmin || viewer.has('users.manage')) return true;
  if (viewer.has('users.manage_department') && viewer.department_id && viewer.department_id === target.department_id) return true;
  return !!(await one('select 1 from user_team($1) t where t = $2', [viewer.id, target.id]));
}

/** Week buckets (Monday) for up to ~3 months, month buckets beyond. */
function buckets(from: string, to: string) {
  const days = (Date.parse(to) - Date.parse(from)) / 864e5;
  const unit = days <= 93 ? 'week' : 'month';
  const out: string[] = [];
  const d = new Date(from + 'T00:00:00Z');
  if (unit === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  else d.setUTCDate(1);
  while (d.toISOString().slice(0, 10) <= to && out.length < 60) {
    out.push(d.toISOString().slice(0, 10));
    if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7); else d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return { unit, keys: out };
}
const bucketOf = (iso: string | Date | null, unit: string) => {
  if (!iso) return null;
  const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  if (unit === 'week') x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); else x.setUTCDate(1);
  return x.toISOString().slice(0, 10);
};
const inPeriod = (iso: string | Date | null, from: string, to: string) => {
  if (!iso) return false;
  const day = new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  return day >= from && day <= to;
};
const avgDays = (pairs: [any, any][]) => {
  const v = pairs.filter(([a, b]) => a && b).map(([a, b]) => (new Date(b).getTime() - new Date(a).getTime()) / 864e5).filter((x) => x >= 0);
  return v.length ? round(v.reduce((s, x) => s + x, 0) / v.length) : null;
};

export async function performance(viewer: Actor, p: Record<string, string>) {
  if (!DATE.test(p.from ?? '') || !DATE.test(p.to ?? '')) throw new ApiError(400, 'VALIDATION', 'Choose a period');
  if (p.to < p.from) throw new ApiError(400, 'VALIDATION', 'The end date is before the start date');
  const id = p.user_id || viewer.id;
  if (!isUuid(id)) throw notFound('Person');
  const u = await one(`select u.id, u.full_name, u.department_id, r.code role_code, r.name role_name, d.code dept_code, d.name dept_name, d.side dept_side,
      (select g.name from designations g where g.id = u.designation_id) designation
    from users u join roles r on r.id = u.role_id left join departments d on d.id = u.department_id where u.id = $1 and u.deleted_at is null`, [id]);
  if (!u) throw notFound('Person');
  if (!(await canView(viewer, u))) throw forbidden('You can see your own performance and your team\'s');
  const kind = kindOf(u);
  const { unit, keys } = buckets(p.from, p.to);
  const series: Record<string, number>[] = keys.map((k) => ({}));
  const bump = (iso: any, name: string, by = 1) => { const b = bucketOf(iso, unit); const i = b ? keys.indexOf(b) : -1; if (i >= 0) series[i][name] = (series[i][name] ?? 0) + by; };
  let cards: Card[] = [], lines: { key: string; label: string }[] = [], rows: any[] = [], cols: { key: string; label: string }[] = [];

  if (kind === 'commercial') {
    const cr = await import('./commercialReports');
    const f: Record<string, string> = { from: p.from, to: p.to };
    if (u.role_code === 'coordinator') f.coordinator_id = u.id; else if (u.role_code !== 'commercials_manager') f.salesman_id = u.id;
    const list = await cr.toCompany(await cr.enquiries(viewer, f));
    const w = list.filter(cr.won), qd = list.filter(cr.quoted), lost = list.filter((r: any) => ['lost', 'cancelled'].includes(r.stage));
    const sales = w.reduce((s: number, r: any) => s + (r.sell_c ?? 0), 0), cost = w.reduce((s: number, r: any) => s + (r.cost_c ?? 0), 0);
    cards = [
      { key: 'enquiries', label: 'Enquiries', value: list.length },
      { key: 'quoted', label: 'Quoted', value: qd.length },
      { key: 'confirmed', label: 'Confirmed', value: w.length, tone: 'ok' },
      { key: 'lost', label: 'Lost / cancelled', value: lost.length, tone: lost.length ? 'danger' : undefined },
      { key: 'rate', label: 'Confirmed %', value: list.length ? `${round((w.length / list.length) * 100)}%` : '—', hint: qd.length ? `${round((w.length / qd.length) * 100)}% of quoted` : undefined },
      { key: 'volume', label: 'Volume confirmed', value: `${round(w.reduce((s: number, r: any) => s + Number(r.volume_cbm ?? 0), 0))} CBM`, hint: `${w.reduce((s: number, r: any) => s + Number(r.teu ?? 0), 0)} TEU` },
    ];
    if (viewer.fin.sellingView) cards.push({ key: 'sales', label: 'Sales confirmed', value: money(sales), money: true });
    if (viewer.fin.profitView) cards.push({ key: 'profit', label: 'Profit confirmed', value: money(sales - cost), money: true, tone: sales - cost < 0 ? 'danger' : 'ok' });
    for (const r of list) { bump(r.created_at, 'enquiries'); if (cr.won(r)) bump(r.created_at, 'confirmed'); }
    lines = [{ key: 'enquiries', label: 'Enquiries' }, { key: 'confirmed', label: 'Confirmed' }];
    const reasons = new Map<string, number>();
    for (const r of lost) reasons.set(r.cancel_reason || 'No reason given', (reasons.get(r.cancel_reason || 'No reason given') ?? 0) + 1);
    if (reasons.size) cards.push({ key: 'reasons', label: 'Why not confirmed', value: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ×${n}`).join(' · ') });
    cols = [{ key: 'ref', label: 'Enquiry' }, { key: 'date', label: 'Date' }, { key: 'customer', label: 'Customer' }, { key: 'route', label: 'Route' }, { key: 'stage', label: 'Stage' },
      ...(viewer.fin.sellingView ? [{ key: 'sell', label: 'Sales (company currency)' }] : []), ...(viewer.fin.profitView ? [{ key: 'profit', label: 'Profit' }] : [])];
    const { stageName } = await import('../lib/commercialRules');
    rows = list.map((r: any) => ({ ref: r.job_no ?? r.enquiry_ref, date: String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at).slice(0, 10),
      customer: r.customer_name, route: r.route, stage: stageName(r.stage), sell: r.sell_c === null ? null : money(r.sell_c),
      profit: r.sell_c === null || r.cost_c === null ? null : money(r.sell_c - r.cost_c) }));
  } else if (kind === 'cs' || kind === 'ops' || kind === 'docs') {
    const col = { cs: 'cs_handler_id', ops: 'ops_handler_id', docs: 'docs_handler_id' }[kind];
    const at = { cs: 'cs_assigned_at', ops: 'ops_assigned_at', docs: 'docs_assigned_at' }[kind];
    const list = await q(`select f.id, f.job_no, f.enquiry_ref, f.status, f.stage, f.confirmed_at, f.handed_over_at, f.closed_at, f.ata, f.do_received_at, f.docs_cleared_at,
        f.${at} assigned_at, c.name customer_name, concat_ws(' → ', coalesce(f.port_of_loading, f.origin), coalesce(f.port_of_discharge, f.destination)) route
      from job_files f join customers c on c.id = f.customer_id where f.deleted_at is null and f.${col} = $1
        and ((f.${at} at time zone 'Asia/Dubai')::date <= $3 and (f.status not in ('closed', 'cancelled') or (coalesce(f.closed_at, f.updated_at) at time zone 'Asia/Dubai')::date >= $2))
      order by f.${at} desc`, [u.id, p.from, p.to]);
    const given = list.filter((r) => inPeriod(r.assigned_at, p.from, p.to));
    const open = list.filter((r) => !['closed', 'cancelled'].includes(r.status) && !(kind === 'docs' && r.docs_cleared_at));
    const closed = list.filter((r) => inPeriod(r.closed_at, p.from, p.to));
    if (kind === 'cs') {
      const ho = list.filter((r) => inPeriod(r.handed_over_at, p.from, p.to));
      cards = [{ key: 'given', label: 'Shipments given to me', value: given.length }, { key: 'handed', label: 'Handed over to Operations', value: ho.length, tone: 'ok' },
        { key: 'closed', label: 'Closed (delivered)', value: closed.length }, { key: 'open', label: 'Open now', value: open.length, tone: open.length ? 'warn' : undefined },
        { key: 'days', label: 'Average days, confirmed → handover', value: avgDays(ho.map((r) => [r.confirmed_at, r.handed_over_at])) }];
      for (const r of given) bump(r.assigned_at, 'given'); for (const r of ho) bump(r.handed_over_at, 'done');
      lines = [{ key: 'given', label: 'Given to me' }, { key: 'done', label: 'Handed over' }];
    } else if (kind === 'ops') {
      const dos = list.filter((r) => inPeriod(r.do_received_at, p.from, p.to));
      cards = [{ key: 'given', label: 'Jobs given to me', value: given.length }, { key: 'do', label: 'DOs received', value: dos.length, tone: 'ok' },
        { key: 'closed', label: 'Closed (delivered)', value: closed.length }, { key: 'open', label: 'Open now', value: open.length, tone: open.length ? 'warn' : undefined },
        { key: 'days', label: 'Average days, arrival → DO', value: avgDays(dos.map((r) => [r.ata ?? r.assigned_at, r.do_received_at])) },
        { key: 'days2', label: 'Average days, handover → closed', value: avgDays(closed.map((r) => [r.handed_over_at, r.closed_at])) }];
      for (const r of given) bump(r.assigned_at, 'given'); for (const r of dos) bump(r.do_received_at, 'done');
      lines = [{ key: 'given', label: 'Given to me' }, { key: 'done', label: 'DO received' }];
    } else {
      const cleared = list.filter((r) => inPeriod(r.docs_cleared_at, p.from, p.to));
      cards = [{ key: 'given', label: 'Jobs given to me', value: given.length }, { key: 'cleared', label: 'Cleared', value: cleared.length, tone: 'ok' },
        { key: 'open', label: 'Waiting to clear', value: open.length, tone: open.length ? 'warn' : undefined },
        { key: 'days', label: 'Average days to clear', value: avgDays(cleared.map((r) => [r.assigned_at ?? r.do_received_at, r.docs_cleared_at])) }];
      for (const r of given) bump(r.assigned_at, 'given'); for (const r of cleared) bump(r.docs_cleared_at, 'done');
      lines = [{ key: 'given', label: 'Given to me' }, { key: 'done', label: 'Cleared' }];
    }
    cols = [{ key: 'ref', label: 'Job' }, { key: 'date', label: 'Given on' }, { key: 'customer', label: 'Customer' }, { key: 'route', label: 'Route' }, { key: 'state', label: 'Where it is' }];
    rows = list.map((r) => ({ ref: r.job_no ?? r.enquiry_ref, date: r.assigned_at ? new Date(r.assigned_at).toISOString().slice(0, 10) : '', customer: r.customer_name, route: r.route,
      state: r.status === 'closed' ? 'Closed' : r.docs_cleared_at ? 'Cleared' : r.do_received_at ? 'With Documentation' : r.stage === 'handed_over' ? 'With Operations' : 'Booking / pre-alert' }));
  } else if (kind === 'transport') {
    const driver = u.role_code === 'driver';
    const list = await q(`select t.id, t.job_no, t.completed_at, t.cancelled_at, t.pod_status, a.planned_delivery_at, a.actual_delivery_at, c.name customer_name,
        concat_ws(' → ', t.pickup_name, t.delivery_name) route
      from transport_requests t join transport_assignments a on a.job_id = t.id and a.is_current left join customers c on c.id = t.customer_id
      where t.deleted_at is null and a.${driver ? 'driver_id' : 'assigned_by'} = $1 and (coalesce(t.completed_at, a.assigned_at) at time zone 'Asia/Dubai')::date between $2 and $3
      order by coalesce(t.completed_at, a.assigned_at) desc`, [u.id, p.from, p.to]);
    const done = list.filter((r) => r.completed_at);
    const onTime = done.filter((r) => r.actual_delivery_at && r.planned_delivery_at && new Date(r.actual_delivery_at) <= new Date(r.planned_delivery_at));
    const pod = done.filter((r) => ['uploaded', 'verified'].includes(r.pod_status));
    cards = [{ key: 'trips', label: driver ? 'Trips done' : 'Trips arranged and done', value: done.length, tone: 'ok' },
      { key: 'ontime', label: 'On time', value: done.length ? `${round((onTime.length / done.length) * 100)}%` : '—' },
      { key: 'pod', label: 'POD received', value: done.length ? `${pod.length} of ${done.length}` : '—', tone: pod.length < done.length ? 'warn' : undefined },
      { key: 'cancelled', label: 'Cancelled', value: list.filter((r) => r.cancelled_at).length }];
    for (const r of done) bump(r.completed_at, 'done');
    lines = [{ key: 'done', label: 'Trips done' }];
    cols = [{ key: 'ref', label: 'Job No.' }, { key: 'date', label: 'Completed' }, { key: 'customer', label: 'Customer' }, { key: 'route', label: 'Route' }, { key: 'state', label: 'POD' }];
    rows = list.map((r) => ({ ref: r.job_no, date: r.completed_at ? new Date(r.completed_at).toISOString().slice(0, 10) : 'Not done', customer: r.customer_name, route: r.route, state: r.pod_status }));
  } else {
    const n = await one(`select count(*)::int n from audit_log where user_id = $1 and (occurred_at at time zone 'Asia/Dubai')::date between $2 and $3`, [u.id, p.from, p.to]).catch(() => ({ n: null }));
    cards = [{ key: 'actions', label: 'Actions recorded', value: n?.n ?? null }];
  }

  // migration 026: a department's own profit, where it has cost and selling (only for people who may see both)
  let department: any = null;
  if (viewer.fin.profitView && u.department_id && kind !== 'commercial') {
    try {
      const f: any = await (await import('./financials')).financials(viewer, { from: p.from, to: p.to });
      department = f.by_department.find((r: any) => r.key === u.department_id || r.label === u.dept_name) ?? null;
    } catch { department = null; }
  }

  const team = await q(`select u.id, u.full_name from users u where u.is_active and u.deleted_at is null and (u.id = $1
      or u.id in (select user_team($1)) or ($2::boolean and u.department_id = $3::uuid) or $4::boolean) order by (u.id = $1) desc, u.full_name`,
    [viewer.id, viewer.has('users.manage_department'), viewer.department_id, viewer.isSuperAdmin || viewer.has('users.manage')]);
  return {
    person: { id: u.id, name: u.full_name, role: u.role_name, department: u.dept_name, designation: u.designation, kind, kind_name: KIND_NAMES[kind] },
    period: { from: p.from, to: p.to, unit }, cards, lines,
    series: keys.map((k, i) => ({ key: k, ...Object.fromEntries(lines.map((l) => [l.key, series[i][l.key] ?? 0])) })),
    columns: cols, rows: rows.slice(0, 500), department, people: team,
  };
}

/** The same numbers as an Excel workbook: Summary, By week / month, and the job list. */
export async function performanceXlsx(viewer: Actor, p: Record<string, string>) {
  const r = await performance(viewer, p);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const head = (ws: any) => { ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F6' } }; };
  const s = wb.addWorksheet('Summary');
  s.addRow([`Performance — ${r.person.name}`]).font = { bold: true, size: 14 };
  s.addRow([[r.person.designation, r.person.role, r.person.department].filter(Boolean).join(' · ')]);
  s.addRow([`Period: ${r.period.from} to ${r.period.to}`]);
  s.addRow([]);
  s.addRow(['Measure', 'Value']).font = { bold: true };
  for (const c of r.cards) s.addRow([c.label, c.value]);
  if (r.department) { s.addRow([]); s.addRow([`Department: ${r.department.label}`]).font = { bold: true };
    for (const [k, v] of Object.entries(r.department)) if (!['key', 'label', 'color'].includes(k)) s.addRow([k.replace(/_/g, ' '), v]); }
  s.getColumn(1).width = 34; s.getColumn(2).width = 40;
  const t = wb.addWorksheet(r.period.unit === 'week' ? 'By week' : 'By month');
  t.addRow([r.period.unit === 'week' ? 'Week starting' : 'Month', ...r.lines.map((l) => l.label)]); head(t);
  for (const row of r.series) t.addRow([row.key, ...r.lines.map((l) => (row as any)[l.key])]);
  t.columns.forEach((c: any) => { c.width = 18; });
  if (r.columns.length) {
    const j = wb.addWorksheet('Jobs');
    j.addRow(r.columns.map((c) => c.label)); head(j);
    for (const row of r.rows) j.addRow(r.columns.map((c) => row[c.key]));
    j.columns.forEach((c: any) => { c.width = 22; });
  }
  const name = `performance-${r.person.name.toLowerCase().replace(/\W+/g, '-')}-${r.period.from}-to-${r.period.to}.xlsx`;
  return { body: Buffer.from(await wb.xlsx.writeBuffer()), name, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}
