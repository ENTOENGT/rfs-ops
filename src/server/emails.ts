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

export type Recipient = { name: string; email: string; role?: string | null; picked: boolean };
export type Draft = { kind: string; id: string; recipients: Recipient[]; subject: string; body: string; note?: string; options?: [string, string][]; update?: string;
  template?: { key: string; name: string; source: string }; missing?: string[] };

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

/** The customer's email addresses: main email and every contact with an email; the primary contact(s) are ticked. */
async function customerRecipients(customerId: string, extra?: string | null): Promise<Recipient[]> {
  const c = await one('select name, email, contact_person from customers where id = $1', [customerId]);
  const contacts = await q(`select full_name, role, email, is_primary from customer_contacts where customer_id = $1 and deleted_at is null and email is not null
    order by is_primary desc, full_name`, [customerId]);
  const out: Recipient[] = [];
  const add = (r: Recipient) => { if (EMAIL.test(r.email) && !out.some((x) => x.email.toLowerCase() === r.email.toLowerCase())) out.push(r); };
  if (extra && EMAIL.test(extra.trim())) add({ name: 'Contact on this case', email: extra.trim(), picked: true });
  for (const k of contacts) add({ name: k.full_name, email: k.email, role: k.role, picked: !!k.is_primary });
  if (c?.email) add({ name: c.contact_person || c.name, email: c.email, role: 'Main email', picked: false });
  if (out.length && !out.some((r) => r.picked)) out[0].picked = true;
  return out;
}
const dear = (r: Recipient[], fallback: string) => {
  const p = r.filter((x) => x.picked && x.name && x.role !== 'Main email' && x.name !== 'Contact on this case');
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
  const recipients: Recipient[] = r.vendor_email && EMAIL.test(r.vendor_email) ? [{ name: r.vendor_contact || r.vendor_name, email: r.vendor_email, role: r.vendor_name, picked: true }] : [];
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
  const recipients = await customerRecipients(d.customer_id);
  const cur = d.currency;
  const options = optionsFor('quotation');
  if (!options.some(([k]) => k === key)) key = d.version_no > 1 ? 'quotation_revision' : 'quotation_submission';
  const f = d.job_file_id ? await shipment(d.job_file_id) : null;
  const base = f ? await shipmentVals(f, false) : {
    ThreadSubject: `Quotation ${d.quote_no}${[d.origin, d.destination].filter(Boolean).length ? ` – ${[d.origin, d.destination].filter(Boolean).join(' to ')}` : ''}`,
    CustomerName: d.customer_name, CustomerReference: d.enquiry_reference, Origin: d.origin, Destination: d.destination,
    CargoDetails: d.cargo_description, ShipmentDetails: facts([['Route', [d.origin, d.destination].filter(Boolean).join(' to ')], ['Cargo', d.cargo_description]]) };
  const line = (l: any) => `- ${l.description}: ${money(l.sell_rate, cur)} ${l.unit_name}${Number(l.quantity) !== 1 ? ` x ${Number(l.quantity)} = ${money(l.sell_amount, cur)}` : ''}`;
  // Part G2: several route options → the charges are listed per option, each with its own total
  const opts: any[] = d.options ?? [];
  const { routeLabel } = await import('../lib/routingRules');
  const multi = opts.length > 1;
  const vals = { ...base,
    QuoteNumber: d.quote_no, QuoteVersion: String(d.version_no ?? 1),
    Charges: multi ? opts.map((o) => `${routeLabel(o)}\n${d.lines.filter((l: any) => l.route_id === o.id).map(line).join('\n')}\nOption ${o.option_no} total: ${money(o.sell_total, cur)}`).join('\n\n')
      : d.lines.map(line).join('\n'),
    Total: multi ? opts.map((o) => `Option ${o.option_no} ${money(o.sell_total, cur)}`).join(' / ') : money(d.totals.sell_total, cur),
    RouteOptions: multi ? opts.map((o) => `${routeLabel(o)}: ${money(o.sell_total, cur)}`).join('\n') : '', ValidUntil: D(d.valid_until), Exclusions: d.exclusions ? `Not included: ${d.exclusions}` : '',
    Greeting: dear(recipients, `${d.customer_name} team`), Signature: await signature(actor) };
  const t = await fromTemplate(key!, f, vals);
  return { kind: 'quotation', id, recipients, ...t, options, update: key,
    note: `Attach the PDF: press "Print / PDF" on the quotation and save it as PDF.${recipients.length ? '' : ' This customer has no email saved — add one under Customers → contacts.'}` };
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
  const recipients = await customerRecipients(f.customer_id);
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

// ------------------------------------------------------------ old customer service case
async function caseDraft(actor: Actor, id: string): Promise<Draft> {
  const k = await getCase(actor, id);
  if (!k.can.manage) throw new ApiError(403, 'FORBIDDEN', 'You can\'t reply on cases');
  const recipients = await customerRecipients(k.customer_id, k.contact_detail);
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
  switch (p.kind) {
    case 'vendor_request': return vendorDraft(actor, p.id, p.update);
    case 'quotation': return quotationDraft(actor, p.id, p.update);
    case 'job_file': return jobFileDraft(actor, p.id, p.update ?? '');
    case 'case': return caseDraft(actor, p.id);
    default: throw bad('Unknown email type');
  }
}

/** Record that the email was prepared (opened in the user's email program): in that record's history and on the shipment's Emails tab. */
export async function emailPrepared(actor: Actor, b: any) {
  const draft = await emailDraft(actor, { kind: b.kind, id: b.id, update: b.update }); // also re-checks permission
  const to = (Array.isArray(b.to) ? b.to : []).map((x: unknown) => String(x).trim()).filter((x: string) => EMAIL.test(x)).slice(0, 20);
  const subject = String(b.subject ?? draft.subject).slice(0, 300);
  const detail = `To ${to.join(', ') || '(typed in email program)'} — "${subject}"`;
  await tx(async (c) => {
    let fileId: string | null = null, vr: string | null = null, qid: string | null = null;
    if (b.kind === 'vendor_request') {
      await c.query('insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [b.id, 'Email prepared', detail, actor.id, actor.full_name]);
      fileId = (await one('select job_file_id from vendor_requests where id = $1', [b.id], c))?.job_file_id ?? null; vr = b.id;
    } else if (b.kind === 'quotation') {
      await c.query('insert into quotation_events (quotation_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [b.id, 'Email prepared for the customer', detail, actor.id, actor.full_name]);
      fileId = (await one('select job_file_id from quotations where id = $1', [b.id], c))?.job_file_id ?? null; qid = b.id;
    } else if (b.kind === 'job_file') {
      await loadFile(actor, b.id, c); await event(c, actor, b.id, { kind: 'note', title: 'Email prepared for the customer', new_value: detail }); fileId = b.id;
    } else if (b.kind === 'case') {
      await c.query('insert into cs_case_events (case_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [b.id, 'Email reply prepared', detail, actor.id, actor.full_name]);
      await c.query('update cs_cases set first_response_at = coalesce(first_response_at, now()) where id = $1', [b.id]);
    }
    if (fileId) {
      const me = await one('select email from users where id = $1', [actor.id], c);
      await c.query(`insert into email_messages (job_file_id, direction, status, template_key, vendor_request_id, quotation_id, from_addr, from_name, to_addrs, subject,
          sent_at, body_excerpt, source, created_by, created_by_name) values ($1,'out','prepared',$2,$3,$4,$5,$6,$7,$8, now(), $9, 'button', $10, $11)`,
        [fileId, draft.template?.key ?? null, vr, qid, me?.email ?? null, actor.full_name, to.join(', ') || null, subject,
          String(b.body ?? draft.body).slice(0, 2000), actor.id, actor.full_name]);
    }
  });
  return { ok: true };
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
