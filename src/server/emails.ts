/**
 * Emails (Part D, templates and history from Part G1).
 *
 * Drafts: the system writes the email from a template — recipients, subject and text with the record's details —
 * and the user's own email program (Outlook, Gmail…) opens it to check and send. Nothing is sent from the server.
 * Kinds: vendor_request (to the agent / carrier — never the customer's name or prices), quotation (to the customer,
 * selling prices only), job_file (to the customer), case (old customer service cases).
 *
 * One subject per shipment: "[ENQ-IMP-26-00012] Shipment Enquiry – Shanghai to Jebel Ali". The Enquiry Ref tag is never
 * removed; the Shipping Ref, then the Job No., is added beside it. The words after the tags are fixed when the enquiry opens.
 *
 * History: every prepared email and every saved .eml / .msg file is listed on the shipment's Emails tab.
 */
import { randomUUID } from 'crypto';
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, getSetting, one, q, tx } from './db';
import { getVendorRequest, VR_SERVICES } from './vendorreqs';
import { getQuotation } from './quotations';
import { getJobFile, loadFile, event, canEdit } from './jobfiles';
import { getCase } from './cases';
import { fileStore } from './storage';
import { label, MODES, DIRECTIONS } from '../lib/jobfileRules';
import { EMAIL_TEMPLATES, fillTemplate } from '../lib/templateRules';
import { pickEmailTemplate } from './templates';

