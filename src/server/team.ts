/**
 * Users, roles and departments — for the Super Admin (everything) and for
 * department managers (their own department only).
 *
 * Rules a manager can never get around (all checked here, on the server):
 *  - sees and edits only users of their own department; never managers or Super Admins; never themselves
 *  - cannot move anyone to another department
 *  - assigns only non-manager roles meant for their side, or roles of their own department
 *  - can hand out only permissions they have themselves, never admin-type ones
 *    (so a Transport manager can't give anyone the selling price — and the database
 *     refuses it for Transport/Messenger departments anyway)
 *  - creates and edits roles for their own department only, under the same limit
 */
import { randomBytes } from 'crypto';
import { Actor, hashPassword, phoneKey, validatePassword } from './auth';
import { ApiError, audit, bad, forbidden, notFound, one, pool, q, tx } from './db';
import { NO_SELLING_SIDES } from '../lib/permissions';
import type { Side } from '../lib/permissions';

const UUID = /^[0-9a-f-]{36}$/i;
const SIDES: Side[] = ['admin', 'operations', 'transport', 'messenger', 'finance', 'pro', 'warehouse'];
export const SIDE_LABEL: Record<Side, string> = {
  admin: 'Administration', operations: 'Operations', transport: 'Transport', messenger: 'Messengers', finance: 'Finance', pro: 'PRO', warehouse: 'Warehouse',
};

type Scope = { all: true } | { all: false; deptId: string; deptName: string; side: Side; team?: boolean; roleId?: string };
function scopeFor(actor: Actor, full: 'users.manage' | 'roles.manage', dept: 'users.manage_department' | 'roles.manage_department'): Scope {
  if (actor.has(full)) return { all: true };
  if (actor.has(dept) && actor.department_id && actor.department_side)
    return { all: false, deptId: actor.department_id, deptName: actor.department_name!, side: actor.department_side, roleId: actor.role_id };
  throw forbidden();
}
export const userScope = (a: Actor): Scope => {
  // migration 025: a Team Leader with only "Manage my team" works on the people below them, inside their own department
  if (!a.has('users.manage') && !a.has('users.manage_department') && a.has('users.manage_team') && a.department_id && a.department_side)
    return { all: false, deptId: a.department_id, deptName: a.department_name!, side: a.department_side, team: true, roleId: a.role_id };
  return scopeFor(a, 'users.manage', 'users.manage_department');
};
const inTeam = async (actor: Actor, id: string, db?: any) => !!(await one('select 1 from user_team($1) t where t = $2', [actor.id, id], db));
const roleScope = (a: Actor) => scopeFor(a, 'roles.manage', 'roles.manage_department');

/** Permissions this person may hand out to others. */
async function grantable(actor: Actor, scope: Scope) {
  const all = await q<{ code: string; module: string; name: string; sensitivity: string; action: string }>(
    'select code, module, name, sensitivity, action from permissions order by module, code');
  return scope.all ? all : all.filter((p) => actor.perms.has(p.code as any) && p.sensitivity !== 'admin');
}

async function assignableRoles(scope: Scope) {
  // retired roles (Customer Service, migration 020) are kept for history but can't be given any more
  if (scope.all) return q(`select r.id, r.code, r.name, r.side, r.department_id, r.is_manager, r.app_only from roles r where r.retired_at is null
    order by r.is_manager desc, r.name`);
  // migration 025: shared roles only when the Super Admin lets the manager's role give them (no list set = as before);
  // roles made for the manager's own department can always be given
  return q(`select r.id, r.code, r.name, r.side, r.department_id, r.is_manager, r.app_only from roles r
    where r.code <> 'super_admin' and not r.is_manager and r.retired_at is null
      and (r.department_id = $1 or (r.department_id is null and r.side = $2
        and (not exists (select 1 from role_assignable_roles a where a.role_id = $3)
             or exists (select 1 from role_assignable_roles a where a.role_id = $3 and a.assignable_role_id = r.id))))
    order by r.name`, [scope.deptId, scope.side, scope.roleId ?? null]);
}

async function checkRoleFits(roleId: unknown, deptId: unknown, scope: Scope, db = pool() as any) {
  if (typeof roleId !== 'string' || !UUID.test(roleId)) throw bad('Choose a role');
  const role = await one('select id, code, name, side, department_id, is_manager, app_only from roles where id = $1', [roleId], db);
  if (!role) throw bad('Choose a role');
  if (!scope.all) {
    const ok = (await assignableRoles(scope)).some((r: any) => r.id === role.id);
    if (!ok) throw forbidden(`You can't give the ${role.name} role`);
  }
  if (role.code === 'super_admin') return { role, dept: null };
  if (typeof deptId !== 'string' || !UUID.test(deptId)) throw bad('Choose a department');
  const dept = await one('select id, name, side, is_active from departments where id = $1', [deptId], db);
  if (!dept || !dept.is_active) throw bad('Choose a department');
  if (role.side && role.side !== dept.side)
    throw bad(`${role.name} is a ${SIDE_LABEL[role.side as Side]} role, but ${dept.name} is on the ${SIDE_LABEL[dept.side as Side]} side.`);
  if (role.department_id && role.department_id !== dept.id) throw bad(`${role.name} belongs to another department.`);
  return { role, dept };
}

