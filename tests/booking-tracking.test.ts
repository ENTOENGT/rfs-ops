/** 24 Nov (migration 042): the AI reads the line's / agent's booking emails (confirmation, roll-over, sailed) — nothing saved
 *  until a person presses Save booking; Track buttons; Sailed / Arrived by hand; the hourly reminders, each sent once. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q, tx } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as cm from '../src/server/commercial';
import { setAiNetwork } from '../src/server/ai';
import { fileOnShipment } from '../src/server/inbox';
import { applyBooking, bookingBox, dismissBooking, markTracking, readBooking, trackingFor } from '../src/server/bookingreader';
import { quoteBox, readQuote } from '../src/server/quotereader';
import { runShipmentReminders } from '../src/server/reminders';
import { DEFAULT_TRACKING, lineFor, parseTracking, trackLinks } from '../src/lib/tracking';
import { saveSettings } from '../src/server/workflow';

let admin: Actor, cora: Actor, ops: Actor, fileId: string, rate: any, agent: string;
let answer: any = {};
const D = (n: number) => { const d = new Date(Date.now() + n * 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }); };
const mail = (over: any) => ({ internet_message_id: `<${Math.random()}@x>`, conversation_id: null, to_addrs: 'coracoord@x.ae', cc_addrs: null,
  received_at: new Date(Date.now() + 60000).toISOString(), has_attachments: false, web_link: null, body_excerpt: '', ...over });
const file = async (m: any, id = fileId) => { await tx((c) => fileOnShipment(c, cora, id, m, 'tag')); return one('select * from email_messages where message_id = $1', [m.internet_message_id]); };

before(async () => {
  await resetDb();
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  ops = await mkUser(admin, 'Otto Viewer', 'transport_manager');
  const sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  const cust = (await createMaster(sam, 'customers', { name: 'Red Chief', email: 'buy@redchief.in' })).id;
  agent = (await createMaster(admin, 'vendors', { name: 'MSC Agency', vendor_type: 'shipping_line', email: 'rates@msc-agency.com' })).id;
  fileId = (await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB', port_of_loading: 'Nhava Sheva', port_of_discharge: 'Jebel Ali' })).id;
  await q(`update job_files set coordinator_id = $2 where id = $1`, [fileId, cora.id]);
  rate = await vr.createVendorRequest(admin, { vendor_id: agent, service: 'rate', job_file_id: fileId, description: '1x40HC Nhava Sheva → Jebel Ali' });
  await vr.vendorRequestAction(admin, rate.id, { status: 'quoted', quoted_cost: '1000', currency: 'USD' });
  await q(`update job_files set stage = 'customer_confirmed' where id = $1`, [fileId]);
  setAiNetwork((async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_booking', input: answer }] }), { status: 200 })) as typeof fetch);
});

test('the booking request: the line\'s reply is matched to it (even in the old rate thread), not read as a rate', async () => {
  await cm.requestBooking(cora, fileId, { rate_request_id: rate.id });
  const f = await one('select booking_vendor_request_id b, stage from job_files where id = $1', [fileId]);
  assert.equal(f.stage, 'booking_requested');
  const e = await file(mail({ from_addr: 'ops@msc-agency.com', from_name: 'Ravi', subject: `RE: Rate request ${rate.request_no}` }));
  assert.equal(e.vendor_request_id, f.b, 'once booked, the vendor\'s mail is about the booking');
  await assert.rejects(readQuote(admin, e.id), /about the booking/);
  assert.deepEqual((await quoteBox(admin, fileId) as any).unread, [], 'the rate box does not offer it');
  const box: any = await bookingBox(cora, fileId);
  assert.deepEqual(box.unread.map((m: any) => m.id), [e.id]);
  assert.deepEqual(await bookingBox(ops, fileId), { allowed: false }, 'only people who can change the shipment');
});

test('confirmation read by AI → old → new; Save booking = the normal "Booking confirmed" step, containers added once', async () => {
  const e = (await one(`select id from email_messages where job_file_id = $1 and direction = 'in' order by created_at desc limit 1`, [fileId])).id;
  answer = { kind: 'confirmation', booking_reference: 'MSCBK7788', carrier: 'MSC', vessel: 'MSC ANNA', voyage: '045W', etd: D(5), eta: D(20),
    port_of_loading: 'Nhava Sheva', port_of_discharge: 'Jebel Ali', routing_type: 'direct', booked_equipment: '1 x 40HC',
    cutoff_si: `${D(3)} 12:00`, cutoff_vgm: `${D(3)} 18:00`, cutoff_gate: D(4), empty_pickup: 'JNPT CFS depot, release 4455',
    containers: [{ container_no: 'MSCU1234566', size_type: '40HC' }, { container_no: 'MSCU1234565' }, { container_no: 'bad' }],
    sailed_on: D(6), summary: 'Booking confirmed on MSC ANNA', quote: 'Booking MSCBK7788 confirmed' };
  const s: any = (await readBooking(cora, fileId, e)).suggestion;
  assert.equal(s.status, 'open');
  assert.equal(s.answers.fields.atd, undefined, 'a sailing date in the future is a plan, not a fact');
  assert.deepEqual(s.answers.containers.map((k: any) => k.container_no), ['MSCU1234566'], 'wrong check digit left out');
  assert.match(JSON.stringify(s.unclear), /MSCU1234565 has a wrong check digit/);
  assert.equal(s.answers.fields.cutoff_gate, `${D(4)} 00:00`);
  assert.equal((await one('select stage, booking_reference from job_files where id = $1', [fileId])).booking_reference, null, 'nothing saved by the AI');
  assert.equal((await readBooking(cora, fileId, e)).suggestion.id, s.id, 'read once');
  const box: any = await bookingBox(cora, fileId);
  const ch = box.open[0].changes;
  assert.ok(ch.some((c: any) => c.key === 'vessel_flight' && c.old === null && c.new === 'MSC ANNA'));
  assert.ok(!ch.some((c: any) => c.key === 'port_of_loading'), 'already on the shipment: not a change');
  assert.ok(box.first);
  // the person unticks the empty pick-up and corrects the voyage
  const fields = Object.fromEntries(ch.filter((c: any) => c.key !== 'empty_pickup').map((c: any) => [c.key, c.key === 'voyage' ? '046W' : c.new]));
  await applyBooking(cora, s.id, { fields, containers: ['MSCU1234566'] });
  const f = await one(`select stage, booking_reference, vessel_flight, voyage, etd::text, empty_pickup, to_char(cutoff_si, 'YYYY-MM-DD HH24:MI') si from job_files where id = $1`, [fileId]);
  assert.deepEqual([f.stage, f.booking_reference, f.vessel_flight, f.voyage, f.etd, f.empty_pickup, f.si], ['prealert_awaited', 'MSCBK7788', 'MSC ANNA', '046W', D(5), null, `${D(3)} 12:00`]);
  assert.equal((await one('select status from vendor_requests where id = (select booking_vendor_request_id from job_files where id = $1)', [fileId])).status, 'confirmed');
  assert.equal((await one('select count(*)::int n from job_file_containers where job_file_id = $1', [fileId])).n, 1);
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title = 'SI / documents cut-off filled in'`, [fileId]));
  assert.ok(await one(`select 1 from notifications where job_file_id = $1 and event = 'booking_confirmed' and user_id = (select salesman_id from job_files where id = $1)`, [fileId]));
  await assert.rejects(applyBooking(cora, s.id, { fields }), /already handled/);
});

test('roll-over: the new vessel / dates go through the vessel step (team told, verify again); container again = no duplicate', async () => {
  await q(`update job_files set vessel_status = 'verified' where id = $1`, [fileId]);
  const e = await file(mail({ from_addr: 'ops@msc-agency.com', subject: 'Roll-over notice MSCBK7788' }));
  answer = { kind: 'update', booking_reference: 'MSCBK7788', vessel: 'MSC BELLA', voyage: '047W', etd: D(9), eta: D(24), containers: [{ container_no: 'MSCU1234566' }], summary: 'Rolled over to MSC BELLA' };
  const s: any = (await readBooking(cora, fileId, e.id)).suggestion;
  const box: any = await bookingBox(cora, fileId);
  const o = box.open.find((x: any) => x.id === s.id);
  assert.deepEqual(o.changes.map((c: any) => [c.key, c.old, c.new]), [['vessel_flight', 'MSC ANNA', 'MSC BELLA'], ['voyage', '046W', '047W'], ['etd', D(5), D(9)], ['eta', D(20), D(24)]]);
  assert.deepEqual(o.new_containers, [], 'already on the shipment');
  await applyBooking(cora, s.id, { fields: Object.fromEntries(o.changes.map((c: any) => [c.key, c.new])), containers: ['MSCU1234566'] });
  const f = await one(`select vessel_flight, voyage, etd::text, eta::text, vessel_status from job_files where id = $1`, [fileId]);
  assert.deepEqual([f.vessel_flight, f.voyage, f.etd, f.eta, f.vessel_status], ['MSC BELLA', '047W', D(9), D(24), 'received']);
  const legs = await q('select vessel, etd::text from shipment_legs where job_file_id = $1', [fileId]);
  assert.deepEqual(legs.map((l: any) => [l.vessel, l.etd]), [['MSC BELLA', D(9)]]);
  assert.ok(await one(`select 1 from notifications where job_file_id = $1 and event = 'vessel_changed'`, [fileId]));
  assert.equal((await one('select count(*)::int n from job_file_containers where job_file_id = $1', [fileId])).n, 1);
  // nothing new → no Save; an email that says nothing useful is "nothing"
  const e2 = await file(mail({ from_addr: 'ops@msc-agency.com', subject: 'Thanks' }));
  answer = { kind: 'other', summary: 'Thanks' };
  assert.equal((await readBooking(cora, fileId, e2.id)).suggestion.status, 'nothing');
  await dismissBooking(cora, (await one(`select id from ai_suggestions where email_id = $1`, [e2.id])).id);
});

test('Track buttons: the line\'s page by container, the vessel; Settings can change the list', async () => {
  const t: any = await trackingFor(cora, fileId);
  assert.deepEqual(t.links.map((l: any) => l.url), ['https://www.msc.com/en/track-a-shipment?trackingNumber=MSCU1234566', 'https://www.vesselfinder.com/vessels?name=MSC%20BELLA']);
  assert.equal(lineFor(DEFAULT_TRACKING, 'Maersk Line')?.name, 'Maersk');
  assert.equal(lineFor(DEFAULT_TRACKING, 'Kaplan Logistics'), null, '"apl" inside another word is not APL');
  assert.equal(lineFor(DEFAULT_TRACKING, 'APL')?.name, 'CMA CGM');
  assert.match(trackLinks(DEFAULT_TRACKING, { carrier: 'Unknown Lines', containers: [{ container_no: 'ABCU1234560' }] })[0].url, /track-trace\.com/);
  assert.equal(trackLinks(DEFAULT_TRACKING, { mode: 'air', carrier: 'Emirates', mbl_mawb: '176-12345675', vessel_flight: 'EK 512' }).length, 1, 'air: the AWB, no vessel map');
  await assert.rejects(saveSettings(admin, { tracking_links: 'MSC | msc | https://example.com/no-number' }), /\{number\}/);
  await saveSettings(admin, { tracking_links: 'MSC | msc | https://track.example.com/?n={number}' });
  assert.equal((await trackingFor(cora, fileId) as any).links[0].url, 'https://track.example.com/?n=MSCU1234566');
  assert.equal(parseTracking('bad line\nX | x | http://not-https/{number}').length, 0);
});

test('Sailed / Arrived by hand (not in the future, not before sailing), told to the team; reminders once each', async () => {
  // ETD has passed without sailing → reminded once
  await q(`update job_files set etd = $2, eta = $3 where id = $1`, [fileId, D(-1), D(2)]);
  let r = await runShipmentReminders(D(0));
  assert.deepEqual([r.sent.etd_passed, r.sent.eta_soon], [1, 1]);
  r = await runShipmentReminders(D(0));
  assert.deepEqual([r.sent.etd_passed, r.sent.eta_soon, r.sent.eta_changed], [0, 0, 0], 'never twice');
  assert.ok(await one(`select 1 from notifications where job_file_id = $1 and event = 'etd_passed' and user_id = $2`, [fileId, cora.id]));
  // the ETA moves (by hand, nobody told) → "ETA changed" once
  await q(`delete from notifications where job_file_id = $1`, [fileId]);
  await q(`update job_files set eta = $2 where id = $1`, [fileId, D(10)]);
  r = await runShipmentReminders(D(0));
  assert.equal(r.sent.eta_changed, 1);
  assert.match((await one(`select title from notifications where job_file_id = $1 and event = 'eta_changed' limit 1`, [fileId])).title, /ETA changed — from/);
  // cut-off tomorrow
  await q(`update job_files set cutoff_vgm = $2 where id = $1`, [fileId, `${D(1)} 18:00`]);
  r = await runShipmentReminders(D(0));
  assert.equal(r.sent.cutoff_soon, 1);
  // Sailed / Arrived
  await assert.rejects(markTracking(cora, fileId, { what: 'sailed', date: D(2) }), /future/);
  await assert.rejects(markTracking(ops, fileId, { what: 'sailed', date: D(0) }), /cannot change/);
  await markTracking(cora, fileId, { what: 'sailed', date: D(-1) });
  await assert.rejects(markTracking(cora, fileId, { what: 'arrived', date: D(-2) }), /before it sailed/);
  const t: any = await markTracking(cora, fileId, { what: 'arrived', date: D(0) });
  assert.deepEqual([t.atd, t.ata], [D(-1), D(0)]);
  assert.ok(await one(`select 1 from notifications where job_file_id = $1 and event = 'arrived'`, [fileId]));
  assert.ok(await one(`select 1 from job_file_events where job_file_id = $1 and title = 'Sailed on'`, [fileId]));
  await q(`update job_files set etd = $2 where id = $1`, [fileId, D(-3)]);
  assert.equal((await runShipmentReminders(D(0))).sent.etd_passed, 0, 'sailed: no ETD reminder');
});