export type Recipient = { name: string; email: string; role?: string | null; picked: boolean; place?: 'to' | 'cc'; side?: 'customer' | 'ours'; removable?: boolean };
export type Draft = { kind: string; id: string; file_id?: string | null; recipients: Recipient[]; subject: string; body: string; note?: string; options?: [string, string][]; update?: string;
  template?: { key: string; name: string; source: string }; missing?: string[];
  /** 23 Nov: a file attached by itself when sent from Outlook (the quotation PDF) */ attach?: { name: string };
  /** 23 Nov: parts of the text sent as an HTML table instead (the quotation's charges) */ blocks?: { text: string; html: string }[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f-]{36}$/i;
const D = (v: any) => {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  const d = new Date(s.length === 10 ? s + 'T00:00:00Z' : s);
  return isNaN(+d) ? null : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' });
};
/** The shipment's number for outside people: the Job No. once given, otherwise the Shipping Ref, otherwise the Enquiry Ref. */
const refOf = (x: any): { label: string; no: string } | null => x?.job_no ? { label: 'Job', no: x.job_no } : x?.shipping_ref ? { label: 'Ref.', no: x.shipping_ref }
  : x?.enquiry_ref ? { label: 'Ref.', no: x.enquiry_ref } : null;
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 23 Nov: the email text as simple HTML (paragraphs, line breaks); a block still there unchanged becomes its table. */
export function toHtml(body: string, blocks: { text: string; html: string }[] = []) {
  let rest = body.replace(/\r/g, ''), out = '';
  const b = blocks.find((x) => x.text && rest.includes(x.text));
  const para = (t: string) => t.split(/\n{2,}/).map((p) => p.trim() ? `<p style="margin:0 0 12px">${esc(p.trim()).replace(/\n/g, '<br>')}</p>` : '').join('');
  if (b) {
    const i = rest.indexOf(b.text);
    // the table has its own heading row and total: a "Charges:" line just above and a "Total …" line just below go
    const before = rest.slice(0, i).replace(/\n?[ \t]*Charges:?[ \t]*\n?$/i, '\n');
    const after = rest.slice(i + b.text.length).replace(/^[ \t]*\n?[ \t]*Total\b[^\n]*(\n|$)/i, '\n');
    out = para(before) + b.html + para(after);
  }
  else out = para(rest);
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45;color:#1a202c">${out}</div>`;
}
const money = (v: any, cur: string) => `${cur} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "Label: value" lines, skipping empty values. */
const facts = (rows: [string, unknown][]) => rows.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
const routeOf = (f: any) => [f.origin, f.port_of_loading, f.port_of_discharge, f.destination].filter(Boolean).filter((v: any, i: number, a: any[]) => a.indexOf(v) === i).join(' → ');

/**
 * The shipment's one email subject. Tags: the Enquiry Ref always, then the Job No. (or, before handover, the Shipping Ref).
 * The words: Enquiry → Booking (customer confirmed) → Update (handed over), then the route fixed when the enquiry opened.
 */
export function threadSubject(f: any): string {
  const second = f.job_no && f.job_no !== f.enquiry_ref ? f.job_no : f.shipping_ref;
  const tags = [f.enquiry_ref, second].filter(Boolean).map((t) => `[${t}]`).join(' ');
  const title = f.job_no && f.status !== 'enquiry' ? 'Shipment Update' : f.shipping_ref ? 'Shipment Booking' : 'Shipment Enquiry';
  const topic = f.email_topic || [f.origin || f.port_of_loading, f.destination || f.port_of_discharge].filter(Boolean).join(' to ') || null;
  return `${tags} ${title}${topic ? ` – ${topic}` : ''}`.trim();
}

async function signature(actor: Actor) {
  const me = await one('select full_name, email, mobile from users where id = $1', [actor.id]);
  const co: Record<string, string> = {};
  for (const k of ['company_name', 'company_phone', 'company_email']) co[k] = String(await getSetting(k, ''));
  return ['Best regards,', me?.full_name ?? actor.full_name, co.company_name, [co.company_phone && `Tel: ${co.company_phone}`, me?.mobile && `Mobile: ${me.mobile}`].filter(Boolean).join(' · '),
    me?.email && !String(me.email).endsWith('.local') ? me.email : co.company_email].filter(Boolean).join('\n');
}

/** The customer's To / CC (migration 033): see emailpeople.ts — contacts, the shipment's people, our team in CC. */
async function customerRecipients(actor: Actor, customerId: string, fileId?: string | null, extra?: string | null): Promise<Recipient[]> {
  const { customerPeople } = await import('./emailpeople');
  return customerPeople(actor, customerId, fileId, extra);
}
const dear = (r: Recipient[], fallback: string) => {
  const p = r.filter((x) => x.picked && x.place !== 'cc' && x.side !== 'ours' && x.name && !x.name.includes('@') && x.role !== 'Main email' && x.name !== 'Contact on this case');
  return `Dear ${p.length === 1 ? p[0].name.split(' ')[0] : fallback},`;
};

/** A shipment with the names the templates need. */
async function shipment(id: string, db?: Db) {
  return one(`select f.*, c.name customer_name, sm.full_name salesman_name, co.full_name coordinator_name from job_files f
    left join customers c on c.id = f.customer_id left join users sm on sm.id = f.salesman_id left join users co on co.id = f.coordinator_id where f.id = $1`, [id], db);
}
/** Placeholder values every email about a shipment can use. `forVendor` leaves out what agents must not see. */
async function shipmentVals(f: any, forVendor: boolean) {
  const conts = await q(`select size_type, count(*) n from job_file_containers where job_file_id = $1 and deleted_at is null group by size_type order by size_type`, [f.id]);
  const air = f.mode === 'air';
  const cargo = [f.cargo_description, f.packages && `${f.packages} pkgs`, f.gross_weight_kg && `${Number(f.gross_weight_kg).toLocaleString()} kg`, f.volume_cbm && `${f.volume_cbm} CBM`].filter(Boolean).join(' · ');
  const details = facts([
    ['Our ref.', [f.enquiry_ref, f.job_no ?? f.shipping_ref].filter(Boolean).join(' / ')], ...(forVendor ? [] : [['Your reference', f.customer_reference] as [string, unknown]]),
    ['Shipment', `${label(DIRECTIONS, f.direction)} · ${label(MODES, f.mode)}`], ['Route', routeOf(f)], ['Incoterm', f.incoterm],
    ['Containers', conts.map((k) => `${k.n} x ${k.size_type}`).join(', ')], ['Cargo', cargo],
    [air ? 'Airline / flight' : 'Carrier / vessel', [f.carrier, f.vessel_flight, f.voyage && `voy. ${f.voyage}`].filter(Boolean).join(' · ')],
    ['Booking no.', f.booking_reference], [air ? 'MAWB / HAWB' : 'BL no.', [f.mbl_mawb, f.hbl_hawb].filter(Boolean).join(' / ')],
    [f.atd ? 'Departed' : 'ETD', D(f.atd ?? f.etd)], [f.ata ? 'Arrived' : 'ETA', D(f.ata ?? f.eta)],
  ]);
  return {
    ThreadSubject: threadSubject(f), EnquiryReference: f.enquiry_ref, ShippingReference: f.shipping_ref,
    OperationalJobNumber: f.job_no && f.status !== 'enquiry' ? f.job_no : null,
    ...(forVendor ? {} : { CustomerName: f.customer_name, CustomerReference: f.customer_reference, SalesmanName: f.salesman_name }),
    CoordinatorName: f.coordinator_name, Origin: f.origin ?? f.port_of_loading, Destination: f.destination ?? f.port_of_discharge,
    ShipmentMode: label(MODES, f.mode), CargoDetails: cargo, BookingReference: f.booking_reference, VesselName: f.vessel_flight, VoyageNumber: f.voyage,
    ETD: D(f.etd), ETA: D(f.eta), BLNumber: f.mbl_mawb ?? f.hbl_hawb, ShipmentDetails: details,
  } as Record<string, string | null>;
}
/** Fill a template; returns the draft fields. */
async function fromTemplate(key: string, f: any | null, vals: Record<string, string | null | undefined>) {
  const t = await pickEmailTemplate(key, { division: f?.division ?? null, mode: f?.mode ?? null, customer_id: f?.customer_id ?? null });
  const s = fillTemplate(t.subject, vals), b = fillTemplate(t.body, vals);
  return { subject: s.text.replace(/\s+/g, ' ').trim(), body: b.text, missing: [...new Set([...s.missing, ...b.missing])],
    template: { key, name: t.name, source: t.source } };
}
const optionsFor = (ctx: string) => EMAIL_TEMPLATES.filter((t) => t[2] === ctx).map(([k, n]) => [k, n] as [string, string]);

// ------------------------------------------------------------ vendor request
async function vendorDraft(actor: Actor, id: string, key?: string): Promise<Draft> {
  const r = await getVendorRequest(actor, id);
  if (!r.can.update) throw new ApiError(403, 'FORBIDDEN', 'You can\'t send vendor requests');
  const f = r.job_file_id ? await shipment(r.job_file_id) : null;
  // migration 038: the vendor's team for this request (Sea FCL team…) gets the email, its other addresses in CC
  const recipients: Recipient[] = r.team_email && EMAIL.test(r.team_email)
    ? [{ name: r.team_contact || `${r.vendor_name} – ${r.team_name}`, email: r.team_email, role: `${r.vendor_name} – ${r.team_name}`, picked: true, place: 'to' },
      ...String(r.team_cc ?? '').split(/[,;\s]+/).filter((e: string) => EMAIL.test(e)).map((e: string) => ({ name: e, email: e, role: `${r.vendor_name} – ${r.team_name}`, picked: true, place: 'cc' as const }))]
    : r.vendor_email && EMAIL.test(r.vendor_email) ? [{ name: r.vendor_contact || r.vendor_name, email: r.vendor_email, role: r.vendor_name, picked: true }] : [];
  if (r.team_email) r.vendor_contact = r.team_contact || null;           // "Dear <team contact>" or "Dear <vendor> team"
  const note = recipients.length ? undefined : `${r.vendor_name} has no email saved. Add it under Vendors, or type the address in your email program.`;
  const templated = ['rate', 'booking'].includes(r.service) && f;
  if (templated) {
    const options = optionsFor('vendor');
    if (!options.some(([k]) => k === key))
      key = r.service === 'booking' ? 'booking_instruction' : ['shipping_line', 'airline'].includes(r.vendor_type) ? 'liner_rate_request' : 'agent_rate_request';
    // Part G2: the exact route option this request is for, in the subject (decision D2) and the details
    const opt = r.route_id ? await one('select * from enquiry_routes where id = $1', [r.route_id]) : null;
    const many = opt ? (await one('select count(*)::int n from enquiry_routes where job_file_id = $1 and removed_at is null', [f.id])).n > 1 : false;
    const { routeLabel } = await import('../lib/routingRules');
    const optText = opt ? facts([['Route option', `Option ${opt.option_no}`], ['Origin', [opt.origin_city, opt.origin_country].filter(Boolean).join(', ')], ['Port of loading', opt.pol],
      ['Port of discharge', opt.pod], ['Destination', [opt.destination_city, opt.destination_country].filter(Boolean).join(', ')], ['Final delivery', opt.final_delivery],
      ['Cargo', [opt.cargo_description, opt.packages && `${opt.packages} pkgs`, opt.gross_weight_kg && `${Number(opt.gross_weight_kg).toLocaleString()} kg`, opt.volume_cbm && `${opt.volume_cbm} CBM`].filter(Boolean).join(' · ')]]) : '';
    const bl = await one('select bl_no, correction_notes from bl_drafts where job_file_id = $1 order by version desc limit 1', [f.id]);
    const vals = { ...(await shipmentVals(f, true)), VendorName: r.vendor_name, RequestNumber: r.request_no,
      ThreadSubject: threadSubject(f) + (many && opt ? ` – ${routeLabel(opt)}` : ''),
      RequestDetails: [many && optText ? `Please quote for this option only:\n${optText}` : null, r.description, `Our request no. ${r.request_no}`].filter(Boolean).join('\n\n'),
      RouteOption: opt ? routeLabel(opt) : null, CorrectionNotes: bl?.correction_notes ?? null, BLNumber: bl?.bl_no ?? f.mbl_mawb ?? f.hbl_hawb,
      NeededBy: r.needed_by ? `We need your ${r.service === 'rate' ? 'rate' : 'reply'} by ${D(r.needed_by)}.` : '',
      Greeting: `Dear ${r.vendor_contact ? r.vendor_contact.split(' ')[0] : `${r.vendor_name} team`},`, Signature: await signature(actor) };
    const t = await fromTemplate(key!, f, vals);
    return { kind: 'vendor_request', id, recipients, ...t, note, options, update: key };
  }
  // other services (trucking, customs, storage…) keep the plain request
  const rate = r.service === 'rate';
  const rr = refOf(r);
  const subject = `${VR_SERVICES[r.service]} request – ${rr ? `${rr.label} ${rr.no} – ` : ''}Our ref. ${r.request_no}`;
  const body = [
    `Dear ${r.vendor_contact ? r.vendor_contact.split(' ')[0] : `${r.vendor_name} team`},`, '',
    rate ? 'Please send us your best rate for the shipment below.' : `Please arrange the following ${VR_SERVICES[r.service].toLowerCase()} for us.`, '',
    r.description, '', facts([['Job No.', r.job_no]]), '',
    'Please confirm with your reference number.', r.needed_by ? `Needed by ${D(r.needed_by)}.` : '',
    `Please quote our reference ${r.request_no} in your reply.`, '', await signature(actor),
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { kind: 'vendor_request', id, recipients, subject, body, note };
}

// ------------------------------------------------------------ quotation (selling only)
async function quotationDraft(actor: Actor, id: string, key?: string): Promise<Draft> {
  if (!actor.fin.sellingView) throw new ApiError(403, 'FORBIDDEN', 'You need to see selling prices to send a quotation');
  const d = await getQuotation(actor, id);
  if (!d.can.customer_copy) throw new ApiError(409, 'QUOTE_NOT_READY', 'Only an approved quotation that has not expired can go to the customer.');
  const recipients = await customerRecipients(actor, d.customer_id, d.job_file_id ?? null);
  const cur = d.currency;
  const options = optionsFor('quotation');
  if (!options.some(([k]) => k === key)) key = d.version_no > 1 ? 'quotation_revision' : 'quotation_submission';
  const f = d.job_file_id ? await shipment(d.job_file_id) : null;
  const base = f ? await shipmentVals(f, false) : {
    ThreadSubject: `Quotation ${d.quote_no}${[d.origin, d.destination].filter(Boolean).length ? ` – ${[d.origin, d.destination].filter(Boolean).join(' to ')}` : ''}`,
    CustomerName: d.customer_name, CustomerReference: d.enquiry_reference, Origin: d.origin, Destination: d.destination,
    CargoDetails: d.cargo_description, ShipmentDetails: facts([['Route', [d.origin, d.destination].filter(Boolean).join(' to ')], ['Cargo', d.cargo_description]]) };
  // 23 Nov: one clean line per charge in the text; sent from Outlook, the charges become a table (see blocks)
  const line = (l: any) => `• ${l.description}${l.note ? ` (${l.note})` : ''} – ${money(l.sell_rate, cur)} ${l.unit_name}${Number(l.quantity) !== 1 ? ` × ${Number(l.quantity)} = ${money(l.sell_amount, cur)}` : ''}`;
  // migration 044: our local charges under their own heading; "if applicable" lines listed after, not in the total
  const listOf = (ls: any[]) => { const main = ls.filter((l) => !l.optional), fr = main.filter((l) => l.section !== 'local'), lo = main.filter((l) => l.section === 'local');
    return [...fr.map(line), ...(lo.length ? [...(fr.length ? ['Local charges:'] : []), ...lo.map(line)] : [])].join('\n'); };
  const extraOf = (ls: any[]) => { const ex = ls.filter((l) => l.optional); return ex.length ? `If applicable (not included in the total):\n${ex.map(line).join('\n')}` : ''; };
  // Part G2: several route options → the charges are listed per option, each with its own total
  const opts: any[] = d.options ?? [];
  const { routeLabel } = await import('../lib/routingRules');
  const multi = opts.length > 1;
  const vals = { ...base,
    QuoteNumber: d.quote_no, QuoteVersion: String(d.version_no ?? 1),
    Charges: multi ? opts.map((o) => { const ls = d.lines.filter((l: any) => l.route_id === o.id); return [`${routeLabel(o)}\n${listOf(ls)}\nOption ${o.option_no} total: ${money(o.sell_total, cur)}`, extraOf(ls)].filter(Boolean).join('\n'); }).join('\n\n')
      : [listOf(d.lines), extraOf(d.lines)].filter(Boolean).join('\n'),
    Total: multi ? opts.map((o) => `Option ${o.option_no} ${money(o.sell_total, cur)}`).join(' / ') : money(d.totals.sell_total, cur),
    RouteOptions: multi ? opts.map((o) => `${routeLabel(o)}: ${money(o.sell_total, cur)}`).join('\n') : '', ValidUntil: D(d.valid_until), Exclusions: d.exclusions ? `Not included: ${d.exclusions}` : '',
    Greeting: dear(recipients, `${d.customer_name} team`), Signature: await signature(actor) };
  const t = await fromTemplate(key!, f, vals);
  // the charges block (with its "Charges:" heading and the "Total:" line) → one neat table per option in the sent email
  const row = (l: any, i: number) => `<tr style="background:${i % 2 ? '#f6f8fb' : '#ffffff'}">${[esc(l.description) + (l.note ? ` <span style="color:#6b7280">(${esc(l.note)})</span>` : ''), esc(l.unit_name), String(Number(l.quantity)), money(l.sell_rate, '').trim(), money(l.sell_amount, '').trim()]
      .map((v, j) => `<td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:${j > 1 ? 'right' : 'left'}">${v}</td>`).join('')}</tr>`;
  const sub = (t: string) => `<tr><td colspan="5" style="padding:7px 10px;background:#eef2f7;font-weight:600;color:#1e3a5f">${esc(t)}</td></tr>`;
  const table = (ls: any[], totalLabel: string, total: unknown) => `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 12px;font-family:Arial,sans-serif;font-size:13px;min-width:520px">`
    + `<tr style="background:#1e3a5f;color:#fff">${['Description', 'Charged', 'Qty', `Rate (${cur})`, `Amount (${cur})`].map((h, i) => `<th style="padding:7px 10px;text-align:${i > 1 ? 'right' : 'left'};font-weight:600">${h}</th>`).join('')}</tr>`
    + (() => { const main = ls.filter((l: any) => !l.optional), fr = main.filter((l: any) => l.section !== 'local'), lo = main.filter((l: any) => l.section === 'local');
      return [...fr.map(row), ...(lo.length && fr.length ? [sub('Local charges')] : []), ...lo.map(row)].join(''); })()
    + `<tr><td colspan="4" style="padding:8px 10px;text-align:right;font-weight:700;color:#1e3a5f">${totalLabel}</td><td style="padding:8px 10px;text-align:right;font-weight:700;color:#1e3a5f;white-space:nowrap">${money(total, cur)}</td></tr>`
    + (ls.some((l: any) => l.optional) ? sub('If applicable (not included in the total)') + ls.filter((l: any) => l.optional).map(row).join('') : '') + `</table>`;
  const html = multi ? opts.map((o) => `<p style="margin:10px 0 2px;font-weight:600">${esc(routeLabel(o))}</p>${table(d.lines.filter((l: any) => l.route_id === o.id), `Option ${o.option_no} total (excluding VAT)`, o.sell_total)}`).join('')
    : table(d.lines, 'Total (excluding VAT)', d.totals.sell_total);
  const blocks = [{ text: `Charges:\n${vals.Charges}\nTotal: ${vals.Total} (excluding VAT)`, html }, { text: String(vals.Charges), html }];
  return { kind: 'quotation', id, recipients, ...t, options, update: key, blocks, attach: { name: `Quotation ${d.quote_no}.pdf` },
    note: recipients.length ? undefined : 'This customer has no email saved — add one under Customers → contacts.' };
}

