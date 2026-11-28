/**
 * Release M step 2 (migration 028): what an agent's rate still lacks. Items with a field_key are read from what is already
 * typed on the rate request (or its charge lines); the others are extra questions answered on the request.
 */
export type QuoteCheck = { id: string; label: string; ask_text: string; field_key: string | null; modes: string[]; is_active?: boolean };
export type QuoteGap = { key: string; label: string; ask: string };
export const QUOTE_FIELDS: [string, string][] = [['freight', 'Freight rate (a freight charge line, or the total)'], ['currency', 'Currency'], ['rate_valid_until', 'Valid until'],
  ['transit_days', 'Transit time'], ['routing', 'Routing'], ['carrier', 'Carrier'], ['etd', 'ETD'], ['free_days', 'Free days'],
  ['origin', 'An origin charge line'], ['destination', 'A destination charge line']];

export const quoteChecksFor = (checks: QuoteCheck[], mode: string | null | undefined) =>
  checks.filter((c) => c.is_active !== false && (!c.modes?.length || c.modes.includes(String(mode ?? ''))));

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

/** r = the request; sections = the charge sections it has (freight / origin / destination / other). */
export function quoteGaps(r: Record<string, any>, sections: string[], checks: QuoteCheck[], mode: string | null | undefined, direction?: string | null): QuoteGap[] {
  // 27 Nov: the UAE side (clearance, delivery / pickup, local charges) is RFS's own work, priced from our rate cards — never asked of the vendor
  const uaeSide = direction === 'import' ? 'destination' : direction === 'export' ? 'origin' : null;
  const ours = (c: QuoteCheck) => !!uaeSide && (c.field_key === uaeSide || (!c.field_key && /customs clearance|clearance charge|delivery|trucking|transportation/i.test(`${c.label} ${c.ask_text}`)));
  const d = r.quote_details ?? {};
  const has = (k: string) => {
    if (k === 'freight') return sections.includes('freight') || (!blank(r.quoted_cost) && Number(r.quoted_cost) > 0);
    if (k === 'origin' || k === 'destination') return sections.includes(k);
    return !blank(r[k]);
  };
  return quoteChecksFor(checks, mode).filter((c) => !ours(c)).filter((c) => c.field_key ? !has(c.field_key) : blank(d[c.id])).map((c) => ({ key: c.id, label: c.label, ask: c.ask_text }));
}
