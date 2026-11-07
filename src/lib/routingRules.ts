// Part G2: route options, vessel legs and BL drafts — labels shared by the server and the screens.

/** BL draft status: code, name, colour. "Customer Confirmation Pending" is shown while a draft is with the customer. */
export const BL_STATUS: [string, string, string][] = [
  ['awaiting', 'BL draft awaiting', '#8A94A6'], ['received', 'BL draft received', '#2B6CB0'], ['under_review', 'BL draft under review', '#553C9A'],
  ['sent_to_customer', 'BL draft sent to customer', '#B7791F'], ['correction_required', 'Correction required', '#C53030'],
  ['correction_sent', 'Correction sent to agent / carrier', '#C05621'], ['revised_received', 'Revised BL draft received', '#2B6CB0'],
  ['revised_sent', 'Revised BL draft sent to customer', '#B7791F'], ['customer_confirmed', 'BL draft confirmed by customer', '#22543D'],
];
export const blStatusName = (c: string | null | undefined) => BL_STATUS.find((s) => s[0] === c)?.[1] ?? '—';
export const blStatusColor = (c: string | null | undefined) => BL_STATUS.find((s) => s[0] === c)?.[2] ?? '#6B7280';
/** With the customer, waiting for their answer. */
export const BL_WITH_CUSTOMER = ['sent_to_customer', 'revised_sent'];

export const VESSEL_STATUS: [string, string][] = [['pending', 'Vessel details pending'], ['received', 'Vessel details received'], ['verified', 'Vessel details verified']];
export const vesselStatusName = (c: string | null | undefined) => VESSEL_STATUS.find((s) => s[0] === c)?.[1] ?? '—';
export const ROUTING_TYPES: [string, string][] = [['direct', 'Direct'], ['via', 'Via / transshipment']];

/** "Option 2 · Ningbo → Jebel Ali" */
export const routeLabel = (r: any) => r ? `Option ${r.option_no}${[r.pol || r.origin_city, r.pod || r.destination_city].filter(Boolean).length
  ? ` · ${[r.pol || r.origin_city, r.pod || r.destination_city].filter(Boolean).join(' → ')}` : ''}` : '';

/** Divisions where the customer must confirm the BL draft before handover (decision D3; a manager can override with a reason). */
export const BL_BEFORE_HANDOVER = ['exports', 'cross_trade'];
