// LCL consolidation (Part F): labels shared by the server and the screens.

/** code, name, colour */
export const LCL_STATUS: [string, string, string][] = [
  ['open', 'Receiving cargo', '#B7791F'], ['ready', 'Ready for stuffing', '#2B6CB0'], ['stuffing', 'Stuffing in progress', '#553C9A'],
  ['stuffed', 'Stuffing completed', '#2C7A7B'], ['sealed', 'Container sealed', '#2C7A7B'], ['dispatched', 'Container dispatched', '#22543D'],
  ['departed', 'Departed', '#22543D'], ['arrived', 'Arrived', '#22543D'], ['closed', 'Closed', '#4A5568'], ['cancelled', 'Cancelled', '#9B2C2C'],
];
export const lclStatusName = (c: string | null | undefined) => LCL_STATUS.find((s) => s[0] === c)?.[1] ?? '—';
export const lclStatusColor = (c: string | null | undefined) => LCL_STATUS.find((s) => s[0] === c)?.[2] ?? '#6B7280';
export const OWNER_TYPES: [string, string][] = [['own_customer', 'Own customer'], ['partner_agent', 'Partner agent'], ['other', 'Other authorised party']];
export const RECEIVING: [string, string, string][] = [['expected', 'Expected', '#8A94A6'], ['partial', 'Partly received', '#B7791F'],
  ['received', 'Received', '#22543D'], ['discrepancy', 'Received with differences', '#C53030']];
export const receivingName = (c: string | null | undefined) => RECEIVING.find((s) => s[0] === c)?.[1] ?? '—';
export const receivingColor = (c: string | null | undefined) => RECEIVING.find((s) => s[0] === c)?.[2] ?? '#6B7280';
export const STUFFING: [string, string][] = [['pending', 'Not stuffed'], ['stuffed', 'Stuffed'], ['shut_out', 'Shut out']];
export const LCL_DOC_TYPES: [string, string][] = [['booking_confirmation', 'Carrier booking confirmation'], ['mbl_draft', 'Master BL draft'], ['mbl_final', 'Master BL final'],
  ['hbl_draft', 'House BL draft'], ['hbl_final', 'House BL final'], ['stuffing_report', 'Stuffing report / load plan'], ['photos', 'Photos'],
  ['shipping_instructions', 'Shipping instructions'], ['other', 'Other']];
export const CONDITIONS: [string, string][] = [['good', 'Good'], ['damaged', 'Damaged'], ['wet', 'Wet'], ['short', 'Short'], ['other', 'Other']];
