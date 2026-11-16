/**
 * Release K (migration 026) — who handles a shipment in each team.
 *  - Default handlers are set once per team, optionally per customer: a job arriving in the team goes to them automatically.
 *  - Customer Service owns the shipment from the customer's confirmation to delivery. The CS Manager, the job's Coordinator or
 *    Salesman (or the Super Admin / Commercials Manager) can change the handler; the Salesman or Coordinator can keep it themselves.
 */
import { Actor } from './auth';
import { ApiError, Db, audit, forbidden, notFound, one, q, tx } from './db';

const bad = (m: string) => new ApiError(400, 'VALIDATION', m);
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const deptIdOf = async (db: Db, code: string) => (await one('select id from departments where code = $1', [code], db))?.id as string | undefined;

/** The default handler of a team for this customer (customer's own first, then the team's), if still active in that team. */
export async function defaultHandler(db: Db, deptCode: string, customerId: string | null) {
  const r = await one(`select h.user_id from default_handlers h join departments d on d.id = h.department_id
      join users u on u.id = h.user_id and u.is_active and u.deleted_at is null and u.department_id = h.department_id
     where d.code = $1 and (h.customer_id = $2 or h.customer_id is null)
     order by (h.customer_id is null) limit 1`, [deptCode, customerId], db);
  return (r?.user_id as string) ?? null;
}

/** The managers of a team (to hear about jobs nobody is set up to take). */
async function teamManagers(db: Db, deptCode: string) {
  return (await q(`select u.id from users u join roles r on r.id = u.role_id join departments d on d.id = u.department_id
     where d.code = $1 and r.is_manager and u.is_active and u.deleted_at is null`, [deptCode], db)).map((x) => x.id as string);
}

async function note(db: Db, actor: Actor | null, fileId: string, title: string, value: string | null, remarks: string | null) {
  const { jfEvent } = await import('./commercial');
  await jfEvent(db, actor, fileId, { kind: 'edit', title, field: 'Customer Service', new_value: value, remarks });
}

async function tell(db: Db, actor: Actor | null, fileId: string, users: string[], title: string) {
  for (const u of users) if (u && u !== actor?.id)
    await db.query(`insert into notifications (user_id, type, event, title, job_file_id, actor_name) values ($1, 'direct', 'assigned', $2, $3, $4)`,
      [u, title, fileId, actor?.full_name ?? 'System']);
}

/** Called when the customer confirms: the job goes to its default Customer Service handler, or waits for the CS Manager. */
export async function assignCsOnConfirm(db: Db, actor: Actor | null, fileId: string) {
  const f = await one('select id, customer_id, cs_handler_id, enquiry_ref, job_no from job_files where id = $1', [fileId], db);
  if (!f || f.cs_handler_id) return;
  const ref = f.job_no ?? f.enquiry_ref ?? 'Shipment';
  const who = await defaultHandler(db, 'customer_service', f.customer_id);
  if (who) {
    await db.query('update job_files set cs_handler_id = $2, cs_assigned_at = now() where id = $1', [fileId, who]);
    const n = (await one('select full_name from users where id = $1', [who], db))?.full_name ?? null;
    await note(db, actor, fileId, 'Given to Customer Service', n, 'Default handler');
    await tell(db, actor, fileId, [who], `${ref}: confirmed — you are the Customer Service handler`);
  } else {
    await tell(db, actor, fileId, await teamManagers(db, 'customer_service'), `${ref}: confirmed — choose a Customer Service handler`);
  }
}

/** Who may change the Customer Service handler of this job. */
export function canPickCs(actor: Actor, f: { salesman_id: string | null; coordinator_id: string | null; cs_handler_id: string | null }) {
  return actor.isSuperAdmin || actor.has('commercial.manage') || actor.id === f.coordinator_id || actor.id === f.salesman_id
    || actor.id === f.cs_handler_id || (actor.department_code === 'customer_service' && actor.has('users.manage_department'));
}

