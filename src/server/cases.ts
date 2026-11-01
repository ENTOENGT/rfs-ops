/**
 * Customer service cases (migration 016): enquiries and complaints for a customer, optionally on a Job File.
 *
 * SLA: each priority has a number of hours to resolve (Settings → cs_sla_hours). The clock stops while the case
 * waits for the customer and the due time moves on by that pause. A case not resolved by its due time is overdue;
 * overdue cases are escalated once to people with cases.escalations (checked during normal use, like PRO reminders).
 *
 * Visibility: cases.view_all → all; otherwise own department's, plus cases they raised or own.
 */
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, getSetting, notFound, one, q, tx } from './db';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const CASE_STATUS: Record<string, [string, string]> = {
  open: ['Open', '#B7791F'], in_progress: ['In progress', '#2B6CB0'], waiting_customer: ['Waiting for customer', '#5B6B82'],
  resolved: ['Resolved', '#2F855A'], closed: ['Closed', '#22543D'],
};
export const CASE_KINDS: Record<string, string> = { enquiry: 'Enquiry', complaint: 'Complaint', delay: 'Delay', damage: 'Damage / loss', documents: 'Documents', other: 'Other' };
export const CASE_CHANNELS: Record<string, string> = { phone: 'Phone', email: 'Email', whatsapp: 'WhatsApp', walk_in: 'Walk-in', portal: 'Portal', other: 'Other' };
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const ACTIVE = ['open', 'in_progress', 'waiting_customer'];

export const canSeeCases = (a: Actor) => a.isSuperAdmin || a.has('cases.view_all') || a.has('cases.manage');
function scope(actor: Actor, params: unknown[], alias = 'k') {
  if (actor.isSuperAdmin || actor.has('cases.view_all')) return '';
  params.push(actor.id);
  const me = `$${params.length}`;
  if (actor.department_id) { params.push(actor.department_id); return ` and (${alias}.department_id = $${params.length} or ${alias}.created_by = ${me} or ${alias}.owner_id = ${me})`; }
  return ` and (${alias}.created_by = ${me} or ${alias}.owner_id = ${me})`;
}
async function load(actor: Actor, id: string, db?: Db, lock = false) {
  if (!canSeeCases(actor)) throw forbidden();
  if (!isUuid(id)) throw notFound('Case');
  const p: unknown[] = [id];
  const k = await one(`select k.* from cs_cases k where k.id = $1${scope(actor, p)}${lock ? ' for update of k' : ''}`, p, db);
  if (!k) throw notFound('Case');
  return k;
}
async function evt(db: Db, actor: Actor | null, id: string, title: string, details?: string | null) {
  await db.query('insert into cs_case_events (case_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)',
    [id, title, details ?? null, actor?.id ?? null, actor?.full_name ?? 'System']);
}
const txt = (v: unknown, max = 200) => { const t = String(v ?? '').trim(); if (t.length > max) throw bad(`Value too long (max ${max} characters)`); return t || null; };
async function slaHours(priority: string, db?: Db) {
  const s = await getSetting<Record<string, number>>('cs_sla_hours', { urgent: 4, high: 8, normal: 24, low: 72 }, db);
  return Number(s[priority] ?? 24);
}
async function notify(db: Db, userIds: (string | null)[], title: string, caseId: string, exclude?: string) {
  for (const u of [...new Set(userIds.filter((x): x is string => !!x && x !== exclude))])
    await db.query('insert into notifications (user_id, type, title, case_id) values ($1,$2,$3,$4)', [u, 'case', title, caseId]);
}

const LIST = `select k.id, k.case_no, k.subject, k.kind, k.priority, k.status, k.channel, k.due_at, k.created_at, k.resolved_at, k.first_response_at,
    c.name customer_name, f.job_no, k.job_file_id, o.full_name owner_name, k.owner_id,
    (k.status in ('open','in_progress') and k.due_at < now()) overdue
  from cs_cases k join customers c on c.id = k.customer_id left join job_files f on f.id = k.job_file_id left join users o on o.id = k.owner_id`;
