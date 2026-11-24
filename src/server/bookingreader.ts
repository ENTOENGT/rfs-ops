/**
 * 24 Nov (migration 042) — the AI reads the shipping line's / agent's booking emails.
 *
 *  1. Once a booking request is sent, the line's / agent's emails filed on the shipment are matched to it (quotereader.
 *     matchVendorRequest: our VR no., the address we sent it to, or the same company domain).
 *  2. Each of those emails is read once: a booking confirmation (booking no., line, vessel, voyage, ETD / ETA, ports, direct or
 *     via, containers booked, cut-offs, empty pick-up) or a later update (rolled over to another vessel, new ETD / ETA,
 *     container numbers, sailed, arrived).
 *  3. It waits on the shipment showing what would change (old → new). Nothing is saved until a person presses "Save booking":
 *     the first time it is the normal "Booking confirmed" step; later it is the normal vessel step (so a roll-over is told
 *     to the team and the vessel must be verified again) and the other details, each in the history in their name.
 *  4. "Sailed" / "Arrived" can also be set by hand (Track box), and the reminders (reminders.ts) use them.
 * People who can change the shipment only.
 */
import { Actor } from './auth';
import { ApiError, bad, forbidden, notFound, one, q, tx } from './db';
import { aiConfig, askWithTool } from './ai';
import { emailText } from './agent';
import { readAttachments } from './attachments';
import { canEdit, event, loadFile } from './jobfiles';
import { blank, isBounce, lineOnly } from './quotereader';
import { containerCheckOk } from './pro';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const txt = (v: unknown, max: number) => { const s = blank(String(v ?? '').trim() || null); return s ? s.slice(0, max) : null; };
const date = (v: unknown) => { const s = String(v ?? '').trim().slice(0, 10); return DATE.test(s) && !isNaN(+new Date(s)) ? s : null; };
/** A cut-off: "YYYY-MM-DD HH:MM" (the time as the line writes it; 00:00 when only a day is given). */
const stamp = (v: unknown) => {
  const m = String(v ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m || isNaN(+new Date(m[1]))) return null;
  const h = Number(m[2] ?? 0), mi = Number(m[3] ?? 0);
  return h < 24 && mi < 60 ? `${m[1]} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
};
const iso = (v: unknown) => (v instanceof Date ? (isNaN(+v) ? null : v.toISOString().slice(0, 10)) : v === null || v === undefined || v === '' ? null : String(v).slice(0, 10));
/** A timestamp column (no zone) as "YYYY-MM-DD HH:MM". */
const isoStamp = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) { const p = (n: number) => String(n).padStart(2, '0'); return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}`; }
  return stamp(v);
};

