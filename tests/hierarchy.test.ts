/** Hierarchy step 2 (migration 025): designations, reporting manager with history and a loop guard,
 *  "Manage my team" for Team Leaders, people moving up when their manager is disabled, team visibility. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, listJobFiles } from '../src/server/jobfiles';
import { listUsers, updateUser, userAssignments, listDesignations, saveDesignation } from '../src/server/team';

let admin: Actor, boss: Actor, lead: Actor, sam: Actor, sara: Actor, other: Actor;
const des = async (name: string) => (await one('select id from designations where name = $1', [name])).id as string;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  boss = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  lead = await mkUser(admin, 'Tina Lead', 'coordinator', undefined, { manager_id: boss.id, designation_id: await des('Team Leader') });
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: lead.id, manager_id: lead.id });
  sara = await mkUser(admin, 'Sara Sales', 'sales', undefined, { coordinator_id: lead.id, manager_id: lead.id });
  other = await mkUser(admin, 'Olly Ops', 'operations');
});

test('reporting line and title are saved, with history', async () => {
  const u = await one('select manager_id, designation_id from users where id = $1', [lead.id]);
  assert.equal(u.manager_id, boss.id);
  assert.equal(u.designation_id, await des('Team Leader'));
  const h = await userAssignments(admin, lead.id);
  assert.ok(h.some((x: any) => x.field === 'manager' && x.new_label === 'Carl Commercial'));
  assert.ok(h.some((x: any) => x.field === 'designation' && x.new_label === 'Team Leader'));
});

test('no loops, no reporting to yourself, and a reason when the line changes', async () => {
  await assert.rejects(updateUser(admin, boss.id, { manager_id: sam.id, assignment_reason: 'x' }), /loop/);
  await assert.rejects(updateUser(admin, sam.id, { manager_id: sam.id }), /themselves/);
  await assert.rejects(updateUser(admin, sam.id, { manager_id: boss.id }), /reason/);
  assert.equal((await one('select manager_id from users where id = $1', [boss.id])).manager_id, null, 'nothing was saved');
});

test('a Team Leader with "Manage my team" works only on the people below them', async () => {
  await q(`insert into user_permission_overrides (user_id, permission_code, granted) values ($1, 'users.manage_team', true)`, [lead.id]);
  const tl = (await loadActor(lead.id))!;
  const list: any = await listUsers(tl);
  assert.deepEqual(list.users.map((x: any) => x.full_name).sort(), ['Sam Sales', 'Sara Sales']);
  await updateUser(tl, sam.id, { designation_id: await des('Senior Executive') });
  await assert.rejects(updateUser(tl, boss.id, { mobile: '0500000000' }), (e: any) => e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN');
  await assert.rejects(updateUser(tl, sam.id, { manager_id: other.id, assignment_reason: 'move' }), (e: any) => e.code === 'FORBIDDEN');
});

test('a department manager sees their department with reporting lines', async () => {
  const list: any = await listUsers(boss);
  const s = list.users.find((x: any) => x.id === sam.id);
  assert.equal(s.manager_name, 'Tina Lead');
  assert.equal(list.users.find((x: any) => x.id === lead.id).reports_count, 2);
  assert.ok(list.designations.some((d: any) => d.name === 'Team Leader'));
  assert.ok(list.managers.some((m: any) => m.id === boss.id));
  assert.ok(!list.managers.some((m: any) => m.id === other.id), 'people of other departments are not offered');
});

test('the team sees each other\'s shipments; others do not', async () => {
  const cust = (await createMaster(sam, 'customers', { name: 'Team Test LLC' })).id;
  const f = await createJobFile(sam, { customer_id: cust, direction: 'import', mode: 'sea_fcl', status: 'enquiry', incoterm: 'EXW',
    pickup_address: 'Factory', delivery_address: 'Warehouse, Dubai' });
  await q('update job_files set coordinator_id = null where id = $1', [f.id]);         // only Sam is on it
  const seen = async (a: Actor) => ((await listJobFiles(a, {})) as any).rows.some((r: any) => r.id === f.id);
  assert.equal(await seen(sara), false, 'a colleague at the same level does not');
  await q(`insert into user_permission_overrides (user_id, permission_code, granted) values ($1, 'jobfiles.view_team', true)`, [lead.id]);
  assert.equal(await seen((await loadActor(lead.id))!), true, 'the Team Leader does, through the team');
});

test('when a manager is disabled, their people move up a level', async () => {
  await updateUser(admin, lead.id, { is_active: false });
  const r = await q('select manager_id from users where id = any($1)', [[sam.id, sara.id]]);
  assert.ok(r.every((x: any) => x.manager_id === boss.id));
  const h = await userAssignments(admin, sam.id);
  assert.ok(h.some((x: any) => x.field === 'manager' && x.new_label === 'Carl Commercial' && /disabled/.test(x.reason)));
});

test('designations: the Super Admin adds and switches off titles; nobody else can', async () => {
  const l = await saveDesignation(admin, { name: 'Branch Head', level: 15 });
  assert.ok(l.some((d: any) => d.name === 'Branch Head'));
  await assert.rejects(saveDesignation(admin, { name: 'branch head' }), (e: any) => e.code === 'DUPLICATE');
  await assert.rejects(saveDesignation(boss, { name: 'Boss' }), (e: any) => e.code === 'FORBIDDEN');
  assert.ok((await listDesignations(boss)).length > 0);
});

test('the dashboard shows a manager their team', async () => {
  const { homeDashboard } = await import('../src/server/home');
  const h: any = await homeDashboard((await loadActor(boss.id))!);
  const t = h.sections.find((s: any) => s.key === 'team');
  assert.ok(t, 'My team section is there');
  assert.equal(t.cards.find((c: any) => c.key === 'people').count, 2);       // Sam and Sara, now directly under Carl
  const s: any = await homeDashboard((await loadActor(sam.id))!);
  assert.ok(!s.sections.some((x: any) => x.key === 'team'), 'not for people with no team');
});