const shape = (r: any) => ({ ...r, status_name: CASE_STATUS[r.status][0], status_color: CASE_STATUS[r.status][1], kind_name: CASE_KINDS[r.kind] });

export async function listCases(actor: Actor, p: Record<string, string>) {
  if (!canSeeCases(actor)) throw forbidden();
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let w = 'where true' + scope(actor, params);
  if (p.status === 'active') w += ` and k.status in ('open','in_progress','waiting_customer')`;
  else if (p.status === 'overdue') w += ` and k.status in ('open','in_progress') and k.due_at < now()`;
  else if (p.status) w += ` and k.status = ${add(p.status)}`;
  if (p.mine === '1') w += ` and k.owner_id = ${add(actor.id)}`;
  for (const [key, col] of Object.entries({ customer_id: 'k.customer_id', owner_id: 'k.owner_id', job_file_id: 'k.job_file_id' }))
    if (p[key]) { if (!isUuid(p[key])) throw bad('Invalid filter'); w += ` and ${col} = ${add(p[key])}`; }
  if (p.kind) w += ` and k.kind = ${add(p.kind)}`;
  if (p.q?.trim()) { const v = add('%' + p.q.trim().toLowerCase() + '%'); w += ` and (lower(k.case_no) like ${v} or lower(k.subject) like ${v} or lower(c.name) like ${v} or lower(coalesce(f.job_no,'')) like ${v})`; }
  const rows = await q(`${LIST} ${w} order by k.status in ('resolved','closed'), k.due_at limit 500`, params);
  const cp: unknown[] = [];
  const counts = await one(`select count(*) filter (where k.status in ('open','in_progress','waiting_customer'))::int active,
      count(*) filter (where k.status in ('open','in_progress') and k.due_at < now())::int overdue,
      count(*) filter (where k.status in ('open','in_progress','waiting_customer') and k.owner_id is null)::int unassigned
    from cs_cases k where true${scope(actor, cp)}`, cp);
  return { rows: rows.map(shape), counts };
}

export async function getCase(actor: Actor, id: string) {
  const k = await load(actor, id);
  const [extra, events] = await Promise.all([
    one(`select c.name customer_name, f.job_no, o.full_name owner_name, u.full_name created_by_name, d.name department_name
       from cs_cases k join customers c on c.id = k.customer_id left join job_files f on f.id = k.job_file_id left join users o on o.id = k.owner_id
       join users u on u.id = k.created_by left join departments d on d.id = k.department_id where k.id = $1`, [id]),
    q('select title, details, user_name, at from cs_case_events where case_id = $1 order by at, id', [id]),
  ]);
  const manage = actor.isSuperAdmin || actor.has('cases.manage');
  return { ...shape({ ...k, ...extra, overdue: ['open', 'in_progress'].includes(k.status) && new Date(k.due_at) < new Date() }),
    channel_name: CASE_CHANNELS[k.channel], events, can: { manage } };
}