/** People who may be picked: active Customer Service staff, plus the job's own Salesman and Coordinator ("we keep it"). */
export async function csCandidates(db: Db, f: { salesman_id: string | null; coordinator_id: string | null }) {
  return q(`select u.id, u.full_name, case when u.id in ($1, $2) then 'This job''s ' || r.name else coalesce(g.name, r.name) end as note
      from users u join roles r on r.id = u.role_id left join departments d on d.id = u.department_id left join designations g on g.id = u.designation_id
     where u.is_active and u.deleted_at is null and (d.code = 'customer_service' or u.id in ($1, $2))
     order by (u.id in ($1, $2)) desc, u.full_name`, [f.salesman_id, f.coordinator_id], db);
}

export async function setCsHandler(actor: Actor, fileId: string, b: any) {
  return setHandler(actor, fileId, 'cs', b);
}

// ---------------------------------------------------------------- the default handlers list
/** The Super Admin sees every team; a department manager sees their own team. */
function teamScope(actor: Actor): string | null {
  if (actor.isSuperAdmin || actor.has('users.manage')) return null;
  if (actor.has('users.manage_department') && actor.department_id) return actor.department_id;
  throw forbidden();
}

export async function listDefaultHandlers(actor: Actor) {
  const dept = teamScope(actor);
  const p: unknown[] = dept ? [dept] : [];
  return {
    rows: await q(`select h.id, h.department_id, d.name department_name, h.customer_id, c.name customer_name, h.user_id, u.full_name user_name,
        u.is_active and u.department_id = h.department_id as valid, h.updated_at
      from default_handlers h join departments d on d.id = h.department_id join users u on u.id = h.user_id left join customers c on c.id = h.customer_id
      ${dept ? 'where h.department_id = $1' : ''} order by d.name, (h.customer_id is not null), c.name`, p),
    departments: await q(`select id, code, name from departments where is_active is not false ${dept ? 'and id = $1' : ''} and side = 'operations' order by name`, p),
    people: await q(`select u.id, u.full_name, u.department_id from users u where u.is_active and u.deleted_at is null and u.department_id is not null
      ${dept ? 'and u.department_id = $1' : ''} order by u.full_name`, p),
  };
}

export async function saveDefaultHandler(actor: Actor, b: any) {
  const dept = teamScope(actor);
  if (!isUuid(b.department_id) || (dept && b.department_id !== dept)) throw bad('Choose the team');
  if (!isUuid(b.user_id)) throw bad('Choose the handler');
  const cust = b.customer_id || null;
  if (cust && !isUuid(cust)) throw bad('Choose the customer');
  return tx(async (c) => {
    const u = await one('select full_name from users where id = $1 and department_id = $2 and is_active and deleted_at is null', [b.user_id, b.department_id], c);
    if (!u) throw bad('The handler must be an active member of that team');
    if (cust && !(await one('select 1 from customers where id = $1', [cust], c))) throw bad('Choose the customer');
    const cur = await one(`select h.id, x.full_name from default_handlers h join users x on x.id = h.user_id
      where h.department_id = $1 and h.customer_id is not distinct from $2`, [b.department_id, cust], c);
    if (cur) await c.query('update default_handlers set user_id = $2, updated_by = $3, updated_at = now() where id = $1', [cur.id, b.user_id, actor.id]);
    else await c.query('insert into default_handlers (department_id, customer_id, user_id, updated_by) values ($1,$2,$3,$4)', [b.department_id, cust, b.user_id, actor.id]);
    const d = await one('select name from departments where id = $1', [b.department_id], c);
    const cn = cust ? (await one('select name from customers where id = $1', [cust], c))?.name : null;
    await audit(c, actor, { entity_type: 'default_handler', entity_id: b.department_id, action: 'Default handler set',
      field: `${d.name}${cn ? ` — ${cn}` : ' — all customers'}`, old_value: cur?.full_name ?? null, new_value: u.full_name, sensitivity: 'admin' });
    return { ok: true };
  });
}

