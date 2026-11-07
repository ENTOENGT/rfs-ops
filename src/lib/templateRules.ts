// Part G1: email templates and quotation terms — shared by the server and the screens.

/** Who an email goes to decides which details it may use: agents and carriers never get the customer's name or selling prices. */
export type EmailContext = 'vendor' | 'quotation' | 'shipment';

/** key, name, context, built-in subject, built-in body. Built-ins are used until a Commercials Manager saves a template. */
export const EMAIL_TEMPLATES: [string, string, EmailContext, string, string][] = [
  ['enquiry_ack', 'Enquiry acknowledgement', 'shipment', '{{ThreadSubject}}',
    '{{Greeting}}\n\nThank you for your enquiry. Our reference is {{EnquiryReference}}; please keep it in the subject of your replies.\n\n{{ShipmentDetails}}\n\nYour Coordinator {{CoordinatorName}} is collecting the rates and will send you our quotation shortly.\n\n{{Signature}}'],
  ['agent_rate_request', 'Agent rate request', 'vendor', '{{ThreadSubject}}',
    '{{Greeting}}\n\nPlease send us your best rate for the shipment below.\n\n{{RequestDetails}}\n\n{{ShipmentDetails}}\n\nPlease include: freight and all local charges at origin and destination, free days, transit time, routing and how long the rate is valid.\n{{NeededBy}}\nPlease keep the subject of this email in your reply.\n\n{{Signature}}'],
  ['liner_rate_request', 'Direct shipping line rate request', 'vendor', '{{ThreadSubject}}',
    '{{Greeting}}\n\nPlease quote your rate for the shipment below.\n\n{{RequestDetails}}\n\n{{ShipmentDetails}}\n\nPlease include: ocean freight and surcharges, free days at destination, transit time, routing, sailing schedule and validity.\n{{NeededBy}}\nPlease keep the subject of this email in your reply.\n\n{{Signature}}'],
  ['booking_instruction', 'Booking instruction', 'vendor', '{{ThreadSubject}}',
    '{{Greeting}}\n\nPlease go ahead and book the shipment below at your rate.\n\n{{ShipmentDetails}}\n\nPlease send the booking confirmation with the vessel, voyage, ETD and ETA.\n\n{{Signature}}'],
  ['booking_followup', 'Booking confirmation follow-up', 'vendor', '{{ThreadSubject}}',
    '{{Greeting}}\n\nWe are still waiting for your booking confirmation for the shipment below. Please send it today if possible.\n\n{{ShipmentDetails}}\n\n{{Signature}}'],
  ['vessel_details_request', 'Vessel details request', 'vendor', '{{ThreadSubject}}',
    '{{Greeting}}\n\nPlease confirm the vessel name, voyage, ETD and ETA for booking {{BookingReference}}, and whether it is direct or via a transshipment port.\n\n{{ShipmentDetails}}\n\n{{Signature}}'],
  ['prealert_followup', 'Pre-alert follow-up', 'vendor', '{{ThreadSubject}}',
    '{{Greeting}}\n\nPlease send the pre-alert for booking {{BookingReference}} (vessel {{VesselName}}, ETD {{ETD}}), with the BL copy and the container details.\n\n{{Signature}}'],
  ['bl_correction_request', 'BL correction request', 'vendor', '{{ThreadSubject}}',
    '{{Greeting}}\n\nThe shipper asks for the following corrections to BL {{BLNumber}}:\n\n{{CorrectionNotes}}\n\nPlease send the revised draft for approval.\n\n{{Signature}}'],
  ['quotation_submission', 'Quotation submission', 'quotation', '{{ThreadSubject}}',
    '{{Greeting}}\n\nThank you for your enquiry {{EnquiryReference}}. Please find our quotation {{QuoteNumber}} below and attached.\n\n{{ShipmentDetails}}\n\nCharges:\n{{Charges}}\nTotal: {{Total}} (excluding VAT)\n\nRates valid until {{ValidUntil}}.\n{{Exclusions}}\n\nTo go ahead, please reply to confirm and we will arrange the booking.\n\n{{Signature}}'],
  ['quotation_revision', 'Quotation revision', 'quotation', '{{ThreadSubject}}',
    '{{Greeting}}\n\nAs discussed, please find our revised quotation {{QuoteNumber}} (version {{QuoteVersion}}).\n\nCharges:\n{{Charges}}\nTotal: {{Total}} (excluding VAT)\n\nRates valid until {{ValidUntil}}.\n{{Exclusions}}\n\nPlease reply to confirm and we will arrange the booking.\n\n{{Signature}}'],
  ['quotation_followup', 'Quotation follow-up', 'quotation', '{{ThreadSubject}}',
    '{{Greeting}}\n\nWe sent you our quotation {{QuoteNumber}} for {{Origin}} to {{Destination}}. The rates are valid until {{ValidUntil}}.\n\nCan we go ahead with the booking? Please let us know if you need any changes.\n\n{{Signature}}'],
  ['shipment_update', 'Shipment status update', 'shipment', '{{ThreadSubject}}',
    '{{Greeting}}\n\n{{UpdateText}}\n\nShipment details:\n{{ShipmentDetails}}\n\nWe will keep you updated. Please contact us if you have any questions.\n\n{{Signature}}'],
  ['bl_draft_to_customer', 'BL draft to customer', 'shipment', '{{ThreadSubject}}',
    '{{Greeting}}\n\nPlease find attached the BL draft for your shipment (booking {{BookingReference}}, vessel {{VesselName}} {{VoyageNumber}}, ETD {{ETD}}).\n\nPlease check every detail and reply to confirm, or tell us what to correct.\n\n{{Signature}}'],
  ['bl_revised_to_customer', 'Revised BL draft to customer', 'shipment', '{{ThreadSubject}}',
    '{{Greeting}}\n\nPlease find attached the revised BL draft with the corrections you asked for.\n\nPlease check it and reply to confirm.\n\n{{Signature}}'],
  ['bl_final_confirmation', 'Final BL confirmation', 'shipment', '{{ThreadSubject}}',
    '{{Greeting}}\n\nThank you for confirming the BL draft. The final BL {{BLNumber}} will be issued on that basis.\n\n{{ShipmentDetails}}\n\n{{Signature}}'],
  ['handover_notification', 'Handover notification', 'shipment', '{{ThreadSubject}}',
    '{{Greeting}}\n\nYour shipment is booked and has been handed over to our operations team under Job No. {{OperationalJobNumber}}. Please use this number with {{EnquiryReference}} in all messages.\n\n{{ShipmentDetails}}\n\n{{Signature}}'],
];
export const emailTemplateName = (k: string | null | undefined) => EMAIL_TEMPLATES.find((t) => t[0] === k)?.[1] ?? k ?? '';