// ------------------------------------------------------------ shipment emails to the customer
const UPDATES: [string, string][] = [['booking_confirmed', 'Booking confirmed'], ['departed', 'Departed'], ['arrived', 'Arrived'],
  ['customs_cleared', 'Customs cleared'], ['delivered', 'Delivered'], ['documents_needed', 'Documents needed from customer'], ['general', 'General update']];
async function jobFileDraft(actor: Actor, id: string, choice: string): Promise<Draft> {
  const g = await getJobFile(actor, id);
  if (!g.can.edit) throw new ApiError(403, 'FORBIDDEN', 'You can\'t send emails on this shipment');
  const f = await shipment(id);
  const options: [string, string][] = optionsFor('shipment').flatMap(([k, n]) => k === 'shipment_update' ? UPDATES.map(([u, un]) => [`shipment_update:${u}`, `Shipment update: ${un}`] as [string, string]) : [[k, n] as [string, string]]);
  if (!options.some(([k]) => k === choice)) {
    // old links passed only the update code
    const u = UPDATES.some(([c]) => c === choice) ? choice : null;
    choice = u ? `shipment_update:${u}` : f.status === 'enquiry' && f.stage !== 'handed_over' ? 'enquiry_ack'
      : `shipment_update:${f.ata ? 'arrived' : f.atd ? 'departed' : f.booking_reference ? 'booking_confirmed' : 'general'}`;
  }
  const [key, upd] = choice.split(':');
  const recipients = await customerRecipients(actor, f.customer_id, id);
  const missing = (g.checklist ?? []).filter((c: any) => c.status === 'missing' || c.status === 'rejected').map((c: any) => `- ${c.name}`);
  const opening: Record<string, string> = {
    booking_confirmed: `We are pleased to confirm the booking for your shipment${f.etd ? `, planned to depart on ${D(f.etd)}` : ''}.`,
    departed: `Your shipment has departed${f.atd ? ` on ${D(f.atd)}` : ''}${f.eta ? ` and is expected to arrive on ${D(f.eta)}` : ''}.`,
    arrived: `Your shipment has arrived${f.ata ? ` on ${D(f.ata)}` : ''}.${f.needs_clearance ? ' We are now proceeding with customs clearance.' : ''}`,
    customs_cleared: `Customs clearance for your shipment is complete.${f.needs_transport ? ' We will now arrange delivery and confirm the time with you.' : ''}`,
    delivered: 'Your shipment has been delivered. Thank you for choosing us. If anything is not in order, please let us know.',
    documents_needed: missing.length ? `To avoid delays, please send us the following documents for your shipment:\n${missing.join('\n')}` : 'Please send us the documents for your shipment.',
    general: 'Please see the latest update on your shipment below.',
  };
  const bl = await one('select bl_no from bl_drafts where job_file_id = $1 order by version desc limit 1', [id]);
  const vals = { ...(await shipmentVals(f, false)), UpdateText: upd ? opening[upd] : null, Greeting: dear(recipients, `${f.customer_name} team`), Signature: await signature(actor),
    BLNumber: f.final_bl_no ?? bl?.bl_no ?? f.mbl_mawb ?? f.hbl_hawb };
  const t = await fromTemplate(key, f, vals);
  return { kind: 'job_file', id, recipients, ...t, options, update: choice,
    note: recipients.length ? undefined : 'This customer has no email saved — add one under Customers → contacts.' };
}

