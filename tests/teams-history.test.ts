/** AI batch 2 (migration 038): vendor teams (picked by mode + direction, the email goes to the team, replies from the team are
 *  the vendor's) and suggestions from the customer's past jobs (Accept / Edit / Ignore, never shipment-specific, unsure = ask). */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import { listTeams, saveTeam, setRequestTeam, pickTeam } from '../src/server/vendorteams';
import { emailDraft } from '../src/server/emails';
import { matchVendorRequest } from '../src/server/quotereader';
import { historyFor, historyPreview, ignoreHint, useHint } from '../src/server/history';
import { createWithCustomer } from '../src/server/newenquiry';

let admin: Actor, sam: Actor, cust: string, agent: string, fcl: any, air: any;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  const cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  cust = (await createMaster(sam, 'customers', { name: 'Habit Trading' })).id;
  agent = (await createMaster(admin, 'vendors', { name: 'Big Agent', vendor_type: 'freight_agent', email: 'info@bigagent.com' })).id;
});

test('teams: added by vendor managers only; checked; never deleted, only switched off', async () => {
  await assert.rejects(saveTeam(sam, agent, { name: 'X', email: 'x@bigagent.com' }), /Only the Super Admin/);
  await assert.rejects(saveTeam(admin, agent, { name: 'Sea FCL team', email: 'nope' }), /email/);
  await assert.rejects(saveTeam(admin, agent, { name: 'Sea FCL team', email: 'fcl@bigagent.com', cc_emails: 'a@b.com, bad' }), /Not an email address: bad/);
  await saveTeam(admin, agent, { name: 'Sea FCL team', email: 'fcl@bigagent.com', cc_emails: 'fcl2@bigagent.com', contact_person: 'Ravi Kumar', modes: ['sea_fcl'] });
  await saveTeam(admin, agent, { name: 'Air import team', email: 'airimp@bigagent.com', modes: ['air'], directions: ['import'] });
  await saveTeam(admin, agent, { name: 'Cross trade team', email: 'xt@bigagent.com', directions: ['cross_trade'] });
  await assert.rejects(saveTeam(admin, agent, { name: 'sea fcl TEAM', email: 'z@bigagent.com' }), /already has a team/);
  const t = await listTeams(admin, agent);
  [fcl, air] = [t.rows.find((r: any) => r.name === 'Sea FCL team'), t.rows.find((r: any) => r.name === 'Air import team')];
  assert.equal(t.rows.length, 3);
});

test('the right team is picked: FCL → Sea FCL team; air import → Air import team; air export → none (vendor\'s own email)', async () => {
  assert.equal((await pickTeam(null as any, agent, 'sea_fcl', 'import'))!.name, 'Sea FCL team');
  assert.equal((await pickTeam(null as any, agent, 'air', 'import'))!.name, 'Air import team');
  assert.equal(await pickTeam(null as any, agent, 'air', 'export'), null, 'the air team is import only');
  assert.equal((await pickTeam(null as any, agent, 'sea_lcl', 'cross_trade'))!.name, 'Cross trade team');
});

