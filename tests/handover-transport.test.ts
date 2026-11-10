/** Step 5 — handover to Transport: the truck job shows the shipment's operational details and documents (never the
 *  commercial invoice or prices); a transport request can start filled in from the shipment. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, reqFields } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { createJob, getJob } from '../src/server/jobs';
import * as jf from '../src/server/jobfiles';
import { transportPrefill, transportShipmentDocUrl } from '../src/server/handover';

let admin: Actor, seaMgr: Actor, transport: Actor, customer: string, fileId: string, tripId: string, bl: string, inv: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  seaMgr = await mkUser(admin, 'SeaMgr', 'operations_manager', 'sea_import');
  transport = await mkUser(admin, 'Trans', 'transport_manager');
  customer = (await createMaster(seaMgr, 'customers', { name: 'Gulf Importers' })).id;
  const f = await jf.createJobFile(seaMgr, { job_no: 'SI-500', customer_id: customer, direction: 'import', mode: 'sea_lcl', needs_transport: true,
    port_of_loading: 'Ningbo', port_of_discharge: 'Jebel Ali', vessel_flight: 'MSC ANNA', voyage: '045W', eta: D(3), hbl_hawb: 'HBL-77',
    incoterm: 'EXW', pickup_address: 'Ningbo Tiles Co., Beilun', delivery_address: 'Warehouse 4, Al Quoz 3, Dubai', delivery_contact: 'Ali Khan, +971 50 123 4567',
    containers: [{ container_no: 'MSCU1234566', size_type: '40HC', seal_no: 'S9' }],
    cargo_lines: [{ package_type: 'Pallets', pieces: 4, length: 120, width: 100, height: 150, dim_unit: 'cm', weight_kg: 2000 },
                  { package_type: 'Cartons', pieces: 30, length: 60, width: 40, height: 40, dim_unit: 'cm', weight_kg: 450 }] });
  fileId = f.id;
  const doc = async (t: string) => (await one(`insert into jf_documents (job_file_id, doc_type, file_name, storage_path, mime_type, size_bytes, uploaded_by)
    values ($1, $2, $3, $4, 'application/pdf', 1000, $5) returning id`, [fileId, t, `${t}.pdf`, `jf/${fileId}/${t}.pdf`, seaMgr.id])).id;
  bl = await doc('bill_of_lading'); inv = await doc('commercial_invoice');
});

test('a request can start filled in from the shipment: Job No., port → delivery address, contact split, cargo and containers', async () => {
  await rejects(transportPrefill(transport, fileId), 'FORBIDDEN');          // Transport does not raise requests for Commercials
  const p: any = await transportPrefill(seaMgr, fileId);
  assert.equal(p.job_no, 'SI-500');
  assert.equal(p.pickup_name, 'Jebel Ali (port)');
  assert.equal(p.delivery_name, 'Warehouse 4, Al Quoz 3, Dubai');
  assert.deepEqual([p.delivery_contact_person, p.delivery_contact_number], ['Ali Khan', '+971 50 123 4567']);
  assert.equal(p.packages, 34); assert.equal(p.pallets, 4);
  assert.match(p.special_instructions, /MSCU1234566 40HC seal S9/);
  assert.match(p.special_instructions, /MSC ANNA 045W/);
  assert.match(p.cargo_description, /4 pallets 120×100×150 cm/);
  assert.equal(p.shipment_number, 'HBL-77');
  const t = await createJob(seaMgr, { ...reqFields(), ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'from_shipment')), required_date: D(4) });
  tripId = t.id;
});

test('Transport sees the shipment on the truck job — operational details and documents, never the invoice or prices', async () => {
  const j: any = await getJob(transport, tripId);
  assert.ok(j.shipment, 'the truck job is linked to the shipment by Job No.');
  assert.equal(j.shipment.cargo_lines.length, 2);
  assert.equal(j.shipment.containers[0].container_no, 'MSCU1234566');
  assert.deepEqual(j.shipment.documents.map((d: any) => d.doc_type), ['bill_of_lading']);
  const text = JSON.stringify(j.shipment);
  for (const word of ['quotation', 'sell', 'cost', 'margin', 'commercial_invoice']) assert.ok(!text.includes(word), `no "${word}" for Transport`);
  assert.ok(await transportShipmentDocUrl(transport, tripId, bl, true));
  await rejects(transportShipmentDocUrl(transport, tripId, inv, true), 'FORBIDDEN');
  // a document of another shipment cannot be reached through this job
  const other = await jf.createJobFile(seaMgr, { job_no: 'SI-501', customer_id: customer, direction: 'import', mode: 'sea_fcl' });
  const od = (await one(`insert into jf_documents (job_file_id, doc_type, file_name, storage_path, mime_type, size_bytes) values ($1, 'bill_of_lading', 'x.pdf', 'jf/x.pdf', 'application/pdf', 1) returning id`, [other.id])).id;
  await rejects(transportShipmentDocUrl(transport, tripId, od, true), 'NOT_FOUND');
  // a job without a shipment has no Shipment tab
  const lone = await createJob(seaMgr, { ...reqFields(), job_no: 'LONE-1', customer_id: customer, required_date: D(4), pickup_name: 'A', delivery_name: 'B' });
  assert.equal((await getJob(transport, lone.id)).shipment, null);
  void q;
});