/** What a booking email can fill, in the order shown. kind: t text, d date, s cut-off (date + time). */
export const BOOKING_FIELDS: [key: string, label: string, kind: 't' | 'd' | 's', max?: number][] = [
  ['booking_reference', 'Carrier booking ref.', 't', 80], ['carrier', 'Shipping line / airline', 't', 120], ['vessel_flight', 'Vessel / flight', 't', 80],
  ['voyage', 'Voyage', 't', 40], ['etd', 'ETD', 'd'], ['eta', 'ETA', 'd'], ['port_of_loading', 'Port of loading', 't', 80], ['port_of_discharge', 'Port of discharge', 't', 80],
  ['routing_type', 'Direct / via', 't', 10], ['booked_equipment', 'Containers booked', 't', 120], ['cutoff_si', 'SI / documents cut-off', 's'],
  ['cutoff_vgm', 'VGM cut-off', 's'], ['cutoff_gate', 'Port / gate-in cut-off', 's'], ['empty_pickup', 'Empty container pick-up', 't', 300],
  ['mbl_mawb', 'MBL / MAWB no.', 't', 60], ['atd', 'Sailed on', 'd'], ['ata', 'Arrived on', 'd'],
];
const VESSEL_KEYS = ['vessel_flight', 'voyage', 'etd', 'eta', 'routing_type'];
const fieldOf = (k: string) => BOOKING_FIELDS.find(([x]) => x === k);
const clean = (k: string, v: unknown) => {
  const f = fieldOf(k); if (!f) return null;
  if (k === 'routing_type') return v === 'via' ? 'via' : v === 'direct' ? 'direct' : null;
  if (k === 'carrier') return lineOnly(txt(v, 120));
  return f[2] === 'd' ? date(v) : f[2] === 's' ? stamp(v) : txt(v, f[3] ?? 200);
};
const current = (f: any, k: string) => {
  const t = fieldOf(k)?.[2];
  return t === 'd' ? iso(f[k]) : t === 's' ? isoStamp(f[k]) : (f[k] ?? null);
};
const same = (a: unknown, b: unknown) => String(a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

async function fileFor(actor: Actor, fileId: string) {
  if (!isUuid(fileId)) throw notFound('Job File');
  const f = await loadFile(actor, fileId);                                // may this person open it?
  return f as any;
}
/** The booking request the emails answer (null before a booking is sent). */
const bookingOf = (f: any) => (f.booking_vendor_request_id
  ? one(`select r.id, r.request_no, r.status, r.created_at, r.vendor_id, v.name vendor_name from vendor_requests r join vendors v on v.id = r.vendor_id where r.id = $1`, [f.booking_vendor_request_id])
  : Promise.resolve(null));

// ------------------------------------------------------------------ the box on the shipment
export async function bookingBox(actor: Actor, fileId: string) {
  const f = await fileFor(actor, fileId);
  if (!canEdit(actor, f)) return { allowed: false };
  const vr = await bookingOf(f);
  if (!vr || vr.status === 'cancelled') return { allowed: true, watching: false };
  await (await import('./quotereader')).linkOldReplies(fileId);           // emails filed before the booking reader existed
  const mails = (await q(`select e.id, e.from_addr, e.from_name, e.subject, e.sent_at from email_messages e
      where e.job_file_id = $1 and e.direction = 'in' and e.vendor_request_id = $2 order by coalesce(e.sent_at, e.created_at) desc limit 20`, [fileId, vr.id]))
    .filter((m: any) => !isBounce(m));
  const sugs = await q(`select s.id, s.email_id, s.status, s.summary, s.answers, s.unclear, s.created_at, e.from_name, e.from_addr, e.subject, e.sent_at,
      u.full_name decided_by_name, s.decided_at
    from ai_suggestions s join email_messages e on e.id = s.email_id left join users u on u.id = s.decided_by
    where s.job_file_id = $1 and s.kind = 'booking' order by e.sent_at desc nulls last`, [fileId]);
  const conts = await q('select container_no from job_file_containers where job_file_id = $1 and deleted_at is null', [fileId]);
  const have = new Set(conts.map((k: any) => k.container_no));
  const open = sugs.filter((s: any) => s.status === 'open').map((s: any) => ({ ...s, changes: changesFor(f, s.answers), new_containers: (s.answers.containers ?? []).filter((k: any) => !have.has(k.container_no)) }));
  return { allowed: true, watching: true, configured: aiConfig().ready, stage: f.stage, booking: vr, first: f.stage === 'booking_requested',
    open, done: sugs.filter((s: any) => s.status !== 'open').slice(0, 8), unread: mails.filter((m: any) => !sugs.some((s: any) => s.email_id === m.id)).slice(0, 5) };
}

/** old → new for every detail the email gives that is not already on the shipment. */
export function changesFor(f: any, a: any) {
  const out: { key: string; label: string; old: unknown; new: unknown }[] = [];
  for (const [k, label] of BOOKING_FIELDS) {
    const v = a?.fields?.[k];
    if (v === null || v === undefined || v === '') continue;
    const old = current(f, k);
    if (!same(old, v)) out.push({ key: k, label, old, new: v });
  }
  return out;
}

// ------------------------------------------------------------------ read one email
const TOOL = {
  name: 'record_booking',
  description: 'Record what the shipping line / agent says about our booking.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['confirmation', 'update', 'pending', 'declined', 'other'], description: 'confirmation = the booking is confirmed (booking no. given). update = a later change or news: rolled over to another vessel, new ETD / ETA, container numbers, sailed, arrived. pending = still working on it / no space yet. declined = they cannot take the booking. other = not about this booking.' },
      booking_reference: { type: 'string', description: 'The carrier\'s booking number / reference' },
      carrier: { type: 'string', description: 'The shipping line or airline itself (e.g. MSC, Maersk, Emirates SkyCargo) — never a port, terminal or the agent\'s own company' },
      vessel: { type: 'string', description: 'Vessel name (first vessel), or flight no. for air' }, voyage: { type: 'string' },
      etd: { type: 'string', description: 'YYYY-MM-DD' }, eta: { type: 'string', description: 'YYYY-MM-DD, at the final port of discharge' },
      port_of_loading: { type: 'string' }, port_of_discharge: { type: 'string' },
      routing_type: { type: 'string', enum: ['direct', 'via'], description: 'via = transshipment / connecting vessel' },
      legs: { type: 'array', description: 'Only for via: one line per vessel', items: { type: 'object', properties: {
        vessel: { type: 'string' }, voyage: { type: 'string' }, from_port: { type: 'string' }, to_port: { type: 'string' }, etd: { type: 'string' }, eta: { type: 'string' } } } },
      booked_equipment: { type: 'string', description: 'What is booked, e.g. "2 x 40HC" or "1 x 20GP"' },
      cutoff_si: { type: 'string', description: 'SI / documentation cut-off, "YYYY-MM-DD HH:MM"' },
      cutoff_vgm: { type: 'string', description: 'VGM cut-off, "YYYY-MM-DD HH:MM"' },
      cutoff_gate: { type: 'string', description: 'Port / CY / gate-in cut-off, "YYYY-MM-DD HH:MM"' },
      empty_pickup: { type: 'string', description: 'Where to pick up the empty container (depot), with any release no.' },
      bl_number: { type: 'string', description: 'Master BL or MAWB number, only when written' },
      containers: { type: 'array', items: { type: 'object', properties: { container_no: { type: 'string', description: '4 letters + 7 digits' }, size_type: { type: 'string' }, seal_no: { type: 'string' } } } },
      sailed_on: { type: 'string', description: 'YYYY-MM-DD — only when they say the vessel HAS sailed / departed' },
      arrived_on: { type: 'string', description: 'YYYY-MM-DD — only when they say it HAS arrived / discharged' },
      summary: { type: 'string', description: 'One short sentence: what this email says' },
      quote: { type: 'string', description: 'Their exact words that matter most (max 200 characters)' },
    },
    required: ['kind', 'summary'],
  },
};