const tempPassword = () => randomBytes(9).toString('base64url') + '7a';
async function activeSuperAdmins(excluding: string) {
  return Number((await one(`select count(*) n from users u join roles r on r.id = u.role_id
    where r.code = 'super_admin' and u.is_active and u.deleted_at is null and u.id <> $1`, [excluding]))!.n);
}

// ---------------------------------------------------------------- Commercials: division + Salesman → Coordinator
export const DIVISIONS: [string, string][] = [['imports', 'Imports'], ['exports', 'Exports'], ['cross_trade', 'Cross Trade']];
const NEEDS_DIVISION = ['sales', 'coordinator'];

/**
 * Division (Imports / Exports / Cross Trade) and, for a Salesman, the dedicated Coordinator.
 * Every change is kept in user_assignments with who, when and why.
 */
async function setCommercialFields(c: any, actor: Actor, userId: string, cur: any, b: any, roleCode: string) {
  const div = b.division !== undefined ? (b.division || null) : (cur?.division ?? null);
  if (div !== null && !DIVISIONS.some(([d]) => d === div)) throw bad('Choose the division: Imports, Exports or Cross Trade');
  if (!div && NEEDS_DIVISION.includes(roleCode)) throw bad('Choose the division (Imports, Exports or Cross Trade)');
  let coord = b.coordinator_id !== undefined ? (b.coordinator_id || null) : (cur?.coordinator_id ?? null);
  if (roleCode !== 'sales') coord = null;                       // only Salesmen have a dedicated Coordinator
  if (coord) {
    if (!UUID.test(coord) || coord === userId) throw bad('Choose the Coordinator');
    const k = await one(`select u.id from users u join roles r on r.id = u.role_id where u.id = $1 and r.code = 'coordinator' and u.is_active and u.deleted_at is null`, [coord], c);
    if (!k) throw bad('The Coordinator must be an active user with the Coordinator role');
  }
  const reason = String(b.assignment_reason ?? '').trim().slice(0, 500) || null;
  const name = async (id: string | null) => id ? (await one('select full_name from users where id = $1', [id], c))?.full_name ?? null : null;
  const label = (d: string | null) => DIVISIONS.find(([x]) => x === d)?.[1] ?? null;
  if (div !== (cur?.division ?? null)) {
    await c.query('update users set division = $2 where id = $1', [userId, div]);
    await c.query(`insert into user_assignments (user_id, field, old_value, new_value, old_label, new_label, reason, changed_by, changed_by_name)
      values ($1,'division',$2,$3,$4,$5,$6,$7,$8)`, [userId, cur?.division ?? null, div, label(cur?.division ?? null), label(div), reason, actor.id, actor.full_name]);
  }
  if (coord !== (cur?.coordinator_id ?? null)) {
    if (cur && cur.coordinator_id && !reason && b.coordinator_id !== undefined && roleCode === 'sales')
      throw bad('Give a reason for changing the Coordinator');
    await c.query('update users set coordinator_id = $2 where id = $1', [userId, coord]);
    await c.query(`insert into user_assignments (user_id, field, old_value, new_value, old_label, new_label, reason, changed_by, changed_by_name)
      values ($1,'coordinator',$2,$3,$4,$5,$6,$7,$8)`, [userId, cur?.coordinator_id ?? null, coord, await name(cur?.coordinator_id ?? null), await name(coord), reason, actor.id, actor.full_name]);
  }
}

/**
 * Migration 025 — who the person reports to and their job title. Every change is kept in user_assignments (who, when, why)
 * and in the audit log. The database itself refuses loops and lines deeper than 12 levels.
 * A department manager may only pick themselves, someone of their department, or someone in their team.
 */
