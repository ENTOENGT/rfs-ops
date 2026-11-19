/** Release M step 2 (migration 028): the agent quote checklist — items read from the rate request's own fields or asked as
 *  extra questions, by mode; what the agent's reply lacks; and the email asking the agent (never the customer's name). */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import { listQuoteChecks, saveQuoteCheck } from '../src/server/checklists';
import { emailDraft, emailPrepared } from '../src/server/emails';

let admin: Actor, cm: Actor, sam: Actor, cora: Actor, sea: string, air: string, agent: string;
const D = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cm = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  const cust = (await createMaster(sam, 'customers', { name: 'Theta Secret Customer LLC' })).id;
  agent = (await createMaster(admin, 'vendors', { name: 'Ningbo Agent Co', vendor_type: 'overseas_agent', email: 'rates@ningbo-agent.cn', contact_person: 'Li Wei' })).id;
  sea = (await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB', port_of_loading: 'Ningbo', port_of_discharge: 'Jebel Ali', cargo_description: 'Furniture', gross_weight_kg: 12000 })).id;
  air = (await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'air', status: 'enquiry', incoterm: 'FOB', port_of_loading: 'PVG', port_of_discharge: 'DXB', cargo_description: 'Spare parts',
    cargo_lines: [{ package_type: 'Cartons', pieces: 4, length: 50, width: 40, height: 40, dim_unit: 'cm', weight_kg: 80 }] })).id;
});

test('the checklist: items read from the rate, by mode; managers add extra questions, a Salesman only reads', async () => {
  const l = await listQuoteChecks(cm);
  assert.ok(l.rows.some((r: any) => r.label === 'Free days' && r.field_key === 'free_days' && r.modes.includes('sea_fcl')));
  const n = await saveQuoteCheck(cm, { label: 'Equipment availability', ask_text: 'whether equipment is available for the ready date', modes: ['sea_fcl'] });
  assert.ok(n.rows.some((r: any) => r.label === 'Equipment availability' && r.field_key === null));
  await assert.rejects(saveQuoteCheck(sam, { label: 'X', ask_text: 'y' }), (e: any) => e.code === 'FORBIDDEN');
});

test('a thin sea rate lists what the agent left out; filling it in clears the list', async () => {
  const id = (await vr.createVendorRequest(cora, { vendor_ids: [agent], service: 'rate', job_file_id: sea, description: '1x40HC Ningbo → Jebel Ali' })).id;
  let r: any = await vr.getVendorRequest(cora, id);
  assert.deepEqual(r.quote_gaps, [], 'nothing flagged before the agent replies');
  await vr.vendorRequestAction(cora, id, { status: 'quoted', currency: 'USD', quoted_cost: '1800', transit_days: 22 });
  r = await vr.getVendorRequest(cora, id);
  const labels = r.quote_gaps.map((g: any) => g.label);
  for (const l of ['Validity', 'Routing (direct / via)', 'Carrier / airline', 'Free days', 'Origin charges', 'Destination charges', 'Equipment availability']) assert.ok(labels.includes(l), l);
  for (const l of ['Freight rate', 'Currency', 'Transit time', 'Weight breaks']) assert.ok(!labels.includes(l), l);
  const eq = r.quote_checks.find((c: any) => c.label === 'Equipment availability').id;
  await vr.vendorRequestAction(cora, id, { what: 'quote_details', quote_details: { [eq]: 'Yes, for 20 Nov' } });
  r = await vr.getVendorRequest(cora, id);
  assert.ok(!r.quote_gaps.some((g: any) => g.label === 'Equipment availability'));
  assert.ok(await one(`select 1 from vendor_request_events where request_id = $1 and title = 'Quote details updated'`, [id]));
});

test('an air rate uses the air items', async () => {
  const id = (await vr.createVendorRequest(cora, { vendor_ids: [agent], service: 'rate', job_file_id: air, description: 'PVG → DXB' })).id;
  await vr.vendorRequestAction(cora, id, { status: 'quoted', currency: 'USD', quoted_cost: '500', transit_days: 2, rate_valid_until: D(7), routing: 'direct', carrier: 'EK', etd: D(3) });
  const r: any = await vr.getVendorRequest(cora, id);
  assert.deepEqual(r.quote_gaps.map((g: any) => g.label).sort(), ['Chargeable weight used', 'Fuel and security surcharges', 'Weight breaks']);
});

test('the email asks the agent for exactly what is missing, with the shipment details, never the customer\'s name', async () => {
  const id = (await vr.createVendorRequest(cora, { vendor_ids: [agent], service: 'rate', job_file_id: sea, description: 'again' })).id;
  await vr.vendorRequestAction(cora, id, { status: 'quoted', currency: 'USD', quoted_cost: '1750' });
  const d = await emailDraft(cora, { kind: 'vendor_missing', id });
  assert.deepEqual(d.recipients.map((r) => r.email), ['rates@ningbo-agent.cn']);
  assert.match(d.subject, /^\[ENQ-IMP-.*Our ref\. /);
  assert.match(d.body, /^Dear Li,/);
  assert.match(d.body, /- How long the rate is valid/);
  assert.match(d.body, /Route: Ningbo → Jebel Ali/);
  assert.doesNotMatch(d.body + d.subject, /Theta|Secret Customer|1750/);
  await emailPrepared(cora, { kind: 'vendor_missing', id, to: ['rates@ningbo-agent.cn'], subject: d.subject, body: d.body });
  assert.ok(await one(`select 1 from vendor_request_events where request_id = $1 and title = 'Missing quote details asked from the agent'`, [id]));
});
