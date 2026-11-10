/**
 * Currencies on the freight side (quotations, agent rates and their charge lines, cargo value).
 * Exchange rates are kept in Settings as "1 unit = x AED" (fx_USD, fx_EUR, fx_INR, fx_CNY); AED is always 1.
 * Transport, PRO, messenger and warehouse stay in the company currency (AED) — they are billed in the UAE.
 */
export const CURRENCIES: [string, string][] = [['AED', 'UAE dirham'], ['USD', 'US dollar'], ['EUR', 'Euro'], ['INR', 'Indian rupee'], ['CNY', 'Chinese yuan']];
export const CURRENCY_CODES = CURRENCIES.map(([c]) => c);
export const isCurrency = (v: unknown) => CURRENCY_CODES.includes(String(v ?? '').toUpperCase());
export const FX_KEYS = CURRENCY_CODES.filter((c) => c !== 'AED').map((c) => `fx_${c}`);

/** "1 <from> = ? <to>", from the AED rates in Settings; null when a rate is missing. */
export function fxRate(from: string, to: string, aed: Record<string, number | string | null | undefined>) {
  if (!from || !to || from === to) return 1;
  const r = (c: string) => (c === 'AED' ? 1 : Number(aed[c] ?? aed[`fx_${c}`]) || null);
  const a = r(from), b = r(to);
  return a && b ? Math.round((a / b) * 1e6) / 1e6 : null;
}