async function setReporting(c: any, actor: Actor, scope: Scope, userId: string, cur: any, b: any) {
  const reason = String(b.assignment_reason ?? '').trim().slice(0, 500) || null;
  const hist = (field: string, o: string | null, n: string | null, ol: string | null, nl: string | null) =>
    c.query(`insert into user_assignments (user_id, field, old_value, new_value, old_label, new_label, reason, changed_by, changed_by_name)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [userId, field, o, n, ol, nl, reason, actor.id, actor.full_name]);
  if (b.designation_id !== undefined) {
    const des = b.designation_id || null;
    if (des !== (cur?.designation_id ?? null)) {
      let label: string | null = null;
      if (des) {
        if (!UUID.test(des)) throw bad('Choose the designation');
        const g = await one('select name from designations where id = $1 and is_active', [des], c);
        if (!g) throw bad('Choose the designation');
        label = g.name;
      }
      const old = cur?.designation_id ? (await one('select name from designations where id = $1', [cur.designation_id], c))?.name ?? null : null;
      await c.query('update users set designation_id = $2, updated_at = now() where id = $1', [userId, des]);
      await hist('designation', cur?.designation_id ?? null, des, old, label);
      await audit(c, actor, { entity_type: 'user', entity_id: userId, action: 'User updated', field: 'designation', old_value: old, new_value: label, sensitivity: 'admin' });
    }
  }
  // a Team Leader's new people report to them unless they say otherwise
  const wanted = b.manager_id !== undefined ? (b.manager_id || null) : (!cur && !scope.all && scope.team ? actor.id : undefined);
  if (wanted === undefined || wanted === (cur?.manager_id ?? null)) return;
  if (wanted) {
    if (!UUID.test(wanted)) throw bad('Choose who they report to');
    if (wanted === userId) throw bad('A person cannot report to themselves');
    const m = await one('select id, full_name, department_id from users where id = $1 and is_active and deleted_at is null', [wanted], c);
    if (!m) throw bad('The manager must be an active user');
    if (!scope.all && m.id !== actor.id && m.department_id !== scope.deptId && !(await inTeam(actor, m.id, c)))
      throw forbidden('You can only choose yourself, someone of your department or someone in your team');
  } else if (!scope.all && cur?.manager_id) {
    throw forbidden('Only the Super Admin can take someone out of the reporting line');
  }
  if (cur?.manager_id && !reason) throw bad('Give a reason for changing who they report to');
  const name = async (id: string | null) => id ? (await one('select full_name from users where id = $1', [id], c))?.full_name ?? null : null;
  try {
    await c.query('savepoint mgr');
    await c.query('update users set manager_id = $2, updated_at = now() where id = $1', [userId, wanted]);
    await c.query('release savepoint mgr');
  } catch (e: any) {
    await c.query('rollback to savepoint mgr');
    if (/loop|report to themselves|12 levels/.test(String(e?.message))) throw bad(String(e.message));
    throw e;
  }
  const ol = await name(cur?.manager_id ?? null), nl = await name(wanted);
  await hist('manager', cur?.manager_id ?? null, wanted, ol, nl);
  await audit(c, actor, { entity_type: 'user', entity_id: userId, action: 'User updated', field: 'reports to', old_value: ol, new_value: nl, sensitivity: 'admin' });
}

/** When someone is switched off, the people who reported to them move up to that person's own manager (decision D5). */
async function passReportsUp(c: any, actor: Actor, userId: string) {
  const me = await one('select full_name, manager_id from users where id = $1', [userId], c);
  const up = me?.manager_id ? await one('select full_name from users where id = $1', [me.manager_id], c) : null;
  const reports = await q('select id from users where manager_id = $1 and deleted_at is null', [userId], c);
  for (const r of reports) {
    await c.query('update users set manager_id = $2, updated_at = now() where id = $1', [r.id, me?.manager_id ?? null]);
    await c.query(`insert into user_assignments (user_id, field, old_value, new_value, old_label, new_label, reason, changed_by, changed_by_name)
      values ($1,'manager',$2,$3,$4,$5,$6,$7,$8)`, [r.id, userId, me?.manager_id ?? null, me?.full_name ?? null, up?.full_name ?? null,
      `${me?.full_name ?? 'Their manager'} was disabled`, actor.id, actor.full_name]);
  }
  if (reports.length) await audit(c, actor, { entity_type: 'user', entity_id: userId, action: 'Team moved up',
    new_value: `${reports.length} person(s) now report to ${up?.full_name ?? 'nobody (to be placed)'}`, sensitivity: 'admin' });
}

// ---------------------------------------------------------------- designations (Super Admin)
export async function listDesignations(actor: Actor) {
  userScope(actor);
  return q(`select g.id, g.name, g.level, g.is_active,
      (select count(*)::int from users u where u.designation_id = g.id and u.deleted_at is null and u.is_active) users
    from designations g order by g.level, g.name`);
}
export async function saveDesignation(actor: Actor, b: any) {
  if (!actor.has('users.manage')) throw forbidden();
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 60) throw bad('Designation name is required (max 60 characters)');
  const level = Number.isInteger(Number(b.level)) ? Math.min(Math.max(Number(b.level), 1), 99) : 50;
  await tx(async (c) => {
    const dup = await one('select id from designations where lower(name) = lower($1)', [name], c);
    if (b.id) {
      if (!UUID.test(b.id)) throw notFound('Designation');
      const cur = await one('select * from designations where id = $1', [b.id], c);
      if (!cur) throw notFound('Designation');
      if (dup && dup.id !== cur.id) throw new ApiError(409, 'DUPLICATE', 'A designation with this name already exists');
      const active = b.is_active === undefined ? cur.is_active : Boolean(b.is_active);
      await c.query('update designations set name = $2, level = $3, is_active = $4 where id = $1', [cur.id, name, level, active]);
      await audit(c, actor, { entity_type: 'designation', entity_id: cur.id, action: 'Designation changed',
        old_value: `${cur.name} (${cur.level})${cur.is_active ? '' : ', off'}`, new_value: `${name} (${level})${active ? '' : ', off'}`, sensitivity: 'admin' });
    } else {
      if (dup) throw new ApiError(409, 'DUPLICATE', 'A designation with this name already exists');
      const g = await one('insert into designations (name, level) values ($1,$2) returning id', [name, level], c);
      await audit(c, actor, { entity_type: 'designation', entity_id: g.id, action: 'Designation added', new_value: `${name} (${level})`, sensitivity: 'admin' });
    }
  });
  return listDesignations(actor);
}

/** History of a user's division and Coordinator changes. */
export async function userAssignments(actor: Actor, id: string) {
  const scope = userScope(actor);
  if (!scope.all) await editableUser(actor, scope, id);
  return q(`select field, old_label, new_label, reason, changed_by_name, at from user_assignments where user_id = $1 order by at desc, id desc`, [id]);
}

// ---------------------------------------------------------------- users
export async function listUsers(actor: Actor) {
  const scope = userScope(actor);
  const params: unknown[] = [];
  let where = 'where u.deleted_at is null';
  if (!scope.all) { params.push(scope.deptId); where += ' and u.department_id = $1'; }
  if (!scope.all && scope.team) { params.push(actor.id); where += ` and u.id in (select user_team($${params.length}))`; }
  const { presenceCols } = await import('./presence');
  const users = await q(`select u.id, ${presenceCols('u')}, u.manager_id, (select m.full_name from users m where m.id = u.manager_id) manager_name,
      u.designation_id, (select g.name from designations g where g.id = u.designation_id) designation_name,
      (select count(*)::int from users s where s.manager_id = u.id and s.deleted_at is null and s.is_active) reports_count, u.full_name, u.email, u.mobile, u.is_active, u.must_change_password, u.last_login_at, u.created_at,
      u.division, u.coordinator_id, (select k.full_name from users k where k.id = u.coordinator_id) coordinator_name,
      (select count(*)::int from users s where s.coordinator_id = u.id and s.deleted_at is null and s.is_active) salesmen_count,
      d.is_active department_active, r.retired_at is not null role_retired,
      r.id role_id, r.code role_code, r.name role_name, r.is_manager, r.app_only, d.id department_id, d.name department_name, d.side department_side
    from users u join roles r on r.id = u.role_id left join departments d on d.id = u.department_id
    ${where} order by d.name nulls first, r.is_manager desc, u.full_name`, params);
  const perms = await grantable(actor, scope);
  const visible = new Set(perms.map((p) => p.code));
  const ov = await q('select user_id, permission_code, granted from user_permission_overrides where user_id = any($1)', [users.map((u) => u.id)]);
  return {
    scope: scope.all ? 'all' : scope.team ? 'team' : 'department',
    department: scope.all ? null : { id: scope.deptId, name: scope.deptName, side: scope.side },
    users: users.map((u) => ({
      ...u,
      overrides: ov.filter((o) => o.user_id === u.id && visible.has(o.permission_code)).map((o) => ({ code: o.permission_code, granted: o.granted })),
      can_edit: scope.all ? !(u.role_code === 'super_admin' && !actor.isSuperAdmin) : (!u.is_manager && u.role_code !== 'super_admin' && u.id !== actor.id),
    })),
    roles: await assignableRoles(scope),
    departments: scope.all ? await q('select id, name, side from departments where is_active order by side, name')
      : [{ id: scope.deptId, name: scope.deptName, side: scope.side }],
    permissions: perms,
    divisions: DIVISIONS,
    designations: await q('select id, name, level from designations where is_active order by level, name'),
    // who a person can report to: anyone active the actor can reach (themselves included for a manager)
    managers: await q(`select u.id, u.full_name, d.name department_name, (select g.name from designations g where g.id = u.designation_id) designation_name
      from users u left join departments d on d.id = u.department_id where u.is_active and u.deleted_at is null
      ${scope.all ? '' : 'and (u.id = $1 or u.department_id = $2 or u.id in (select user_team($1)))'} order by u.full_name`,
      scope.all ? [] : [actor.id, scope.deptId]),
    coordinators: await q(`select u.id, u.full_name, u.division from users u join roles r on r.id = u.role_id
      where r.code = 'coordinator' and u.is_active and u.deleted_at is null order by u.full_name`),
  };
}

export async function createUser(actor: Actor, b: any) {
  const scope = userScope(actor);
  const name = String(b.full_name ?? '').trim();
  if (!name) throw bad('Name is required');
  const deptId = scope.all ? b.department_id : scope.deptId;      // managers always add to their own department
  const { role, dept } = await checkRoleFits(b.role_id, deptId, scope);
  let email = String(b.email ?? '').trim().toLowerCase();
  // Phone-app people (messengers, drivers) may have no email: they sign in with their mobile number.
  if (!email && role.app_only) {
    if (phoneKey(b.mobile).length < 9) throw bad('Enter a mobile number — they sign in to the phone app with it');
    if (await one(`select 1 from users where deleted_at is null and right(regexp_replace(coalesce(mobile, ''), '\\D', '', 'g'), 9) = $1`, [phoneKey(b.mobile)]))
      throw new ApiError(409, 'MOBILE_TAKEN', 'Another user already has this mobile number');
    email = `app.${randomBytes(5).toString('hex')}@users.app`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
  if (role.code === 'super_admin' && !actor.isSuperAdmin) throw forbidden('Only a Super Admin can create another Super Admin');
  const password = b.password ? validatePassword(b.password) : tempPassword();
  if (await one('select 1 from users where lower(email) = $1 and deleted_at is null', [email]))
    throw new ApiError(409, 'EMAIL_TAKEN', 'A user with this email already exists');
  return tx(async (c) => {
    const u = await one(`insert into users (full_name, email, mobile, password_hash, role_id, department_id, must_change_password)
        values ($1,$2,$3,$4,$5,$6,true) returning id`,
      [name, email, b.mobile || null, await hashPassword(password), role.id, dept?.id ?? (b.department_id || null)], c);
    await setCommercialFields(c, actor, u.id, null, b, role.code);
    await setReporting(c, actor, scope, u.id, null, b);
    await audit(c, actor, { entity_type: 'user', entity_id: u.id, action: 'User created',
      new_value: `${name} <${email}>, ${role.name}${dept ? ', ' + dept.name : ''}`, sensitivity: 'admin' });
    return { id: u.id, temporary_password: password };          // shown once, never logged
  });
}

export async function editableUser(actor: Actor, scope: Scope, id: string, db?: any) {
  if (!UUID.test(id)) throw notFound('User');
  const cur = await one(`select u.*, r.code role_code, r.is_manager from users u join roles r on r.id = u.role_id
    where u.id = $1 and u.deleted_at is null`, [id], db);
  if (!cur) throw notFound('User');
  if (scope.all) {
    if (cur.role_code === 'super_admin' && !actor.isSuperAdmin) throw forbidden('Only a Super Admin can edit a Super Admin');
  } else {
    if (cur.department_id !== scope.deptId) throw notFound('User');                       // other departments don't exist for you
    if (scope.team && !(await inTeam(actor, id, db))) throw notFound('User');               // a Team Leader: only the people below them
    if (cur.is_manager || cur.role_code === 'super_admin') throw forbidden('Only the Super Admin can change a manager');
    if (cur.id === actor.id) throw forbidden('Ask the Super Admin to change your own account');
  }
  return cur;
}

export async function updateUser(actor: Actor, id: string, b: any) {
  const scope = userScope(actor);
  return tx(async (c) => {
    const cur = await editableUser(actor, scope, id, c);
    const changes: [string, unknown, unknown][] = [];
    let bump = false;
    if (b.full_name !== undefined && String(b.full_name).trim() && String(b.full_name).trim() !== cur.full_name)
      changes.push(['full_name', cur.full_name, String(b.full_name).trim()]);
    if (b.mobile !== undefined && (b.mobile || null) !== cur.mobile) changes.push(['mobile', cur.mobile, b.mobile || null]);

    const newDept = b.department_id !== undefined ? (b.department_id || null) : cur.department_id;
    const newRole = b.role_id !== undefined ? b.role_id : cur.role_id;
    if (newDept !== cur.department_id && !scope.all) throw forbidden('Only the Super Admin can move someone to another department');
    if (newDept !== cur.department_id || newRole !== cur.role_id) {
      const { role } = await checkRoleFits(newRole, newDept, scope, c);
      if (role.code === 'super_admin' && !actor.isSuperAdmin) throw forbidden('Only a Super Admin can grant Super Admin');
      if (cur.role_code === 'super_admin' && role.code !== 'super_admin' && (await activeSuperAdmins(id)) === 0)
        throw new ApiError(409, 'LAST_ADMIN', 'This is the last active Super Admin. Create another one first.');
      if (newDept !== cur.department_id) changes.push(['department_id', cur.department_id, newDept]);
      if (newRole !== cur.role_id) changes.push(['role_id', cur.role_id, role.id]);
      bump = true;
    }
    if (b.is_active !== undefined && Boolean(b.is_active) !== cur.is_active) {
      if (id === actor.id && !b.is_active) throw new ApiError(409, 'SELF_DISABLE', 'You cannot disable your own account');
      if (!b.is_active && cur.role_code === 'super_admin' && (await activeSuperAdmins(id)) === 0)
        throw new ApiError(409, 'LAST_ADMIN', 'This is the last active Super Admin');
      changes.push(['is_active', cur.is_active, Boolean(b.is_active)]); bump = true;
    }
    for (const [field, , val] of changes)
      await c.query(`update users set ${field} = $2, updated_at = now() where id = $1`, [id, val]);
    if (b.division !== undefined || b.coordinator_id !== undefined || newRole !== cur.role_id) {
      const rc = (await one('select code from roles where id = $1', [newRole], c)).code;
      await setCommercialFields(c, actor, id, cur, b, rc);
    }
    await setReporting(c, actor, scope, id, cur, b);
    if (b.is_active !== undefined && !b.is_active && cur.is_active) await passReportsUp(c, actor, id);

    if (Array.isArray(b.overrides)) {
      // A manager only touches the permissions they can hand out; anything else stays as it was.
      const mine = new Set((await grantable(actor, scope)).map((p) => p.code));
      const asked = b.overrides.filter((o: any) => typeof o?.code === 'string');
      const refused = asked.filter((o: any) => !mine.has(o.code));
      if (refused.length) throw forbidden(`You can't give or remove: ${refused.map((o: any) => o.code).join(', ')}`);
      const before = await q('select permission_code code, granted from user_permission_overrides where user_id = $1 order by 1', [id], c);
      await c.query('delete from user_permission_overrides where user_id = $1 and permission_code = any($2)', [id, [...mine]]);
      for (const o of asked)
        await c.query('insert into user_permission_overrides (user_id, permission_code, granted) values ($1,$2,$3) on conflict (user_id, permission_code) do update set granted = excluded.granted',
          [id, o.code, Boolean(o.granted)]);
      const after = await q('select permission_code code, granted from user_permission_overrides where user_id = $1 order by 1', [id], c);
      const fmt = (l: any[]) => l.map((o) => `${o.granted ? '+' : '−'}${o.code}`).sort().join(', ') || 'none';
      if (fmt(before) !== fmt(after)) { changes.push(['permission exceptions', fmt(before), fmt(after)]); bump = true; }
    }
    if (bump) await c.query('update users set token_version = token_version + 1 where id = $1', [id]);   // signs them out everywhere
    const label = async (field: string, v: unknown) => {
      if (!v) return v;
      if (field === 'role_id') return (await one('select name from roles where id = $1', [v], c))?.name;
      if (field === 'department_id') return (await one('select name from departments where id = $1', [v], c))?.name;
      return v;
    };
    for (const [field, o, nv] of changes)
      await audit(c, actor, { entity_type: 'user', entity_id: id, action: 'User updated', field: field.replace('_id', ''),
        old_value: await label(field, o), new_value: await label(field, nv), sensitivity: 'admin' });
    return { ok: true };
  });
}