export async function readBooking(actor: Actor, fileId: string, emailId: string) {
  const f = await fileFor(actor, fileId);
  if (!canEdit(actor, f)) throw forbidden('You cannot change this shipment');
  if (!isUuid(emailId)) throw notFound('Email');
  const vr = await bookingOf(f);
  const e = await one('select * from email_messages where id = $1 and job_file_id = $2', [emailId, fileId]);
  if (!vr || !e || e.direction !== 'in' || e.vendor_request_id !== vr.id) throw bad('This email is not from the line / agent about the booking');
  if (isBounce(e)) throw bad('This is an automatic reply, not the line\'s / agent\'s answer');
  const old = await one(`select * from ai_suggestions where email_id = $1 and kind = 'booking'`, [emailId]);
  if (old) return { suggestion: old };                                    // read once
  const body = (await emailText(e)).slice(0, 12000);
  const box = e.attachment_count && e.message_id
    ? await one('select ms_message_id from outlook_inbox where user_id = $1 and internet_message_id = $2 limit 1', [e.created_by, e.message_id]) : null;
  const att = box ? await readAttachments(e.created_by, box.ms_message_id).catch(() => ({ blocks: [], text: '', notes: [], names: [] }))
    : { blocks: [] as any[], text: '', notes: [] as string[], names: [] as string[] };
  const text = `Our booking request ${vr.request_no} to ${vr.vendor_name}. Shipment ${f.job_no ?? f.shipping_ref ?? f.enquiry_ref ?? ''}: ${f.mode ?? ''} ${[f.port_of_loading ?? f.origin, f.port_of_discharge ?? f.destination].filter(Boolean).join(' to ')}
On the shipment now: booking ref. ${f.booking_reference ?? '—'}, vessel ${f.vessel_flight ?? '—'} ${f.voyage ?? ''}, ETD ${iso(f.etd) ?? '—'}, ETA ${iso(f.eta) ?? '—'}

Their email — from ${e.from_name ? `${e.from_name} <${e.from_addr}>` : e.from_addr}, subject: ${e.subject ?? ''}, sent ${iso(e.sent_at) ?? ''}

${body || '(no text)'}`
    + (att.text ? `\n\n--- Attached files ---\n${att.text}` : '') + (att.blocks.length ? '\n\nThe attached PDF / pictures are included above: read them too (a booking confirmation is often a PDF).' : '');
  const { input: x, model } = await askWithTool(
    `You read a shipping line's or agent's email about a booking made by Reliance Freight Systems, a freight forwarder in Dubai, UAE.
Pick out the booking details they give. Use only what the email and attachments say; never guess or fill from general knowledge.
Our own earlier emails are often quoted below their reply: details only count when THEY wrote them in this email. Dates as YYYY-MM-DD (today is ${today()}; with no year, use the nearest such date).
"Rolled over / shut out / next vessel" → kind update with the NEW vessel, voyage, ETD and ETA. "Sailed / departed on" → sailed_on. "Arrived / discharged" → arrived_on.
Leave a field out when the email does not say it — never write "not stated", "TBA", "N/A" or similar.`,
    att.blocks.length ? [...att.blocks, { type: 'text', text }] : text, TOOL as any, 1500, 9000);

  // checked here, never taken on trust
  const kind = ['confirmation', 'update', 'pending', 'declined', 'other'].includes(x?.kind) ? x.kind : 'other';
  const fields: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { const c = clean(k, v); if (c !== null) fields[k] = c; };
  set('booking_reference', x?.booking_reference); set('carrier', x?.carrier); set('vessel_flight', x?.vessel); set('voyage', x?.voyage);
  set('etd', x?.etd); set('eta', x?.eta); set('port_of_loading', x?.port_of_loading); set('port_of_discharge', x?.port_of_discharge);
  set('routing_type', x?.routing_type); set('booked_equipment', x?.booked_equipment); set('cutoff_si', x?.cutoff_si); set('cutoff_vgm', x?.cutoff_vgm);
  set('cutoff_gate', x?.cutoff_gate); set('empty_pickup', x?.empty_pickup); set('mbl_mawb', x?.bl_number); set('atd', x?.sailed_on); set('ata', x?.arrived_on);
  // our own numbers are not the booking ref.
  const ours = [vr.request_no, f.enquiry_ref, f.job_no, f.shipping_ref].filter(Boolean).map((v: string) => v.toUpperCase());
  if (fields.booking_reference && (ours.includes(String(fields.booking_reference).toUpperCase()) || /^(ENQ|VR|SR|SI|SE|AI|AE)-/i.test(String(fields.booking_reference)))) delete fields.booking_reference;
  // a "sailed" / "arrived" day in the future is a plan, not a fact
  for (const k of ['atd', 'ata']) if (fields[k] && String(fields[k]) > today()) delete fields[k];
  const unclear: { note: string }[] = att.notes.map((n: string) => ({ note: n }));
  if (fields.etd && fields.eta && String(fields.eta) < String(fields.etd)) { unclear.push({ note: `The email's ETA (${fields.eta}) is before its ETD (${fields.etd}) — ETA left out, check it` }); delete fields.eta; }
  const legs = fields.routing_type === 'via' && Array.isArray(x?.legs) ? x.legs.slice(0, 9).map((l: any) => ({
    vessel: txt(l?.vessel, 80), voyage: txt(l?.voyage, 40), from_port: txt(l?.from_port, 80), to_port: txt(l?.to_port, 80), etd: date(l?.etd), eta: date(l?.eta) }))
    .filter((l: any) => l.vessel) : [];
  const containers: any[] = [];
  for (const k of Array.isArray(x?.containers) ? x.containers.slice(0, 60) : []) {
    const no = String(k?.container_no ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z]{4}\d{7}$/.test(no)) continue;
    if (!containerCheckOk(no)) { unclear.push({ note: `Container ${no} has a wrong check digit — probably mistyped, left out` }); continue; }
    if (!containers.some((c) => c.container_no === no)) containers.push({ container_no: no, size_type: txt(k?.size_type, 20), seal_no: txt(k?.seal_no, 40) });
  }
  const useful = Object.keys(fields).length > 0 || containers.length > 0;
  const answers = { kind, fields, legs, containers, quote: txt(x?.quote, 200), email_date: iso(e.sent_at) };
  const s = await one(`insert into ai_suggestions (job_file_id, email_id, kind, vendor_request_id, status, summary, answers, unclear, model, read_by)
      values ($1, $2, 'booking', $3, $4, $5, $6, $7, $8, $9) on conflict (email_id, kind) do nothing returning *`,
    [fileId, emailId, vr.id, useful && !['declined', 'other'].includes(kind) ? 'open' : 'nothing', txt(x?.summary, 300) ?? '', JSON.stringify(answers), JSON.stringify(unclear), model, actor.id]);
  return { suggestion: s ?? await one(`select * from ai_suggestions where email_id = $1 and kind = 'booking'`, [emailId]) };
}

