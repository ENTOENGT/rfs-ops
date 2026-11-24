/**
 * 24 Nov (migration 042) — "Track" buttons on a shipment: the shipping line's / airline's own tracking page with the booking,
 * BL or container number already filled in, and where the vessel is now. Nothing is fetched by RFS CRM: the buttons only open
 * the public page in a new tab.
 *
 * The lines' web addresses change from time to time, so the list is kept in Settings → Tracking links (one line each:
 * "Name | words in the line's name | web address with {number}"). The list below is only used until Settings has one.
 */
export type TrackLink = { name: string; match: string; url: string };

export const DEFAULT_TRACKING: TrackLink[] = [
  { name: 'Maersk', match: 'maersk, sealand, sea-land', url: 'https://www.maersk.com/tracking/{number}' },
  { name: 'MSC', match: 'msc, mediterranean shipping', url: 'https://www.msc.com/en/track-a-shipment?trackingNumber={number}' },
  { name: 'CMA CGM', match: 'cma, cgm, apl, anl', url: 'https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&Reference={number}' },
  { name: 'Hapag-Lloyd', match: 'hapag, hlag', url: 'https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container={number}' },
  { name: 'ONE', match: 'ocean network express, one line', url: 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trkNoParam={number}' },
  { name: 'COSCO', match: 'cosco, oocl', url: 'https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number={number}' },
  { name: 'Evergreen', match: 'evergreen', url: 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do?SEL=s_cntr&NO={number}' },
  { name: 'Emirates SkyCargo', match: 'emirates, skycargo, 176-', url: 'https://www.skychain.emirates.com/track?awb={number}' },
];
/** Any line not in the list: a general tracking site. */
export const ANY_LINE = 'https://www.track-trace.com/container?number={number}';
export const VESSEL_URL = 'https://www.vesselfinder.com/vessels?name={vessel}';

/** The Settings text → the list (bad lines are left out). */
export function parseTracking(text: unknown): TrackLink[] {
  return String(text ?? '').split(/\r?\n/).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length >= 3 && p[0] && /^https:\/\/\S+$/i.test(p[2]))
    .map(([name, match, url]) => ({ name: name.slice(0, 60), match: (match || name).slice(0, 200), url: url.slice(0, 400) })).slice(0, 60);
}
export const trackingText = (list: TrackLink[]) => list.map((t) => `${t.name} | ${t.match} | ${t.url}`).join('\n');

/** Which line is it? By the words of each entry, in the line name (or an AWB's airline prefix). */
export function lineFor(list: TrackLink[], carrier: string | null | undefined, numbers: string[] = []) {
  const c = ` ${String(carrier ?? '').toLowerCase()} `;
  const hay = `${c} ${numbers.join(' ').toLowerCase()}`;
  return list.find((t) => t.match.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean)
    .some((w) => (w.length <= 3 && !w.endsWith('-') ? new RegExp(`(^|[^a-z])${w.replace(/[^a-z0-9]/g, '')}([^a-z]|$)`).test(c) : hay.includes(w)))) ?? null;
}

export type Track = { label: string; url: string };
/** The buttons for one shipment: by container (each), else BL, else booking ref.; and the vessel. */
export function trackLinks(list: TrackLink[], f: { carrier?: string | null; booking_reference?: string | null; mbl_mawb?: string | null; vessel_flight?: string | null; mode?: string | null; containers?: { container_no: string }[] }): Track[] {
  const conts = (f.containers ?? []).map((k) => k.container_no).filter(Boolean);
  const line = lineFor(list, f.carrier, [f.mbl_mawb ?? '', f.booking_reference ?? '']);
  const tpl = line?.url ?? ANY_LINE;
  const who = line?.name ?? 'tracking site';
  const fill = (n: string) => tpl.replace('{number}', encodeURIComponent(n.trim()));
  const out: Track[] = [];
  if (conts.length) for (const n of conts.slice(0, 6)) out.push({ label: `Track ${n} (${who})`, url: fill(n) });
  else if (f.mbl_mawb) out.push({ label: `Track ${f.mode === 'air' ? 'AWB' : 'BL'} ${f.mbl_mawb} (${who})`, url: fill(f.mbl_mawb) });
  else if (f.booking_reference && line) out.push({ label: `Track booking ${f.booking_reference} (${who})`, url: fill(f.booking_reference) });
  const vessel = String(f.vessel_flight ?? '').trim();
  if (vessel && f.mode !== 'air') out.push({ label: `Where is ${vessel} now`, url: VESSEL_URL.replace('{vessel}', encodeURIComponent(vessel.replace(/^(m\/?v|mv\.?)\s+/i, ''))) });
  return out;
}