export async function resetPassword(actor: Actor, id: string, b: any) {
  const scope = userScope(actor);
  await editableUser(actor, scope, id);
  const password = b?.password ? validatePassword(b.password) : tempPassword();
  await tx(async (c) => {
    await c.query(`update users set password_hash = $2, must_change_password = true, token_version = token_version + 1,
        failed_logins = 0, locked_until = null, updated_at = now() where id = $1`, [id, await hashPassword(password)]);
    await audit(c, actor, { entity_type: 'user', entity_id: id, action: 'Password reset', sensitivity: 'admin' });
  });
  return { temporary_password: password };
}

// ---------------------------------------------------------------- roles
export async function listRoles(actor: Actor) {
  const scope = roleScope(actor);
  const params: unknown[] = [];
  let where = '';
  if (!scope.all) {
    params.push(scope.deptId, scope.side);
    where = `where r.code <> 'super_admin' and not r.is_manager and (r.department_id = $1 or (r.department_id is null and r.side = $2))`;
  }
  const roles = await q(`select r.id, r.code, r.name, r.description, r.is_system, r.is_manager, r.side, r.department_id, d.name department_name,
      (select count(*)::int from users u where u.role_id = r.id and u.deleted_at is null ${scope.all ? '' : 'and u.department_id = $1'}) user_count,
      coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null), '{}') permissions
    from roles r left join role_permissions rp on rp.role_id = r.id left join departments d on d.id = r.department_id
    ${where} group by r.id, d.name order by r.side nulls last, r.is_manager desc, r.is_system desc, r.name`, params);
  const perms = await grantable(actor, scope);
  const shown = new Set(perms.map((p) => p.code));
  return {
    scope: scope.all ? 'all' : 'department',
    department: scope.all ? null : { id: scope.deptId, name: scope.deptName, side: scope.side },
    roles: roles.map((r) => ({ ...r, permissions: r.permissions.filter((p: string) => shown.has(p)),
      editable: r.code !== 'super_admin' && (scope.all || r.department_id === scope.deptId) })),
    permissions: perms,
    // migration 025: which roles each manager role may give (Super Admin only sees and sets this)
    assignable: scope.all ? await q('select role_id, assignable_role_id from role_assignable_roles') : [],
  };
}

