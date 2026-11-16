/** Hierarchy step 4 (migration 025): every permission has an action for the grid; roles can start as a copy;
 *  the Super Admin decides which shared roles each manager role may give. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { listRoles, createRole, setAssignableRoles, listUsers, createUser } from '../src/server/team';

let admin: Actor, boss: Actor;
const roleId = async (code: string) => (await one('select id from roles where code = $1', [code])).id as string;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  boss = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
});

test('every permission has one of the seven actions', async () => {
  const bad = await q(`select code from permissions where action is null or action not in ('view','create','edit','delete','approve','manage','export')`);
  assert.deepEqual(bad, []);
  const l: any = await listRoles(admin);
  assert.ok(l.permissions.every((p: any) => p.action));
});

test('a new role can start as a copy, limited to what the creator may give', async () => {
  const r = await createRole(admin, { name: 'Senior Coordinator', side: 'operations', copy_from: await roleId('coordinator') });
  const got = (await q('select permission_code c from role_permissions where role_id = $1 order by 1', [r.id])).map((x) => x.c);
  const src = (await q(`select permission_code c from role_permissions rp join roles r on r.id = rp.role_id where r.code = 'coordinator' order by 1`)).map((x) => x.c);
  assert.deepEqual(got, src);
});

test('the Super Admin limits which shared roles a manager can give', async () => {
  const before: any = await listUsers(boss);
  assert.ok(before.roles.some((r: any) => r.code === 'coordinator'));
  await setAssignableRoles(admin, await roleId('commercials_manager'), [await roleId('sales')]);
  const after: any = await listUsers(boss);
  assert.ok(after.roles.some((r: any) => r.code === 'sales'));
  assert.ok(!after.roles.some((r: any) => r.code === 'coordinator'), 'no longer offered');
  await assert.rejects(createUser(boss, { full_name: 'New Coord', email: 'newcoord@x.ae', role_id: await roleId('coordinator'),
    department_id: await deptId('commercial'), division: 'imports' }), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(setAssignableRoles(boss, await roleId('commercials_manager'), []), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(setAssignableRoles(admin, await roleId('commercials_manager'), [await roleId('operations_manager')]), /non-manager/);
  await setAssignableRoles(admin, await roleId('commercials_manager'), []);            // empty = as before
  assert.ok((await listUsers(boss) as any).roles.some((r: any) => r.code === 'coordinator'));
});

test('a department manager shapes the roles of their own department, never more than they hold', async () => {
  const l: any = await listRoles(boss);
  assert.ok(l.roles.length > 0);
  const r = await createRole(boss, { name: 'Senior Salesman', copy_from: await roleId('sales') });
  const d = await one('select department_id from roles where id = $1', [r.id]);
  assert.equal(d.department_id, await deptId('commercial'), 'made for their own department');
  const got = (await q('select permission_code c from role_permissions where role_id = $1', [r.id])).map((x) => x.c);
  const mine = boss.perms;
  assert.ok(got.every((c: string) => mine.has(c as any)), 'only permissions the manager holds were copied');
  assert.ok(!(l.roles.find((x: any) => x.code === 'sales')?.editable), 'shared roles are read-only for them');
});
