// Labels and lists for Job Files and quotations — shared by the screens and the server.

export const DIRECTIONS: [string, string][] = [['import', 'Import'], ['export', 'Export'], ['cross_trade', 'Cross-trade'], ['domestic', 'Domestic']];
export const MODES: [string, string][] = [['sea_fcl', 'Sea FCL'], ['sea_lcl', 'Sea LCL'], ['air', 'Air'], ['road', 'Road / land']];
export const JF_STATUSES: [string, string, string][] = [
  // code, name, colour
  ['enquiry', 'Enquiry / quoting', '#8A94A6'], ['open', 'Open', '#5B6B82'], ['booked', 'Booked', '#2B6CB0'], ['in_transit', 'In transit', '#553C9A'],
  ['arrived', 'Arrived', '#2C7A7B'], ['delivering', 'Clearance / delivery', '#B7791F'],
  ['closed', 'Closed', '#22543D'], ['cancelled', 'Cancelled', '#9B2C2C'],
];
export const jfStatusName = (c: string) => JF_STATUSES.find((s) => s[0] === c)?.[1] ?? c;
export const jfStatusColor = (c: string) => JF_STATUSES.find((s) => s[0] === c)?.[2] ?? '#6B7280';
export const label = (list: [string, string, ...unknown[]][], code: string | null | undefined) => (code ? list.find((x) => x[0] === code)?.[1] ?? code : '—');

export const CONTAINER_TYPES = ['20GP', '40GP', '40HC', '45HC', '20RF', '40RF', '20OT', '40OT', '20FR', '40FR', 'Other'];
export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

export const SERVICE_TYPES: [string, string][] = [
  ['sea_fcl', 'Sea freight FCL'], ['sea_lcl', 'Sea freight LCL'], ['air', 'Air freight'], ['road', 'Land / cross-border'],
  ['customs', 'Customs clearance'], ['transport', 'Pickup and delivery'], ['warehousing', 'Warehousing / 3PL'], ['door_to_door', 'Door-to-door package'],
];
export const CHARGE_UNITS: [string, string][] = [
  ['shipment', 'per shipment'], ['container', 'per container'], ['cbm', 'per CBM'], ['kg', 'per kg'], ['trip', 'per trip'],
  ['pallet', 'per pallet'], ['carton', 'per carton'], ['day', 'per day'], ['lump_sum', 'lump sum'],
];
export const Q_STATUSES: [string, string, string][] = [
  ['draft', 'Draft', '#8A94A6'], ['pending_approval', 'Waiting for approval', '#B7791F'], ['approved', 'Approved — ready to send', '#2B6CB0'],
  ['sent', 'Sent to customer', '#553C9A'], ['accepted', 'Accepted', '#22543D'], ['rejected', 'Not accepted', '#9B2C2C'],
  ['expired', 'Expired', '#6B7280'], ['cancelled', 'Cancelled', '#6B7280'],
];
export const qStatusName = (c: string) => Q_STATUSES.find((s) => s[0] === c)?.[1] ?? c;
export const qStatusColor = (c: string) => Q_STATUSES.find((s) => s[0] === c)?.[2] ?? '#6B7280';

/**
 * The milestone plan a new Job File starts with. Planned and actual dates are filled in by hand.
 * Steps that a service does not need are simply left out (e.g. no customs step without clearance).
 */
export function milestonePlan(direction: string, mode: string, needs: { clearance: boolean; transport: boolean; warehouse: boolean }): [string, string][] {
  const out: [string, string][] = [];
  const air = mode === 'air', road = mode === 'road';
  const finalStep: [string, string] = needs.warehouse ? ['warehouse_received', 'Received in warehouse'] : ['delivered', 'Delivered to consignee'];
  if (direction === 'domestic' || (road && direction !== 'export' && direction !== 'import')) {
    out.push(['collected', 'Cargo collected']);
    if (needs.clearance) out.push(['customs_cleared', 'Customs cleared']);
    out.push(finalStep);
    return out;
  }
  if (direction === 'export') {
    out.push(['booking_confirmed', 'Booking confirmed'], ['cargo_collected', 'Cargo collected']);
    if (needs.clearance) out.push(['customs_cleared', 'Export customs cleared']);
    out.push(['departed', air ? 'Flight departed' : road ? 'Truck departed' : 'Vessel departed'],
      ['documents_released', air ? 'AWB released' : 'BL released'], ['arrived', 'Arrived at destination']);
    return out;
  }
  // import and cross-trade
  out.push(['pre_alert', 'Pre-alert / documents received'], ['departed', air ? 'Flight departed origin' : road ? 'Truck departed origin' : 'Vessel departed origin'],
    ['arrived', air ? 'Flight arrived' : road ? 'Truck arrived at border' : 'Vessel arrived']);
  if (!road && direction === 'import') out.push(['delivery_order', 'Delivery order collected']);
  if (needs.clearance) out.push(['customs_cleared', 'Customs cleared']);
  if (direction === 'import') out.push(finalStep);
  return out;
}