export async function createRole(actor: Actor, b: any) {
  const scope = roleScope(actor);
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 60) throw bad('Role name is required (max 60 characters)');
  let side: Side | null = null, deptId: string | null = null, prefix = '';
  if (scope.all) {
    if (b.side) { if (!SIDES.includes(b.side)) throw bad('Choose a side'); side = b.side; }
  } else {
    side = scope.side; deptId = scope.deptId;
    prefix = ((await one('select code from departments where id = $1', [deptId]))!.code) + '_';
  }
  const code = prefix + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (await one('select 1 from roles where code = $1', [code])) throw new ApiError(409, 'ROLE_EXISTS', 'A role with this name already exists');
  // migration 025: "start from" an existing role — its permissions are copied, limited to what this person may give
  let copy: string[] = [];
  if (b.copy_from) {
    if (!UUID.test(b.copy_from)) throw bad('Choose the role to copy');
    const src = (await listRoles(actor)).roles.find((x: any) => x.id === b.copy_from);
    if (!src || src.code === 'super_admin') throw bad('Choose the role to copy');
    copy = src.permissions;
  }
  const r = await tx(async (c) => {
    const row = await one('insert into roles (code, name, description, side, department_id) values ($1,$2,$3,$4,$5) returning id',
      [code, name, b.description || null, side, deptId], c);
    for (const p of copy) await c.query('insert into role_permissions (role_id, permission_code) values ($1,$2) on conflict do nothing', [row.id, p]);
    // a new shared role can be given by that side's managers straight away, as before (the Super Admin can untick it)
    if (scope.all && side) await c.query(`insert into role_assignable_roles (role_id, assignable_role_id)
      select m.id, $1 from roles m where m.is_manager and m.side = $2 and m.retired_at is null on conflict do nothing`, [row.id, side]);
    await audit(c, actor, { entity_type: 'role', entity_id: row.id, action: 'Role created',
      new_value: name + (scope.all ? '' : ` (${scope.deptName})`) + (copy.length ? `, copied ${copy.length} permission(s)` : ''), sensitivity: 'admin' });
    return row;
  });
  return r;
}