// ------------------------------------------------------------ ask the customer for what the enquiry is missing (migration 028)
async function missingDraft(actor: Actor, id: string): Promise<Draft> {
  const g: any = await getJobFile(actor, id);
  if (!g.can.edit) throw new ApiError(403, 'FORBIDDEN', 'You can\'t send emails on this shipment');
  const f = await shipment(id);
  const recipients = await customerRecipients(actor, f.customer_id, id);
  const gaps: { ask: string }[] = g.enquiry_gaps ?? [];
  const body = [
    dear(recipients, `${f.customer_name} team`), '',
    'Thank you for your enquiry. To prepare an accurate quotation, could you please share:', '',
    ...(gaps.length ? gaps.map((x) => `- ${x.ask.charAt(0).toUpperCase()}${x.ask.slice(1)}`) : ['- [Nothing is missing — write your question here]']), '',
    'Once we have these, we will send you our quotation.', '',
    await signature(actor),
  ].join('\n');
  return { kind: 'enquiry_missing', id, recipients, subject: threadSubject({ ...f, ...g }), body,
    note: recipients.length ? (gaps.length ? undefined : 'Nothing is missing on this enquiry.') : 'This customer has no email saved — add one under Customers → contacts.' };
}

/** The vendor's people for a request: its team (migration 038) — To + the team's CC — or the vendor's own email. */
function vendorPeople(r: any): Recipient[] {
  if (r.team_email && EMAIL.test(r.team_email)) return [
    { name: r.team_contact || `${r.vendor_name} – ${r.team_name}`, email: r.team_email, role: `${r.vendor_name} – ${r.team_name}`, picked: true, place: 'to' },
    ...String(r.team_cc ?? '').split(/[,;\s]+/).filter((e: string) => EMAIL.test(e)).map((e: string) => ({ name: e, email: e, role: `${r.vendor_name} – ${r.team_name}`, picked: true, place: 'cc' as const }))];
  return r.vendor_email && EMAIL.test(r.vendor_email) ? [{ name: r.vendor_contact || r.vendor_name, email: r.vendor_email, role: r.vendor_name, picked: true }] : [];
}