// ------------------------------------------------------------------ Save booking / Dismiss
/**
 * b.fields   the details to save (as checked / corrected on the screen; only these are saved)
 * b.containers the container numbers to add
 */
export async function applyBooking(actor: Actor, id: string, b: any) {
  if (!isUuid(id)) throw notFound('Suggestion');
  const s = await one(`select * from ai_suggestions where id = $1 and kind = 'booking'`, [id]);
  if (!s) throw notFound('Suggestion');
  let f = await fileFor(actor, s.job_file_id);
  if (!canEdit(actor, f)) throw forbidden('You cannot change this shipment');
  if (s.status !== 'open') throw bad('This email is already handled');
  if (f.booking_vendor_request_id !== s.vendor_request_id) throw new ApiError(409, 'BOOKING_CHANGED', 'The booking on this shipment changed since this email was read');
  const want: Record<string, any> = {};
  for (const [k, v] of Object.entries(b?.fields ?? {})) {
    if (!fieldOf(k)) continue;
    if (v === null || v === undefined || String(v).trim() === '') continue;
    const c = clean(k, v);
    if (c === null) throw bad(`${fieldOf(k)![1]}: ${fieldOf(k)![2] === 'd' ? 'a date (YYYY-MM-DD)' : fieldOf(k)![2] === 's' ? 'a date and time (YYYY-MM-DD HH:MM)' : 'check the value'}`);
    if (!same(current(f, k), c)) want[k] = c;
  }
  const conts: any[] = (Array.isArray(b?.containers) ? b.containers : []).map((k: any) => String(k?.container_no ?? k ?? '').toUpperCase().replace(/[\s-]/g, ''))
    .filter((no: string) => /^[A-Z]{4}\d{7}$/.test(no)).map((no: string) => (s.answers.containers ?? []).find((k: any) => k.container_no === no) ?? { container_no: no });
  for (const k of conts) if (!containerCheckOk(k.container_no)) throw bad(`Container ${k.container_no}: the last digit does not match (check digit) — check the number`);
  if (!Object.keys(want).length && !conts.length) throw bad('Nothing new to save — tick at least one detail, or Dismiss');
  const who = s.answers?.email_date ? `the line's / agent's email of ${s.answers.email_date}` : "the line's / agent's email";
  const note = `From ${who} (AI reading, checked)`;
  const done = new Set<string>();

  // 1. the first confirmation: the normal "Booking confirmed" step
  if (f.stage === 'booking_requested') {
    const ref = want.booking_reference ?? f.booking_reference;
    if (!ref) throw bad('The booking is not confirmed yet: enter the carrier booking reference (the email has none)');
    const { confirmBooking } = await import('./commercial');
    await confirmBooking(actor, f.id, { booking_reference: ref, carrier: want.carrier, vessel_flight: want.vessel_flight, voyage: want.voyage, etd: want.etd, eta: want.eta,
      port_of_loading: want.port_of_loading, port_of_discharge: want.port_of_discharge, booked_equipment: want.booked_equipment, routing_type: want.routing_type,
      booking_confirmed_on: s.answers?.email_date && s.answers.email_date <= today() ? s.answers.email_date : today(), note });
    for (const k of ['booking_reference', 'carrier', 'vessel_flight', 'voyage', 'etd', 'eta', 'port_of_loading', 'port_of_discharge', 'booked_equipment', 'routing_type']) if (want[k] !== undefined) done.add(k);
    f = await loadFile(actor, f.id);
    // a via booking: the vessel legs as the email gives them
    if (want.routing_type === 'via' && (s.answers.legs ?? []).length >= 2) await saveLegs(actor, f, { routing_type: 'via' }, s.answers.legs, note);
  } else if (VESSEL_KEYS.some((k) => want[k] !== undefined)) {
    // 2. a later change of vessel / dates (roll-over): the normal vessel step — told to the team, verified again
    if (await saveLegs(actor, f, want, s.answers.legs ?? [], note)) for (const k of VESSEL_KEYS) if (want[k] !== undefined) done.add(k);
  }
  // 3. everything else, one history line each (old → new)
  await tx(async (c) => {
    const g = await one('select * from job_files where id = $1 for update', [f.id], c);
    for (const [k, v] of Object.entries(want)) {
      if (done.has(k)) continue;
      const old = current(g, k);
      await c.query(`update job_files set ${k} = $2, updated_at = now() where id = $1`, [f.id, v]);
      await event(c, actor, f.id, { kind: 'edit', title: `${fieldOf(k)![1]} ${old ? 'changed' : 'filled in'}`, field: fieldOf(k)![1], old_value: old, new_value: v, remarks: note });
    }
    const added: string[] = [];
    for (const k of conts) {
      const r = await c.query(`insert into job_file_containers (job_file_id, container_no, size_type, seal_no) values ($1, $2, $3, $4) on conflict do nothing`,
        [f.id, k.container_no, k.size_type ?? null, k.seal_no ?? null]);
      if (r.rowCount) added.push(k.container_no);
    }
    if (added.length) await event(c, actor, f.id, { kind: 'edit', title: `Container${added.length === 1 ? '' : 's'} added`, field: 'Containers', new_value: added.join(', '), remarks: note });
    const n = (await import('./notify')).notifyGroup;
    if (want.atd) await n(c, actor, f.id, 'sailed', `on ${want.atd}`);
    if (want.ata) await n(c, actor, f.id, 'arrived', `on ${want.ata}`);
    if (want.etd || want.eta) await c.query(`insert into shipment_reminders (job_file_id, kind, for_date) values ($1, 'eta', $2) on conflict do nothing`, [f.id, want.eta ?? iso(g.eta)]);
    await c.query(`update ai_suggestions set status = 'applied', applied_keys = $2, decided_by = $3, decided_at = now() where id = $1`,
      [id, JSON.stringify([...Object.keys(want), ...(added.length ? ['containers'] : [])]), actor.id]);
    await c.query(`insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1, $2, $3, $4, $5)`,
      [s.vendor_request_id, 'Booking details saved from the line\'s / agent\'s email (AI reading, checked)', Object.keys(want).map((k) => fieldOf(k)![1]).join(', ') + (added.length ? `${Object.keys(want).length ? ', ' : ''}containers` : ''), actor.id, actor.full_name]);
  });
  return bookingBox(actor, f.id);
}