export async function removeDefaultHandler(actor: Actor, id: string) {
  const dept = teamScope(actor);
  if (!isUuid(id)) throw notFound('Default handler');
  return tx(async (c) => {
    const h = await one(`select h.*, d.name dn, u.full_name un, cu.name cn from default_handlers h join departments d on d.id = h.department_id
      join users u on u.id = h.user_id left join customers cu on cu.id = h.customer_id where h.id = $1`, [id], c);
    if (!h || (dept && h.department_id !== dept)) throw notFound('Default handler');
    await c.query('delete from default_handlers where id = $1', [id]);
    await audit(c, actor, { entity_type: 'default_handler', entity_id: h.department_id, action: 'Default handler removed',
      field: `${h.dn}${h.cn ? ` — ${h.cn}` : ' — all customers'}`, old_value: h.un, sensitivity: 'admin' });
    return { ok: true };
  });
}


// ================================================================ Step 7: Operations and Documentation
const ACTIVE_STAGES = ['customer_confirmed', 'booking_requested', 'booking_confirmed', 'prealert_awaited', 'prealert_received', 'prealert_verified', 'handed_over'];

/** The team a shipment goes to at handover: exact direction + mode first, then the direction's "any mode" line. */
export async function routeFor(db: Db, direction: string | null, mode: string | null) {
  const r = await one(`select h.department_id, d.code from handover_routes h join departments d on d.id = h.department_id
     where h.direction = $1 and (h.mode = $2 or h.mode is null) order by (h.mode is null) limit 1`, [direction ?? 'import', mode], db);
  return r as { department_id: string; code: string } | null;
}

async function nameOf(db: Db, id: string | null) { return id ? (await one('select full_name from users where id = $1', [id], db))?.full_name ?? null : null; }

/** Called at handover: the job moves to its Operations team and to that team's default handler (or waits for the manager). */
export async function routeOnHandover(db: Db, actor: Actor | null, fileId: string) {
  const f = await one('select id, direction, mode, customer_id, job_no, enquiry_ref, ops_handler_id, job_type from job_files where id = $1', [fileId], db);
  if (!f) return;
  if (f.job_type === 'clearance_delivery') {               // straight to Documentation
    const d = await one(`select id from departments where code = 'documentations'`, [], db);
    await db.query('update job_files set department_id = $2 where id = $1', [fileId, d.id]);
    return startClearance(db, actor as Actor, fileId, null, false);
  }
  const r = await routeFor(db, f.direction, f.mode);
  if (!r) return;
  const who = f.ops_handler_id ?? await defaultHandler(db, r.code, f.customer_id);
  await db.query('update job_files set department_id = $2, ops_handler_id = $3, ops_assigned_at = case when $3::uuid is null then null else now() end where id = $1',
    [fileId, r.department_id, who]);
  const team = (await one('select name from departments where id = $1', [r.department_id], db)).name;
  const { jfEvent } = await import('./commercial');
  await jfEvent(db, actor, fileId, { kind: 'edit', title: `Sent to ${team}`, field: 'Operations', new_value: [team, await nameOf(db, who)].filter(Boolean).join(' — '),
    remarks: who ? 'Default handler' : 'Waiting for the team manager to choose the handler' });
  const ref = f.job_no ?? f.enquiry_ref ?? 'Shipment';
  if (who) await tell(db, actor, fileId, [who], `${ref}: handed over — you are the ${team} handler`);
  else await tell(db, actor, fileId, await teamManagers(db, r.code), `${ref}: handed over to ${team} — choose the handler`);
}

type Kind = 'cs' | 'ops' | 'docs';
const KIND: Record<Kind, { col: string; at: string; label: string; team: (f: any) => Promise<string | null> }> = {
  cs: { col: 'cs_handler_id', at: 'cs_assigned_at', label: 'Customer Service', team: async () => 'customer_service' },
  ops: { col: 'ops_handler_id', at: 'ops_assigned_at', label: 'Operations', team: async (f) => f.department_code },
  docs: { col: 'docs_handler_id', at: 'docs_assigned_at', label: 'Documentation', team: async () => 'documentations' },
};

