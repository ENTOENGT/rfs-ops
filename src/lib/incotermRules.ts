/**
 * Incoterm rules on an enquiry (migration 023): the term says where our work starts and ends, so it decides which
 * addresses and details the enquiry must have before it is opened. Same rules on the screen and on the server.
 *
 * Import  = our customer is the buyer in the UAE.   Export = our customer is the seller in the UAE.
 * Cross trade is treated like export (we move it from the seller's side).
 */
export type IncotermField = 'pickup_address' | 'named_place' | 'port_of_loading' | 'port_of_discharge' | 'delivery_address' | 'cargo_value';

export const INCOTERM_INFO: Record<string, { name: string; text: string }> = {
  EXW: { name: 'Ex Works', text: 'The buyer arranges everything from the seller\'s door: pickup, export clearance, freight and delivery.' },
  FCA: { name: 'Free Carrier', text: 'The seller clears export and hands the cargo to the buyer\'s carrier at a named place.' },
  FAS: { name: 'Free Alongside Ship', text: 'The seller delivers the cargo alongside the vessel at the port of loading.' },
  FOB: { name: 'Free On Board', text: 'The seller loads the cargo on board at the port of loading. The buyer pays the freight from there.' },
  CFR: { name: 'Cost and Freight', text: 'The seller pays the freight to the port of discharge. The buyer handles it from arrival.' },
  CIF: { name: 'Cost, Insurance and Freight', text: 'Like CFR, plus the seller insures the cargo to the port of discharge.' },
  CPT: { name: 'Carriage Paid To', text: 'The seller pays the carriage to the named destination. The buyer handles it from there.' },
  CIP: { name: 'Carriage and Insurance Paid', text: 'Like CPT, plus the seller insures the cargo to the destination.' },
  DAP: { name: 'Delivered at Place', text: 'The seller delivers to the buyer\'s address, ready for unloading. The buyer pays import duty.' },
  DPU: { name: 'Delivered at Place Unloaded', text: 'Like DAP, but the seller also unloads at the buyer\'s address.' },
  DDP: { name: 'Delivered Duty Paid', text: 'The seller delivers to the buyer\'s address and pays import clearance and duty.' },
};

export const FIELD_LABEL: Record<IncotermField, string> = {
  pickup_address: 'Pickup (loading) address', named_place: 'Handover place', port_of_loading: 'Port of loading',
  port_of_discharge: 'Port of discharge', delivery_address: 'Delivery address', cargo_value: 'Cargo value (for insurance)',
};

/** What the enquiry needs for this term and direction, plus one line saying what our job covers. */
export function incotermNeeds(term: string | null | undefined, direction: string | null | undefined, needsTransport?: boolean, mode?: string | null) {
  const t = String(term ?? '').toUpperCase();
  const imp = direction === 'import';
  const need = new Set<IncotermField>();
  let scope = '';
  if (!INCOTERM_INFO[t]) return { need, scope, notes: [] as string[] };
  const notes: string[] = [];
  if (imp) {
    // our customer buys: we carry it from where the seller's part ends
    if (t === 'EXW') { need.add('pickup_address').add('delivery_address'); scope = 'Door to door: we collect from the seller, clear export at origin, ship, clear import and deliver.'; notes.push('Export clearance at origin is on us — add it to the agent rate request.'); }
    else if (t === 'FCA') { need.add('named_place').add('port_of_discharge'); scope = 'From the named handover place to the UAE.'; }
    else if (t === 'FAS' || t === 'FOB') { need.add('port_of_loading').add('port_of_discharge'); scope = 'From the port of loading to the UAE: freight, import clearance and delivery if asked.'; }
    else if (['CFR', 'CIF', 'CPT', 'CIP'].includes(t)) { need.add('port_of_discharge'); scope = 'The seller pays the freight. Our job starts on arrival: destination charges, clearance and delivery if asked.'; }
    else { need.add('delivery_address'); scope = 'The seller delivers to the buyer\'s door. We usually only help at destination, if asked.'; if (t === 'DDP') notes.push('Import duty is paid by the seller.'); }
    if (needsTransport) need.add('delivery_address');
  } else {
    // our customer sells: we carry it as far as the seller's part goes
    if (t === 'EXW') { need.add('pickup_address'); scope = 'The buyer arranges the shipment. We only load / hand over at the seller\'s place if asked.'; }
    else if (t === 'FCA') { need.add('pickup_address').add('named_place'); scope = 'We collect, clear export and hand over at the named place.'; }
    else if (t === 'FAS' || t === 'FOB') { need.add('pickup_address').add('port_of_loading'); scope = 'We collect, clear export and load at the port of loading.'; }
    else if (['CFR', 'CPT'].includes(t)) { need.add('port_of_loading').add('port_of_discharge'); scope = 'We ship it to the port / place of destination.'; }
    else if (['CIF', 'CIP'].includes(t)) { need.add('port_of_loading').add('port_of_discharge').add('cargo_value'); scope = 'We ship it to destination and arrange insurance.'; }
    else { need.add('port_of_loading').add('port_of_discharge').add('delivery_address'); scope = 'Door delivery at destination through our agent.'; if (t === 'DDP') notes.push('Import clearance and duty at destination are on the seller — ask the agent to quote them.'); if (t === 'DPU') notes.push('Unloading at the delivery address is included.'); }
  }
  // courier and "others" have no ports of their own (migration 024)
  if (mode === 'courier' || mode === 'other') { need.delete('port_of_loading'); need.delete('port_of_discharge'); }
  return { need, scope, notes };
}

/** The required fields that are still empty. */
export function incotermMissing(f: Record<string, any>) {
  const { need } = incotermNeeds(f.incoterm, f.direction, !!f.needs_transport, f.mode);
  const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
  return [...need].filter((k) => k === 'cargo_value' ? !(Number(f.cargo_value) > 0) || blank(f.cargo_value_currency) : blank(f[k]));
}
/** New commercial enquiries must say the Incoterm (domestic jobs have none). */
/** Courier and "others" jobs may go without one (migration 024). */
export const incotermRequired = (direction: string | null | undefined, mode?: string | null) => !!direction && direction !== 'domestic' && mode !== 'courier' && mode !== 'other';