export async function setRolePermissions(actor: Actor, roleId: string, codes: unknown) {
  const scope = roleScope(actor);
  if (!Array.isArray(codes)) throw bad('permissions must be a list');
  if (!UUID.test(roleId)) throw notFound('Role');
  const role = await one('select r.id, r.code, r.name, r.side, r.department_id, r.app_only from roles r where r.id = $1', [roleId]);
  if (!role) throw notFound('Role');
  if (role.code === 'super_admin') throw new ApiError(409, 'LOCKED_ROLE', 'Super Admin always has every permission');
  if (!scope.all && role.department_id !== scope.deptId) throw forbidden('You can only change roles of your own department');
  const perms = await grantable(actor, scope);
  const mine = new Set(perms.map((p) => p.code));
  const asked = [...new Set(codes.filter((x): x is string => typeof x === 'string'))];
  const refused = asked.filter((x) => !mine.has(x));
  if (refused.length) throw forbidden(`You can't give: ${refused.join(', ')}`);
  if (NO_SELLING_SIDES.includes(role.side) || role.app_only) {
    const commercial = new Set(perms.filter((p) => p.sensitivity === 'commercial').map((p) => p.code));
    if (asked.some((x) => commercial.has(x)))
      throw bad('Selling price, revenue, profit and customer documents can never be given to a Transport, Messenger, PRO, Warehouse or phone-app role.');
  }
  await tx(async (c) => {
    const before = (await q('select permission_code c from role_permissions where role_id = $1 order by 1', [roleId], c)).map((r) => r.c);
    // Only the permissions this person controls are replaced; others on the role are kept.
    await c.query('delete from role_permissions where role_id = $1 and permission_code = any($2)', [roleId, [...mine]]);
    for (const p of asked) await c.query('insert into role_permissions (role_id, permission_code) values ($1,$2) on conflict do nothing', [roleId, p]);
    const after = (await q('select permission_code c from role_permissions where role_id = $1 order by 1', [roleId], c)).map((r) => r.c);
    const added = after.filter((p) => !before.includes(p)), removed = before.filter((p) => !after.includes(p));
    if (added.length || removed.length) {
      await c.query('update users set token_version = token_version + 1 where role_id = $1', [roleId]);
      await audit(c, actor, { entity_type: 'role', entity_id: roleId, action: 'Role permissions changed', field: role.name,
        old_value: removed.length ? `removed: ${removed.join(', ')}` : null, new_value: added.length ? `added: ${added.join(', ')}` : null, sensitivity: 'admin' });
    }
  });
  return { ok: true };
}

