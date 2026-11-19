/** Release M step 1 (migration 028): the enquiry checklist — your own items by division / mode, answers on the enquiry,
 *  what is missing (built-in + yours), and the email asking the customer for it. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, updateJobFile, getJobFile } from '../src/server/jobfiles';
import { listEnquiryChecks, saveEnquiryCheck } from '../src/server/checklists';
import { emailDraft, emailPrepared } from '../src/server/emails';
import { saveContact } from '../src/server/contacts';

let admin: Actor, cm: Actor, sam: Actor, cust: string, hs: string, dg: string, ready: string;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cm = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  const cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  cust = (await createMaster(sam, 'customers', { name: 'Eta Trading' })).id;
  await saveContact(admin, cust, { full_name: 'Nina Buyer', email: 'nina@eta.ae', is_primary: true });
  const rows = (await listEnquiryChecks(cm)).rows;
  hs = rows.find((r: any) => r.label === 'HS code')!.id; dg = rows.find((r: any) => r.label === 'Hazardous (DG) cargo')!.id; ready = rows.find((r: any) => r.label === 'Cargo ready date')!.id;
});

test('the Commercials Manager keeps the checklist; a Salesman only reads it', async () => {
  const l = await saveEnquiryCheck(cm, { label: 'Reefer temperature', ask_text: 'the temperature setting', field_type: 'text', modes: ['sea_fcl'], divisions: ['imports'] });
  assert.ok(l.rows.some((r: any) => r.label === 'Reefer temperature'));
  await assert.rejects(saveEnquiryCheck(cm, { label: 'hs code', ask_text: 'x' }), (e: any) => e.code === 'DUPLICATE');
  await assert.rejects(saveEnquiryCheck(sam, { label: 'X', ask_text: 'y' }), (e: any) => e.code === 'FORBIDDEN');
  const s = await listEnquiryChecks(sam);
  assert.equal(s.can_manage, false);
  assert.ok(s.rows.every((r: any) => r.is_active), 'only items that are on');
});

test('a thin enquiry lists every missing detail, built-in and yours, for its division and mode', async () => {
  const f = await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali' });
  const g: any = await getJobFile(sam, f.id);
  const labels = g.enquiry_gaps.map((x: any) => x.label);
  for (const l of ['Cargo weight', 'Commodity', 'HS code', 'Hazardous (DG) cargo', 'Cargo ready date', 'Reefer temperature']) assert.ok(labels.includes(l), l);
  const air = await createJobFile(sam, { customer_id: cust, division: 'exports', mode: 'air', status: 'enquiry', incoterm: 'FOB', port_of_loading: 'DXB', pickup_address: 'Jebel Ali FZ',
    cargo_lines: [{ package_type: 'Cartons', pieces: 5, length: 40, width: 30, height: 30, dim_unit: 'cm', weight_kg: 60 }], cargo_description: 'Dates' });
  const a: any = await getJobFile(sam, air.id);
  assert.ok(!a.enquiry_gaps.some((x: any) => x.label === 'Reefer temperature'), 'Sea FCL imports only');
  assert.ok(!a.enquiry_gaps.some((x: any) => x.built_in), 'nothing built-in missing');
});

test('answers are saved in their format; an answered item is no longer missing', async () => {
  const f = await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali',
    cargo_description: 'Rice', gross_weight_kg: 18000, enquiry_details: { [hs]: '1006.30' } });
  await assert.rejects(updateJobFile(sam, f.id, { enquiry_details: { [hs]: '1006.30', [dg]: 'maybe' } }), /Yes or No/);
  await assert.rejects(updateJobFile(sam, f.id, { enquiry_details: { [ready]: '20 Nov' } }), /choose a date/);
  await updateJobFile(sam, f.id, { enquiry_details: { [hs]: '1006.30', [dg]: 'no', [ready]: '2026-11-25' } });
  const g: any = await getJobFile(sam, f.id);
  assert.equal(g.enquiry_details[dg], 'no');
  const left = g.enquiry_gaps.map((x: any) => x.label);
  assert.deepEqual(left, ['Reefer temperature']);
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title = 'Additional enquiry details changed'`, [f.id]));
});

test('the email asks the customer for exactly what is missing, on the enquiry\'s own subject', async () => {
  const f = await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali' });
  const d = await emailDraft(sam, { kind: 'enquiry_missing', id: f.id });
  assert.deepEqual(d.recipients.map((r) => r.email), ['nina@eta.ae']);
  assert.match(d.subject, /^\[ENQ-IMP-/);
  assert.match(d.body, /could you please share:/);
  assert.match(d.body, /- The total cargo weight/);
  assert.match(d.body, /- The HS code of the goods/);
  await emailPrepared(sam, { kind: 'enquiry_missing', id: f.id, to: ['nina@eta.ae'], subject: d.subject, body: d.body });
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title = 'Missing details asked from the customer'`, [f.id]));
  assert.ok(await one(`select 1 from email_messages where job_file_id = $1 and status = 'prepared'`, [f.id]));
});