/** Who may choose a job's handler for each part. */
export function canPick(actor: Actor, kind: Kind, f: any) {
  if (kind === 'cs') return canPickCs(actor, f);
  const mgr = actor.isSuperAdmin || actor.has('users.manage');
  if (kind === 'ops') return f.stage === 'handed_over' && (mgr || actor.id === f.ops_handler_id || actor.id === f.cs_handler_id
    || (actor.has('users.manage_department') && !!actor.department_id && actor.department_id === f.department_id));
  return (!!f.do_received_at || f.job_type === 'clearance_delivery') && (mgr || actor.id === f.docs_handler_id
    || (actor.has('users.manage_department') && actor.department_code === 'documentations'));
}

/** People who may be picked for a part: that team's active members (Customer Service also allows the job's Salesman / Coordinator). */
export async function candidates(db: Db, kind: Kind, f: any) {
  if (kind === 'cs') return csCandidates(db, f);
  if (kind === 'docs' && f.job_type === 'clearance_delivery') return q(   // Documentation + the job's Salesman / Coordinator
    `select u.id, u.full_name, case when u.id in ($1, $2) then 'This job''s ' || r.name else coalesce(g.name, r.name) end note
        from users u join roles r on r.id = u.role_id left join departments d on d.id = u.department_id left join designations g on g.id = u.designation_id
       where u.is_active and u.deleted_at is null and (d.code = 'documentations' or u.id in ($1, $2)) order by (u.id in ($1, $2)) desc, u.full_name`,
      [f.salesman_id ?? null, f.coordinator_id ?? null], db);
  const code = await KIND[kind].team(f);
  return q(`select u.id, u.full_name, coalesce(g.name, r.name) note from users u join roles r on r.id = u.role_id join departments d on d.id = u.department_id
      left join designations g on g.id = u.designation_id where u.is_active and u.deleted_at is null and d.code = $1 order by u.full_name`, [code], db);
}

async function fileWithTeam(actor: Actor, fileId: string, c: Db) {
  const { loadFile } = await import('./jobfiles');
  const f: any = await loadFile(actor, fileId, c, true);
  f.department_code = (await one('select code from departments where id = $1', [f.department_id], c))?.code ?? null;
  return f;
}

export async function setHandler(actor: Actor, fileId: string, kind: Kind, b: any) {
  if (!KIND[kind]) throw notFound('Part');
  return tx(async (c) => {
    const f = await fileWithTeam(actor, fileId, c);
    if (kind === 'cs' && !ACTIVE_STAGES.includes(f.stage)) throw new ApiError(409, 'STAGE', 'Customer Service takes the job once the customer has confirmed');
    if (kind === 'ops' && f.stage !== 'handed_over') throw new ApiError(409, 'STAGE', 'Operations takes the job at handover');
    if (kind === 'docs' && !f.do_received_at && f.job_type !== 'clearance_delivery') throw new ApiError(409, 'STAGE', 'Documentation takes the job once the DO is received');
    if (!canPick(actor, kind, f)) throw forbidden(`You cannot choose the ${KIND[kind].label} handler of this job`);
    const to = b.user_id || null;
    if (!isUuid(to)) throw bad(`Choose the ${KIND[kind].label} handler`);
    const k = KIND[kind];
    if (to === f[k.col]) throw bad('Nothing changed');
    if (!(await candidates(c, kind, f)).some((x: any) => x.id === to))
      throw bad(kind === 'cs' ? 'Choose someone from Customer Service, or this job\'s Salesman / Coordinator' : `Choose someone from the ${k.label} team`);
    const reason = String(b.reason ?? '').trim().slice(0, 500) || null;
    if (f[k.col] && !reason) throw bad('Give a reason for changing the handler');
    const was = await nameOf(c, f[k.col]), now = await nameOf(c, to);
    await c.query(`update job_files set ${k.col} = $2, ${k.at} = now(), updated_at = now() where id = $1`, [fileId, to]);
    const { jfEvent } = await import('./commercial');
    await jfEvent(c, actor, fileId, { kind: 'edit', title: f[k.col] ? `${k.label} handler changed` : `Given to ${k.label}`,
      field: k.label, old_value: was, new_value: now, remarks: reason });
    await tell(c, actor, fileId, [to, f[k.col]].filter(Boolean) as string[], `${f.job_no ?? f.enquiry_ref ?? 'Shipment'}: ${k.label} handler is now ${now}`);
    return { ok: true, id: to, name: now };
  });
}