export async function createCase(actor: Actor, b: any) {
  if (!actor.isSuperAdmin && !actor.has('cases.manage')) throw forbidden();
  if (!isUuid(b.customer_id)) throw bad('Choose the customer');
  const subject = txt(b.subject, 200);
  if (!subject) throw bad('Write a short subject');
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  if (b.kind && !CASE_KINDS[b.kind]) throw bad('Choose the type');
  if (b.channel && !CASE_CHANNELS[b.channel]) throw bad('Choose how the customer contacted us');
  return tx(async (c) => {
    if (!(await one('select 1 from customers where id = $1 and deleted_at is null', [b.customer_id], c))) throw bad('Customer not found');
    let fileId: string | null = null;
    if (b.job_no?.trim()) {
      const f = await one(`select id, customer_id from job_files where upper(btrim(job_no)) = upper(btrim($1)) and deleted_at is null and status <> 'cancelled'`, [b.job_no], c);
      if (!f) throw bad(`No Job File with Job No. ${String(b.job_no).trim()}`);
      fileId = f.id;
    }
    let owner: string | null = null;
    if (b.owner_id) {
      if (!isUuid(b.owner_id) || !(await one(`select 1 from users where id = $1 and is_active and deleted_at is null and user_has_perm(id, 'cases.manage')`, [b.owner_id], c)))
        throw bad('Choose someone who works on cases');
      owner = b.owner_id;
    }
    const hours = await slaHours(priority, c);
    const k = await one(`insert into cs_cases (case_no, customer_id, job_file_id, department_id, contact_name, contact_detail, channel, kind, priority, subject, description,
        owner_id, due_at, created_by)
      values ('CS-' || nextval('cs_case_no_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' hours')::interval, $13) returning id, case_no`,
      [b.customer_id, fileId, actor.department_side === 'operations' ? actor.department_id : null, txt(b.contact_name, 120), txt(b.contact_detail, 120),
       b.channel ?? 'phone', b.kind ?? 'enquiry', priority, subject, txt(b.description, 4000), owner, String(hours), actor.id], c);
    await evt(c, actor, k.id, 'Case opened', `${priority} priority — resolve within ${hours} hours`);
    if (owner) await notify(c, [owner], `Case ${k.case_no} assigned to you`, k.id, actor.id);
    return k;
  });
}

/** One door for every change: assign, status, note, priority. */
export async function caseAction(actor: Actor, id: string, b: any) {
  if (!actor.isSuperAdmin && !actor.has('cases.manage')) throw forbidden();
  await tx(async (c) => {
    const k = await load(actor, id, c, true);
    const what = String(b.what ?? '');
    const respond = async () => { if (!k.first_response_at) await c.query('update cs_cases set first_response_at = now() where id = $1', [id]); };
    if (what === 'assign') {
      if (!isUuid(b.owner_id) || !(await one(`select full_name from users where id = $1 and is_active and deleted_at is null and user_has_perm(id, 'cases.manage')`, [b.owner_id], c)))
        throw bad('Choose someone who works on cases');
      const u = await one('select full_name from users where id = $1', [b.owner_id], c);
      await c.query('update cs_cases set owner_id = $2, updated_at = now() where id = $1', [id, b.owner_id]);
      await evt(c, actor, id, 'Assigned', u.full_name);
      await notify(c, [b.owner_id], `Case ${k.case_no} assigned to you`, id, actor.id);
    } else if (what === 'note') {
      const note = txt(b.note, 2000);
      if (!note) throw bad('Write the note');
      await respond();
      await evt(c, actor, id, b.to_customer ? 'Reply to customer' : 'Note', note);
    } else if (what === 'priority') {
      if (!PRIORITIES.includes(b.priority)) throw bad('Choose the priority');
      const hours = await slaHours(b.priority, c);
      await c.query(`update cs_cases set priority = $2, due_at = created_at + ($3 || ' hours')::interval, escalated_at = null, updated_at = now() where id = $1`, [id, b.priority, String(hours)]);
      await evt(c, actor, id, 'Priority changed', `${k.priority} → ${b.priority} (resolve within ${hours} hours of opening)`);
    } else if (what === 'status') {
      const to = String(b.status ?? '');
      if (!CASE_STATUS[to]) throw bad('Choose the status');
      if (to === k.status) return;
      if (k.status === 'closed') throw new ApiError(409, 'CASE_CLOSED', 'This case is closed. Open a new case if the customer comes back.');
      let sql = 'status = $2, updated_at = now()';
      const params: unknown[] = [id, to];
      // the SLA clock stops while waiting for the customer: the due time moves on by the pause
      if (k.status === 'waiting_customer' && k.waiting_since) sql += `, due_at = due_at + (now() - waiting_since), waiting_since = null`;
      if (to === 'waiting_customer') sql += ', waiting_since = now()';
      if (to === 'resolved') {
        const res = txt(b.resolution, 2000);
        if (!res) throw bad('Write how it was resolved');
        params.push(res); sql += `, resolved_at = now(), resolution = $${params.length}`;
      }
      if (to === 'closed' && k.status !== 'resolved') throw bad('Resolve the case first, then close it');
      if (['open', 'in_progress', 'waiting_customer'].includes(to) && ['resolved'].includes(k.status)) sql += ', resolved_at = null';
      await c.query(`update cs_cases set ${sql} where id = $1`, params);
      if (to !== 'open') await respond();
      await evt(c, actor, id, `Status: ${CASE_STATUS[to][0]}`, to === 'resolved' ? String(b.resolution).trim() : txt(b.note, 500));
      if (to === 'resolved' && k.created_by !== actor.id) await notify(c, [k.created_by], `Case ${k.case_no} resolved`, id);
    } else throw bad('Unknown action');
  });
  return getCase(actor, id);
}

