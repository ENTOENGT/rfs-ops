/** 25 Nov (migration 044): local charges rate cards; worked out per container / BL / document / kg (minimum) / DG;
 *  "if applicable" lines shown but not in the total; any vendor's rate as its own option. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile } from '../src/server/jobfiles';
import * as vr from '../src/server/vendorreqs';
import * as qt from '../src/server/quotations';
import { calcLocal, containersFrom, getCard, listCards, saveCard } from '../src/server/localcharges';
import { routeAction } from '../src/server/routing';
import { emailDraft } from '../src/server/emails';

let admin: Actor, cora: Actor, boss: Actor, sam: Actor, cust: string;
const D = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const byName = (r: any, s: string) => r.lines.filter((l: any) => l.description.startsWith(s));

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  boss = await mkUser(admin, 'Ben Boss', 'commercials_manager');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  cust = (await createMaster(sam, 'customers', { name: 'Red Chief', email: 'buy@redchief.in' })).id;
});

const fcl = async (extra: any = {}) => (await createJobFile(cora, { customer_id: cust, salesman_id: sam.id, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB',
  port_of_loading: 'Nhava Sheva', port_of_discharge: 'Jebel Ali', origin: 'Mumbai', destination: 'Dubai', cargo_description: 'Rice, 2x40HC', delivery_address: 'DIC, Dubai', ...extra })).id;

test('containers from the enquiry text', () => {
  assert.deepEqual(containersFrom('2x40HC'), { n20: 0, n40: 2 });
  assert.deepEqual(containersFrom('1 x 20GP and 3 X 40\' HC'), { n20: 1, n40: 3 });
  assert.deepEqual(containersFrom("40' HQ x 2"), { n20: 0, n40: 2 });
  assert.equal(containersFrom('rice in bags'), null);
  assert.deepEqual(containersFrom('RE: 2x40HC Mumbai — please quote 2x40HC'), { n20: 0, n40: 2 }, 'the same said twice is not added up');
});

test('Jebel Ali FCL, 2 x 40 ft on one BL: per container × 2, per BL / document × 1; our selling charge not ticked; "if applicable" apart', async () => {
  const id = await fcl();
  await q('update job_files set needs_clearance = true, needs_transport = true where id = $1', [id]);
  const v = (await createMaster(admin, 'vendors', { name: `Line ${Math.random()}`, vendor_type: 'shipping_line', email: `l${Date.now()}@x.ae` })).id;
  await vr.createVendorRequest(cora, { vendor_id: v, service: 'rate', job_file_id: id, description: '2x40HC Nhava Sheva to Jebel Ali' });   // said twice: still 2
  const r: any = await calcLocal(cora, { file_id: id });
  assert.equal(r.card.name, 'Sea import FCL – Jebel Ali clearance');
  const thc = byName(r, 'Terminal handling')[0];
  assert.deepEqual([thc.description, thc.quantity, thc.cost_rate, thc.amount, thc.note], ['Terminal handling (THC) (40 ft)', '2', '1100.00', '2200.00', 'as per receipt']);
  assert.deepEqual(byName(r, 'Port handling').map((l: any) => [l.quantity, l.amount]), [['2', '628.00']]);
  assert.deepEqual(byName(r, 'DPC').map((l: any) => [l.charge_unit, l.quantity, l.amount]), [['document', '1', '55.00']]);
  assert.deepEqual(byName(r, 'Delivery order').map((l: any) => [l.charge_unit, l.quantity, l.amount]), [['bl', '1', '580.00']]);
  const rfs = byName(r, 'RFS handling')[0];
  assert.deepEqual([rfs.sell_only, rfs.include, rfs.cost_rate, rfs.sell_rate], [true, false, '0.00', '250.00']);
  assert.ok(byName(r, 'Inspection')[0].optional);
  assert.ok(r.missing.some((m: string) => /DIC, Dubai/.test(m)), 'the delivery address is shown to check the trucking');
  // not asked for transport (e.g. FOB, port to port): the transport lines are left unticked, and it says so
  await q('update job_files set needs_transport = false where id = $1', [id]);
  const nt: any = await calcLocal(cora, { file_id: id });
  assert.equal(byName(nt, 'Transportation')[0].include, false);
  assert.ok(nt.missing.some((m: string) => /Transport left unticked/.test(m)));
  // DG: THC +500 per container; 20 ft has its own amount
  const dg: any = await calcLocal(cora, { file_id: id, dg: true, n20: 1, n40: 0 });
  assert.deepEqual(byName(dg, 'Terminal handling').map((l: any) => [l.description, l.cost_rate]), [['Terminal handling (THC) (20 ft)', '1200.00']]);
  // another port → its own card; a port with no card → said plainly
  assert.equal((await calcLocal(cora, { file_id: await fcl({ port_of_discharge: 'Khorfakkan' }) }) as any).card.name, 'Sea import FCL – Khorfakkan clearance');
  const none: any = await calcLocal(cora, { file_id: await fcl({ port_of_discharge: 'Sharjah' }) });
  assert.equal(none.card, null); assert.match(none.missing[0], /No card fits/);
  // in USD: converted with the rate in Settings
  await q(`insert into settings (key, value) values ('fx_USD', '3.6725') on conflict (key) do update set value = excluded.value`);
  const usd: any = await calcLocal(cora, { file_id: id, currency: 'USD' });
  assert.equal(byName(usd, 'DPC')[0].cost_rate, '14.98');
});

test('air: the airline picks the card (Emirates or DNATA); per kg with a minimum', async () => {
  const air = await fcl({ port_of_discharge: 'Dubai DXB', cargo_description: 'Spare parts' });
  await q(`update job_files set mode = 'air' where id = $1`, [air]);
  const small: any = await calcLocal(cora, { file_id: air, kg: 150, dg: false });
  assert.equal(small.card.name, 'Air import – DNATA (non-DG)');
  assert.deepEqual(byName(small, 'Handling').map((l: any) => [l.charge_unit, l.quantity, l.cost_rate]), [['shipment', '1', '34.00']], '0.17 × 150 = 25.50 → minimum 34');
  const big: any = await calcLocal(cora, { file_id: air, kg: 1000, dg: false });
  assert.deepEqual(byName(big, 'Handling').map((l: any) => [l.charge_unit, l.quantity, l.cost_rate]), [['kg', '1000', '0.17']]);
  const ek: any = await calcLocal(cora, { file_id: air, kg: 1000, dg: true, carrier: 'Emirates SkyCargo' });
  assert.equal(ek.card.name, 'Air import – Emirates (DG)');
});

test('the cards: team leaders change them (old version kept); others only read; cost needed to see them', async () => {
  await assert.rejects(saveCard(cora, null, { name: 'X', mode: 'air', direction: 'import', lines: [{ description: 'DO', unit: 'bl', cost: 1 }] }), /cannot add local charges/);
  assert.equal((await listCards(cora) as any).can_manage, false, 'a coordinator reads the cards, does not change them');
  const list: any = await listCards(boss);
  assert.ok(list.can_manage && list.cards.length >= 6);
  const id = list.cards.find((c: any) => c.name === 'Air import – DNATA (non-DG)').id;
  const c: any = await getCard(boss, id);
  await assert.rejects(saveCard(boss, id, { ...c.card, lines: [{ description: 'DO', unit: 'kg' }] }), /enter the amount/);
  const saved: any = await saveCard(boss, id, { ...c.card, lines: c.lines.map((l: any) => (l.description === 'Delivery order' ? { ...l, cost: 160 } : l)) });
  assert.equal(saved.card.version, 2);
  assert.equal(saved.lines.find((l: any) => l.description === 'Delivery order').cost, '160.00');
  assert.equal(saved.history.length, 1);
  assert.ok(await one(`select 1 from audit_log where entity_type = 'local_charge_card' and entity_id = $1`, [id]));
});

test('quotation: "if applicable" lines are shown but not in the total; local charges under their own heading', async () => {
  const id = await fcl();
  const L = (d: string, cost: string, sell: string, extra: any = {}) => ({ description: d, charge_unit: 'container', quantity: '2', cost_rate: cost, sell_rate: sell, ...extra });
  const x = await qt.createQuotation(cora, { customer_id: cust, service_type: 'sea_fcl', job_file_id: id, salesman_id: sam.id, valid_until: D(10), lines: [
    L('Ocean freight', '1000', '1200'),
    L('Terminal handling (THC) (40 ft)', '1100', '1100', { section: 'local', note: 'as per receipt' }),
    L('Inspection charges', '200', '200', { section: 'local', optional: true, internal_note: 'From the card' })] });
  const g: any = await qt.getQuotation(cora, x.id);
  assert.equal(g.totals.sell_total, '4600.00', 'inspection (400) not counted');
  assert.deepEqual(g.lines.map((l: any) => [l.section, l.optional]), [['freight', false], ['local', false], ['local', true]]);
  assert.equal(g.lines[2].internal_note, 'From the card');
  await q(`update quotations set status = 'approved', approved_at = now() where id = $1`, [x.id]);
  const c: any = await qt.customerCopy(cora, x.id, 'pdf');
  assert.equal(c.total, '4600.00');
  assert.doesNotMatch(JSON.stringify(c), /From the card/, 'the staff note never goes to the customer');
  const d: any = await emailDraft(cora, { kind: 'quotation', id: x.id });
  assert.match(d.body, /Local charges:\n• Terminal handling \(THC\) \(40 ft\) \(as per receipt\)/);
  assert.match(d.body, /If applicable \(not included in the total\):\n• Inspection charges/);
});

test('any vendor\'s quoted rate can be offered as its own option (label for the customer); not while it is on a quotation', async () => {
  const id = await fcl();
  const v1 = (await createMaster(admin, 'vendors', { name: 'Agent One', vendor_type: 'freight_agent', email: 'a1@x.ae' })).id;
  const v2 = (await createMaster(admin, 'vendors', { name: 'Agent Two', vendor_type: 'freight_agent', email: 'a2@x.ae' })).id;
  const a = await vr.createVendorRequest(cora, { vendor_id: v1, service: 'rate', job_file_id: id, description: '2x40HC' });
  const b = await vr.createVendorRequest(cora, { vendor_id: v2, service: 'rate', job_file_id: id, description: '2x40HC' });
  await vr.vendorRequestAction(admin, a.id, { status: 'quoted', quoted_cost: '2400', currency: 'USD', carrier: 'MSC' });
  await vr.vendorRequestAction(admin, b.id, { status: 'quoted', quoted_cost: '2100', currency: 'USD', carrier: 'CMA CGM', routing: 'via Colombo' });
  await routeAction(cora, id, { step: 'own_option', request_id: b.id, label: 'CMA CGM via Colombo' });
  const routes = await q('select id, option_no, pod, label from enquiry_routes where job_file_id = $1 order by option_no', [id]);
  assert.deepEqual(routes.map((r: any) => [r.option_no, r.pod, r.label]), [[1, 'Jebel Ali', null], [2, 'Jebel Ali', 'CMA CGM via Colombo']]);
  const rs = await q('select id, route_id from vendor_requests where id in ($1, $2)', [a.id, b.id]);
  assert.equal(rs.find((r: any) => r.id === a.id).route_id, routes[0].id);
  assert.equal(rs.find((r: any) => r.id === b.id).route_id, routes[1].id);
  await assert.rejects(routeAction(cora, id, { step: 'own_option', request_id: b.id }), /already the only one/);
  // used on a quotation: take it off there first
  const c = await vr.createVendorRequest(cora, { vendor_id: v2, service: 'rate', job_file_id: id, route_id: routes[0].id, description: 'again' });
  await vr.vendorRequestAction(admin, c.id, { status: 'quoted', quoted_cost: '2000', currency: 'USD' });
  await qt.createQuotation(cora, { customer_id: cust, service_type: 'sea_fcl', job_file_id: id, salesman_id: sam.id, valid_until: D(10),
    lines: [{ description: 'Freight', charge_unit: 'shipment', quantity: '1', cost_rate: '7000', sell_rate: '8000', vendor_request_id: c.id, route_id: routes[0].id }] });
  await assert.rejects(routeAction(cora, id, { step: 'own_option', request_id: c.id }), /used on quotation/);
});
