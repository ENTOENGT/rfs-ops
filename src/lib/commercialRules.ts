// Commercials Department (Part E): stages of a shipment from enquiry to handover — shared by server and screens.

export const DIVISIONS: [string, string][] = [['imports', 'Imports'], ['exports', 'Exports'], ['cross_trade', 'Cross Trade']];
export const divisionName = (c: string | null | undefined) => DIVISIONS.find(([d]) => d === c)?.[1] ?? '—';

/** code, name, colour, next action (what has to happen next, in plain words) */
export const STAGES: [string, string, string, string][] = [
  ['enquiry', 'Enquiry', '#8A94A6', 'Ask agents or carriers for rates'],
  ['rates_requested', 'Rates requested', '#B7791F', 'Waiting for rates'],
  ['rates_received', 'Rates received', '#2B6CB0', 'Compare rates and make the quotation'],
  ['quotation_draft', 'Quotation draft', '#2B6CB0', 'Finish the quotation and send it for approval'],
  ['pending_approval', 'Pending approval', '#B7791F', 'Salesman to approve the quotation'],
  ['sent_to_customer', 'Sent to customer', '#553C9A', 'Waiting for the customer'],
  ['customer_confirmed', 'Customer confirmed', '#2C7A7B', 'Send the booking to the agent or carrier'],
  ['booking_requested', 'Booking requested', '#B7791F', 'Waiting for booking confirmation'],
  ['booking_confirmed', 'Booking confirmed', '#2C7A7B', 'Waiting for the pre-alert'],
  ['prealert_awaited', 'Awaiting pre-alert', '#B7791F', 'Waiting for the pre-alert'],
  ['prealert_received', 'Pre-alert received', '#2B6CB0', 'Check the pre-alert details'],
  ['prealert_verified', 'Pre-alert verified', '#22543D', 'Create the operational job (Job No. from the ERP)'],
  ['handed_over', 'Handed over to Operations', '#22543D', 'With Operations'],
  ['lost', 'Lost', '#9B2C2C', '—'],
  ['cancelled', 'Cancelled', '#6B7280', '—'],
];
export const STAGE_ORDER = STAGES.map((s) => s[0]);
export const stageName = (c: string | null | undefined) => STAGES.find((s) => s[0] === c)?.[1] ?? '—';
export const stageColor = (c: string | null | undefined) => STAGES.find((s) => s[0] === c)?.[2] ?? '#6B7280';
export const nextAction = (c: string | null | undefined) => STAGES.find((s) => s[0] === c)?.[3] ?? '';
/** Stages before the customer confirms (quotation work can still move the stage back here). */
export const PRE_CONFIRM = ['enquiry', 'rates_requested', 'rates_received', 'quotation_draft', 'pending_approval', 'sent_to_customer'];

export const RATE_SOURCES: [string, string][] = [['shipping_line', 'Direct shipping line'], ['airline', 'Direct airline'],
  ['overseas_agent', 'Overseas agent'], ['agent_coordinator', 'Through Agent Coordinator'], ['other', 'Other']];
export const rateSourceName = (c: string | null | undefined) => RATE_SOURCES.find(([s]) => s === c)?.[1] ?? '—';
export const CHARGE_SECTIONS: [string, string][] = [['freight', 'Freight'], ['origin', 'Origin charges'], ['destination', 'Destination charges'], ['other', 'Other']];
export const PREALERT_CHECKS: [string, string][] = [['check_vessel', 'Vessel / flight'], ['check_voyage', 'Voyage'], ['check_containers', 'Containers'],
  ['check_bl', 'BL / AWB'], ['check_etd', 'ETD'], ['check_eta', 'ETA']];
export const RESPONSES: [string, string][] = [['accepted', 'Accepted'], ['revision_requested', 'Asked for changes'], ['declined', 'Declined'],
  ['no_reply', 'No reply yet'], ['note', 'Note']];