/** The vessel step (routing.vesselAction) with the email's vessel / dates on top of the legs we have. */
async function saveLegs(actor: Actor, f: any, want: Record<string, any>, aiLegs: any[], note: string) {
  const { legsFor, vesselAction } = await import('./routing');
  const now = (await legsFor(f.id)).map((l: any) => ({ vessel: l.vessel, voyage: l.voyage, from_port: l.from_port, to_port: l.to_port, etd: iso(l.etd), eta: iso(l.eta) }));
  const routing = want.routing_type ?? f.routing_type ?? (now.length > 1 ? 'via' : 'direct');
  let legs: any[];
  if (routing === 'via' && aiLegs.length >= 2) legs = aiLegs;
  else if (routing === 'direct' || now.length <= 1) {
    const l = now[0] ?? { from_port: f.port_of_loading, to_port: f.port_of_discharge };
    legs = [{ ...l, vessel: want.vessel_flight ?? l.vessel ?? f.vessel_flight, voyage: want.voyage ?? l.voyage ?? f.voyage, etd: want.etd ?? l.etd ?? iso(f.etd), eta: want.eta ?? l.eta ?? iso(f.eta) }];
  } else {
    // via, the email gives only the first vessel / the final ETA: first leg and last leg's ETA
    legs = now.map((l, i) => i === 0 ? { ...l, vessel: want.vessel_flight ?? l.vessel, voyage: want.voyage ?? l.voyage, etd: want.etd ?? l.etd } : l);
    if (want.eta) legs[legs.length - 1] = { ...legs[legs.length - 1], eta: want.eta };
  }
  // via with only one vessel known: the details go on the shipment as they are; the legs are entered by hand
  if (routing === 'via' && legs.length < 2) return false;
  await vesselAction(actor, f.id, { step: 'save', routing_type: routing, legs, note });
  return true;
}

