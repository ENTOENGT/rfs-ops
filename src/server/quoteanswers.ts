/**
 * 26 Nov (migration 046): the customer's answer buttons in the quotation email — Accept, Reject or Negotiate, one link per option.
 * The link is the proof (no sign-in), so it is long and random, works once, and wrong links are limited per connection.
 * An answer is never applied by itself: the team is told and confirms the quotation in RFS CRM as before.
 */
import { randomBytes } from 'crypto';
import { Actor } from './auth';
import { ApiError, audit, bad, Db, forbidden, getSetting, notFound, one, q, tx } from './db';
import { routeLabel } from '../lib/routingRules';

export const appUrl = () => (process.env.APP_URL || 'https://rfsops.netlify.app').replace(/\/$/, '');
const ANSWERS: Record<string, string> = { accepted: 'Accepted', rejected: 'Rejected', negotiate: 'Asks to negotiate' };

/** One link per option of this version (made once, reused when the email is prepared again). */
export async function answerLinks(quotationId: string, versionNo: number, routeIds: (string | null)[], db?: Db) {
  const out: Record<string, string> = {};
  for (const rid of routeIds) {
    await q(`insert into quote_answers (quotation_id, version_no, route_id, token) values ($1, $2, $3, $4) on conflict do nothing`,
      [quotationId, versionNo, rid, randomBytes(24).toString('base64url')], db);
    const r = await one(`select token from quote_answers where quotation_id = $1 and version_no = $2 and route_id is not distinct from $3`, [quotationId, versionNo, rid], db);
    out[rid ?? 'main'] = `${appUrl()}/answer/${r.token}`;
  }
  return out;
}

const linkErr = () => new ApiError(404, 'LINK_EXPIRED', 'This link is not valid. Please reply to our email instead.');
async function byToken(token: string, db?: Db, lock = false) {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(String(token))) throw linkErr();
  const a = await one(`select a.*, x.quote_no, x.version_no current_version, x.status, x.currency, x.valid_until, x.job_file_id, x.created_by, x.salesman_id,
      c.name customer_name, r.option_no, r.pol, r.pod, r.origin_city, r.destination_city, r.label
    from quote_answers a join quotations x on x.id = a.quotation_id join customers c on c.id = x.customer_id
    left join enquiry_routes r on r.id = a.route_id where a.token = $1${lock ? ' for update of a' : ''}`, [token], db);
  if (!a) throw linkErr();
  return a;
}

/** What the customer sees on the answer page (no cost, no vendor). */
export async function answerInfo(token: string) {
  const a = await byToken(token);
  const lines = await q(`select quantity, sell_rate, optional from quotation_lines where quotation_id = $1 and ($2::uuid is null or route_id = $2)`, [a.quotation_id, a.route_id]);
  const { quoteTotals } = await import('./quotations');
  const t = quoteTotals(lines.map((l) => ({ ...l, cost_rate: '0' })));
  const others = await one(`select count(*)::int n from quote_answers where quotation_id = $1 and version_no = $2`, [a.quotation_id, a.version_no]);
  return {
    company: String(await getSetting('company_name', 'Reliance Freight Systems')), quote_no: a.quote_no, version_no: a.version_no, customer_name: a.customer_name,
    option: a.route_id && others.n > 1 ? routeLabel(a) : null, total: t.sell_total, currency: a.currency, valid_until: a.valid_until,
    answer: a.answer, answer_name: a.answer ? ANSWERS[a.answer] : null, answered_at: a.answered_at,
    closed: a.answer ? null : a.version_no !== a.current_version ? 'This quotation has been revised. Please use the buttons in our latest email.'
      : ['cancelled', 'accepted', 'rejected'].includes(a.status) ? 'This quotation is closed. Please reply to our email if you need anything.' : null,
  };
}

const short = (v: unknown, max: number, what: string) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw bad(`${what}: up to ${max} characters`);
  return s || null;
};

/** The customer's answer: saved once, the team told. */
export async function answerQuote(token: string, b: any, ip: string) {
  const answer = String(b?.answer ?? '');
  if (!ANSWERS[answer]) throw bad('Choose Accept, Reject or Negotiate');
  const reason = short(b.reason, 1000, 'Reason'), comment = short(b.comment, 2000, 'Comment');
  if (answer === 'rejected' && !reason) throw bad('Please tell us why, so we can do better next time');
  let target: string | null = null;
  if (answer === 'negotiate') {
    const s = String(b.target_rate ?? '').replace(/,/g, '').trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(s) || Number(s) <= 0) throw bad('Enter your target rate, e.g. 1500');
    target = s;
  }
  return tx(async (c) => {
    const a = await byToken(token, c, true);
    if (a.answer) throw new ApiError(409, 'ALREADY_ANSWERED', `Thank you — this was already answered (${ANSWERS[a.answer].toLowerCase()}). Please reply to our email to change it.`);
    const info = await answerInfo(token);
    if (info.closed) throw new ApiError(409, 'QUOTE_CLOSED', info.closed);
    await c.query(`update quote_answers set answer = $2, reason = $3, target_rate = $4, target_currency = $5, comment = $6, answered_at = now(), answered_ip = $7 where id = $1`,
      [a.id, answer, reason, target, target ? a.currency : null, comment, ip.slice(0, 64)]);
    const what = `${ANSWERS[answer]}${info.option ? ` — ${info.option}` : ''}${target ? ` · target ${a.currency} ${target}` : ''}${reason ? ` · ${reason}` : ''}${comment ? ` · ${comment}` : ''}`;
    await c.query('insert into quotation_events (quotation_id, title, details, user_name) values ($1, $2, $3, $4)',
      [a.quotation_id, 'Customer answered from the email', what, a.customer_name]);
    await audit(c, null, { entity_type: 'quotation', entity_id: a.quotation_id, action: `Customer answer from the email: ${ANSWERS[answer]}`, new_value: what });
    if (a.job_file_id) await (await import('./notify')).notifyGroup(c, null, a.job_file_id, 'customer_response', `${a.quote_no}: ${what}`,
      { quotationId: a.quotation_id, also: [a.created_by, a.salesman_id] });
    return { ok: true, answer_name: ANSWERS[answer] };
  });
}

/** In RFS CRM: the answers on a quotation, and "Handled". */
export async function answersFor(quotationId: string) {
  return q(`select a.id, a.version_no, a.answer, a.reason, a.target_rate, a.target_currency, a.comment, a.answered_at, a.handled_at, u.full_name handled_by_name,
      r.option_no, r.pol, r.pod, r.origin_city, r.destination_city, r.label
    from quote_answers a left join enquiry_routes r on r.id = a.route_id left join users u on u.id = a.handled_by
    where a.quotation_id = $1 and a.answer is not null order by a.answered_at desc`, [quotationId]);
}
export async function markAnswerHandled(actor: Actor, quotationId: string, answerId: string) {
  if (!actor.has('quotes.create')) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(answerId)) throw notFound('Answer');
  const { getQuotation } = await import('./quotations');
  await getQuotation(actor, quotationId);                              // can this person see the quotation?
  await tx(async (c) => {
    const r = await c.query(`update quote_answers set handled_at = now(), handled_by = $3 where id = $1 and quotation_id = $2 and answer is not null and handled_at is null`,
      [answerId, quotationId, actor.id]);
    if (!r.rowCount) throw notFound('Answer');
    await audit(c, actor, { entity_type: 'quotation', entity_id: quotationId, action: 'Customer answer marked handled' });
  });
  return getQuotation(actor, quotationId);
}