/** placeholder, what it holds, which emails may use it */
export const PLACEHOLDERS: [string, string, EmailContext[]][] = [
  ['ThreadSubject', 'The fixed subject of this shipment: [ENQ…] tags and route', ['vendor', 'quotation', 'shipment']],
  ['EnquiryReference', 'Enquiry Ref, e.g. ENQ-IMP-26-00012', ['vendor', 'quotation', 'shipment']],
  ['ShippingReference', 'Shipping Ref (after the customer confirms)', ['vendor', 'quotation', 'shipment']],
  ['OperationalJobNumber', 'Job No. from the ERP (after handover)', ['vendor', 'quotation', 'shipment']],
  ['CustomerName', 'Customer name (never in emails to agents)', ['quotation', 'shipment']],
  ['CustomerReference', "Customer's own reference", ['quotation', 'shipment']],
  ['SalesmanName', 'Responsible Salesman', ['quotation', 'shipment']],
  ['CoordinatorName', 'Assigned Coordinator', ['vendor', 'quotation', 'shipment']],
  ['Origin', 'Origin', ['vendor', 'quotation', 'shipment']],
  ['Destination', 'Destination', ['vendor', 'quotation', 'shipment']],
  ['ShipmentMode', 'Sea FCL, Sea LCL, Air, Road', ['vendor', 'quotation', 'shipment']],
  ['CargoDetails', 'Cargo description, packages, weight, volume', ['vendor', 'quotation', 'shipment']],
  ['BookingReference', 'Carrier booking reference', ['vendor', 'quotation', 'shipment']],
  ['VesselName', 'Vessel or flight', ['vendor', 'quotation', 'shipment']],
  ['VoyageNumber', 'Voyage', ['vendor', 'quotation', 'shipment']],
  ['ETD', 'ETD', ['vendor', 'quotation', 'shipment']],
  ['ETA', 'ETA', ['vendor', 'quotation', 'shipment']],
  ['BLNumber', 'BL / AWB number', ['vendor', 'quotation', 'shipment']],
  ['ShipmentDetails', 'A block of the shipment facts (route, cargo, dates…)', ['vendor', 'quotation', 'shipment']],
  ['Greeting', '"Dear …," for the ticked recipient', ['vendor', 'quotation', 'shipment']],
  ['Signature', 'Your name, company, phone and email', ['vendor', 'quotation', 'shipment']],
  ['VendorName', 'Agent / carrier name', ['vendor']],
  ['RequestNumber', 'Rate / booking request number', ['vendor']],
  ['RequestDetails', 'What was asked of the vendor', ['vendor']],
  ['NeededBy', '"We need your rate by …" line', ['vendor']],
  ['RouteOption', 'The route option this request is for (Option 2 · Ningbo → Jebel Ali)', ['vendor']],
  ['CorrectionNotes', "The customer's BL corrections", ['vendor']],
  ['RouteOptions', 'The quoted route options with their totals', ['quotation']],
  ['QuoteNumber', 'Quotation number', ['quotation']],
  ['QuoteVersion', 'Quotation version', ['quotation']],
  ['Charges', 'Selling charges, one per line', ['quotation']],
  ['Total', 'Selling total with currency', ['quotation']],
  ['ValidUntil', 'Rates valid until', ['quotation']],
  ['Exclusions', '"Not included: …" line', ['quotation']],
  ['UpdateText', 'The opening line for the chosen update (departed, arrived…)', ['shipment']],
];
const PH = /\{\{\s*([A-Za-z]+)\s*\}\}/g;
/** Placeholders a template uses that do not exist, or that this kind of email may not use. */
export function badPlaceholders(text: string, ctx: EmailContext): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PH)) {
    const p = PLACEHOLDERS.find(([k]) => k === m[1]);
    if (!p || !p[2].includes(ctx)) out.add(m[1]);
  }
  return [...out];
}
/** Fill the placeholders; the ones with no value yet are listed and left visible as [Name]. */
export function fillTemplate(text: string, vals: Record<string, string | null | undefined>) {
  const missing = new Set<string>();
  const out = text.replace(PH, (_, k: string) => {
    const v = vals[k];
    if (v === null || v === undefined || String(v).trim() === '') { missing.add(k); return `[${k}]`; }
    return String(v);
  }).replace(/\n{3,}/g, '\n\n');
  return { text: out, missing: [...missing] };
}

/** Quotation terms: the five texts a template fills. */
export const TERM_FIELDS: [string, string][] = [['scope', 'Scope of services'], ['exclusions', 'Exclusions'], ['terms', 'Terms and conditions'],
  ['additional_remarks', 'Additional remarks'], ['payment_terms', 'Payment / commercial conditions']];
export const TEMPLATE_MODES: [string, string][] = [['sea', 'Sea'], ['air', 'Air'], ['road', 'Road']];
export const SHIPMENT_TYPES: [string, string][] = [['fcl', 'FCL'], ['lcl', 'LCL']];
/** sea_fcl → sea + fcl; air → air + null… */
export const modeParts = (mode: string | null | undefined): { mode: string | null; type: string | null } =>
  !mode ? { mode: null, type: null } : mode.startsWith('sea') ? { mode: 'sea', type: mode.endsWith('lcl') ? 'lcl' : mode.endsWith('fcl') ? 'fcl' : null }
    : { mode: mode.startsWith('air') ? 'air' : mode.startsWith('road') ? 'road' : mode, type: null };