export async function dismissBooking(actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Suggestion');
  const s = await one(`select * from ai_suggestions where id = $1 and kind = 'booking'`, [id]);
  if (!s) throw notFound('Suggestion');
  const f = await fileFor(actor, s.job_file_id);
  if (!canEdit(actor, f)) throw forbidden();
  if (!['open', 'nothing'].includes(s.status)) throw bad('This email is already handled');
  await q(`update ai_suggestions set status = 'dismissed', decided_by = $2, decided_at = now() where id = $1`, [id, actor.id]);
  return bookingBox(actor, f.id);
}

// ------------------------------------------------------------------ Track box: links, Sailed / Arrived by hand
export async function trackingFor(actor: Actor, fileId: string) {
  const f = await fileFor(actor, fileId);
  const { getSetting } = await import('./db');
  const { DEFAULT_TRACKING, trackLinks } = await import('../lib/tracking');
  const list = await getSetting<any>('tracking_links', null);
  const containers = await q('select container_no from job_file_containers where job_file_id = $1 and deleted_at is null order by container_no', [fileId]);
  const links = trackLinks(Array.isArray(list) && list.length ? list : DEFAULT_TRACKING, { ...f, containers });
  return { links, atd: iso(f.atd), ata: iso(f.ata), etd: iso(f.etd), eta: iso(f.eta),
    cutoffs: { si: isoStamp(f.cutoff_si), vgm: isoStamp(f.cutoff_vgm), gate: isoStamp(f.cutoff_gate) }, empty_pickup: f.empty_pickup ?? null,
    can_mark: canEdit(actor, f) && !!(f.vessel_flight || f.booking_reference) };
}

