/**
 * 26 Nov (migration 047, Point 13): after the customer approves an option, ask the vendor who gave that rate to confirm
 * space and rate before booking. The email is the vendor request's own email (template "availability_check"), so the
 * vendor's reply comes back on the same request and is read by the AI in the background.
 *   sent → confirmed (book at the agreed rate) | unavailable (ask the vendor for the next sailing; tell the customer politely).
 * Nothing changes the customer's approved option or books an alternative by itself.
 */
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, notFound, one, q, tx } from './db';
import { aiConfig, askWithTool } from './ai';
import { canEdit, event, getJobFile, loadFile } from './jobfiles';

const NOT_FREIGHT = ['customs_broker', 'transporter', 'warehouse'];
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const txt = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

/** The freight rate behind the option the customer approved (the accepted quotation's lines on the chosen option). */
export async function approvedRate(fileId: string, db?: Db) {
  const f = await one('select quotation_id, selected_route_id from job_files where id = $1', [fileId], db);
  if (!f?.quotation_id) return null;
  return one(`select r.id, r.request_no, r.carrier, r.routing, r.vendor_reference, v.name vendor_name from quotation_lines l
      join vendor_requests r on r.id = l.vendor_request_id join vendors v on v.id = r.vendor_id
    where l.quotation_id = $1 and ($2::uuid is null or l.route_id = $2 or l.route_id is null) and coalesce(v.vendor_type, '') <> all($3)
    order by l.sort_order limit 1`, [f.quotation_id, f.selected_route_id, NOT_FREIGHT], db);
}

/** The latest check on the shipment (older ones stay as history in the Activity). */
export async function availabilityOf(fileId: string, db?: Db) {
  return one(`select a.id, a.status, a.reason, a.alternative, a.sent_at, a.answered_at, a.answer_source, a.vendor_request_id, r.request_no, v.name vendor_name, u.full_name answered_by_name
    from availability_checks a left join vendor_requests r on r.id = a.vendor_request_id left join vendors v on v.id = r.vendor_id left join users u on u.id = a.answered_by
    where a.job_file_id = $1 and a.status <> 'cancelled' order by a.created_at desc limit 1`, [fileId], db);
}

/** Called when the availability email to the vendor is sent (or opened in the email program). */
export async function markAvailabilityAsked(c: Db, actor: Actor, vendorRequestId: string) {
  const r = await one('select job_file_id from vendor_requests where id = $1', [vendorRequestId], c);
  if (!r?.job_file_id) return;
  const f = await one('select quotation_id, selected_route_id from job_files where id = $1', [r.job_file_id], c);
  const open = await one(`select id from availability_checks where job_file_id = $1 and vendor_request_id = $2 and status in ('to_send', 'sent')`, [r.job_file_id, vendorRequestId], c);
  if (open) await c.query(`update availability_checks set status = 'sent', sent_at = now() where id = $1`, [open.id]);
  else await c.query(`insert into availability_checks (job_file_id, quotation_id, route_id, vendor_request_id, status, sent_at, created_by) values ($1, $2, $3, $4, 'sent', now(), $5)`,
    [r.job_file_id, f?.quotation_id ?? null, f?.selected_route_id ?? null, vendorRequestId, actor.id]);
  await event(c, actor, r.job_file_id, { kind: 'note', title: 'Availability confirmation asked from the vendor' });
}

async function record(c: Db, actor: Actor | null, fileId: string, checkId: string, result: 'confirmed' | 'unavailable', reason: string | null, alternative: string | null, source: string) {
  await c.query(`update availability_checks set status = $2, reason = $3, alternative = $4, answered_at = now(), answered_by = $5, answer_source = $6 where id = $1`,
    [checkId, result, reason, alternative, actor?.id ?? null, source]);
  const what = result === 'confirmed' ? 'Vendor confirmed availability' : 'Vendor: the quoted space / rate is not available';
  await event(c, actor, fileId, { kind: 'status', title: what, new_value: [reason, alternative && `Offered: ${alternative}`].filter(Boolean).join(' · ') || null, remarks: source === 'ai' ? 'Read by the AI from the vendor\'s reply' : null });
  await (await import('./notify')).notifyGroup(c, actor, fileId, 'rate_updated', result === 'confirmed' ? 'Vendor confirmed availability — ready to book'
    : `Not available${reason ? `: ${reason}` : ''} — ask for the next sailing and tell the customer`);
}