// ------------------------------------------------------------ batch 3: ask the customer / the vendor about a mismatch (migration 039)
async function clarifyDraft(actor: Actor, issueId: string, side: 'customer' | 'vendor'): Promise<Draft> {
  if (!actor.fin.buyingView) throw new ApiError(403, 'FORBIDDEN', 'Only people who see cost handle these mismatches');
  const i = await one('select * from scope_issues where id = $1', [issueId]);
  if (!i) throw new ApiError(404, 'NOT_FOUND', 'Mismatch not found');
  const ask = String(i.question || i.issue);
  if (side === 'customer') {
    const g: any = await getJobFile(actor, i.job_file_id);
    if (!g.can.edit) throw new ApiError(403, 'FORBIDDEN', 'You can\'t send emails on this shipment');
    const f = await shipment(i.job_file_id);
    const recipients = await customerRecipients(actor, f.customer_id, i.job_file_id);
    const body = [dear(recipients, `${f.customer_name} team`), '', 'Thank you for your enquiry. Before we finalise our quotation, could you please confirm the following:', '',
      ask, '', 'Thank you.', '', await signature(actor)].join('\n');
    return { kind: 'clarify_customer', id: issueId, recipients, subject: threadSubject({ ...f, ...g }), body,
      note: recipients.length ? undefined : 'This customer has no email saved — add one under Customers → contacts.' };
  }
  if (!i.vendor_request_id) throw new ApiError(400, 'NO_VENDOR', 'This mismatch is not about one vendor');
  const r: any = await getVendorRequest(actor, i.vendor_request_id);
  if (!r.can.update) throw new ApiError(403, 'FORBIDDEN', 'You can\'t send vendor requests');
  const recipients = vendorPeople(r);
  if (r.team_email) r.vendor_contact = r.team_contact || null;
  const body = [`Dear ${r.vendor_contact ? String(r.vendor_contact).split(' ')[0] : `${r.vendor_name} team`},`, '', `Thank you for your rate (${r.request_no}). Before we can use it, could you please clarify:`, '',
    ask, '', 'Thank you.', '', await signature(actor)].join('\n');
  return { kind: 'clarify_vendor', id: issueId, recipients, subject: `[${r.request_no}] Clarification on your rate${r.job_no || r.enquiry_ref ? ` – ${r.job_no ?? r.enquiry_ref}` : ''}`, body,
    note: recipients.length ? undefined : `${r.vendor_name} has no email saved.` };
}

// ------------------------------------------------------------ ask the agent for what their rate lacks (migration 028)
// Never the customer's name or our prices — only what the agent needs to complete the quote.
async function vendorMissingDraft(actor: Actor, id: string): Promise<Draft> {
  const r: any = await getVendorRequest(actor, id);
  if (!r.can.update) throw new ApiError(403, 'FORBIDDEN', 'You can\'t send vendor requests');
  const f = r.job_file_id ? await shipment(r.job_file_id) : null;
  const recipients = vendorPeople(r);                                      // the team when there is one (migration 038)
  const gaps: { ask: string }[] = r.quote_gaps ?? [];
  let ship = '';
  if (f) {
    const lines = await q(`select pieces, package_type, package_other, length, width, height, dim_unit, weight_kg from job_file_cargo_lines
      where job_file_id = $1 and removed_at is null order by line_no`, [f.id]);
    const { allEnquiryChecks } = await import('./checklists');
    const extra = (await allEnquiryChecks()).filter((c) => (f.enquiry_details ?? {})[c.id])
      .map((c) => [c.label, c.field_type === 'yes_no' ? (f.enquiry_details[c.id] === 'yes' ? 'Yes' : 'No') : f.enquiry_details[c.id]] as [string, unknown]);
    ship = facts([['Shipment', `${label(DIRECTIONS, f.direction)} · ${label(MODES, f.mode)}`], ['Route', routeOf(f)], ['Incoterm', f.incoterm], ['Commodity', f.cargo_description],
      ['Cargo', lines.map((l: any) => `${l.pieces} ${(l.package_type === 'Other' ? l.package_other : l.package_type)} ${Number(l.length)}×${Number(l.width)}×${Number(l.height)} ${l.dim_unit}, ${Number(l.weight_kg)} kg`).join('; ')
        || [f.packages && `${f.packages} pkgs`, f.gross_weight_kg && `${Number(f.gross_weight_kg).toLocaleString()} kg`, f.volume_cbm && `${f.volume_cbm} CBM`].filter(Boolean).join(' · ')],
      ...extra]);
  }
  const body = [
    `Dear ${r.vendor_contact ? r.vendor_contact.split(' ')[0] : `${r.vendor_name} team`},`, '',
    `Thank you for your rate (our ref. ${r.request_no}). To complete it, could you please also share:`, '',
    ...(gaps.length ? gaps.map((x) => `- ${x.ask.charAt(0).toUpperCase()}${x.ask.slice(1)}`) : ['- [Nothing is missing — write your question here]']), '',
    ...(ship ? ['For your reference, the shipment details:', ship, ''] : []),
    `Please quote our reference ${r.request_no} in your reply.`, '',
    await signature(actor),
  ].join('\n');
  return { kind: 'vendor_missing', id, recipients, subject: f ? `${threadSubject(f)} – Our ref. ${r.request_no}` : `Rate request – Our ref. ${r.request_no}`, body,
    note: recipients.length ? (gaps.length ? undefined : 'Nothing is missing on this rate.') : `${r.vendor_name} has no email saved. Add it under Vendors, or type the address in your email program.` };
}

