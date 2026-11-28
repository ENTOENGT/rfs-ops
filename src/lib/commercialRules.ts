// Commercials Department (Part E): stages of a shipment from enquiry to handover — shared by server and screens.

export const DIVISIONS: [string, string][] = [['imports', 'Imports'], ['exports', 'Exports'], ['cross_trade', 'Cross Trade']];
export const divisionName = (c: string | null | undefined) => DIVISIONS.find(([d]) => d === c)?.[1] ?? '—';
/** Step 4: on an enquiry the division is the one question — Imports team = import, Exports team = export, Cross Trade = cross-trade. */
export const directionOfDivision = (d: string | null | undefined) => d === 'imports' ? 'import' : d === 'exports' ? 'export' : d === 'cross_trade' ? 'cross_trade' : null;
export const divisionOfDirection = (d: string | null | undefined) => d === 'import' ? 'imports' : d === 'export' ? 'exports' : d === 'cross_trade' ? 'cross_trade' : null;

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

/**
 * 26 Nov (Point 16): where the enquiry stands — the steps from enquiry to handover, the one next action (with where to do it)
 * and what is still open. Worked out from the record the enquiry page already has; nothing is stored.
 */
export type Progress = { steps: { name: string; state: 'done' | 'now' | 'todo'; sub?: string }[];
  next: { text: string; label?: string; tab?: string; href?: string }; pending: string[] };
export const PROGRESS_STEPS = ['Enquiry created', 'Vendor rates', 'Compare rates', 'Prepare quotation', 'Send quotation', 'Customer approval',
  'Confirm availability', 'Create booking', 'Operations handover'];