/** The person records the vendor's answer (or corrects the AI). */
export async function availabilityAction(actor: Actor, fileId: string, b: any) {
  await tx(async (c) => {
    const f = await loadFile(actor, fileId, c, true);
    if (!canEdit(actor, f) || (!actor.isSuperAdmin && !actor.has('vendors.requests'))) throw forbidden();
    if (!['customer_confirmed', 'booking_requested'].includes(f.stage)) throw new ApiError(409, 'STAGE', 'Availability is checked after the customer approves and before the booking is confirmed');
    const a = await availabilityOf(fileId, c);
    if (!a) throw bad('Send the availability email to the vendor first');
    const result = b.result === 'confirmed' ? 'confirmed' : b.result === 'unavailable' ? 'unavailable' : null;
    if (!result) throw bad('Choose: available or not available');
    const reason = txt(b.reason, 500), alternative = txt(b.alternative, 500);
    if (result === 'unavailable' && !reason) throw bad('Write what the vendor said (e.g. "vessel full", "rate no longer valid")');
    await record(c, actor, fileId, a.id, result, reason, alternative, 'user');
  });
  return getJobFile(actor, fileId);
}

const TOOL = { name: 'availability_answer', description: 'What the vendor answered about space and rate availability',
  input_schema: { type: 'object', properties: {
    answer: { type: 'string', enum: ['available', 'not_available', 'unclear'], description: 'available = they confirm space and the rate; not_available = space or the quoted rate is not available (vessel full, rolled, rate expired, increase); unclear = anything else' },
    reason: { type: 'string', description: 'Their reason in a few words, only when not available' },
    alternative: { type: 'string', description: 'The next sailing / flight or other routing they offer, with date and rate if given' },
  }, required: ['answer'] } };

/** The AI reads the vendor's reply to the availability email (background, once per email). Unclear answers are left for the person. */
export async function readAvailability(actor: Actor, emailId: string) {
  if (!isUuid(emailId)) throw notFound('Email');
  const e = await one('select * from email_messages where id = $1', [emailId]);
  if (!e?.job_file_id || e.direction !== 'in') return { read: false };
  const a = await availabilityOf(e.job_file_id);
  if (!a || a.status !== 'sent' || a.vendor_request_id !== e.vendor_request_id || +new Date(e.created_at) < +new Date(a.sent_at)) return { read: false };
  if (!aiConfig().ready) return { read: false };
  const { emailText } = await import('./agent');
  const body = (await emailText(e)).slice(0, 8000);
  const { input: x } = await askWithTool(`You read a shipping line's or agent's reply for Reliance Freight Systems, a freight forwarder in Dubai, UAE.
We asked them to confirm that space and their quoted rate are still available before we book. Decide what THEY answered in this email
(our own earlier email is often quoted below their reply — ignore it). Use only what they wrote; never guess.`,
    `Our request ${a.request_no} to ${a.vendor_name}.\n\nTheir reply — subject: ${e.subject ?? ''}\n\n${body || '(no text)'}`, TOOL as any, 600, 9000);
  const answer = ['available', 'not_available'].includes(x?.answer) ? x.answer : null;
  if (!answer) return { read: true, answer: 'unclear' };
  await tx(async (c) => {
    const now = await one(`select id, status from availability_checks where id = $1 for update`, [a.id], c);
    if (now?.status !== 'sent') return;                                   // the person answered meanwhile
    await record(c, null, e.job_file_id, a.id, answer === 'available' ? 'confirmed' : 'unavailable', txt(x.reason, 500), txt(x.alternative, 500), 'ai');
  });
  return { read: true, answer };
}

/** For the background reader: replies to an availability email not read yet. */
export async function availabilityReplies(n: number) {
  return q(`select e.id, coalesce(e.created_by, f.coordinator_id) uid from email_messages e join availability_checks a on a.vendor_request_id = e.vendor_request_id and a.status = 'sent'
      join job_files f on f.id = e.job_file_id
    where e.direction = 'in' and e.created_at > a.sent_at and e.created_at > now() - interval '3 days' and e.ai_bg_tries < 2
    order by e.created_at desc limit $1`, [n]);
}
