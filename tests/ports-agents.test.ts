/** Migration 034: the world port list, regions, agent coverage and the agents suggested for an enquiry's rate. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJobFile, getJobFile, updateJobFile } from '../src/server/jobfiles';
import { addPort, ensurePortsLoaded, listRegions, saveRegion, searchPorts } from '../src/server/ports';
import { saveCoverage, suggestAgents, listCoverage } from '../src/server/agents';
import { createVendorRequest } from '../src/server/vendorreqs';

let admin: Actor, cm: Actor, sam: Actor, cust: string;
const v: Record<string, string> = {};

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cm = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  const cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  cust = (await createMaster(sam, 'customers', { name: 'Eta Trading' })).id;
  for (const n of ['Hamburg Agent', 'Germany Agent', 'Euro Agent', 'France Agent', 'German Air Agent', 'German Delivery Agent', 'Paused Agent'])
    v[n] = (await createMaster(admin, 'vendors', { name: n, vendor_type: 'freight_agent', email: `${n.split(' ')[0].toLowerCase()}@agent.example` })).id;
});

test('the world port list loads once by itself; searching by name, code or airport code', async () => {
  await ensurePortsLoaded();
  const n = Number((await one('select count(*) n from ports'))!.n);
  assert.ok(n > 20000, `${n} ports`);
  await q('update ports set is_custom = is_custom');                              // nothing changes when it runs again
  await ensurePortsLoaded();
  assert.equal(Number((await one('select count(*) n from ports'))!.n), n);
  const jebel = (await searchPorts(sam, { q: 'jebel ali', kind: 'sea' })).rows;
  assert.equal(jebel[0].code, 'AEJEA');
  assert.equal(jebel[0].country_name, 'United Arab Emirates');
  assert.equal((await searchPorts(sam, { q: 'DXB', kind: 'air' })).rows[0].code, 'AEDXB');
  assert.equal((await searchPorts(sam, { q: 'deham' })).rows[0].name, 'Hamburg');
  assert.equal((await searchPorts(sam, { q: 'hamb', kind: 'sea' })).rows[0].code, 'DEHAM', 'big ports first');
  assert.equal((await searchPorts(sam, { q: 'hamb', kind: 'sea', country: 'DE' })).rows[0].code, 'DEHAM');
  assert.ok((await searchPorts(sam, { q: 'chennai', kind: 'sea' })).rows.some((r: any) => r.code === 'INMAA'));
  assert.ok(!(await searchPorts(sam, { q: 'jebel ali', kind: 'air' })).rows.some((r: any) => r.code === 'AEJEA'), 'a seaport is not offered as an airport');
});

test('your own port: made by the Commercials Manager, with its own code; a Salesman cannot', async () => {
  const p: any = await addPort(cm, { name: 'Dubai Logistics City ICD', country_code: 'AE', kind: 'inland' });
  assert.match(p.code, /^AEX\d\d$/);
  assert.equal((await searchPorts(sam, { q: 'logistics city', kind: 'sea' })).rows[0].code, p.code);
  await assert.rejects(addPort(sam, { name: 'X', country_code: 'AE' }), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(addPort(cm, { name: 'Y', country_code: 'AE', code: 'DEXYZ' }), /must start with AE/);
});

test('regions: the starting set is there; names are unique; only real countries', async () => {
  const r = await listRegions(cm);
  assert.ok(r.rows.some((x: any) => x.name === 'North Europe' && x.countries.includes('DE')));
  await saveRegion(cm, { name: 'Baltics', countries: ['EE', 'LV', 'LT'] });
  await assert.rejects(saveRegion(cm, { name: 'baltics', countries: ['EE'] }), /already exists/);
  await assert.rejects(saveRegion(cm, { name: 'Bad', countries: ['ZZ'] }), /not in the list/);
  await assert.rejects(saveRegion(sam, { name: 'Mine', countries: ['DE'] }), (e: any) => e.code === 'FORBIDDEN');
});

test('agent coverage: port, country or region, with modes, side and priority; no duplicates', async () => {
  const ne = (await listRegions(cm)).rows.find((x: any) => x.name === 'North Europe').id;
  await saveCoverage(cm, v['Hamburg Agent'], { scope: 'port', port_code: 'DEHAM', priority: 1 });
  await saveCoverage(cm, v['Germany Agent'], { scope: 'country', country_code: 'DE' });
  await saveCoverage(cm, v['Euro Agent'], { scope: 'region', region_id: ne, priority: 3 });
  await saveCoverage(cm, v['France Agent'], { scope: 'country', country_code: 'FR' });
  await saveCoverage(cm, v['German Air Agent'], { scope: 'country', country_code: 'DE', modes: ['air'] });
  await saveCoverage(cm, v['German Delivery Agent'], { scope: 'country', country_code: 'DE', side: 'destination' });
  await saveCoverage(cm, v['Paused Agent'], { scope: 'country', country_code: 'DE' });
  await q('update vendors set is_active = false where id = $1', [v['Paused Agent']]);
  await assert.rejects(saveCoverage(cm, v['Germany Agent'], { scope: 'country', country_code: 'de' }), /already in this agent's coverage/);
  await assert.rejects(saveCoverage(sam, v['Germany Agent'], { scope: 'country', country_code: 'FR' }), (e: any) => e.code === 'FORBIDDEN');
  const l = await listCoverage(sam, v['Hamburg Agent']);
  assert.equal(l.can_manage, false); assert.equal(l.rows[0].port_name, 'Hamburg');
});

test('"collection anywhere in Germany": every agent covering Germany is suggested, best match first', async () => {
  const f = await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali', pod_code: 'AEJEA', origin_country: 'DE' });
  const s = await suggestAgents(sam, f.id);
  assert.equal(s.ends.length, 1, 'the UAE end needs no agent');
  const o = s.ends[0];
  assert.equal(o.end, 'origin'); assert.match(o.label, /Germany \(any port\)/);
  assert.deepEqual(o.agents.map((a: any) => a.name), ['Hamburg Agent', 'Germany Agent', 'Euro Agent'], 'preferred first, region last');
  // with the port known, the agent of that port comes first
  await updateJobFile(sam, f.id, { port_of_loading: 'Hamburg', pol_code: 'DEHAM' });
  const s2 = await suggestAgents(sam, f.id);
  assert.deepEqual(s2.ends[0].agents.map((a: any) => [a.name, a.matched]),
    [['Hamburg Agent', 'Port: Hamburg'], ['Germany Agent', 'Country: Germany'], ['Euro Agent', 'Region: North Europe']]);
  const g: any = await getJobFile(sam, f.id);
  assert.equal(g.pol_code, 'DEHAM'); assert.equal(g.origin_country, 'DE');
  await assert.rejects(updateJobFile(sam, f.id, { pol_code: 'Hamburg port' }), /Choose the port from the list/);
  // air: only the air agent and the agents for every mode
  const air = await createJobFile(sam, { customer_id: cust, division: 'imports', mode: 'air', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Dubai', origin_country: 'DE',
    cargo_lines: [{ package_type: 'Cartons', pieces: 5, length: 40, width: 30, height: 30, dim_unit: 'cm', weight_kg: 60 }] });
  assert.ok((await suggestAgents(sam, air.id)).ends[0].agents.some((a: any) => a.name === 'German Air Agent'));
  // export to Germany: the destination side (the delivery agent too)
  const ex = await createJobFile(sam, { customer_id: cust, division: 'exports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'FOB', pickup_address: 'JAFZ', port_of_loading: 'Jebel Ali', pol_code: 'AEJEA', destination_country: 'DE' });
  const e = await suggestAgents(sam, ex.id);
  assert.equal(e.ends[0].end, 'destination');
  assert.ok(e.ends[0].agents.some((a: any) => a.name === 'German Delivery Agent'));
  // one rate request to all of them (more than 10 at a time is fine now)
  const r = await createVendorRequest(sam, { job_file_id: f.id, service: 'rate', description: '1x40HC Hamburg to Jebel Ali', vendor_ids: s2.ends[0].agents.map((a: any) => a.vendor_id) });
  assert.equal(r.ids.length, 3);
});
