/** 26 Nov (migration 047): one action at a time — View / Create / Edit / Delete — or everything with "Manage"; checked on the server. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createRole, setRolePermissions, createUser } from '../src/server/team';
import { createMaster, deleteMaster, listMaster, updateMaster } from '../src/server/masters';
import { listCards, saveCard } from '../src/server/localcharges';
import { listEmailTemplates, saveEmailTemplate } from '../src/server/templates';

let admin: Actor;
async function person(name: string, perms: string[]) {
  const r: any = await createRole(admin, { name, side: 'operations' });
  await setRolePermissions(admin, r.id, perms);
  const dept = (await one(`select id from departments where code = 'commercial'`)).id;
  const u: any = await createUser(admin, { full_name: name, email: `${name.replace(/\W/g, '').toLowerCase()}@x.ae`, role_id: r.id, department_id: dept, division: 'imports' });
  await q('update users set must_change_password = false where id = $1', [u.id]);
  return (await loadActor(u.id))!;
}

before(async () => { await resetDb(); admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!; });

test('local charges only: view and change the rates, nothing else', async () => {
  const lc = await person('Local Charges Clerk', ['local_charges.view', 'local_charges.edit']);
  const card = (await listCards(lc)).cards[0];
  assert.ok(card, 'sees the cards');
  await assert.rejects(saveCard(lc, null, { name: 'New', mode: 'air', direction: 'import', lines: [{ description: 'DO', unit: 'bl', cost: 1 }] }), /cannot add/);
  const { getCard } = await import('../src/server/localcharges');
  const c: any = await getCard(lc, card.id);
  await saveCard(lc, card.id, { ...c.card, lines: c.lines.map((l: any) => ({ ...l, cost: l.cost ?? undefined })) });
  await assert.rejects(listMaster(lc, 'vendors', {}), /permission|forbidden|not allowed/i, 'no other module');
  await assert.rejects(listEmailTemplates(lc), /permission|forbidden|not allowed/i);
});

test('vendors: add but not remove; customers: change only', async () => {
  const v = await person('Vendor Clerk', ['vendors.view', 'vendors.create']);
  const id = (await createMaster(v, 'vendors', { name: 'Fine Agent', vendor_type: 'freight_agent', email: 'f@agent.ae' })).id;
  assert.ok((await listMaster(v, 'vendors', {})).rows.some((r: any) => r.id === id));
  await assert.rejects(updateMaster(v, 'vendors', id, { name: 'Renamed' }), /permission|forbidden|not allowed/i);
  await assert.rejects(deleteMaster(v, 'vendors', id), /permission|forbidden|not allowed/i);
  const c = await person('Customer Editor', ['customers.edit']);
  const cust = (await createMaster(admin, 'customers', { name: 'Fine Customer', email: 'c@fine.ae' })).id;
  await updateMaster(c, 'customers', cust, { name: 'Fine Customer LLC' });
  assert.ok((await listMaster(c, 'customers', {})).rows.length, 'whoever may change it may see it');
  await assert.rejects(createMaster(c, 'customers', { name: 'Another' }), /permission|forbidden|not allowed/i);
});

test('templates: view only; existing roles kept what they had', async () => {
  const t = await person('Template Reader', ['templates.view']);
  assert.ok((await listEmailTemplates(t)).built_in.length);
  await assert.rejects(saveEmailTemplate(t, { template_key: 'quotation_submission', subject: 'x', body: 'y' }), /Commercials Manager/);
  // migration 047 gave the fine rights to every role that had the broad one
  const missing = await q(`select r.code from roles r join role_permissions rp on rp.role_id = r.id and rp.permission_code = 'quotes.create'
    where not exists (select 1 from role_permissions x where x.role_id = r.id and x.permission_code = 'quotes.edit')`);
  assert.deepEqual(missing, []);
  const lcm = await q(`select r.code from roles r join role_permissions rp on rp.role_id = r.id and rp.permission_code = 'vendors.manage'
    where not exists (select 1 from role_permissions x where x.role_id = r.id and x.permission_code = 'vendors.delete')`);
  assert.deepEqual(lcm, []);
});