/** Ops: the DO is in hand → the job goes to Documentation (its default handler, or the Documentation Manager chooses). */
export async function doReceived(actor: Actor, fileId: string, b: any) {
  return tx(async (c) => {
    const f = await fileWithTeam(actor, fileId, c);
    if (f.stage !== 'handed_over') throw new ApiError(409, 'STAGE', 'The job is not with Operations yet');
    if (f.job_type === 'clearance_delivery') throw new ApiError(409, 'STAGE', 'A Clearance & Delivery job is with Documentation from the start');
    if (f.do_received_at) throw new ApiError(409, 'STAGE', 'The DO is already recorded as received');
    if (!(canPick(actor, 'ops', f) || actor.has('jobfiles.edit') && actor.department_id === f.department_id)) throw forbidden('Only the Operations team of this job can record the DO');
    const who = await defaultHandler(c, 'documentations', f.customer_id);
    await c.query(`update job_files set do_received_at = now(), docs_handler_id = coalesce(docs_handler_id, $2),
      docs_assigned_at = case when coalesce(docs_handler_id, $2) is null then null else now() end, updated_at = now() where id = $1`, [fileId, who]);
    const { jfEvent } = await import('./commercial');
    const note = String(b.note ?? '').trim().slice(0, 500) || null;
    await jfEvent(c, actor, fileId, { kind: 'status', title: 'DO received — sent to Documentation', field: 'Documentation', new_value: await nameOf(c, who), remarks: note });
    const ref = f.job_no ?? f.enquiry_ref ?? 'Shipment';
    if (who) await tell(c, actor, fileId, [who], `${ref}: DO received — you are the Documentation handler`);
    else await tell(c, actor, fileId, await teamManagers(c, 'documentations'), `${ref}: DO received — choose the Documentation handler`);
    await tell(c, actor, fileId, [f.cs_handler_id].filter(Boolean), `${ref}: DO received, now with Documentation`);
    return { ok: true };
  });
}

