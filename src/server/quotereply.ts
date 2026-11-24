/**
 * 23 Nov (migration 041) — the AI reads the customer's answer to a quotation that was sent.
 *
 * Emails received on the enquiry after the quotation went out (not a vendor's reply, not our own team, not a bounce) are read
 * once: Accepted / Wants changes (what, a target price) / Declined (why) / a Question. It waits on the quotation as a
 * suggestion; nothing changes until a person presses the button, which uses the normal steps in their name:
 *   Accepted  → "Confirmed by the customer" (their email as the proof; Shipping Ref as usual; the route option they chose)
 *   Changes   → "Customer asked for changes" (then Revise as today)
 *   Declined  → "Not accepted" with the reason, and if wanted the enquiry marked lost (the "Why not confirmed" reports)
 *   Question  → kept as the customer's response
 * People who see selling prices and handle quotations only.
 */
import { Actor } from './auth';
import { ApiError, bad, forbidden, notFound, one, q, tx } from './db';
import { aiConfig, askWithTool } from './ai';
import { emailText } from './agent';
import { isBounce } from './quotereader';
import { ownWords } from '../lib/opsRules';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const canUse = (a: Actor) => a.fin.sellingView && (a.isSuperAdmin || a.has('quotes.create'));
export const REASONS: [string, string][] = [['price', 'Price too high'], ['transit', 'Transit time'], ['service', 'Service / scope did not fit'],
  ['other_forwarder', 'Went with another forwarder'], ['postponed', 'Shipment postponed / cancelled'], ['not_needed', 'No longer needed'], ['other', 'Other']];
const reasonName = (k: unknown) => REASONS.find(([x]) => x === k)?.[1] ?? 'Other';

async function quote(actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Quotation');
  const { getQuotation } = await import('./quotations');
  return getQuotation(actor, id) as Promise<any>;                         // may this person see it?
}

/** The customer's emails after the quotation went out, and what the AI made of them. */
export async function replyBox(actor: Actor, quotationId: string) {
  if (!canUse(actor)) return { allowed: false };
  const x = await quote(actor, quotationId);
  if (!x.job_file_id || !['sent', 'approved', 'accepted', 'rejected'].includes(x.status)) return { allowed: true, watching: false };
  const since = (await one('select coalesce(sent_at, approved_at, created_at) t from quotations where id = $1', [quotationId])).t;
  const { isOurs } = await import('./emailpeople');
  const mails = (await q(`select e.id, e.from_addr, e.from_name, e.subject, e.sent_at from email_messages e
      where e.job_file_id = $1 and e.direction = 'in' and e.vendor_request_id is null and coalesce(e.sent_at, e.created_at) > $2
      order by coalesce(e.sent_at, e.created_at) desc limit 12`, [x.job_file_id, since])).filter((m: any) => !isBounce(m));
  const theirs: any[] = [];
  for (const m of mails) if (!(await isOurs(String(m.from_addr ?? '')))) theirs.push(m);
  const sugs = await q(`select s.id, s.email_id, s.status, s.summary, s.answers, s.created_at, e.from_name, e.from_addr, e.subject, e.sent_at, u.full_name decided_by_name, s.decided_at
    from ai_suggestions s join email_messages e on e.id = s.email_id left join users u on u.id = s.decided_by
    where s.kind = 'quote_reply' and s.answers->>'quotation_id' = $1 order by e.sent_at desc nulls last`, [quotationId]);
  const unread = theirs.filter((m) => !sugs.some((s: any) => s.email_id === m.id)).slice(0, 5);
  const routes = await q('select id, option_no, coalesce(pol, origin_city) pol, coalesce(pod, destination_city) pod, label from enquiry_routes where job_file_id = $1 order by option_no', [x.job_file_id]);
  return { allowed: true, watching: x.status === 'sent' || x.status === 'approved', configured: aiConfig().ready, status: x.status,
    open: sugs.filter((s: any) => s.status === 'open'), done: sugs.filter((s: any) => s.status !== 'open').slice(0, 6), unread,
    routes: routes.length > 1 ? routes : [], reasons: REASONS };
}