export function progressOf(d: any, today: string = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' })): Progress {
  const st: string = d.stage ?? 'enquiry';
  const at = (s: string) => STAGE_ORDER.indexOf(s);
  const rates = (d.vendor_requests ?? []).filter((r: any) => r.service === 'rate' && r.status !== 'cancelled');
  const got = rates.filter((r: any) => r.quoted_cost !== null && r.quoted_cost !== undefined).length;
  const quotes = (d.quotations ?? []).filter((x: any) => !['cancelled', 'rejected', 'expired'].includes(x.status));
  const q = quotes[quotes.length - 1];                                    // the latest one
  const av = d.availability;
  const sel = (d.routes ?? []).find((x: any) => x.id === d.selected_route_id);
  const option = sel ? `Option ${sel.option_no}${sel.label ? ` – ${sel.label}` : ''}` : 'the quotation';
  // which step we are on (index into PROGRESS_STEPS)
  // 27 Nov: "Confirm availability" is done when checked, or skipped once the booking is sent
  const now = st === 'handed_over' ? 9
    : at(st) >= at('booking_confirmed') ? 8
    : st === 'booking_requested' || av?.status === 'confirmed' ? 7
    : st === 'customer_confirmed' ? 6
    : st === 'sent_to_customer' ? 5
    : q && ['approved'].includes(q.status) ? 4
    : q || ['quotation_draft', 'pending_approval'].includes(st) ? 3
    : got > 0 && (st === 'rates_received' || got === rates.length) ? 2 : 1;
  const steps = PROGRESS_STEPS.map((name, i) => ({ name, state: (i < now ? 'done' : i === now ? 'now' : 'todo') as 'done' | 'now' | 'todo',
    sub: i === 1 && rates.length ? `${got} of ${rates.length} received` : i === 8 && now === 8 ? (d.mode !== 'air' && d.mode !== 'road' && d.bl_status && d.bl_status !== 'customer_confirmed' && st !== 'prealert_received' && st !== 'prealert_verified' ? 'BL draft' : stageName(st)) : undefined }));
  const quote = q ? `/quotations/${q.id}` : undefined;
  let next: Progress['next'];
  if (['lost', 'cancelled'].includes(st)) next = { text: st === 'lost' ? 'Lost' : 'Cancelled' };
  else if (now === 9) next = { text: 'Handed over to Operations.' };
  else if (now === 8) {
    // 27 Nov: by sea, the BL draft comes before the pre-alert — and is chased the day after the cut-off / loading date
    const bl = d.mode && d.mode !== 'air' && d.mode !== 'road' ? (d.bl_status ?? 'awaiting') : null;
    const loading = String(d.cutoff_gate ?? d.cutoff_si ?? d.etd ?? '').slice(0, 10);
    const late = !!loading && loading < String(today).slice(0, 10);
    next = st === 'prealert_verified' ? { text: 'Pre-alert verified. Hand over to Operations.', label: 'Hand over', tab: 'overview' }
      : st === 'prealert_received' ? { text: 'Pre-alert received. Check it against the booking.', label: 'Check pre-alert', tab: 'overview' }
      : bl === 'awaiting' ? (late ? { text: `Cut-off / loading was ${loading} and no BL draft has come. Ask the agent for the loading status and the BL draft.`, label: 'Ask the agent', tab: 'bl' }
        : { text: `Booking confirmed. Waiting for the BL draft from the agent${loading ? ` (cut-off / loading ${loading})` : ''}.`, label: 'Open BL documents', tab: 'bl' })
      : bl && ['received', 'under_review', 'revised_received'].includes(bl) ? { text: 'BL draft received. Check it (Check with AI) and send it to the customer.', label: 'Open BL draft', tab: 'bl' }
      : bl && ['sent_to_customer', 'revised_sent'].includes(bl) ? { text: 'BL draft with the customer. Waiting for their confirmation or corrections.', label: 'Open BL draft', tab: 'bl' }
      : bl === 'correction_required' ? { text: 'The customer asked for corrections. Send them to the agent.', label: 'Send corrections', tab: 'bl' }
      : bl === 'correction_sent' ? { text: 'Corrections sent to the agent. Waiting for the revised BL draft.', label: 'Open BL draft', tab: 'bl' }
      : { text: 'Booking confirmed. Waiting for the pre-alert.', label: 'Open pre-alert', tab: 'overview' };
  }
  else if (now === 7) next = st === 'booking_requested' ? { text: `Booking sent${d.booking ? ` to ${d.booking.vendor_name}` : ''}. Waiting for the confirmation.`, label: 'Open booking', tab: 'booking' }
    : { text: 'Vendor confirmed availability.', label: 'Proceed to booking', tab: 'booking' };
  else if (now === 6) next = av?.status === 'sent' ? { text: `Customer approved ${option}. Waiting for ${av.vendor_name ?? 'the vendor'} to confirm availability.`, label: 'Open booking', tab: 'booking' }
    : av?.status === 'unavailable' ? { text: `The quoted space is not available${av.reason ? ` (${av.reason})` : ''}. Ask for the next sailing and tell the customer.`, label: 'Open booking', tab: 'booking' }
    // 27 Nov: asking availability first is optional — booking is the main step
    : { text: `Customer approved ${option}. Send the booking to the agent or carrier${d.approved_rate ? ' (or ask availability first)' : ''}.`, label: 'Proceed to booking', tab: 'booking' };
  else if (now === 5) next = d.open_items?.answers ? { text: 'The customer answered from the quotation email.', label: 'See the answer', href: quote }
    : { text: 'Quotation sent. Waiting for the customer.', label: 'Open quotation', href: quote };
  else if (now === 4) next = { text: `Quotation ${q.quote_no} approved. Send it to the customer.`, label: 'Send quotation', href: quote };
  else if (now === 3) next = q?.status === 'pending_approval' ? { text: `Quotation ${q.quote_no} is waiting for approval.`, label: 'Open quotation', href: quote }
    : q ? { text: `Finish quotation ${q.quote_no} and send it for approval.`, label: 'Open quotation', href: quote }
    : { text: 'Make the quotation.', label: 'Prepare quotation', tab: 'rates' };
  else if (now === 2) next = { text: 'Vendor rates received. Ready to compare.', label: 'Compare vendor rates', tab: 'rates' };
  else next = rates.length ? { text: `Waiting for vendor rates (${got} of ${rates.length} received).`, label: 'Open vendor rates', tab: 'rates' }
    : { text: 'Ask agents or carriers for rates.', label: 'Request vendor rates', tab: 'rates' };   // 27 Nov: routing options only when quoting several routes
  const pending = [
    (d.enquiry_gaps ?? []).length ? `${d.enquiry_gaps.length} missing detail${d.enquiry_gaps.length > 1 ? 's' : ''} from the customer` : null,
    d.open_items?.clarifications ? `${d.open_items.clarifications} clarification${d.open_items.clarifications > 1 ? 's' : ''} open` : null,
    now === 1 && rates.length > got ? `${rates.length - got} vendor rate${rates.length - got > 1 ? 's' : ''} awaited` : null,
    d.open_items?.answers ? `${d.open_items.answers} customer answer${d.open_items.answers > 1 ? 's' : ''} to handle` : null,
  ].filter((x): x is string => !!x);
  return { steps, next, pending };
}
