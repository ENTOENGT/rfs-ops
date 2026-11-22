/**
 * Operations rules (21 Nov 2026, batch 1) — how an experienced freight forwarding executive reads an enquiry. One place, used
 * by the AI reading a new enquiry email, by the AI reading the customer's replies, by "what is still missing" and by the
 * "ask the customer" email, so they all agree:
 *
 *  - Services from the Incoterm AND what the customer actually asked for. The Incoterm gives the default; the customer's own
 *    words win; a clash between the two is flagged, never silently decided.
 *  - "General cargo" (or non-DG / non-hazardous) = Non-DG: no DG question. DG words (UN number, class, MSDS, lithium…) = check.
 *  - FCL: never ask stackable.
 *  - "Ready for collection" with no date = ready today; a date given wins.
 *  - CIF / CIP import: the seller insures — no insurance question.
 *
 * Import = our customer is the UAE buyer. Export and cross trade = our customer is the seller (as in incotermRules).
 */
export type Svc = 'origin_pickup' | 'export_clearance' | 'freight' | 'import_clearance' | 'delivery';
export type YesNo = 'yes' | 'no' | 'unknown';
export type Asked = Partial<Record<Svc | 'insurance', YesNo>>;

const ALL: Svc[] = ['origin_pickup', 'export_clearance', 'freight', 'import_clearance', 'delivery'];
export const SVC_LABEL: Record<Svc, string> = {
  origin_pickup: 'pickup at origin', export_clearance: 'export clearance', freight: 'freight', import_clearance: 'import clearance', delivery: 'delivery',
};
/** What the BUYER arranges and pays under each Incoterm (the seller does the rest). */
const BUYER: Record<string, Svc[]> = {
  EXW: ['origin_pickup', 'export_clearance', 'freight', 'import_clearance', 'delivery'],
  FCA: ['freight', 'import_clearance', 'delivery'], FAS: ['freight', 'import_clearance', 'delivery'], FOB: ['freight', 'import_clearance', 'delivery'],
  CFR: ['import_clearance', 'delivery'], CPT: ['import_clearance', 'delivery'], CIF: ['import_clearance', 'delivery'], CIP: ['import_clearance', 'delivery'],
  DAP: ['import_clearance'], DPU: ['import_clearance'], DDP: [],
};
const SELLER_INSURES = ['CIF', 'CIP'];

/** The services that are our customer's side of the deal under this term, or null when the term is not known. */
export function customerScope(term: string | null | undefined, direction: string | null | undefined): Set<Svc> | null {
  const t = String(term ?? '').toUpperCase();
  if (!BUYER[t]) return null;
  return direction === 'import' ? new Set(BUYER[t]) : new Set(ALL.filter((s) => !BUYER[t].includes(s)));
}

export type ServiceDecision = { needs_clearance: boolean | null; needs_transport: boolean | null; insurance: 'yes' | 'no' | null; reasons: string[]; flags: string[] };

/**
 * Which of our UAE services the enquiry needs (customs clearance and transport — pickup for export, delivery for import), the
 * insurance answer when the term settles it, why, and what does not add up. null = leave as it is.
 */
export function decideServices(x: { incoterm?: string | null; direction?: string | null; asked?: Asked; pickup_address?: string | null; delivery_address?: string | null }): ServiceDecision {
  const t = String(x.incoterm ?? '').toUpperCase();
  const a = x.asked ?? {};
  const scope = customerScope(t, x.direction);
  const out: ServiceDecision = { needs_clearance: null, needs_transport: null, insurance: null, reasons: [], flags: [] };
  const has = (v: unknown) => String(v ?? '').trim() !== '';
  // anything the customer asked for that is the other party's job under this term
  if (scope) for (const s of ALL) if (a[s] === 'yes' && !scope.has(s)) {
    out.flags.push(`The customer asks for ${SVC_LABEL[s]}, but under ${t} that is the ${x.direction === 'import' ? 'seller' : 'buyer'}'s side — confirm who pays it before quoting.`);
  }
  if (x.direction === 'import') {
    // UAE import clearance
    if (a.import_clearance === 'no') { out.needs_clearance = false; out.reasons.push('No customs clearance: the customer clears it themselves.'); }
    else if (!scope || scope.has('import_clearance') || a.import_clearance === 'yes') { out.needs_clearance = true; out.reasons.push(scope ? `Customs clearance: under ${t} the import clearance in the UAE is the buyer's.` : 'Customs clearance: an import into the UAE.'); }
    else { out.needs_clearance = false; out.reasons.push(`No customs clearance: under ${t} the seller clears and pays the duty.`); }
    // UAE delivery
    if (a.delivery === 'no') { out.needs_transport = false; out.reasons.push('No delivery: the customer collects.'); }
    else if (a.delivery === 'yes' || has(x.delivery_address)) {
      out.needs_transport = true; out.reasons.push('Delivery: the customer asks for delivery to their address.');
      if (scope && !scope.has('delivery')) out.flags.push(`Delivery is asked, but under ${t} delivery to the door is the seller's — confirm it is not paid twice.`);
    } else if (t === 'EXW') { out.needs_transport = true; out.reasons.push('Delivery: EXW import is door to door.'); }
    else { out.needs_transport = false; out.reasons.push('Delivery not ticked: no delivery address or request — tick it if the customer wants delivery.'); }
    if (t === 'DDP') out.flags.push('DDP import: the seller pays the duty and the delivery. Check who our customer is (the seller or the buyer) before quoting.');
    // insurance: under CIF / CIP the seller insures
    if (SELLER_INSURES.includes(t)) {
      if (a.insurance === 'yes') out.flags.push(`The customer asks for insurance, but under ${t} the seller already insures — confirm they want extra cover.`);
      else { out.insurance = 'no'; out.reasons.push(`No insurance from us: under ${t} the seller insures the cargo.`); }
    } else if (a.insurance === 'yes' || a.insurance === 'no') out.insurance = a.insurance;
  } else if (x.direction === 'export') {
    // UAE export clearance
    if (a.export_clearance === 'no') { out.needs_clearance = false; out.reasons.push('No customs clearance: the customer clears export themselves.'); }
    else if (!scope || scope.has('export_clearance') || a.export_clearance === 'yes') { out.needs_clearance = true; out.reasons.push(scope ? `Customs clearance: under ${t} the export clearance is the seller's.` : 'Customs clearance: an export from the UAE.'); }
    else { out.needs_clearance = false; out.reasons.push(`No customs clearance: under ${t} the buyer clears export.`); }
    // UAE pickup
    if (a.origin_pickup === 'no') { out.needs_transport = false; out.reasons.push('No pickup: the customer delivers the cargo themselves.'); }
    else if (a.origin_pickup === 'yes' || has(x.pickup_address) || (scope?.has('origin_pickup') ?? false)) { out.needs_transport = true; out.reasons.push('Transport: we collect the cargo in the UAE.'); }
    else { out.needs_transport = false; out.reasons.push(`No pickup: under ${t} the buyer collects.`); }
    if (['FCA', 'FAS', 'FOB'].includes(t) && a.freight === 'yes') out.flags.push(`Freight is asked, but under ${t} the buyer pays the freight — confirm whose account the freight is for.`);
    if (t === 'DDP') out.flags.push('DDP export: duty and taxes at destination are on our customer — get the agent\'s duty estimate.');
    if (SELLER_INSURES.includes(t)) {
      if (a.insurance === 'no') out.flags.push(`Under ${t} the seller must insure, but the customer says no insurance — confirm.`);
      else { out.insurance = 'yes'; out.reasons.push(`Insurance: under ${t} the seller insures the cargo.`); }
    } else if (a.insurance === 'yes' || a.insurance === 'no') out.insurance = a.insurance;
  } else if (a.insurance === 'yes' || a.insurance === 'no') out.insurance = a.insurance;
  return out;
}

