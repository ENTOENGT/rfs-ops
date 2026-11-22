/**
 * Release M (migration 028): what an enquiry still needs before it can be quoted well — the built-in rules (Incoterm and the
 * addresses it needs, cargo lines, a description of the goods) plus your own checklist items. Each gap says how to ask the
 * customer for it. Used on the screen, by the "ask the customer" email, and later by the AI agent.
 */
import { incotermMissing, incotermRequired } from './incotermRules';
import { dimsRequired } from './cargoRules';
import { notNeeded } from './opsRules';

export type EnquiryCheck = { id: string; label: string; ask_text: string; field_type: string; divisions: string[]; modes: string[]; is_active?: boolean };
export type Gap = { key: string; label: string; ask: string; built_in: boolean };

const ASK: Record<string, [string, string]> = {
  pickup_address: ['Pickup address', 'the pickup address, with a contact person and phone number'],
  named_place: ['Handover place', 'the place where the cargo will be handed over'],
  port_of_loading: ['Port / airport of loading', 'the port or airport of loading'],
  port_of_discharge: ['Port / airport of discharge', 'the port or airport of discharge'],
  delivery_address: ['Delivery address', 'the delivery address, with a contact person and phone number'],
  cargo_value: ['Cargo value', 'the cargo value and its currency (for insurance)'],
};

/** The checklist items that apply to this enquiry's division and mode. */
export const checksFor = (checks: EnquiryCheck[], division: string | null | undefined, mode: string | null | undefined) =>
  checks.filter((c) => c.is_active !== false && (!c.divisions?.length || c.divisions.includes(String(division ?? '')))
    && (!c.modes?.length || c.modes.includes(String(mode ?? ''))));

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

export function enquiryGaps(f: Record<string, any>, checks: EnquiryCheck[]): Gap[] {
  const out: Gap[] = [];
  if (incotermRequired(f.direction, f.mode) && blank(f.incoterm)) out.push({ key: 'incoterm', label: 'Incoterm', ask: 'the Incoterm (for example EXW, FOB or CIF)', built_in: true });
  for (const k of incotermMissing(f)) { const a = ASK[k]; if (a) out.push({ key: k, label: a[0], ask: a[1], built_in: true }); }
  const lines = (f.cargo_lines ?? []).length;
  if (dimsRequired(f.mode) && !lines) out.push({ key: 'cargo_lines', label: 'Cargo details', ask: 'the number and type of packages, with the dimensions and weight of each', built_in: true });
  if (f.mode === 'sea_fcl' && !lines && blank(f.gross_weight_kg)) out.push({ key: 'gross_weight_kg', label: 'Cargo weight', ask: 'the total cargo weight', built_in: true });
  if (blank(f.cargo_description)) out.push({ key: 'cargo_description', label: 'Commodity', ask: 'a short description of the goods', built_in: true });
  const d = f.enquiry_details ?? {};
  // 21 Nov: questions the operations rules answer are not asked (FCL stackable, general cargo DG, CIF/CIP import insurance…)
  for (const c of checksFor(checks, f.division, f.mode)) if (blank(d[c.id]) && !notNeeded(c.label, f)) out.push({ key: c.id, label: c.label, ask: c.ask_text, built_in: false });
  return out;
}
