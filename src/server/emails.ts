/**
 * Email drafts (Part D). The system writes the email — recipients, subject and text with the right details — and the
 * user's own email program (Outlook, Gmail…) opens it to check and send. Nothing is sent from the server.
 *
 * Kinds: vendor_request (rate / booking request to the vendor), quotation (to the customer, selling prices only —
 * never cost or margin), job_file (shipment update to the customer), case (reply to the customer).
 * Each draft obeys the same permissions as the screen it comes from. "Prepared" is written in that record's history.
 */
import { Actor } from './auth';
import { ApiError, bad, getSetting, one, q, tx } from './db';
import { getVendorRequest, VR_SERVICES } from './vendorreqs';
import { getQuotation } from './quotations';
import { getJobFile, loadFile, event } from './jobfiles';
import { getCase } from './cases';
import { label, MODES, DIRECTIONS } from '../lib/jobfileRules';

export type Recipient = { name: string; email: string; role?: string | null; picked: boolean };
export type Draft = { kind: string; id: string; recipients: Recipient[]; subject: string; body: string; note?: string; options?: [string, string][]; update?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

// ------------------------------------------------------------ vendor request
async function vendorDraft(actor: Actor, id: string): Promise<Draft> {
  const r = await getVendorRequest(actor, id);
  if (!r.can.update) throw new ApiError(403, 'FORBIDDEN', 'You can\'t send vendor requests');
  const f = r.job_file_id ? await one('select * from job_files where id = $1', [r.job_file_id]) : null;
  const conts = f ? await q(`select size_type, count(*) n from job_file_containers where job_file_id = $1 and deleted_at is null group by size_type order by size_type`, [f.id]) : [];
  const recipients: Recipient[] = r.vendor_email && EMAIL.test(r.vendor_email) ? [{ name: r.vendor_contact || r.vendor_name, email: r.vendor_email, role: r.vendor_name, picked: true }] : [];
  const rate = r.service === 'rate';
  const route = f ? [f.origin, f.port_of_loading, f.port_of_discharge, f.destination].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' → ') : null;
  const shipment = f ? facts([
    [f.job_no ? 'Job No.' : 'Our ref.', refOf(f)?.no], ['Shipment', `${label(DIRECTIONS, f.direction)} · ${label(MODES, f.mode)}`], ['Route', route], ['Incoterm', f.incoterm],
    ['Containers', conts.map((k) => `${k.n} x ${k.size_type}`).join(', ')], ['Packages', f.packages], ['Gross weight', f.gross_weight_kg && `${Number(f.gross_weight_kg).toLocaleString()} kg`],
    ['Volume', f.volume_cbm && `${f.volume_cbm} CBM`], ['Cargo', f.cargo_description], ['Cargo ready / ETD', D(f.etd)],
  ]) : facts([['Job No.', r.job_no]]);
  const rr = refOf(r);
  const subject = `${rate ? 'Rate request' : `${VR_SERVICES[r.service]} request`} – ${[rr && `${rr.label} ${rr.no}`, route].filter(Boolean).join(' – ') || r.description.slice(0, 60)} – Our ref. ${r.request_no}`;
  const body = [
    `Dear ${r.vendor_contact ? r.vendor_contact.split(' ')[0] : `${r.vendor_name} team`},`, '',
    rate ? 'Please send us your best rate for the shipment below.' : `Please arrange the following ${VR_SERVICES[r.service].toLowerCase()} for us.`, '',
    r.description, '', shipment, '',
    rate ? 'Please include: freight and all local charges at origin and destination, free days, transit time, routing and how long the rate is valid.'
      : 'Please confirm with your reference number.',
    r.needed_by ? `${rate ? 'We need your rate' : 'Needed'} by ${D(r.needed_by)}.` : '',
    `Please quote our reference ${r.request_no}${rr ? ` / ${rr.label === 'Job' ? 'Job ' : ''}${rr.no}` : ''} in your reply.`, '',
    await signature(actor),
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { kind: 'vendor_request', id, recipients, subject, body,
    note: recipients.length ? undefined : `${r.vendor_name} has no email saved. Add it under Vendors, or type the address in your email program.` };
}

// ------------------------------------------------------------ quotation (selling only)
async function quotationDraft(actor: Actor, id: string): Promise<Draft> {
  if (!actor.fin.sellingView) throw new ApiError(403, 'FORBIDDEN', 'You need to see selling prices to send a quotation');
  const d = await getQuotation(actor, id);
  if (!d.can.customer_copy) throw new ApiError(409, 'QUOTE_NOT_READY', 'Only an approved quotation that has not expired can go to the customer.');
  const recipients = await customerRecipients(d.customer_id);
  const cur = d.currency;
  const lines = d.lines.map((l: any) => `- ${l.description}: ${money(l.sell_rate, cur)} ${l.unit_name}${Number(l.quantity) !== 1 ? ` x ${Number(l.quantity)} = ${money(l.sell_amount, cur)}` : ''}`);
  const route = [d.origin, d.destination].filter(Boolean).join(' to ');
  const qr = refOf(d);
  const subject = `Quotation ${d.quote_no}${d.version_no > 1 ? ` v${d.version_no}` : ''}${route ? ` – ${route}` : ''}${qr ? ` – ${qr.label} ${qr.no}` : ''}${d.enquiry_reference ? ` – Your ref. ${d.enquiry_reference}` : ''}`;
  const body = [
    dear(recipients, `${d.customer_name} team`), '',
    `Thank you for your enquiry${d.enquiry_reference ? ` (your ref. ${d.enquiry_reference})` : ''}. Please find our quotation ${d.quote_no} attached and summarised below.`, '',
    facts([['Service', `${d.service_name}${d.direction_name && d.direction_name !== '—' ? ` (${d.direction_name})` : ''}`], ['Route', route], ['Cargo', d.cargo_description],
      ['Volume / weight', [d.volume_cbm && `${d.volume_cbm} CBM`, d.gross_weight_kg && `${Number(d.gross_weight_kg).toLocaleString()} kg`].filter(Boolean).join(' · ')]]), '',
    'Charges:', ...lines, `Total: ${money(d.totals.sell_total, cur)} (excluding VAT)`, '',
    `Rates valid until ${D(d.valid_until)}.`,
    d.exclusions ? `Not included: ${d.exclusions}` : '', '',
    'To go ahead, please reply to confirm and we will arrange the booking.', '',
    await signature(actor),
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { kind: 'quotation', id, recipients, subject, body,
    note: `Attach the PDF: press "Print / PDF" on the quotation and save it as PDF.${recipients.length ? '' : ' This customer has no email saved — add one under Customers → contacts.'}` };
}

// ------------------------------------------------------------ Job File update to the customer
const UPDATES: [string, string][] = [['booking_confirmed', 'Booking confirmed'], ['departed', 'Departed'], ['arrived', 'Arrived'],
  ['customs_cleared', 'Customs cleared'], ['delivered', 'Delivered'], ['documents_needed', 'Documents needed from customer'], ['general', 'General update']];
async function jobFileDraft(actor: Actor, id: string, update: string): Promise<Draft> {
  const f = await getJobFile(actor, id);
  if (!f.can.edit) throw new ApiError(403, 'FORBIDDEN', 'You can\'t send updates on this Job File');
  if (!UPDATES.some(([c]) => c === update)) update = f.ata ? 'arrived' : f.atd ? 'departed' : f.booking_reference ? 'booking_confirmed' : 'general';
  const recipients = await customerRecipients(f.customer_id);
  const air = f.mode === 'air';
  const route = [f.origin, f.port_of_loading, f.port_of_discharge, f.destination].filter(Boolean).filter((v: any, i: number, a: any[]) => a.indexOf(v) === i).join(' → ');
  const details = facts([
    [f.job_no ? 'Job No.' : 'Our ref.', refOf(f)?.no], ['Your reference', f.customer_reference], ['Shipper', f.shipper], ['Consignee', f.consignee], ['Route', route],
    [air ? 'Airline / flight' : 'Carrier / vessel', [f.carrier, f.vessel_flight, f.voyage && `voy. ${f.voyage}`].filter(Boolean).join(' · ')],
    ['Booking no.', f.booking_reference], [air ? 'MAWB / HAWB' : 'BL no.', [f.mbl_mawb, f.hbl_hawb].filter(Boolean).join(' / ')],
    ['Containers', f.containers.map((k: any) => `${k.container_no} (${k.size_type})`).join(', ')],
    ['Packages / weight', [f.packages && `${f.packages} pkgs`, f.gross_weight_kg && `${Number(f.gross_weight_kg).toLocaleString()} kg`, f.volume_cbm && `${f.volume_cbm} CBM`].filter(Boolean).join(' · ')],
    [f.atd ? 'Departed' : 'ETD', D(f.atd ?? f.etd)], [f.ata ? 'Arrived' : 'ETA', D(f.ata ?? f.eta)],
  ]);
  const missing = (f.checklist ?? []).filter((c: any) => c.status === 'missing' || c.status === 'rejected').map((c: any) => `- ${c.name}`);
  const opening: Record<string, string> = {
    booking_confirmed: `We are pleased to confirm the booking for your shipment${f.etd ? `, planned to depart on ${D(f.etd)}` : ''}.`,
    departed: `Your shipment has departed${f.atd ? ` on ${D(f.atd)}` : ''}${f.eta ? ` and is expected to arrive on ${D(f.eta)}` : ''}.`,
    arrived: `Your shipment has arrived${f.ata ? ` on ${D(f.ata)}` : ''}.${f.needs_clearance ? ' We are now proceeding with customs clearance.' : ''}`,
    customs_cleared: `Customs clearance for your shipment is complete.${f.needs_transport ? ' We will now arrange delivery and confirm the time with you.' : ''}`,
    delivered: 'Your shipment has been delivered. Thank you for choosing us.',
    documents_needed: missing.length ? 'To avoid delays, please send us the following documents for your shipment:' : 'Please send us the documents for your shipment.',
    general: 'Please see the latest update on your shipment below.',
  };
  const name = UPDATES.find(([c]) => c === update)![1];
  const fr = refOf(f);
  const subject = `${name} – ${fr ? `${fr.label} ${fr.no}` : ''}${f.customer_reference ? ` – Your ref. ${f.customer_reference}` : ''}${route ? ` – ${route}` : ''}`;
  const body = [
    dear(recipients, `${f.customer_name} team`), '', opening[update],
    ...(update === 'documents_needed' && missing.length ? ['', ...missing] : []), '',
    'Shipment details:', details, '',
    update === 'delivered' ? 'If anything is not in order, please let us know.' : 'We will keep you updated. Please contact us if you have any questions.', '',
    await signature(actor),
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { kind: 'job_file', id, recipients, subject, body, options: UPDATES, update,
    note: recipients.length ? undefined : 'This customer has no email saved — add one under Customers → contacts.' };
}

// ------------------------------------------------------------ customer service case
async function caseDraft(actor: Actor, id: string): Promise<Draft> {
  const k = await getCase(actor, id);
  if (!k.can.manage) throw new ApiError(403, 'FORBIDDEN', 'You can\'t reply on cases');
  const recipients = await customerRecipients(k.customer_id, k.contact_detail);
  const subject = `Re: ${k.subject} – Case ${k.case_no}${k.job_no ? ` – Job ${k.job_no}` : ''}`;
  const waiting = k.status === 'waiting_customer', done = ['resolved', 'closed'].includes(k.status);
  const body = [
    k.contact_name ? `Dear ${String(k.contact_name).split(' ')[0]},` : dear(recipients, `${k.customer_name} team`), '',
    `Thank you for contacting us about "${k.subject}"${k.job_no ? ` (Job ${k.job_no})` : ''}. Your case number is ${k.case_no}.`, '',
    done ? (k.resolution ? `This has now been resolved: ${k.resolution}` : 'This has now been resolved.')
      : waiting ? 'To move forward, we need the following from you: [write what you need]'
        : `We are looking into this and will update you${k.due_at ? ` by ${D(k.due_at)}` : ' shortly'}.`, '',
    '[Write your reply here]', '',
    done ? 'If anything is still not right, simply reply to this email.' : `Please quote case ${k.case_no} in your reply.`, '',
    await signature(actor),
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { kind: 'case', id, recipients, subject, body,
    note: recipients.length ? 'Replace the text in [brackets] before sending.' : 'This customer has no email saved — add one under Customers → contacts. Replace the text in [brackets] before sending.' };
}

export async function emailDraft(actor: Actor, p: Record<string, string>): Promise<Draft> {
  switch (p.kind) {
    case 'vendor_request': return vendorDraft(actor, p.id);
    case 'quotation': return quotationDraft(actor, p.id);
    case 'job_file': return jobFileDraft(actor, p.id, p.update ?? '');
    case 'case': return caseDraft(actor, p.id);
    default: throw bad('Unknown email type');
  }
}

/** Record in the history that the email was prepared (opened in the user's email program). */
export async function emailPrepared(actor: Actor, b: any) {
  const draft = await emailDraft(actor, { kind: b.kind, id: b.id, update: b.update }); // also re-checks permission
  const to = (Array.isArray(b.to) ? b.to : []).map((x: unknown) => String(x).trim()).filter((x: string) => EMAIL.test(x)).slice(0, 20);
  const subject = String(b.subject ?? draft.subject).slice(0, 300);
  const detail = `To ${to.join(', ') || '(typed in email program)'} — "${subject}"`;
  await tx(async (c) => {
    if (b.kind === 'vendor_request') await c.query('insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [b.id, 'Email prepared', detail, actor.id, actor.full_name]);
    else if (b.kind === 'quotation') await c.query('insert into quotation_events (quotation_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [b.id, 'Email prepared for the customer', detail, actor.id, actor.full_name]);
    else if (b.kind === 'job_file') { await loadFile(actor, b.id, c); await event(c, actor, b.id, { kind: 'note', title: 'Email prepared for the customer', new_value: detail }); }
    else if (b.kind === 'case') {
      await c.query('insert into cs_case_events (case_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)', [b.id, 'Email reply prepared', detail, actor.id, actor.full_name]);
      await c.query('update cs_cases set first_response_at = coalesce(first_response_at, now()) where id = $1', [b.id]);
    }
  });
  return { ok: true };
}
