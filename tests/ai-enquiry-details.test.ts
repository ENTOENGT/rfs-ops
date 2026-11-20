/** 20 Nov feedback on "Create enquiry": a Coordinator may add the new customer; the packing list fills the cargo lines;
 *  "Nhava Sheva" finds INNSA "Jawaharlal Nehru (Nhava Sheva)"; every HS code once in Additional details. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import * as ol from '../src/server/outlook';
import { setAiNetwork } from '../src/server/ai';
import { ensurePortsLoaded } from '../src/server/ports';
import { createFromEmail, draftEnquiry } from '../src/server/newenquiry';
import { getJobFile } from '../src/server/jobfiles';

let admin: Actor, cora: Actor, sam: Actor, rowId: string;
let answer: any = {};

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  await ensurePortsLoaded();
  await q(`update enquiry_checks set is_active = true where label ~* '(stack|insur)'`);
  await ol.setPilot(admin, cora.id, true);
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
    values ($1, 'ms', 'coracoord@x.ae', $2, $3, now() + interval '1 hour', $4)`, [cora.id, ol.seal('r'), ol.seal('a'), ol.SCOPES]);
  rowId = (await one(`insert into outlook_inbox (user_id, ms_message_id, internet_message_id, from_addr, from_name, subject, received_at, body_excerpt, has_attachments, status, ai_kind, ai_checked_at)
    values ($1, 'M2', '<m2@x>', 'jrrrahman@gmail.com', 'Mohamed Rahman', 'New enquiry', now(), 'Please quote, sheet attached', false, 'unmatched', 'new_enquiry', now()) returning id`, [cora.id]))!.id;
  ol.setNetwork((async () => new Response(JSON.stringify({ body: { content: 'Please quote. Details below.' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
  setAiNetwork((async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'enquiry_from_email', input: answer }] }), { status: 200 })) as typeof fetch);
});

test('the packing list fills the cargo lines; Nhava Sheva → INNSA; HS codes once each', async () => {
  answer = { company_name: 'Red Chief', mode: 'sea_lcl', incoterm: 'FOB', origin_country: 'India', origin_port: 'Nhava Sheva Port', destination_port: 'Jebel Ali',
    hazardous: 'no', stackable: 'yes', insurance: 'yes', summary: 'LCL footwear Nhava Sheva to Jebel Ali',
    cargo_lines: [
      { package_type: 'carton', pieces: 120, length: 58.75, width: 52.5, height: 33.75, dim_unit: 'cm', weight_per_package_kg: 15 },
      { package_type: 'Sandals', pieces: 0, length: 40, width: 30, height: 20 },                    // no cartons yet: left out
    ],
    hs_codes: ['6404', '6404', '6404.11.00', '64022000'] };
  const d: any = (await draftEnquiry(cora, rowId)).draft;
  assert.deepEqual([d.pol_code, d.port_of_loading], ['INNSA', (await one(`select name from ports where code = 'INNSA'`)).name]);
  assert.match(d.port_of_loading, /Nhava Sheva/);
  assert.equal(d.pod_code, 'AEJEA');
  assert.deepEqual(d.cargo_lines, [{ package_type: 'Cartons', package_other: '', pieces: 120, length: 58.75, width: 52.5, height: 33.75, dim_unit: 'cm', weight_kg: 1800 }]);
  assert.equal(d.gross_weight_kg, 1800);
  assert.deepEqual(d.hs_codes, ['6404', '64041100', '64022000']);
  const hsId = (await one(`select id from enquiry_checks where label = 'HS code'`)).id;
  assert.equal(d.enquiry_details[hsId], '6404, 64041100, 64022000');
});

test('the AI\'s port code wins when it is right; a wrong one is ignored', async () => {
  answer = { mode: 'sea_fcl', origin_country: 'India', origin_port: 'Nava Sheva', origin_port_code: 'INNSA', destination_port: 'Jebel Ali', destination_port_code: 'XXZZZ', hazardous: 'unknown', summary: 's' };
  await q(`update outlook_inbox set ai_draft = null where id = $1`, [rowId]);
  const d: any = (await draftEnquiry(cora, rowId)).draft;
  assert.equal(d.pol_code, 'INNSA', 'a misspelling is saved by the code');
  assert.equal(d.pod_code, 'AEJEA', 'an unknown code falls back to the name');
});

test('a Coordinator saves it: the new customer is created (with the chosen Salesman as owner)', async () => {
  answer = { company_name: 'Red Chief', contact_person: 'Mohamed Rahman', mode: 'sea_lcl', incoterm: 'FOB', origin_country: 'India', origin_port: 'Nhava Sheva', destination_port: 'Jebel Ali',
    hazardous: 'no', summary: 's', cargo_lines: [{ package_type: 'Cartons', pieces: 120, length: 58.75, width: 52.5, height: 33.75, dim_unit: 'cm', total_weight_kg: 1800 }] };
  await q(`update outlook_inbox set ai_draft = null where id = $1`, [rowId]);
  const d: any = (await draftEnquiry(cora, rowId)).draft;
  const { new_customer, customer_name, summary, mode_unknown, attachments_read, attachments_notes, hs_codes, v, ...enquiry } = d;
  const r: any = await createFromEmail(cora, rowId, { enquiry: { ...enquiry, salesman_id: sam.id, pickup_address: 'Ballard Estate, Mumbai' }, new_customer });
  assert.equal(r.customer_created, 'Red Chief');
  const f: any = await getJobFile(cora, r.id);
  assert.equal(f.pol_code, 'INNSA');
  assert.equal(f.cargo_lines?.length ?? (await one(`select count(*) n from job_file_cargo_lines where job_file_id = $1`, [r.id]).catch(() => ({ n: 1 })))!.n, 1);
  assert.equal((await one(`select user_id from customer_salesmen where customer_id = $1 and is_main`, [f.customer_id])).user_id, sam.id);
});