const TOOL = {
  name: 'record_customer_answer',
  description: 'Record what the customer answers about the quotation we sent.',
  input_schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['accepted', 'changes', 'declined', 'question', 'other'],
        description: 'accepted = they confirm / go ahead / please book; changes = they want a lower price or something changed before deciding; declined = they will not go ahead with us; question = they ask something; other = not about the quotation.' },
      reason: { type: 'string', enum: REASONS.map(([k]) => k), description: 'When declined: why.' },
      reason_words: { type: 'string', description: 'When declined or changes: in their words, short.' },
      changes: { type: 'array', items: { type: 'string' }, description: 'When changes: each thing they ask to change (e.g. "lower the ocean freight", "add insurance").' },
      target_price: { type: 'number', description: 'A price they say they want or got elsewhere, digits only.' },
      target_currency: { type: 'string' },
      question: { type: 'string', description: 'When question: their question, short.' },
      chosen_option: { type: 'integer', description: 'When accepted and the quotation had route options: the option number they chose.' },
      quote: { type: 'string', description: 'The few words that show their answer (copied, max 160 characters).' },
      summary: { type: 'string', description: 'One short sentence.' },
    },
    required: ['decision', 'summary'],
  },
};

export async function readReply(actor: Actor, quotationId: string, emailId: string) {
  if (!canUse(actor)) throw forbidden('Only people who handle quotations can read the customer\'s answer');
  const x = await quote(actor, quotationId);
  if (!isUuid(emailId)) throw notFound('Email');
  const e = await one('select * from email_messages where id = $1', [emailId]);
  if (!e || e.job_file_id !== x.job_file_id || e.direction !== 'in' || e.vendor_request_id) throw bad('This email is not the customer\'s answer to this quotation');
  const old = await one(`select * from ai_suggestions where email_id = $1 and kind = 'quote_reply'`, [emailId]);
  if (old) return { suggestion: old };
  const full = await emailText(e);
  const mine = ownWords(full);
  const lines = (x.lines ?? []).map((l: any) => `${l.description}: ${x.currency} ${l.sell_rate} ${l.unit_name ?? ''} × ${Number(l.quantity)}`).join('; ');
  const opts = (x.options ?? []).length > 1 ? `\nRoute options: ${x.options.map((o: any) => `Option ${o.option_no} ${[o.pol, o.pod].filter(Boolean).join(' to ')}${o.label ? ` (${o.label})` : ''} ${x.currency} ${o.sell_total}`).join('; ')}` : '';
  const { input: a, model } = await askWithTool(
    `You read a customer's email about a freight quotation from Reliance Freight Systems, Dubai. Decide what they answer: accepted, wants changes, declined, a question, or not about the quotation. Read only what the customer wrote (our quotation may be quoted below their text). Be careful: "please send the booking details" or "go ahead" = accepted; "can you do better" / "too high" = changes; "we went with another forwarder" / "not going ahead" = declined. When unsure between accepted and something else, do not say accepted.`,
    `Our quotation ${x.quote_no}: ${lines}. Total ${x.currency} ${x.totals?.sell_total}. Valid until ${x.valid_until}.${opts}\n\nThe customer's email — from ${e.from_name ? `${e.from_name} <${e.from_addr}>` : e.from_addr}, subject: ${e.subject ?? ''}\n\nWHAT THEY WROTE:\n${mine.slice(0, 6000) || '(empty)'}\n\n(Full email for context:)\n${full.slice(0, 4000)}`,
    TOOL, 900, 8500);
  const decision = ['accepted', 'changes', 'declined', 'question'].includes(a?.decision) ? a.decision : 'other';
  const answers = {
    quotation_id: quotationId, quote_no: x.quote_no, decision,
    reason: decision === 'declined' ? (REASONS.some(([k]) => k === a?.reason) ? a.reason : 'other') : null,
    reason_words: String(a?.reason_words ?? '').slice(0, 300) || null,
    changes: (Array.isArray(a?.changes) ? a.changes : []).map((s: any) => String(s).slice(0, 200)).filter(Boolean).slice(0, 6),
    target_price: Number(a?.target_price) > 0 ? Math.round(Number(a.target_price) * 100) / 100 : null,
    target_currency: String(a?.target_currency ?? '').trim().toUpperCase().slice(0, 3) || null,
    question: String(a?.question ?? '').slice(0, 400) || null,
    chosen_option: Number.isInteger(a?.chosen_option) ? a.chosen_option : null,
    quote: String(a?.quote ?? '').slice(0, 200) || null,
  };
  const s = await one(`insert into ai_suggestions (job_file_id, email_id, kind, status, summary, answers, unclear, model, read_by)
      values ($1, $2, 'quote_reply', $3, $4, $5, '[]', $6, $7) on conflict (email_id, kind) do nothing returning *`,
    [x.job_file_id, emailId, decision === 'other' ? 'nothing' : 'open', String(a?.summary ?? '').slice(0, 300), JSON.stringify(answers), model, actor.id]);
  return { suggestion: s ?? await one(`select * from ai_suggestions where email_id = $1 and kind = 'quote_reply'`, [emailId]) };
}

