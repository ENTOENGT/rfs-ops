/** 21 Nov, AI batch 1 — operations rules: services from the Incoterm + the customer's words (clashes flagged), "ready for
 *  collection" = today + mark + remark, general cargo = Non-DG, FCL never asked stackable, CIF/CIP import no insurance question,
 *  customer remarks captured and highlighted. Same rules for a new enquiry email, a reply, and "what is still missing". */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import * as ol from '../src/server/outlook';
import { setAiNetwork } from '../src/server/ai';
import { ensurePortsLoaded } from '../src/server/ports';
import { draftEnquiry } from '../src/server/newenquiry';
import { applySuggestion, readEmail } from '../src/server/agent';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile } from '../src/server/jobfiles';
import { decideServices, dgFromText, notNeeded, saysReady } from '../src/lib/opsRules';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
let admin: Actor, cora: Actor, sam: Actor, rowId: string;
let answer: any = {}, tool = 'enquiry_from_email', body = '';

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
    values ($1, 'M9', '<m9@x>', 'buyer@alnoor.ae', 'Ali', 'Enquiry', now(), 'Please quote', false, 'unmatched', 'new_enquiry', now()) returning id`, [cora.id]))!.id;
  ol.setNetwork((async () => new Response(JSON.stringify({ body: { content: body } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
  setAiNetwork((async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: answer }] }), { status: 200 })) as typeof fetch);
});

test('the rules on their own', () => {
  // EXW import = door to door: clearance + delivery
  let r = decideServices({ incoterm: 'EXW', direction: 'import', asked: {} });
  assert.deepEqual([r.needs_clearance, r.needs_transport, r.flags.length], [true, true, 0]);
  // FOB import, no delivery address: clearance yes, delivery left unticked (said why)
  r = decideServices({ incoterm: 'FOB', direction: 'import', asked: {} });
  assert.deepEqual([r.needs_clearance, r.needs_transport], [true, false]); assert.match(r.reasons.join(' '), /Delivery not ticked/);
  // FOB import but asks pickup at the factory → flagged, not silently accepted
  r = decideServices({ incoterm: 'FOB', direction: 'import', asked: { origin_pickup: 'yes' } });
  assert.match(r.flags[0], /pickup at origin, but under FOB that is the seller's side/);
  // the customer's own words win: "we clear ourselves"
  assert.equal(decideServices({ incoterm: 'EXW', direction: 'import', asked: { import_clearance: 'no' } }).needs_clearance, false);
  // CIF import: the seller insures → no; asking for it anyway → flagged
  assert.equal(decideServices({ incoterm: 'CIF', direction: 'import', asked: {} }).insurance, 'no');
  assert.equal(decideServices({ incoterm: 'CIF', direction: 'import', asked: { insurance: 'yes' } }).flags.length, 1);
  // DAP import asking delivery → flagged (the seller pays the door delivery)
  assert.match(decideServices({ incoterm: 'DAP', direction: 'import', asked: { delivery: 'yes' } }).flags.join(), /not paid twice/);
  // FOB export: clearance + pickup; freight asked → flagged; EXW export: nothing of ours
  r = decideServices({ incoterm: 'FOB', direction: 'export', asked: { freight: 'yes' } });
  assert.deepEqual([r.needs_clearance, r.needs_transport], [true, true]); assert.match(r.flags.join(), /buyer pays the freight/);
  r = decideServices({ incoterm: 'EXW', direction: 'export', asked: {} });
  assert.deepEqual([r.needs_clearance, r.needs_transport], [false, false]);
  assert.equal(decideServices({ incoterm: 'CIP', direction: 'export', asked: {} }).insurance, 'yes');
  // DG
  assert.equal(dgFromText('General cargo, 5 pallets').dg, 'no');
  assert.equal(dgFromText('Non-DG household goods').dg, 'no');
  assert.deepEqual(dgFromText('General cargo but includes lithium batteries').dg, 'check');
  assert.equal(dgFromText('Furniture').dg, null);
  // ready
  assert.ok(saysReady('Cargo is ready for collection')); assert.ok(saysReady('goods ready for pickup at our warehouse'));
  assert.ok(!saysReady('please advise when you are ready'));
  const { ownWords } = require('../src/lib/opsRules');
  const reply = 'Hi, see below.\n\n-----Original Message-----\n- Whether the cargo is hazardous (DG): No\n- The date the cargo will be ready for pickup: 22 Nov';
  assert.equal(ownWords(reply).trim(), 'Hi, see below.'); assert.equal(dgFromText(ownWords(reply)).dg, null); assert.ok(!saysReady(ownWords(reply)));
  // questions not asked
  assert.ok(notNeeded('Stackable', { mode: 'sea_fcl' })); assert.equal(notNeeded('Stackable', { mode: 'sea_lcl' }), null);
  assert.ok(notNeeded('Hazardous (DG) cargo', { cargo_description: 'General cargo' }));
  assert.ok(notNeeded('Insurance required', { direction: 'import', incoterm: 'CIF' }));
});

test('a new enquiry email: EXW door to door, ready for collection, general cargo, remarks — nothing unnecessary asked', async () => {
  body = 'Dear team, please quote EXW Shanghai to Jebel Ali, 1x40HC, general cargo. Cargo is ready for collection. Pickup: No 8 Industrial Rd, Shanghai. Need fumigation certificate. Deliver to our Al Quoz warehouse.';
  answer = { mode: 'sea_fcl', incoterm: 'EXW', origin_country: 'China', origin_port: 'Shanghai', destination_port: 'Jebel Ali', pickup_address: 'No 8 Industrial Rd, Shanghai',
    delivery_address: 'Al Quoz warehouse, Dubai', cargo_description: 'General cargo', containers: '1x40HC', gross_weight_kg: 12000, hazardous: 'unknown', stackable: 'yes', insurance: 'unknown',
    general_cargo: true, cargo_ready_now: true, asked_services: { delivery: 'yes' }, customer_remarks: 'Need fumigation certificate',
    remark_impacts: ['Fumigation certificate: extra cost at origin — ask the agent to include it'], summary: 'EXW 1x40HC Shanghai to Jebel Ali' };
  const d: any = (await draftEnquiry(cora, rowId)).draft;
  assert.deepEqual([d.needs_clearance, d.needs_transport, d.cargo_ready_confirmed], [true, true, true]);
  const labels = await q(`select id, label from enquiry_checks`);
  const ans = (re: RegExp) => d.enquiry_details?.[labels.find((l: any) => re.test(l.label))?.id];
  assert.equal(ans(/ready/i), today(), 'no date given: today');
  assert.equal(ans(/hazard/i), 'no', 'general cargo = Non-DG');
  assert.equal(ans(/stack/i), undefined, 'FCL: stackable not taken / asked');
  assert.match(d.remarks, /Need fumigation certificate\nCustomer confirmed that the cargo is ready for collection\./);
  assert.match(d.ai_notes.remarks[0], /Fumigation/);
  assert.ok(d.ai_notes.services.some((t: string) => /EXW|delivery/i.test(t)));
  // what is still missing on that enquiry: no stackable, no DG, no ready date, no insurance asked for an EXW import? (insurance is asked: EXW buyer may insure)
  const { enquiryGaps } = await import('../src/lib/enquiryGaps');
  const checks = await q(`select * from enquiry_checks`);
  const gaps = enquiryGaps({ ...d, cargo_lines: [] }, checks).map((g) => g.label);
  assert.ok(!gaps.some((g) => /stack|hazard|ready/i.test(g)), gaps.join());
});

test('DG words are never a silent "no": flagged, DG left to ask', async () => {
  body = 'General cargo incl. lithium batteries, FOB Nhava Sheva, ready on 2027-01-10';
  answer = { mode: 'sea_lcl', incoterm: 'FOB', origin_country: 'India', origin_port: 'Nhava Sheva', destination_port: 'Jebel Ali', cargo_description: 'Electronics with lithium batteries',
    hazardous: 'no', general_cargo: true, cargo_ready_date: '2027-01-10', cargo_ready_now: false, asked_services: { origin_pickup: 'yes' }, summary: 's' };
  await q(`update outlook_inbox set ai_draft = null where id = $1`, [rowId]);
  const d: any = (await draftEnquiry(cora, rowId)).draft;
  const dg = (await one(`select id from enquiry_checks where label ~* 'hazard'`)).id;
  assert.equal(d.enquiry_details?.[dg], undefined);
  assert.ok(d.ai_notes.flags.some((t: string) => /DG words.*lithium/i.test(t)));
  assert.ok(d.ai_notes.flags.some((t: string) => /pickup at origin, but under FOB/.test(t)), 'scope clash flagged');
  assert.equal(d.cargo_ready_confirmed, false, 'a later date: not ready now');
  assert.equal(d.needs_transport, false);
});

test('a customer reply: "ready for collection" + general cargo + a remark → suggested, applied with the mark and remark', async () => {
  const cust = (await createMaster(sam, 'customers', { name: 'Al Noor' })).id;
  const f = await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali', cargo_description: 'Spare parts' });
  const before: any = await getJobFile(sam, f.id);
  const gapLabels = before.enquiry_gaps.map((g: any) => g.label);
  assert.ok(!gapLabels.some((g: string) => /insur/i.test(g)), 'CIF import: insurance not asked');
  const e = (await one(`insert into email_messages (job_file_id, direction, status, from_addr, subject, sent_at, body_text, source, created_by)
    values ($1, 'in', 'received', 'buyer@alnoor.ae', 'RE: enquiry', now(), $2, 'mailbox', $3) returning id`,
    [f.id, 'Hi, it is general cargo and ready for collection. Please use a tail-lift truck for delivery.', sam.id])).id;
  tool = 'record_answers';
  answer = { answers: [], unclear: [], summary: 'Ready, general cargo, tail-lift', remarks: 'Use a tail-lift truck for delivery', remark_impacts: ['Tail-lift truck: higher delivery cost'] };
  const s: any = (await readEmail(sam, e)).suggestion;
  const keys = s.answers.map((a: any) => a.key);
  const ready = before.enquiry_gaps.find((g: any) => /ready/i.test(g.label)).key, dg = before.enquiry_gaps.find((g: any) => /hazard/i.test(g.label)).key;
  assert.ok(keys.includes(ready) && keys.includes(dg) && keys.includes('cargo_ready_confirmed') && keys.includes('remarks'), keys.join());
  assert.equal(s.answers.find((a: any) => a.key === ready).value, today());
  assert.ok(s.unclear.some((u: any) => u.key === 'flag' && /Tail-lift/.test(u.note)));
  await applySuggestion(sam, s.id, { keys });
  const after: any = await getJobFile(sam, f.id);
  assert.equal(after.cargo_ready_confirmed, true); assert.ok(after.cargo_ready_confirmed_at);
  assert.equal(after.remarks, 'Customer confirmed that the cargo is ready for collection.\nUse a tail-lift truck for delivery');
  assert.equal(after.enquiry_details[dg], 'no');
  assert.ok(!after.enquiry_gaps.some((g: any) => /ready|hazard/i.test(g.label)));
});
