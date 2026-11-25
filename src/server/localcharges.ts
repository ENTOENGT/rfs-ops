/**
 * 25 Nov (migration 044) — our own local charges: clearance, transport and handling at the Dubai end.
 *
 *  - Rate cards (our COST), one per situation: mode, import / export, the port / airport, the airline (Emirates or any other),
 *    DG or not. Kept by the admin, the commercial / operations / customer service team leaders and anyone given "Manage local charges". Every save keeps the
 *    old version (who, when) — local_charge_history.
 *  - Each line: per container (20 / 40 ft can differ), per BL / AWB, per document, per kg (with a minimum), per shipment, or a %
 *    of the invoice value; tagged "always", "as per receipt" or "if applicable" (shown to the customer, not in the total);
 *    a DG extra per unit; and our own selling-only charges (RFS handling: no cost, added only when the customer has it).
 *  - calcLocal: for an enquiry / quotation, picks the card, works out each line from the number of containers, BLs,
 *    documents, the weight and the DG answer, and says what may be missing. Selling = cost by default (passed on); the team
 *    puts a margin on it in the quotation like on any line.
 */
import { Actor } from './auth';
import { audit, bad, forbidden, notFound, one, q, tx } from './db';
import { fxRate } from '../lib/currency';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const txt = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const num = (v: unknown) => { if (v === null || v === undefined || String(v).trim() === '') return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const words = (s: unknown) => String(s ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
const hits = (list: unknown, hay: string) => { const h = ` ${hay.toLowerCase()} `; return words(list).some((w) => (w.length <= 3 ? new RegExp(`[^a-z0-9]${w.replace(/[^a-z0-9-]/g, '')}[^a-z0-9]`).test(h) : h.includes(w))); };

export const MODES = ['sea_fcl', 'sea_lcl', 'air', 'road', 'courier'];
export const UNITS: [string, string][] = [['container', 'per container'], ['bl', 'per BL / AWB'], ['document', 'per document'], ['kg', 'per kg'], ['shipment', 'per shipment'], ['percent', '% of invoice value']];
export const TAGS: [string, string][] = [['always', 'Always'], ['receipt', 'As per receipt'], ['if_applicable', 'If applicable (not in total)']];
export const SERVICES: [string, string][] = [['clearance', 'Clearance'], ['transport', 'Transport'], ['handling', 'Our handling'], ['other', 'Other']];

const canSee = (a: Actor) => a.isSuperAdmin || a.has('local_charges.manage') || a.fin.buyingView;
const canManage = (a: Actor) => a.isSuperAdmin || a.has('local_charges.manage');

// ------------------------------------------------------------------ the cards
export async function listCards(actor: Actor) {
  if (!canSee(actor)) throw forbidden();
  const cards = await q(`select c.*, u.full_name updated_by_name, (select count(*)::int from local_charge_lines l where l.card_id = c.id) line_count
    from local_charge_cards c left join users u on u.id = c.updated_by order by c.is_active desc, c.mode, c.direction, c.name`);
  return { cards, can_manage: canManage(actor), units: UNITS, tags: TAGS, services: SERVICES, modes: MODES };
}

export async function getCard(actor: Actor, id: string) {
  if (!canSee(actor)) throw forbidden();
  if (!isUuid(id)) throw notFound('Rate card');
  const card = await one(`select c.*, u.full_name updated_by_name from local_charge_cards c left join users u on u.id = c.updated_by where c.id = $1`, [id]);
  if (!card) throw notFound('Rate card');
  const lines = await q('select * from local_charge_lines where card_id = $1 order by sort_order', [id]);
  const history = await q('select version, user_name, at from local_charge_history where card_id = $1 order by version desc limit 30', [id]);
  return { card, lines, history, can_manage: canManage(actor) };
}

/** Create (id null) or save a card with all its lines. The old version is kept in the history. */
export async function saveCard(actor: Actor, id: string | null, b: any) {
  if (!canManage(actor)) throw forbidden('Only the admin, team leaders and people given "Manage local charges" can change the rate cards');
  const name = txt(b?.name, 120);
  if (!name) throw bad('Name the card, e.g. "Sea import FCL – Jebel Ali clearance"');
  if (!MODES.includes(b?.mode)) throw bad('Choose the mode');
  if (!['import', 'export'].includes(b?.direction)) throw bad('Import or export?');
  const dg = ['no', 'yes', 'any'].includes(b?.dg) ? b.dg : 'no';
  const currency = /^[A-Z]{3}$/.test(String(b?.currency ?? 'AED')) ? String(b?.currency ?? 'AED') : 'AED';
  const raw: any[] = Array.isArray(b?.lines) ? b.lines : [];
  if (!raw.length) throw bad('Add at least one charge');
  if (raw.length > 60) throw bad('Up to 60 charges per card');
  const lines = raw.map((l, i) => {
    const n = `Charge ${i + 1}`;
    const description = txt(l?.description, 200);
    if (!description) throw bad(`${n}: name the charge`);
    if (!UNITS.some(([u]) => u === l?.unit)) throw bad(`${n}: choose how it is charged`);
    const v = {} as { cost: number | null; cost_20: number | null; cost_40: number | null; min_amount: number | null; dg_extra: number | null };
    for (const k of ['cost', 'cost_20', 'cost_40', 'min_amount', 'dg_extra'] as const) {
      const x = num(l?.[k]);
      if (Number.isNaN(x) || (x !== null && x < 0)) throw bad(`${n}: amounts are numbers of 0 or more`);
      v[k] = x === null ? null : Math.round(x * 100) / 100;
    }
    if (l.unit === 'container' ? v.cost === null && v.cost_20 === null && v.cost_40 === null : v.cost === null) throw bad(`${n} (${description}): enter the amount`);
    return { description, service: SERVICES.some(([s]) => s === l?.service) ? l.service : 'clearance', unit: l.unit, ...v,
      tag: TAGS.some(([t]) => t === l?.tag) ? l.tag : 'always', sell_only: !!l?.sell_only, note: txt(l?.note, 200) };
  });
  const cardId = await tx(async (c) => {
    const dup = await one('select id from local_charge_cards where lower(name) = lower($1) and id <> coalesce($2, gen_random_uuid())', [name, id], c);
    if (dup) throw bad('A card with this name is already there');
    let card: any;
    const head = [name, b.mode, b.direction, txt(b?.places, 300), txt(b?.carriers, 300), dg, currency, txt(b?.notes, 1000), b?.is_active !== false];
    if (id) {
      if (!isUuid(id)) throw notFound('Rate card');
      const old = await one('select * from local_charge_cards where id = $1 for update', [id], c);
      if (!old) throw notFound('Rate card');
      // keep the version being replaced
      const oldLines = await q('select * from local_charge_lines where card_id = $1 order by sort_order', [id], c);
      await c.query('insert into local_charge_history (card_id, version, snapshot, user_id, user_name) values ($1, $2, $3, $4, $5)',
        [id, old.version, JSON.stringify({ card: old, lines: oldLines }), old.updated_by, (await one('select full_name from users where id = $1', [old.updated_by], c))?.full_name ?? null]);
      card = await one(`update local_charge_cards set name = $2, mode = $3, direction = $4, places = $5, carriers = $6, dg = $7, currency = $8, notes = $9, is_active = $10,
          version = version + 1, updated_by = $11, updated_at = now() where id = $1 returning *`, [id, ...head, actor.id], c);
      await c.query('delete from local_charge_lines where card_id = $1', [id]);
    } else {
      card = await one(`insert into local_charge_cards (name, mode, direction, places, carriers, dg, currency, notes, is_active, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning *`, [...head, actor.id], c);
    }
    for (const [i, l] of lines.entries())
      await c.query(`insert into local_charge_lines (card_id, sort_order, description, service, unit, cost, cost_20, cost_40, min_amount, dg_extra, tag, sell_only, note)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [card.id, i + 1, l.description, l.service, l.unit, l.cost, l.cost_20, l.cost_40, l.min_amount, l.dg_extra, l.tag, l.sell_only, l.note]);
    await audit(c, actor, { entity_type: 'local_charge_card', entity_id: card.id, action: id ? `Local charges card changed (version ${card.version})` : 'Local charges card added',
      new_value: `${name}: ${lines.length} charge(s)`, sensitivity: 'commercial' as any });
    return card.id as string;
  });
  return getCard(actor, cardId);              // after the save is committed
}

// ------------------------------------------------------------------ the calculation
/** "2x40HC, 1 x 20GP" → { n20: 1, n40: 2 } (45 ft counts as 40). */
export function containersFrom(text: unknown) {
  const s = String(text ?? '');
  let n20 = 0, n40 = 0, found = false;
  const seen = new Set<string>();             // "2x40HC" written twice in one email is still 2 containers
  const add = (n: number, size: string) => { found = true; const k = `${n}x${size === '20' ? 20 : 40}`; if (seen.has(k)) return; seen.add(k); if (size === '20') n20 += n; else n40 += n; };
  for (const m of s.matchAll(/(\d{1,3})\s*(?:x|×|\*|nos?\.?\s*(?:of)?)\s*(20|40|45)\s*(?:'|ft|feet|’)?\s*(?:gp|dv|hc|hq|dc|std|rf|reefer|ot|fr|dry)?/gi)) add(Number(m[1]), m[2]);
  if (!found) for (const m of s.matchAll(/\b(20|40|45)\s*(?:'|ft|’)?\s*(?:gp|dv|hc|hq|dc|std|rf|ot|fr)?\s*(?:x|×|\*)\s*(\d{1,3})\b/gi)) add(Number(m[2]), m[1]);
  return found ? { n20, n40 } : null;
}

type CalcIn = { file_id?: string; card_id?: string; currency?: string; mode?: string; direction?: string; port?: string; carrier?: string; dg?: boolean | null;
  n20?: number; n40?: number; bls?: number; docs?: number; kg?: number | null; cargo_value?: number | null; cargo_value_currency?: string | null };

export async function calcLocal(actor: Actor, b: CalcIn) {
  if (!canSee(actor)) throw forbidden('You need to see cost to work out local charges');
  const fx = Object.fromEntries((await q(`select key, value from settings where key like 'fx\\_%'`)).map((r) => [String(r.key).slice(3), r.value === null ? null : Number(r.value)]));
  // what we know from the enquiry (anything sent in the request wins)
  let f: any = null, guess: any = {};
  if (b.file_id) {
    if (!isUuid(b.file_id)) throw notFound('Job File');
    const { loadFile } = await import('./jobfiles');
    f = await loadFile(actor, b.file_id);
    const dgCheck = await one(`select id from enquiry_checks where label ~* '(hazard|\\mdg\\M|dangerous)' limit 1`);
    const dgAns = dgCheck ? String(f.enquiry_details?.[dgCheck.id] ?? '').toLowerCase() : '';
    const rates = await q(`select carrier, description from vendor_requests where job_file_id = $1 and service = 'rate' and status <> 'cancelled' order by created_at desc`, [f.id]);
    // the first place that says it (never added up: the same "2x40HC" is often written in several places)
    const conts = [f.booked_equipment, f.cargo_description, Object.values(f.enquiry_details ?? {}).join(' \n '), ...rates.map((r: any) => r.description)]
      .map((t) => containersFrom(t)).find(Boolean) ?? null;
    const imp = f.direction !== 'export';
    guess = {
      mode: f.mode, direction: f.direction === 'export' ? 'export' : 'import',
      port: [imp ? f.port_of_discharge : f.port_of_loading, imp ? f.pod_code : f.pol_code, imp ? f.destination : f.origin].filter(Boolean).join(', '),
      carrier: f.carrier || rates.find((r: any) => r.carrier)?.carrier || '',
      dg: dgAns.startsWith('y') ? true : dgAns.startsWith('n') ? false : null,
      n20: conts?.n20 ?? 0, n40: conts?.n40 ?? 0, bls: 1, docs: 1,
      kg: f.chargeable_weight_kg != null ? Number(f.chargeable_weight_kg) : f.gross_weight_kg != null ? Number(f.gross_weight_kg) : null,
      cargo_value: f.cargo_value != null ? Number(f.cargo_value) : null, cargo_value_currency: f.cargo_value_currency ?? null,
      needs_clearance: f.needs_clearance ?? null, needs_transport: f.needs_transport ?? null, delivery_address: f.delivery_address ?? null,
      containers_known: !!conts,
    };
  }
  const p = {
    mode: b.mode ?? guess.mode ?? null, direction: b.direction ?? guess.direction ?? 'import', port: b.port ?? guess.port ?? '', carrier: b.carrier ?? guess.carrier ?? '',
    dg: b.dg === undefined ? guess.dg ?? null : b.dg,
    n20: Math.max(0, Math.round(Number(b.n20 ?? guess.n20 ?? 0)) || 0), n40: Math.max(0, Math.round(Number(b.n40 ?? guess.n40 ?? 0)) || 0),
    bls: Math.max(1, Math.round(Number(b.bls ?? guess.bls ?? 1)) || 1), docs: Math.max(1, Math.round(Number(b.docs ?? guess.docs ?? 1)) || 1),
    kg: b.kg === undefined || b.kg === null || String(b.kg) === '' ? guess.kg ?? null : Number(b.kg),
    cargo_value: b.cargo_value === undefined || b.cargo_value === null || String(b.cargo_value) === '' ? guess.cargo_value ?? null : Number(b.cargo_value),
    cargo_value_currency: b.cargo_value_currency ?? guess.cargo_value_currency ?? null,
  };
  const cur = /^[A-Z]{3}$/.test(String(b.currency ?? '')) ? String(b.currency) : 'AED';
  const missing: string[] = [];

  // the card: the one asked for, else the best match
  const all = await q(`select * from local_charge_cards where is_active ${p.mode ? 'and mode = $1' : ''} order by name`, p.mode ? [p.mode] : []);
  const same = all.filter((c: any) => c.direction === p.direction);
  const fit = same.filter((c: any) => (!c.places || hits(c.places, p.port)) && (!c.carriers || hits(c.carriers, p.carrier))
    && (p.dg === true ? c.dg !== 'no' : c.dg !== 'yes'));
  // a card for this airline / line beats the general one
  fit.sort((a: any, z: any) => Number(!!z.carriers) - Number(!!a.carriers) || Number(z.dg !== 'any') - Number(a.dg !== 'any'));
  let card: any = null;
  if (b.card_id) { if (!isUuid(b.card_id)) throw notFound('Rate card'); card = await one('select * from local_charge_cards where id = $1', [b.card_id]); }
  else card = fit[0] ?? null;
  const choices = same.map((c: any) => ({ id: c.id, name: c.name, fits: fit.some((x: any) => x.id === c.id) }));
  if (!card) {
    missing.push(same.length
      ? `No card fits ${p.port ? `"${p.port}"` : 'this port (not known)'}${p.carrier ? ` / ${p.carrier}` : ''}${p.dg ? ' (DG)' : ''} — choose a card, or add the charges by hand.`
      : `There is no local charges card for ${p.mode ?? 'this mode'} ${p.direction} yet — add the charges by hand, or ask your team leader to add a card.`);
    return { params: p, guess, card: null, choices, lines: [], missing, currency: cur };
  }
  const lines = await q('select * from local_charge_lines where card_id = $1 order by sort_order', [card.id]);
  const rate = fxRate(card.currency, cur, fx);
  if (!rate) { missing.push(`No exchange rate from ${card.currency} to ${cur} in Settings — the amounts are in ${card.currency}.`); }
  const k = rate ?? 1;
  const conv = (n: number) => r2(n * k);

  // what we are asked to do
  const needC = guess.needs_clearance ?? null, needT = guess.needs_transport ?? null;
  if (f && needC === null) missing.push('Customs clearance: not sure the customer needs it (Incoterm / their request) — check; the clearance charges are added.');
  if (f && needT === null) missing.push('Delivery: not sure the customer needs transport — check; the transport charges are added.');
  if (card.dg !== 'any' && p.dg === null) missing.push(`DG not known — the ${card.dg === 'yes' ? 'DG' : 'non-DG'} card is used. Ask the customer.`);
  if (p.mode === 'air' && !p.carrier) missing.push('Airline not known — the card for "any other airline" is used. Emirates shipments have their own card.');

  const out: any[] = [];
  const add = (l: any, x: { description: string; unit: string; qty: number; amount: number; how: string; extraNote?: string | null }) => {
    const note = [l.tag === 'receipt' ? 'as per receipt' : null, l.note, x.extraNote].filter(Boolean).join('; ') || null;
    const per = r2(x.amount);
    const cost = l.sell_only ? 0 : conv(per), sell = conv(per);
    out.push({ key: `${l.id}:${x.description}`, card_line_id: l.id, service: l.service, description: x.description, charge_unit: x.unit, quantity: String(x.qty),
      cost_rate: cost.toFixed(2), sell_rate: sell.toFixed(2), optional: l.tag === 'if_applicable', note, sell_only: !!l.sell_only,
      include: !l.sell_only && !((l.service === 'clearance' && needC === false) || (l.service === 'transport' && needT === false)),
      how: `${x.how}${card.currency !== cur && rate ? ` · ${card.currency}→${cur} × ${rate}` : ''}`,
      amount: r2(x.qty * sell).toFixed(2) });
  };
  let containerGap = false, kgGap = false, valueGap = false;
  for (const l of lines) {
    const dgx = p.dg && l.dg_extra ? Number(l.dg_extra) : 0;
    const dgNote = dgx ? `incl. DG +${Number(l.dg_extra)}` : null;
    if (l.unit === 'container') {
      const sizes: [string, number, number | null][] = [['20 ft', p.n20, l.cost_20 ?? l.cost], ['40 ft', p.n40, l.cost_40 ?? l.cost]];
      if (!p.n20 && !p.n40) { containerGap = true; continue; }
      for (const [size, n, c] of sizes) {
        if (!n) continue;
        if (c === null || c === undefined) { missing.push(`${l.description}: no amount for ${size} on the card.`); continue; }
        const one1 = Number(c) + dgx;
        add(l, { description: `${l.description} (${size})`, unit: 'container', qty: n, amount: one1, how: `${card.currency} ${one1} × ${n} × ${size}`, extraNote: dgNote });
      }
    } else if (l.unit === 'bl' || l.unit === 'document' || l.unit === 'shipment') {
      const n = l.unit === 'bl' ? p.bls : l.unit === 'document' ? p.docs : 1;
      const one1 = Number(l.cost) + dgx;
      add(l, { description: l.description, unit: l.unit, qty: n, amount: one1, how: `${card.currency} ${one1} × ${n} ${l.unit === 'bl' ? 'BL' : l.unit === 'document' ? 'document' : 'shipment'}${n === 1 ? '' : 's'}`, extraNote: dgNote });
    } else if (l.unit === 'kg') {
      const per = Number(l.cost), min = l.min_amount != null ? Number(l.min_amount) : null;
      if (p.kg === null || !(p.kg > 0)) {
        kgGap = true;
        if (min !== null) add(l, { description: l.description, unit: 'shipment', qty: 1, amount: min, how: `minimum ${card.currency} ${min} (weight not known)`, extraNote: `${card.currency} ${per}/kg, min ${min}` });
        continue;
      }
      const total = r2(per * p.kg);
      if (min !== null && total < min) add(l, { description: l.description, unit: 'shipment', qty: 1, amount: min, how: `${card.currency} ${per} × ${p.kg} kg = ${total} → minimum ${min}`, extraNote: 'minimum' });
      else if (card.currency === cur) add(l, { description: l.description, unit: 'kg', qty: p.kg, amount: per, how: `${card.currency} ${per} × ${p.kg} kg` });
      else add(l, { description: `${l.description} (${p.kg} kg)`, unit: 'shipment', qty: 1, amount: total, how: `${card.currency} ${per} × ${p.kg} kg` });
    } else if (l.unit === 'percent') {
      const pct = Number(l.cost);
      const vr = p.cargo_value !== null && p.cargo_value_currency ? fxRate(p.cargo_value_currency, card.currency, fx) : null;
      if (p.cargo_value === null || !vr) { valueGap = true; add(l, { description: l.description, unit: 'shipment', qty: 1, amount: 0, how: `${pct}% of the invoice value (not known)`, extraNote: `${pct}% of invoice value` }); continue; }
      const amt = r2((p.cargo_value * vr * pct) / 100);
      add(l, { description: l.description, unit: 'shipment', qty: 1, amount: amt, how: `${pct}% of ${p.cargo_value_currency} ${p.cargo_value}` });
    }
  }
  if (containerGap) missing.push('Number of containers not known — enter 20 ft / 40 ft to add the per-container charges.');
  if (kgGap) missing.push('Weight not known — the minimum is used for the per-kg charges. Enter the chargeable weight.');
  if (valueGap) missing.push('Invoice value not known — the customs duty line has no amount.');
  const trans = out.filter((l) => l.service === 'transport' && l.include && !l.optional);
  if (trans.length && guess.delivery_address) missing.push(`Transport on the card: "${trans.map((l) => l.description).join('", "')}". Delivery address: ${guess.delivery_address} — check the trucking rate fits.`);
  const left = [...new Set(out.filter((l) => !l.include && !l.sell_only).map((l) => l.service))];
  if (left.length) missing.push(`${left.map((x) => (x === 'transport' ? 'Transport' : x === 'clearance' ? 'Clearance' : x)).join(' and ')} left unticked: the enquiry does not ask for it (Incoterm / the customer's request). Tick it if they want it.`);
  if (out.some((l) => l.sell_only)) missing.push('Our own charge (e.g. RFS handling) is not ticked — tick it when this customer pays it.');
  return { params: p, guess, card: { id: card.id, name: card.name, version: card.version, currency: card.currency, notes: card.notes, updated_at: card.updated_at }, choices, lines: out, missing, currency: cur };
}