/** The person's choice: use the AI's reading (as it is or corrected) through the normal quotation steps, or dismiss it. */
export async function applyReply(actor: Actor, id: string, b: any) {
  if (!isUuid(id)) throw notFound('Suggestion');
  if (!canUse(actor)) throw forbidden();
  const s = await one(`select s.*, e.from_addr, e.from_name, e.sent_at from ai_suggestions s join email_messages e on e.id = s.email_id where s.id = $1 and s.kind = 'quote_reply'`, [id]);
  if (!s) throw notFound('Suggestion');
  const qid = s.answers.quotation_id;
  const x = await quote(actor, qid);
  if (b?.action === 'dismiss') {
    if (!['open', 'nothing'].includes(s.status)) throw bad('This suggestion is already handled');
    await q(`update ai_suggestions set status = 'dismissed', decided_by = $2, decided_at = now() where id = $1`, [id, actor.id]);
    return replyBox(actor, qid);
  }
  if (s.status !== 'open') throw bad('This suggestion is already handled');
  const { quotationAction } = await import('./quotations');
  const when = new Date(s.sent_at ?? Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const who = s.from_name ? `${s.from_name} <${s.from_addr}>` : s.from_addr;
  const said = String(b?.note ?? s.answers.quote ?? s.summary ?? '').trim().slice(0, 600);
  const action = String(b?.action ?? s.answers.decision);
  if (action === 'accepted') {
    let route_id = b?.route_id;
    if (!route_id && s.answers.chosen_option) route_id = (await one('select id from enquiry_routes where job_file_id = $1 and option_no = $2', [x.job_file_id, s.answers.chosen_option]))?.id;
    await quotationAction(actor, qid, { action: 'accept', route_id, evidence_note: `Confirmed by email from ${who} on ${when}: "${said || 'confirmed'}"` });
  } else if (action === 'changes') {
    const what = [...(s.answers.changes ?? []), s.answers.target_price ? `target ${s.answers.target_currency ?? x.currency} ${s.answers.target_price}` : ''].filter(Boolean).join('; ');
    await quotationAction(actor, qid, { action: 'response', response: 'revision_requested', note: String(b?.note ?? '').trim() || `${what || said} (email from ${who}, ${when})` });
  } else if (action === 'declined') {
    const reason = String(b?.reason_text ?? '').trim() || `${reasonName(b?.reason ?? s.answers.reason)}${s.answers.reason_words ? ` — ${s.answers.reason_words}` : ''}`;
    await quotationAction(actor, qid, { action: 'decline', reason });
    if (b?.mark_lost && x.job_file_id) {
      const { markLost } = await import('./commercial');
      await markLost(actor, x.job_file_id, { reason }).catch((err: any) => { throw new ApiError(409, 'LOST', `The quotation is marked not accepted, but the enquiry could not be marked lost: ${err.message}`); });
    }
  } else if (action === 'question') {
    await quotationAction(actor, qid, { action: 'response', response: 'note', note: `Question: ${String(b?.note ?? s.answers.question ?? said).slice(0, 900)} (email from ${who}, ${when})` });
  } else throw bad('Choose what the customer answered');
  await tx(async (c) => {
    await c.query(`update ai_suggestions set status = 'applied', applied_keys = $2, decided_by = $3, decided_at = now() where id = $1`, [id, JSON.stringify([action]), actor.id]);
    await c.query('insert into quotation_events (quotation_id, title, details, user_id, user_name) values ($1,$2,$3,$4,$5)',
      [qid, `Customer's email read by AI — ${action === 'accepted' ? 'accepted' : action === 'changes' ? 'asked for changes' : action === 'declined' ? 'declined' : 'question'} (checked)`,
        `${who}, ${when}${action !== s.answers.decision ? ` · the AI read it as "${s.answers.decision}"` : ''}`, actor.id, actor.full_name]);
  });
  return replyBox(actor, qid);
}