// ------------------------------------------------------------------ DG / general cargo
const NON_DG = /\b(non[-\s]?(dg|dangerous|hazardous|haz|hazmat)|not\s+(dg|dangerous|hazardous)|general\s+cargo|gen(\.|eral)?\s+cargo)\b/i;
const DG = /\b(dg|dangerous\s+goods?|hazardous|hazmat|imdg|imo\s*class|un\s?\d{4}|class\s?[1-9](\.\d)?|msds|sds|chemicals?|flammable|corrosive|toxic|lithium|batter(y|ies)|aerosols?|perfumes?|paints?|explosives?|radioactive|oxidi[sz]ing|gas\s+cylinders?|compressed\s+gas)\b/i;

/** "General cargo" / non-DG with no DG words → 'no'. DG words (outside "non-DG") → 'check' with the words. Otherwise null. */
export function dgFromText(text: unknown): { dg: 'no' | 'check' | null; words: string[] } {
  const s = String(text ?? '');
  const rest = s.replace(new RegExp(NON_DG.source, 'gi'), ' ');
  const words = [...new Set((rest.match(new RegExp(DG.source, 'gi')) ?? []).map((w) => w.trim()))];
  if (words.length) return { dg: 'check', words };
  return { dg: NON_DG.test(s) ? 'no' : null, words: [] };
}

// ------------------------------------------------------------------ cargo ready
const READY = /\b(ready\s+(for|to)\s+(collection|collect|pick[\s-]?up|dispatch|ship(ment)?|load(ing)?)|(cargo|goods|shipment|material|consignment)\s+(is\s+|are\s+)?(now\s+)?ready|available\s+for\s+(collection|pick[\s-]?up)|ready\s+at\s+(our|the)\s+(warehouse|factory|premises))\b/i;
export const READY_REMARK = 'Customer confirmed that the cargo is ready for collection.';
/** Does the text say the cargo is ready now? */
export const saysReady = (text: unknown) => READY.test(String(text ?? ''));

// ------------------------------------------------------------------ the sender's own words
/** A reply quotes our email (our questions say "hazardous (DG)", "ready for pickup"…): the rules read only what is above it. */
export function ownWords(text: unknown): string {
  const s = String(text ?? '');
  const cut = s.search(/\n\s*(-{2,}\s*Original Message|_{5,}|From:\s.+|On .{4,120} wrote:|Sent from my )/i);
  return cut > 0 ? s.slice(0, cut) : s;
}

// ------------------------------------------------------------------ which checklist questions are NOT asked
/** A checklist question the rules answer or make unnecessary for this enquiry (with the reason). */
export function notNeeded(label: string, f: Record<string, any>): string | null {
  if (/stack/i.test(label) && f.mode === 'sea_fcl') return 'FCL: stackable is not asked';
  if (/hazard|\bdg\b/i.test(label) && dgFromText(f.cargo_description).dg === 'no') return 'General cargo = Non-DG';
  if (/insur/i.test(label) && f.direction === 'import' && SELLER_INSURES.includes(String(f.incoterm ?? '').toUpperCase())) return `${String(f.incoterm).toUpperCase()}: the seller insures`;
  if (/ready/i.test(label) && f.cargo_ready_confirmed) return 'Cargo ready for collection';
  return null;
}