/** Documentation: cleared → back to Ops for collection and delivery. */
export async function docsCleared(actor: Actor, fileId: string, b: any) {
  return tx(async (c) => {
    const f = await fileWithTeam(actor, fileId, c);
    if (!f.do_received_at && f.job_type !== 'clearance_delivery') throw new ApiError(409, 'STAGE', 'Documentation has not started on this job');
    if (f.docs_cleared_at) throw new ApiError(409, 'STAGE', 'Already cleared');
    if (!canPick(actor, 'docs', f)) throw forbidden('Only the Documentation handler or manager can mark the job cleared');
    await c.query('update job_files set docs_cleared_at = now(), updated_at = now() where id = $1', [fileId]);
    const { jfEvent } = await import('./commercial');
    await jfEvent(c, actor, fileId, { kind: 'status', title: 'Cleared — back to Operations for collection and delivery', remarks: String(b.note ?? '').trim().slice(0, 500) || null });
    await tell(c, actor, fileId, [f.ops_handler_id, f.cs_handler_id, f.job_type === 'clearance_delivery' ? f.salesman_id : null].filter(Boolean),
      `${f.job_no ?? f.enquiry_ref ?? 'Shipment'}: cleared — arrange collection and delivery`);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- the routing list (Super Admin)
export async function listRoutes(actor: Actor) {
  if (!actor.isSuperAdmin && !actor.has('users.manage') && !actor.has('users.manage_department')) throw forbidden();
  return {
    rows: await q(`select h.id, h.direction, h.mode, h.department_id, d.name department_name from handover_routes h join departments d on d.id = h.department_id
      order by h.direction, (h.mode is null), h.mode`),
    departments: await q(`select id, name from departments where side = 'operations' and is_active order by name`),
    editable: actor.isSuperAdmin || actor.has('users.manage'),
  };
}
export async function saveRoute(actor: Actor, b: any) {
  if (!actor.isSuperAdmin && !actor.has('users.manage')) throw forbidden();
  if (!['import', 'export', 'cross_trade', 'domestic'].includes(b.direction)) throw bad('Choose the direction');
  const { MODES } = await import('../lib/jobfileRules');
  const mode = b.mode || null;
  if (mode && !MODES.some(([k]: any) => k === mode)) throw bad('Choose the mode');
  if (!isUuid(b.department_id)) throw bad('Choose the team');
  return tx(async (c) => {
    const d = await one(`select name from departments where id = $1 and side = 'operations' and is_active`, [b.department_id], c);
    if (!d) throw bad('Choose an Operations team');
    const cur = await one(`select h.id, x.name from handover_routes h join departments x on x.id = h.department_id where h.direction = $1 and h.mode is not distinct from $2`, [b.direction, mode], c);
    if (cur) await c.query('update handover_routes set department_id = $2, updated_by = $3, updated_at = now() where id = $1', [cur.id, b.department_id, actor.id]);
    else await c.query('insert into handover_routes (direction, mode, department_id, updated_by) values ($1,$2,$3,$4)', [b.direction, mode, b.department_id, actor.id]);
    await audit(c, actor, { entity_type: 'handover_route', entity_id: b.department_id, action: 'Handover route set', field: `${b.direction} / ${mode ?? 'any mode'}`,
      old_value: cur?.name ?? null, new_value: d.name, sensitivity: 'admin' });
    return listRoutes(actor);
  });
}

// ================================================================ Step 8: Clearance & Delivery jobs
/** A new direct Clearance & Delivery job: to the person it is given to (Documentation, or its Salesman / Coordinator), else Documentation's default. */
export async function startClearance(db: Db, actor: Actor, fileId: string, handlerId?: string | null, keepIfOpener = true) {
  const f = await one('select id, customer_id, salesman_id, coordinator_id, job_no from job_files where id = $1', [fileId], db);
  let who: string | null = null;
  if (handlerId) {
    if (!isUuid(handlerId) || !(await candidates(db, 'docs', { ...f, job_type: 'clearance_delivery' })).some((x: any) => x.id === handlerId))
      throw bad('Give the job to someone in Documentation, or to its Salesman / Coordinator');
    who = handlerId;
  } else if (keepIfOpener && (actor.role_code === 'sales' || actor.department_code === 'documentations')) who = actor.id;   // they keep the work they open
  who = who ?? await defaultHandler(db, 'documentations', f.customer_id);
  await db.query('update job_files set docs_handler_id = $2, docs_assigned_at = case when $2::uuid is null then null else now() end where id = $1', [fileId, who]);
  const { jfEvent } = await import('./commercial');
  await jfEvent(db, actor, fileId, { kind: 'edit', title: 'Clearance & Delivery job — given to Documentation', field: 'Documentation', new_value: await nameOf(db, who) });
  if (who && who !== actor.id) await tell(db, actor, fileId, [who], `${f.job_no}: Clearance & Delivery job — you are the handler`);
  if (!who) await tell(db, actor, fileId, await teamManagers(db, 'documentations'), `${f.job_no}: new Clearance & Delivery job — choose the handler`);
}