// ------------------------------------------------------------ old customer service case
async function caseDraft(actor: Actor, id: string): Promise<Draft> {
  const k = await getCase(actor, id);
  if (!k.can.manage) throw new ApiError(403, 'FORBIDDEN', 'You can\'t reply on cases');
  const recipients = await customerRecipients(actor, k.customer_id, null, k.contact_detail);
  const subject = `Re: ${k.subject} – Case ${k.case_no}${k.job_no ? ` – Job ${k.job_no}` : ''}`;
  const done = ['resolved', 'closed'].includes(k.status);
  const body = [
    k.contact_name ? `Dear ${String(k.contact_name).split(' ')[0]},` : dear(recipients, `${k.customer_name} team`), '',
    `Thank you for contacting us about "${k.subject}"${k.job_no ? ` (Job ${k.job_no})` : ''}. Your case number is ${k.case_no}.`, '',
    done ? (k.resolution ? `This has now been resolved: ${k.resolution}` : 'This has now been resolved.') : '[Write your reply here]', '',
    await signature(actor),
  ].join('\n');
  return { kind: 'case', id, recipients, subject, body, note: 'Replace the text in [brackets] before sending.' };
}

export async function emailDraft(actor: Actor, p: Record<string, string>): Promise<Draft> {
  const d = await draftOf(actor, p);
  // the shipment whose To / CC people this email uses (for × on a person)
  const fileId = ['job_file', 'enquiry_missing'].includes(p.kind) ? p.id
    : p.kind === 'clarify_customer' ? (await one('select job_file_id from scope_issues where id = $1', [p.id]))?.job_file_id ?? null
    : p.kind === 'quotation' ? (await one('select job_file_id from quotations where id = $1', [p.id]))?.job_file_id ?? null : null;
  return { ...d, file_id: fileId };
}
async function draftOf(actor: Actor, p: Record<string, string>): Promise<Draft> {
  switch (p.kind) {
    case 'vendor_request': return vendorDraft(actor, p.id, p.update);
    case 'quotation': return quotationDraft(actor, p.id, p.update);
    case 'job_file': return jobFileDraft(actor, p.id, p.update ?? '');
    case 'enquiry_missing': return missingDraft(actor, p.id);
    case 'vendor_missing': return vendorMissingDraft(actor, p.id);
    case 'case': return caseDraft(actor, p.id);
    case 'clarify_customer': return clarifyDraft(actor, p.id, 'customer');
    case 'clarify_vendor': return clarifyDraft(actor, p.id, 'vendor');
    default: throw bad('Unknown email type');
  }
}

/** Record that the email was prepared (opened in the user's email program): in that record's history and on the shipment's Emails tab. */
export async function emailPrepared(actor: Actor, b: any) {
  const draft = await emailDraft(actor, { kind: b.kind, id: b.id, update: b.update }); // also re-checks permission
  const clean = (l: unknown) => (Array.isArray(l) ? l : []).map((x: unknown) => String(x).trim()).filter((x: string) => EMAIL.test(x)).slice(0, 20);
  const to = clean(b.to), cc = clean(b.cc).filter((x) => !to.includes(x));
  await recordEmail(actor, b, draft, to, cc, String(b.subject ?? draft.subject).slice(0, 300), null);
  return { ok: true };
}

/** Outlook Step 2: send the checked email from the person's own Outlook, then note it as sent in the same histories. */
export async function emailSend(actor: Actor, b: any) {
  const draft = await emailDraft(actor, { kind: b.kind, id: b.id, update: b.update }); // also re-checks permission
  const { sendMail } = await import('./outlook');
  const text = String(b.body ?? draft.body);
  // 23 Nov: the quotation PDF goes with it (unless unticked), and the charges as a table
  const attachments = draft.attach && b.attach_pdf !== false && b.kind === 'quotation'
    ? await (async () => { const { quotationPdf } = await import('./quotepdf'); const p = await quotationPdf(actor, b.id);
      return [{ name: p.filename, contentType: 'application/pdf', contentBytes: Buffer.from(p.bytes).toString('base64') }]; })() : [];
  const sent = await sendMail(actor.id, { to: Array.isArray(b.to) ? b.to : [], cc: Array.isArray(b.cc) ? b.cc : [],
    subject: String(b.subject ?? draft.subject), body: text, html: draft.blocks ? toHtml(text, draft.blocks) : undefined, attachments });
  await recordEmail(actor, { ...b, body: text, attached: attachments.map((a) => a.name) }, draft, sent.to, sent.cc, sent.subject, sent.from);
  // 23 Nov: an approved quotation emailed from Outlook is sent — marked so (no extra click); the AI then watches for the answer
  if (b.kind === 'quotation' && (await one('select status from quotations where id = $1', [b.id]))?.status === 'approved') {
    const { quotationAction } = await import('./quotations');
    await quotationAction(actor, b.id, { action: 'send', note: `Emailed from Outlook to ${sent.to.join(', ')}` }).catch(() => {});
  }
  return { ok: true, sent: true, to: sent.to };
}