test('a rate request goes to the team; the email is to the team (CC the other address); a reply from the team is the vendor\'s', async () => {
  const f = await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB', port_of_loading: 'Shanghai', port_of_discharge: 'Jebel Ali' });
  const r = await vr.createVendorRequest(admin, { vendor_ids: [agent], service: 'rate', job_file_id: f.id, description: '1x40HC' });
  const got: any = await vr.getVendorRequest(admin, r.id);
  assert.equal(got.team_name, 'Sea FCL team');
  const d: any = await emailDraft(admin, { kind: 'vendor_request', id: r.id });
  assert.deepEqual(d.recipients.map((x: any) => [x.email, x.place]), [['fcl@bigagent.com', 'to'], ['fcl2@bigagent.com', 'cc']]);
  assert.match(d.body, /Dear Ravi,/);
  assert.equal(await matchVendorRequest(null as any, f.id, { from_addr: 'fcl2@bigagent.com', subject: 'RE: rates' }), r.id);
  // changed by hand: back to the vendor's own email, with history
  await setRequestTeam(admin, r.id, '');
  const d2: any = await emailDraft(admin, { kind: 'vendor_request', id: r.id });
  assert.deepEqual(d2.recipients.map((x: any) => x.email), ['info@bigagent.com']);
  assert.ok(await one(`select 1 from vendor_request_events where request_id = $1 and title = 'Team changed'`, [r.id]));
  await assert.rejects(setRequestTeam(admin, r.id, air.id === fcl.id ? 'x' : (await one(`select gen_random_uuid() id`)).id), /Choose one of this vendor's teams/);
  // a switched-off team is not picked
  await saveTeam(admin, agent, { id: fcl.id, active: false });
  assert.equal(await pickTeam(null as any, agent, 'sea_fcl', 'import'), null);
});

test('past jobs: the habit is suggested (pickup from the same origin), never weight / dates; accept, edit, ignore are kept', async () => {
  await q(`update enquiry_checks set is_active = true where label ~* '(stack|insur)'`);
  const hs = (await one(`select id from enquiry_checks where label = 'HS code'`)).id;
  const ins = (await one(`select id from enquiry_checks where label ~* 'insur'`)).id;
  const mk = (over: any) => createJobFile(sam, { customer_id: cust, division: 'exports', mode: 'sea_lcl', status: 'enquiry', incoterm: 'FOB', cargo_lines: [{ package_type: 'Pallets', pieces: 2, length: 120, width: 100, height: 100, dim_unit: 'cm', weight_kg: 500 }],
    port_of_loading: 'Jebel Ali', port_of_discharge: 'Hamburg', destination_country: 'DE', cargo_description: 'Shoes', ...over });
  // three past exports: twice pickup at the Jafza warehouse, once elsewhere; HS 6404 every time; insurance yes
  for (const pickup of ['Jafza warehouse LOB 12', 'Jafza warehouse LOB 12', 'Al Quoz yard'])
    await mk({ pickup_address: pickup, gross_weight_kg: 900, enquiry_details: { [hs]: '6404', [ins]: 'yes' } });
  // on the New enquiry form (not saved yet): the pickup address this customer uses from here (2 of 3), the HS code, insurance
  const form = { customer_id: cust, division: 'exports', mode: 'sea_lcl', status: 'enquiry', incoterm: 'FOB', port_of_loading: 'Jebel Ali', port_of_discharge: 'Hamburg', destination_country: 'DE', cargo_description: 'Shoes' };
  const r: any = await historyPreview(sam, form);
  const h = (k: string) => r.hints.find((x: any) => x.key === k);
  assert.deepEqual([h('pickup_address').value, h('pickup_address').count, h('pickup_address').total], ['Jafza warehouse LOB 12', 2, 3]);
  assert.equal(h(hs).value, '6404'); assert.equal(h(ins).value, 'yes');
  assert.ok(!r.hints.some((x: any) => /weight|ready|date|dimension/i.test(x.label)), 'never shipment-specific');
  // saved with the pickup address edited from the suggestion: logged
  const now: any = await createWithCustomer(sam, { ...form, cargo_lines: [{ package_type: 'Pallets', pieces: 1, length: 100, width: 100, height: 100, dim_unit: 'cm', weight_kg: 300 }],
    pickup_address: 'Jafza warehouse LOB 14', history_used: [{ key: 'pickup_address', label: 'Pickup address', value: 'Jafza warehouse LOB 14', action: 'edited', from: 'x, y' }] });
  // on the saved enquiry: accept insurance, ignore the HS code (not suggested again)
  await useHint(sam, now.id, { key: ins });
  const r3: any = await ignoreHint(sam, now.id, { key: hs });
  assert.ok(!r3.hints.some((x: any) => x.key === hs));
  const f: any = await getJobFile(sam, now.id);
  assert.deepEqual([f.enquiry_details?.[ins], f.pickup_address, f.enquiry_details?.[hs]], ['yes', 'Jafza warehouse LOB 14', undefined]);
  const log = (await q(`select field_key, action from history_choices where job_file_id = $1 order by created_at`, [now.id])).map((x: any) => `${x.field_key}:${x.action}`);
  assert.deepEqual(log, ['pickup_address:edited', `${ins}:accepted`, `${hs}:ignored`]);
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title like 'Pickup address filled in from past jobs (edited)'`, [now.id]));
});

test('past jobs disagree → nothing suggested, "ask the customer"; another customer\'s jobs never count', async () => {
  const hs = (await one(`select id from enquiry_checks where label = 'HS code'`)).id;
  const other = (await createMaster(sam, 'customers', { name: 'Other Co' })).id;
  const mk = (c: string, code?: string) => createJobFile(sam, { customer_id: c, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF',
    port_of_discharge: 'Jebel Ali', cargo_description: 'Tiles', ...(code ? { enquiry_details: { [hs]: code } } : {}) });
  await mk(other, '6907'); await mk(other, '6907');
  await mk(cust, '6908'); await mk(cust, '6810');
  const now = await mk(cust);
  const r: any = await historyFor(sam, now.id);
  assert.ok(!r.hints.some((x: any) => x.key === hs));
  assert.ok(r.unsure.includes('HS code'));
  void tx;
});