/** Super Admin: the shared roles a manager role may give to its people (migration 025). An empty list = the side's roles, as before. */
export async function setAssignableRoles(actor: Actor, roleId: string, ids: unknown) {
  if (!actor.has('roles.manage')) throw forbidden();
  if (!UUID.test(roleId) || !Array.isArray(ids)) throw bad('Choose the roles');
  const role = await one('select id, name, is_manager from roles where id = $1 and retired_at is null', [roleId]);
  if (!role) throw notFound('Role');
  if (!role.is_manager) throw bad('Only a manager role hands out roles');
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && UUID.test(x)))];
  const ok = await q(`select id, name from roles where id = any($1) and not is_manager and code <> 'super_admin' and retired_at is null`, [want]);
  if (ok.length !== want.length) throw bad('A manager can only give non-manager roles');
  await tx(async (c) => {
    const before = (await q('select r.name from role_assignable_roles a join roles r on r.id = a.assignable_role_id where a.role_id = $1 order by 1', [roleId], c)).map((x) => x.name);
    await c.query('delete from role_assignable_roles where role_id = $1', [roleId]);
    for (const x of ok) await c.query('insert into role_assignable_roles (role_id, assignable_role_id) values ($1,$2)', [roleId, x.id]);
    const after = ok.map((x) => x.name).sort();
    if (before.join() !== after.join())
      await audit(c, actor, { entity_type: 'role', entity_id: roleId, action: 'Roles this role may give changed', field: role.name,
        old_value: before.join(', ') || 'none', new_value: after.join(', ') || 'none', sensitivity: 'admin' });
  });
  return { ok: true };
}