/** One email in the record's own history and on the shipment's Emails tab. `sentFrom` = sent from Outlook; null = only prepared. */
async function recordEmail(actor: Actor, b: any, draft: Draft, to: string[], cc: string[], subject: string, sentFrom: string | null) {
  const sent = sentFrom !== null;
  const detail = `To ${to.join(', ') || '(typed in email program)'}${cc.length ? ` · CC ${cc.join(', ')}` : ''} — "${subject}"${sent ? ' — sent from Outlook' : ''}${b.attached?.length ? ` — attached: ${b.attached.join(', ')}` : ''}`;
  const t = (prepared: string, done: string) => sent ? done : prepared;
  await tx(async (c) => {
    let fileId: string | null = null, vr: string | null = null, qid: string | null = null;
    if (b.kind === 'vendor_request' || b.kind === 'vendor_missing') {
      await c.query('insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)',
        [b.id, b.kind === 'vendor_missing' ? 'Missing quote details asked from the agent' : t('Email prepared', 'Email sent'), detail, actor.id, actor.full_name]);
      fileId = (await one('select job_file_id from vendor_requests where id = $1', [b.id], c))?.job_file_id ?? null; vr = b.id;
    } else if (b.kind === 'quotation') {
      await c.query('insert into quotation_events (quotation_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [b.id, t('Email prepared for the customer', 'Email sent to the customer'), detail, actor.id, actor.full_name]);
      fileId = (await one('select job_file_id from quotations where id = $1', [b.id], c))?.job_file_id ?? null; qid = b.id;
    } else if (b.kind === 'job_file' || b.kind === 'enquiry_missing') {
      await loadFile(actor, b.id, c);
      await event(c, actor, b.id, { kind: 'note', title: b.kind === 'enquiry_missing' ? 'Missing details asked from the customer' : t('Email prepared for the customer', 'Email sent to the customer'), new_value: detail }); fileId = b.id;
    } else if (b.kind === 'clarify_customer' || b.kind === 'clarify_vendor') {
      // migration 039: the mismatch is marked as asked; the email is on the shipment (and on the vendor's request)
      const i = await one('select job_file_id, vendor_request_id, issue from scope_issues where id = $1', [b.id], c);
      await c.query(`update scope_issues set status = $2, decided_by = $3, decided_at = now() where id = $1`, [b.id, b.kind === 'clarify_customer' ? 'asked_customer' : 'asked_vendor', actor.id]);
      fileId = i.job_file_id;
      if (b.kind === 'clarify_vendor') {
        vr = i.vendor_request_id;
        await c.query('insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [vr, 'Clarification asked', detail, actor.id, actor.full_name]);
      }
      await event(c, actor, fileId!, { kind: 'note', title: b.kind === 'clarify_customer' ? 'Mismatch: asked the customer' : 'Mismatch: asked the vendor', new_value: `${i.issue} — ${detail}`.slice(0, 500) });
    } else if (b.kind === 'case') {
      await c.query('insert into cs_case_events (case_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [b.id, t('Email reply prepared', 'Email reply sent'), detail, actor.id, actor.full_name]);
      await c.query('update cs_cases set first_response_at = coalesce(first_response_at, now()) where id = $1', [b.id]);
    }
    if (fileId) {
      const me = await one('select email from users where id = $1', [actor.id], c);
      await c.query(`insert into email_messages (job_file_id, direction, status, template_key, vendor_request_id, quotation_id, from_addr, from_name, to_addrs, subject,
          sent_at, body_excerpt, source, created_by, created_by_name, cc_addrs) values ($1,'out',$12,$2,$3,$4,$5,$6,$7,$8, now(), $9, 'button', $10, $11, $13)`,
        [fileId, draft.template?.key ?? null, vr, qid, sentFrom || me?.email || null, actor.full_name, to.join(', ') || null, subject,
          String(b.body ?? draft.body).slice(0, 2000), actor.id, actor.full_name, sent ? 'sent' : 'prepared', cc.join(', ') || null]);
      // migration 033: addresses typed in by hand stay on this shipment's later customer emails
      if (['job_file', 'enquiry_missing', 'quotation'].includes(b.kind))
        await (await import('./emailpeople')).rememberTyped(c, actor, fileId, draft.recipients, to, cc);
    }
  });
}

// ------------------------------------------------------------ the shipment's Emails tab
const canSeeEmails = (a: Actor) => a.isSuperAdmin || a.has('emails.view');
export async function listEmails(actor: Actor, fileId: string) {
  await loadFile(actor, fileId);
  if (!canSeeEmails(actor)) throw forbidden();
  const rows = await q(`select e.*, d.file_name document_name, vr.request_no, x.quote_no from email_messages e left join jf_documents d on d.id = e.document_id
      left join vendor_requests vr on vr.id = e.vendor_request_id left join quotations x on x.id = e.quotation_id
    where e.job_file_id = $1 order by coalesce(e.sent_at, e.created_at) desc`, [fileId]);
  const att = rows.length ? await q(`select id, email_id, file_name, size_bytes from jf_documents where email_id = any($1) and deleted_at is null order by file_name`, [rows.map((r) => r.id)]) : [];
  const f = await shipment(fileId);
  return { thread_subject: threadSubject(f), rows: rows.map((r) => ({ ...r, attachments: att.filter((a) => a.email_id === r.id) })) };
}

type Parsed = { from_addr: string | null; from_name: string | null; to: string[]; cc: string[]; subject: string | null; sent_at: Date | null;
  message_id: string | null; in_reply_to: string | null; conversation_id: string | null; text: string; attachments: { name: string; mime: string; body: Buffer }[] };
const MIME_EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'message/rfc822': 'eml', 'application/vnd.ms-outlook': 'msg' };
const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));
const header = (raw: string | undefined, name: string) => raw?.match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im'))?.[1].replace(/\r?\n[ \t]+/g, ' ').trim() ?? null;

async function parseEmail(buf: Buffer, kind: 'eml' | 'msg'): Promise<Parsed> {
  if (kind === 'eml') {
    const { simpleParser } = await import('mailparser');
    const m = await simpleParser(buf);
    const addrs = (v: any) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x: any) => x.value ?? []).map((a: any) => a.address).filter(Boolean);
    const refs = Array.isArray(m.references) ? m.references : m.references ? [m.references] : [];
    return { from_addr: m.from?.value?.[0]?.address ?? null, from_name: m.from?.value?.[0]?.name || null, to: addrs(m.to), cc: addrs(m.cc), subject: m.subject ?? null,
      sent_at: m.date ?? null, message_id: m.messageId ?? null, in_reply_to: (m.inReplyTo as string) ?? null, conversation_id: refs[0] ?? (m.inReplyTo as string) ?? null,
      text: m.text ?? '', attachments: m.attachments.filter((a) => !a.related && a.contentDisposition !== 'inline').map((a) => ({ name: a.filename ?? 'attachment', mime: a.contentType, body: a.content })) };
  }
  const MsgReader = (await import('@kenjiuno/msgreader')).default;
  const r = new MsgReader(new Uint8Array(buf).buffer as ArrayBuffer);
  const d: any = r.getFileData();
  if (d.error) throw bad('This .msg file could not be read');
  const rec = (t: string) => (d.recipients ?? []).filter((x: any) => (x.recipType ?? 'to') === t).map((x: any) => x.smtpAddress || x.email).filter(Boolean);
  const when = d.messageDeliveryTime || d.clientSubmitTime || header(d.headers, 'Date');
  const atts: Parsed['attachments'] = [];
  for (const a of d.attachments ?? []) {
    if (a.attachmentHidden || a.pidContentId || a.innerMsgContent) continue;
    const x = r.getAttachment(a);
    const ext = String(x.fileName ?? '').split('.').pop()?.toLowerCase() ?? '';
    atts.push({ name: x.fileName || 'attachment', mime: a.attachMimeTag || EXT_MIME[ext] || 'application/octet-stream', body: Buffer.from(x.content) });
  }
  return { from_addr: d.senderSmtpAddress || d.senderEmail || d.creatorSMTPAddress || null, from_name: d.senderName ?? null, to: rec('to'), cc: rec('cc'),
    subject: d.subject ?? null, sent_at: when ? new Date(when) : null, message_id: header(d.headers, 'Message-ID'), in_reply_to: header(d.headers, 'In-Reply-To'),
    conversation_id: header(d.headers, 'Thread-Index') ?? header(d.headers, 'References')?.split(/\s+/)[0] ?? null, text: d.body ?? '', attachments: atts };
}

