/**
 * Step 5 — handover to Transport. After the enquiry is handed over, the transport team gets the shipment's operational
 * details on their truck job: references, ports, vessel / ETA, containers, pickup and delivery addresses with contacts,
 * cargo lines and the operational documents (BL / AWB / CMR, DO, packing list, customs declaration, POD).
 * Never prices, never the commercial invoice or quotation — Transport stays cost-only, as before.
 */
import { Actor } from './auth';
import { forbidden, notFound, one, q } from './db';
import { fileStore } from './storage';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Documents a driver / dispatcher may need. The commercial invoice and anything about money are left out. */
export const TRANSPORT_DOC_TYPES = ['bill_of_lading', 'air_waybill', 'cmr', 'delivery_order', 'packing_list', 'customs_declaration', 'pod'];
const DOC_NAMES: Record<string, string> = { bill_of_lading: 'Bill of lading', air_waybill: 'Air waybill', cmr: 'CMR', delivery_order: 'Delivery order',
  packing_list: 'Packing list', customs_declaration: 'Customs declaration / BOE', pod: 'Proof of delivery' };

/** The shipment behind a truck job, as Transport may see it (null when the job is not linked to a shipment). */
export async function shipmentForTransport(jobFileId: string | null) {
  if (!jobFileId) return null;
  const f = await one(`select id, enquiry_ref, shipping_ref, job_no, direction, mode, incoterm, port_of_loading, port_of_discharge, origin, destination,
      carrier, vessel_flight, voyage, eta, ata, mbl_mawb, hbl_hawb, pickup_address, pickup_contact, delivery_address, delivery_contact,
      packages, package_type, gross_weight_kg, volume_cbm, cargo_description, needs_clearance, handed_over_at
    from job_files where id = $1 and deleted_at is null`, [jobFileId]);
  if (!f) return null;
  const [containers, lines, docs] = await Promise.all([
    q('select container_no, size_type, seal_no from job_file_containers where job_file_id = $1 and deleted_at is null order by container_no', [jobFileId]),
    q(`select line_no, package_type, package_other, pieces, length, width, height, dim_unit, weight_kg, cbm
         from job_file_cargo_lines where job_file_id = $1 and removed_at is null order by line_no`, [jobFileId]),
    q(`select id, doc_type, file_name, created_at from jf_documents
        where job_file_id = $1 and deleted_at is null and replaced_at is null and status <> 'rejected' and doc_type = any($2)
        order by created_at`, [jobFileId, TRANSPORT_DOC_TYPES]),
  ]);
  return { ...f, containers, cargo_lines: lines, documents: docs.map((d) => ({ ...d, doc_name: DOC_NAMES[d.doc_type] ?? d.doc_type })) };
}

/** Open one of those documents from the truck job: the person must be able to open the job, and the document must be on its shipment. */
export async function transportShipmentDocUrl(actor: Actor, jobId: string, docId: string, inline: boolean) {
  if (!isUuid(jobId) || !isUuid(docId)) throw notFound('Document');
  const { getJob } = await import('./jobs');
  await getJob(actor, jobId);                                     // the job's own permission and department rules
  const t = await one('select job_file_id from transport_requests where id = $1', [jobId]);
  const d = await one('select * from jf_documents where id = $1 and deleted_at is null and replaced_at is null', [docId]);
  if (!d || !t?.job_file_id || d.job_file_id !== t.job_file_id) throw notFound('Document');
  if (!TRANSPORT_DOC_TYPES.includes(d.doc_type)) throw forbidden('This document is not shared with Transport');
  return fileStore().downloadUrl(d.storage_path, d.file_name, inline);
}

/** "Name, phone" typed on the enquiry → the two request fields (the phone is whatever has digits). */
function splitContact(v: string | null | undefined) {
  const s = String(v ?? '').trim();
  if (!s) return { person: '', number: '' };
  const m = s.match(/^(.*?)[,;/–-]?\s*(\+?[\d][\d\s()-]{5,})\s*$/);
  return m ? { person: m[1].replace(/[,;\s]+$/, '').trim(), number: m[2].trim() } : { person: s, number: '' };
}

/** A transport request filled in from the shipment (who may open the shipment and create requests). */
export async function transportPrefill(actor: Actor, fileId: string) {
  if (!actor.has('jobs.create')) throw forbidden();
  const { getJobFile } = await import('./jobfiles');
  const f: any = await getJobFile(actor, fileId);
  const imp = f.direction === 'import';
  const port = (p: string | null) => p ? `${p}${f.mode === 'air' ? ' (airport)' : f.mode === 'road' ? '' : ' (port)'}` : '';
  const pick = imp ? { name: port(f.port_of_discharge) || f.destination || 'Port / airport of arrival', address: '', ...splitContact(null) }
    : { name: (f.pickup_address ?? '').split('\n')[0].slice(0, 120) || 'Pickup', address: f.pickup_address ?? '', ...splitContact(f.pickup_contact) };
  const drop = imp ? { name: (f.delivery_address ?? '').split('\n')[0].slice(0, 120) || 'Delivery', address: f.delivery_address ?? '', ...splitContact(f.delivery_contact) }
    : { name: port(f.port_of_loading) || f.origin || 'Port / airport of loading', address: '', ...splitContact(null) };
  const pallets = (f.cargo_lines ?? []).filter((l: any) => l.package_type === 'Pallets').reduce((s: number, l: any) => s + Number(l.pieces), 0);
  const conts = (f.containers ?? []).map((k: any) => `${k.container_no}${k.size_type ? ` ${k.size_type}` : ''}${k.seal_no ? ` seal ${k.seal_no}` : ''}`).join(', ');
  const sizes = (f.cargo_lines ?? []).map((l: any) => `${l.pieces} ${(l.package_type === 'Other' ? l.package_other : l.package_type).toLowerCase()} ${Number(l.length)}×${Number(l.width)}×${Number(l.height)} ${l.dim_unit}`).join('; ');
  return {
    job_no: f.job_no && f.job_no !== f.enquiry_ref ? f.job_no : '',
    department_id: f.department_id ?? '', customer_id: f.customer_id, customer_reference: f.customer_reference ?? '', booking_reference: f.booking_reference ?? '',
    shipment_number: f.hbl_hawb || f.mbl_mawb || f.shipping_ref || '',
    pickup_name: pick.name, pickup_address: pick.address, pickup_contact_person: pick.person, pickup_contact_number: pick.number,
    delivery_name: drop.name, delivery_address: drop.address, delivery_contact_person: drop.person, delivery_contact_number: drop.number,
    cargo_description: [f.cargo_description, sizes].filter(Boolean).join(' — ').slice(0, 1000),
    packages: f.packages ?? '', weight_kg: f.gross_weight_kg ?? '', volume_cbm: f.volume_cbm ?? '', pallets: pallets || '',
    special_instructions: [conts && `Containers: ${conts}`, f.vessel_flight && `Vessel / flight: ${[f.vessel_flight, f.voyage].filter(Boolean).join(' ')}`,
      f.eta && `ETA ${String(f.eta).slice(0, 10)}`].filter(Boolean).join(' · ').slice(0, 500),
    from_shipment: { id: f.id, ref: f.job_no && f.job_no !== f.enquiry_ref ? f.job_no : f.shipping_ref ?? f.enquiry_ref },
  };
}