// ---------------------------------------------------------------- departments (Super Admin)
export async function listDepartments(actor: Actor) {
  if (!actor.has('settings.manage')) throw forbidden();
  return q(`select d.id, d.code, d.name, d.side, d.is_active,
      (select count(*)::int from users u where u.department_id = d.id and u.deleted_at is null and u.is_active) users
    from departments d order by d.side, d.name`);
}

export async function saveDepartment(actor: Actor, b: any) {
  if (!actor.has('settings.manage')) throw forbidden();
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 60) throw bad('Department name is required');
  await tx(async (c) => {
    if (b.id) {
      if (!UUID.test(b.id)) throw notFound('Department');
      const cur = await one('select * from departments where id = $1', [b.id], c);
      if (!cur) throw notFound('Department');
      const active = b.is_active === undefined ? cur.is_active : Boolean(b.is_active);
      const users = Number((await one('select count(*) n from users where department_id = $1 and deleted_at is null and is_active', [b.id], c))!.n);
      if (b.side && b.side !== cur.side && users) throw bad(`Move this department's ${users} user(s) out before changing its side.`);
      if (!active && cur.is_active && users) throw bad(`Move or disable this department's ${users} user(s) before switching it off.`);
      if (cur.code === 'admin' && !active) throw bad('The Administration department is needed for the Super Admin');
      const side = b.side && SIDES.includes(b.side) ? b.side : cur.side;
      await c.query('update departments set name = $2, side = $3, is_active = $4 where id = $1', [b.id, name, side, active]);
      await audit(c, actor, { entity_type: 'department', entity_id: b.id, action: 'Department changed',
        old_value: `${cur.name}, ${cur.side}${cur.is_active ? '' : ', off'}`, new_value: `${name}, ${side}${active ? '' : ', off'}`, sensitivity: 'admin' });
    } else {
      if (!SIDES.includes(b.side) || b.side === 'admin') throw bad('Choose which side the department is on');
      const code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
      if (await one('select 1 from departments where code = $1 or lower(name) = lower($2)', [code, name], c))
        throw new ApiError(409, 'DUPLICATE', 'A department with this name already exists');
      const d = await one('insert into departments (code, name, side) values ($1,$2,$3) returning id', [code, name, b.side], c);
      await audit(c, actor, { entity_type: 'department', entity_id: d.id, action: 'Department added', new_value: `${name}, ${b.side}`, sensitivity: 'admin' });
    }
  });
  return listDepartments(actor);
}