/**
 * Save a .eml / .msg file (already uploaded to the shipment's documents) as an email on the shipment: read who sent it,
 * to whom, when, the subject and the attachments; each attachment of a type we keep becomes a document of the shipment.
 * The same email can't be saved twice. If its subject carries another shipment's Enquiry Ref, the user must confirm.
 */
export async function saveEmailFile(actor: Actor, fileId: string, b: any) {
  const f0 = await loadFile(actor, fileId);
  if (!canEdit(actor, f0) || !canSeeEmails(actor)) throw forbidden('You cannot add emails to this shipment');
  if (!UUID.test(String(b.document_id ?? ''))) throw bad('Upload the email file first');
  const doc = await one(`select * from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null`, [b.document_id, fileId]);
  if (!doc) throw bad('Upload the email file first');
  const kind = doc.mime_type === 'message/rfc822' ? 'eml' : doc.mime_type === 'application/vnd.ms-outlook' ? 'msg' : null;
  if (!kind) throw bad('Only saved emails (.eml or .msg) can be read');
  if (await one('select 1 from email_messages where document_id = $1', [doc.id])) throw new ApiError(409, 'EMAIL_EXISTS', 'This email file is already saved on this shipment');
  const store = fileStore();
  let m: Parsed;
  try { m = await parseEmail(await store.read(doc.storage_path), kind); } catch (e: any) { if (e instanceof ApiError) throw e; throw bad('This email file could not be read. Save it again from Outlook and retry.'); }
  const f = await shipment(fileId);
  const tag = m.subject?.match(/\[(ENQ-[A-Z]{0,4}-?\d{2}-\d{4,6})\]/)?.[1];
  if (tag && tag !== f.enquiry_ref && !b.force) {
    const other = await one('select id from job_files where enquiry_ref = $1', [tag]);
    throw new ApiError(409, 'EMAIL_OTHER_SHIPMENT', `The subject carries ${tag}, which is ${other ? 'another shipment' : 'not this shipment'}. Save it here anyway?`, { tag });
  }
  if (m.message_id && await one('select 1 from email_messages where job_file_id = $1 and message_id = $2', [fileId, m.message_id]))
    throw new ApiError(409, 'EMAIL_EXISTS', 'This email is already saved on this shipment');
  // ours or theirs: sent from one of our users or our company domain = outgoing
  const company = String(await getSetting('company_email', '')).toLowerCase();
  const domain = company.includes('@') ? company.split('@')[1] : null;
  const from = (m.from_addr ?? '').toLowerCase();
  const ours = !!from && (!!(await one('select 1 from users where lower(email) = $1 and deleted_at is null', [from])) || (!!domain && from.endsWith('@' + domain)));
  // keep the attachments we can store (the 10 MB limit and the usual types)
  const keep = m.attachments.filter((a) => MIME_EXT[a.mime.toLowerCase()] && a.body.length > 0 && a.body.length <= 10 * 1024 * 1024).slice(0, 20);
  const saved: { key: string; name: string; mime: string; size: number }[] = [];
  for (const a of keep) {
    const key = `jobfiles/${fileId}/${randomUUID()}.${MIME_EXT[a.mime.toLowerCase()]}`;
    await store.write(key, a.body, a.mime.toLowerCase());
    saved.push({ key, name: a.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150), mime: a.mime.toLowerCase(), size: a.body.length });
  }
  const id = await tx(async (c) => {
    const e = await one(`insert into email_messages (job_file_id, direction, status, from_addr, from_name, to_addrs, cc_addrs, subject, sent_at, message_id, in_reply_to,
        conversation_id, body_excerpt, document_id, attachment_count, source, created_by, created_by_name)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'upload',$16,$17) returning id`,
      [fileId, ours ? 'out' : 'in', ours ? 'sent' : 'received', m.from_addr, m.from_name, m.to.join(', ') || null, m.cc.join(', ') || null, m.subject?.slice(0, 300) ?? doc.file_name,
        m.sent_at && !isNaN(+m.sent_at) ? m.sent_at : null, m.message_id, m.in_reply_to, m.conversation_id, m.text.replace(/\s+\n/g, '\n').slice(0, 2000), doc.id,
        saved.length, actor.id, actor.full_name], c);
    for (const a of saved)
      await c.query(`insert into jf_documents (job_file_id, doc_type, file_name, storage_path, mime_type, size_bytes, version, description, uploaded_by, email_id)
        values ($1,'correspondence',$2,$3,$4,$5,1,$6,$7,$8)`, [fileId, a.name, a.key, a.mime, a.size, `Attachment of the email "${(m.subject ?? '').slice(0, 120)}"`, actor.id, e.id]);
    await event(c, actor, fileId, { kind: 'document', title: ours ? 'Sent email saved' : 'Received email saved',
      new_value: `${m.from_name || m.from_addr || 'Unknown sender'} — "${m.subject ?? ''}"${saved.length ? ` (${saved.length} attachment${saved.length > 1 ? 's' : ''})` : ''}` });
    await (await import('./notify')).notifyGroup(c, actor, fileId, 'email_saved', `${ours ? 'sent' : 'from'} ${m.from_name || m.from_addr || ''}: ${m.subject ?? ''}`);
    return e.id as string;
  }).catch(async (e) => { for (const a of saved) await store.remove(a.key).catch(() => {}); throw e; });
  return { id, skipped: m.attachments.length - saved.length, ...(await listEmails(actor, fileId)) };
}
