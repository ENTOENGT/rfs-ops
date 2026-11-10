/** Step 6 — the LCL Team role: full access to LCL Management, nothing else (no shipments, quotations, transport, warehouse, admin). */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import * as lcl from '../src/server/lcl';
import { listJobFiles } from '../src/server/jobfiles';
import { listQuotations } from '../src/server/quotations';
import { listJobs } from '../src/server/jobs';
import { homeDashboard } from '../src/server/home';
import { visibleModules } from '../src/lib/navigation';

let admin: Actor, team: Actor;
before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  team = await mkUser(admin, 'Lina LCL', 'lcl_team');
});

test('the LCL Team runs consolidations end to end', async () => {
  assert.equal(team.department_name, 'LCL');
  for (const p of ['lcl.view', 'lcl.manage', 'lcl.receive', 'lcl.stuff']) assert.ok(team.has(p as any), p);
  const c = await lcl.createConsolidation(team, { division: 'exports', direction: 'export', pol: 'Jebel Ali', pod: 'Hamburg', carrier: 'MSC', mbl_no: 'MEDULCL0001' });
  assert.ok(c.id);
  assert.ok((await lcl.listConsolidations(team, { view: 'all' })).rows.some((x: any) => x.id === c.id));
  await lcl.lclOptions(team);
  await lcl.lclCandidates(team, {});
  const h: any = await homeDashboard(team);
  assert.deepEqual(h.sections.map((s: any) => s.key), ['lcl']);
});

test('…and sees nothing else', async () => {
  await assert.rejects(listJobFiles(team, {}), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(listQuotations(team, {}), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(listJobs(team, {}), (e: any) => e.code === 'FORBIDDEN');
  const mods = visibleModules((p) => team.has(p as any), { moneyScreens: true });
  assert.deepEqual(mods.map((m) => m.key), ['dashboard', 'lcl', 'reports']);
  assert.deepEqual(mods.find((m) => m.key === 'reports')!.items.map((i) => i.href), ['/lcl/reports'], 'Reports holds only the LCL reports');
});