/** { what: 'sailed' | 'arrived', date } — date '' clears it (a mistake). */
export async function markTracking(actor: Actor, fileId: string, b: any) {
  const f = await fileFor(actor, fileId);
  if (!canEdit(actor, f)) throw forbidden('You cannot change this shipment');
  const what = b?.what === 'arrived' ? 'arrived' : b?.what === 'sailed' ? 'sailed' : null;
  if (!what) throw bad('Sailed or arrived?');
  const raw = String(b?.date ?? '').trim();
  const d = raw ? date(raw) : null;
  if (raw && !d) throw bad('Enter the date as YYYY-MM-DD');
  if (d && d > today()) throw bad('That date is in the future');
  const col = what === 'sailed' ? 'atd' : 'ata', label = what === 'sailed' ? 'Sailed on' : 'Arrived on';
  if (what === 'arrived' && d && f.atd && d < iso(f.atd)!) throw bad('Arrived before it sailed — check the dates');
  if (iso(f[col]) === d) return trackingFor(actor, fileId);
  await tx(async (c) => {
    await c.query(`update job_files set ${col} = $2, updated_at = now() where id = $1`, [fileId, d]);
    await event(c, actor, fileId, { kind: 'edit', title: d ? label : `${label} taken off`, field: label, old_value: iso(f[col]), new_value: d, remarks: String(b?.note ?? '').slice(0, 300) || null });
    if (d) await (await import('./notify')).notifyGroup(c, actor, fileId, what, `on ${d}`);
  });
  return trackingFor(actor, fileId);
}