/** Overdue cases go to the people who receive escalations, once per case. Run during normal use. */
export async function runCaseEscalations() {
  await tx(async (c) => {
    const due = await q(`select id, case_no, owner_id from cs_cases where status in ('open','in_progress') and due_at < now() and escalated_at is null for update skip locked`, [], c);
    if (!due.length) return;
    const bosses = await q<{ id: string }>(`select u.id from users u join roles r on r.id = u.role_id where u.is_active and u.deleted_at is null
      and r.code <> 'super_admin' and user_has_perm(u.id, 'cases.escalations')`, [], c);
    for (const k of due) {
      await notify(c, [...bosses.map((u) => u.id), k.owner_id], `Case ${k.case_no} is overdue`, k.id);
      await c.query('update cs_cases set escalated_at = now() where id = $1', [k.id]);
      await evt(c, null, k.id, 'Escalated — past its due time');
    }
  });
}

export async function casesReport(actor: Actor, def: any, cols: any[], colsOut: any[], p: Record<string, string>, opts: { all?: boolean }) {
  if (!canSeeCases(actor)) throw forbidden();
  const params: unknown[] = [];
  let w = 'where true' + scope(actor, params);
  if (p.from && p.to) { params.push(p.from, p.to); w += ` and (k.created_at at time zone 'Asia/Dubai')::date between $${params.length - 1} and $${params.length}`; }
  if (p.customer_id) { if (!isUuid(p.customer_id)) throw bad('Invalid filter'); params.push(p.customer_id); w += ` and k.customer_id = $${params.length}`; }
  if (p.status) { params.push(p.status); w += ` and k.status = $${params.length}`; }
  const size = opts.all ? 50000 : Math.min(Math.max(Number(p.page_size) || 100, 1), 500), page = opts.all ? 1 : Math.max(Number(p.page) || 1, 1);
  const rows = await q(`select k.case_no, k.created_at, c.name customer_name, f.job_no, k.kind, k.priority, k.subject, o.full_name owner_name, k.status,
      round(extract(epoch from (k.first_response_at - k.created_at)) / 3600, 1) response_hours,
      round(extract(epoch from (k.resolved_at - k.created_at)) / 3600, 1) resolution_hours,
      (coalesce(k.resolved_at, now()) > k.due_at) sla_breached, k.due_at, count(*) over() _total
    from cs_cases k join customers c on c.id = k.customer_id left join job_files f on f.id = k.job_file_id left join users o on o.id = k.owner_id
    ${w} order by k.created_at desc limit ${size} offset ${(page - 1) * size}`, params);
  const shaped = rows.map(({ _total, ...r }) => Object.fromEntries(cols.map((col: any) => [col.key,
    col.key === 'status' ? CASE_STATUS[r.status][0] : col.key === 'kind' ? CASE_KINDS[r.kind] : col.key === 'sla_breached' ? (r.sla_breached ? 'Yes' : 'No') : r[col.key]])));
  return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped, totals: null,
    total: Number(rows[0]?._total ?? 0), page, page_size: size, filters: p };
}
export { ACTIVE as CASE_ACTIVE };
