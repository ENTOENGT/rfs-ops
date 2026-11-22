/**
 * AI agent part B — the agent's / carrier's reply to a rate request → a suggested rate (no new tables: ai_suggestions kind 'quote').
 *
 *  1. When a received email is filed on an enquiry, it is matched to the rate request it answers: our request no. (VR-1001) in the
 *     subject or text, else the sender is the vendor (the vendor's email, an address we sent the request to, or the same company
 *     domain). It is marked on the email (email_messages.vendor_request_id) and in the request's history. A vendor's reply is
 *     never taken as the customer's (no customer CC learnt from it, not read by part A).
 *  2. A person who sees cost opens the enquiry: the AI reads the reply and its attachments (Excel / PDF / pictures) and picks out
 *     the rate, currency, charge lines, transit, free days, ETD, routing, carrier, validity and the vendor's reference.
 *  3. It waits on the enquiry as a suggestion. The person checks / corrects it and presses Save rate → the normal "Quoted" step
 *     (or a revised rate if one was already in), in their name, with history. Or Dismiss. Nothing is saved by the AI itself.
 *  4. A reply with no price ("we will revert") is noted as such; the request keeps waiting.
 */
import { Actor } from './auth';
import { ApiError, Db, bad, forbidden, notFound, one, q, tx } from './db';
import { aiConfig, askWithTool } from './ai';
import { readAttachments } from './attachments';
import { emailText } from './agent';
import { event, loadFile } from './jobfiles';
import { isCurrency } from '../lib/currency';
import { CHARGE_SECTIONS } from '../lib/commercialRules';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'msn.com',
  'yandex.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'ymail.com', 'yahoo.co.in', 'qq.com', '163.com', '126.com']);
const domainOf = (e: string) => e.split('@')[1] ?? '';
const list = (s: unknown) => String(s ?? '').split(/[,;]\s*/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@'));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

// ------------------------------------------------------------------ 1. which rate request does a received email answer?
/** The rate request on this enquiry that a received email answers, or null (then it is the customer's or someone else's). */
export async function matchVendorRequest(db: Db, fileId: string, m: { from_addr?: string | null; subject?: string | null; body_excerpt?: string | null }) {
  const reqs = await q(`select r.id, r.request_no, r.status, r.created_at, lower(v.email) vendor_email, lower(vt.email) team_email, lower(vt.cc_emails) team_cc
    from vendor_requests r join vendors v on v.id = r.vendor_id left join vendor_teams vt on vt.id = r.team_id
    where r.job_file_id = $1 and r.service = 'rate' and r.status <> 'cancelled' order by r.created_at desc`, [fileId], db);
  if (!reqs.length) return null;
  const best = (rs: any[]) => rs.find((r) => r.status === 'requested') ?? rs.find((r) => r.status === 'quoted') ?? rs[0] ?? null;
  // our reference in the subject or the text
  const nos = new Set(`${m.subject ?? ''} ${m.body_excerpt ?? ''}`.toUpperCase().match(/VR-\d+/g) ?? []);
  const byNo = reqs.filter((r) => nos.has(String(r.request_no).toUpperCase()));
  const from = String(m.from_addr ?? '').trim().toLowerCase();
  // the addresses each request went to (the vendor's email, and the To / CC of what we sent)
  const sent = await q(`select vendor_request_id id, to_addrs, cc_addrs from email_messages where job_file_id = $1 and direction = 'out' and vendor_request_id is not null`, [fileId], db);
  const addrs = (r: any) => new Set([r.vendor_email, r.team_email, ...list(r.team_cc), ...sent.filter((s) => s.id === r.id).flatMap((s) => [...list(s.to_addrs), ...list(s.cc_addrs)])].filter(Boolean));
  if (byNo.length) {
    const fromVendor = byNo.filter((r) => from && (addrs(r).has(from) || [...addrs(r)].some((a) => !PUBLIC.has(domainOf(a)) && domainOf(a) === domainOf(from))));
    return best(fromVendor.length ? fromVendor : byNo)?.id ?? null;
  }
  if (!from) return null;
  const exact = reqs.filter((r) => addrs(r).has(from));
  if (exact.length) return best(exact).id;
  const d = domainOf(from);
  if (!d || PUBLIC.has(d)) return null;
  // the same company domain — but never our own or the customer's
  const { isOurs } = await import('./emailpeople');
  if (await isOurs(from, undefined, db)) return null;
  const cust = await one(`select 1 from job_files f left join customers c on c.id = f.customer_id left join customer_contacts cc on cc.customer_id = f.customer_id
    where f.id = $1 and (lower(c.email) like $2 or lower(cc.email) like $2) limit 1`, [fileId, `%@${d}`], db);
  if (cust) return null;
  const sameDomain = reqs.filter((r) => [...addrs(r)].some((a) => domainOf(a) === d));
  return sameDomain.length ? best(sameDomain).id : null;
}

/** Called when a received email is filed: mark it as the vendor's reply (and in the request's history). Returns the request id. */
export async function linkReply(db: Db, actor: Actor | null, emailId: string, fileId: string, m: any) {
  const vr = await matchVendorRequest(db, fileId, m);
  if (!vr) return null;
  await db.query('update email_messages set vendor_request_id = $2 where id = $1', [emailId, vr]);
  await db.query(`insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1, 'Vendor replied by email', $2, $3, $4)`,
    [vr, `${m.from_name || m.from_addr || ''}: "${String(m.subject ?? '').slice(0, 200)}"`, actor?.id ?? null, actor?.full_name ?? 'RFS CRM']);
  return vr;
}

/** Replies filed before this existed: matched now, once (and a vendor address learnt as the customer's CC is taken off). */
export async function linkOldReplies(fileId: string) {
  const rows = await q(`select e.id, e.from_addr, e.from_name, e.subject, e.body_excerpt from email_messages e
    where e.job_file_id = $1 and e.direction = 'in' and e.vendor_request_id is null
      and exists (select 1 from vendor_requests r where r.job_file_id = e.job_file_id and r.service = 'rate' and r.created_at <= coalesce(e.sent_at, e.created_at))
      and not exists (select 1 from ai_suggestions s where s.email_id = e.id and s.kind = 'enquiry')`, [fileId]);
  for (const e of rows) {
    await tx(async (c) => {
      if (!(await linkReply(c, null, e.id, fileId, e))) return;
      const from = String(e.from_addr ?? '').toLowerCase(), d = domainOf(from);
      await c.query(`delete from job_file_email_people where job_file_id = $1 and source = 'customer_email'
        and (lower(email) = $2 or ($3 <> '' and lower(email) like '%@' || $3))`, [fileId, from, PUBLIC.has(d) ? '' : d]);
    });
  }
}

// ------------------------------------------------------------------ 2. the AI reads the reply
const TOOL = {
  name: 'record_rate',
  description: 'Record the rate the agent / carrier gives in this reply to our rate request.',
  input_schema: {
    type: 'object',
    properties: {
      has_rate: { type: 'boolean', description: 'true only when the email or its attachments give a price for this request.' },
      no_rate_reason: { type: 'string', description: 'When there is no price: what they said instead, in a few words (e.g. "will revert tomorrow", "no space").' },
      total: { type: 'number', description: 'The total price for the whole shipment as asked (all containers / the full weight), digits only. When they give an all-in price, this is the all-in price.' },
      currency: { type: 'string', description: '3-letter currency code of the total, e.g. USD, AED, EUR.' },
      charges: { type: 'array', description: 'The breakup lines when the vendor lists them. Only the parts — never the all-in / total line itself as one more line.', items: { type: 'object', properties: {
        section: { type: 'string', enum: CHARGE_SECTIONS.map(([k]) => k), description: 'freight (sea / air freight), origin (charges at loading side), destination (charges at the arrival side), other' },
        description: { type: 'string' }, basis: { type: 'string', description: 'per container, per kg, per CBM, per BL, per shipment…' },
        quantity: { type: 'number', description: 'How many of the basis for this shipment (e.g. 2 containers). 1 when per shipment.' },
        amount: { type: 'number', description: 'The price for one basis unit.' }, currency: { type: 'string' },
      }, required: ['section', 'description', 'amount', 'currency'] } },
      transit_days: { type: 'integer', description: 'As stated, or the days from ETD to ETA when both are given.' }, free_days: { type: 'integer', description: 'Free days at destination (detention / demurrage), when given.' },
      etd: { type: 'string', description: 'Next sailing / departure date, YYYY-MM-DD.' },
      routing: { type: 'string', description: 'Direct, or via which port (transhipment).' },
      carrier: { type: 'string', description: 'The shipping line or airline (MSC, Maersk, Emirates…). A terminal / port operator (DP World, AD Ports) is NOT a carrier. Leave out when not named.' },
      valid_until: { type: 'string', description: 'Rate valid until, YYYY-MM-DD.' },
      vendor_reference: { type: 'string', description: 'The vendor\'s OWN quote number. Never our numbers (ENQ-…, VR-…, our job no.). Leave out when they give none.' },
      inclusions: { type: 'string' }, exclusions: { type: 'string', description: 'What is not included (subject to, excluding…), short.' },
      quote: { type: 'string', description: 'The few words in the email that give the price (copied, max 160 characters).' },
      summary: { type: 'string', description: 'One short sentence: what the vendor offers.' },
    },
    required: ['has_rate', 'summary'],
  },
};

/** A terminal or port operator is not the shipping line (22 Nov: "DP World" came back as the line). */
const TERMINAL = /\b(dp\s*world|ad\s*ports?|abu\s*dhabi\s*ports?|khalifa\s*port|jebel\s*ali|port\s*rashid|terminal|cfs|gulftainer|psa|apm\s*terminals?|hutchison|icd)\b/i;
export const lineOnly = (v: string | null) => (v && TERMINAL.test(v) ? null : v);

/** Raised when the reading changes: suggestions read the old way (not yet saved) are read again. */
const QUOTE_V = 2;
const NOT_SAID = /^\s*(not\s+(stated|mentioned|given|specified|provided|included)|n\/?a|none|nil|-+)\b/i;
/** "Not stated in reply" and the like are no answer; "Direct (no transhipment stated)" → "Direct". */
export const blank = (v: string | null) => { if (!v || NOT_SAID.test(v)) return null; const s = v.replace(/\s*\([^)]*\b(not|no)\b[^)]*\bstated\)/i, '').trim(); return s || null; };

/**
 * The rate total and its charge lines. The vendor's all-in price wins: when the lines also hold the all-in line itself
 * ("all in 4500" + breakup 500 + 75 + 3925), that line is dropped. Lines that do not add up to the total are shown, not saved.
 */
export function settleTotal(total: number | null, currency: string | null, charges: any[]) {
  const cent = (n: number) => Math.round(n * 100);
  const val = (l: any) => cent(Number(l.quantity) * Number(l.amount));
  const cur = currency || charges[0]?.currency || null;
  const lines = charges.filter((l) => l.currency === cur);
  const sum = (ls: any[]) => ls.reduce((t, l) => t + val(l), 0);
  if (!lines.length || lines.length !== charges.length) return { total, currency: cur, lines: [] as any[], note: null as string | null };
  if (total === null) return { total: sum(lines) / 100, currency: cur, lines, note: null };
  if (sum(lines) === cent(total)) return { total, currency: cur, lines, note: null };
  // the all-in line listed together with its own breakup
  const allIn = lines.findIndex((l, i) => val(l) === cent(total) && sum(lines.filter((_, j) => j !== i)) === cent(total));
  if (allIn >= 0) return { total, currency: cur, lines: lines.filter((_, j) => j !== allIn), note: null };
  return { total, currency: cur, lines: [], note: `The charge lines add up to ${cur} ${(sum(lines) / 100).toLocaleString('en-US')}, not the ${cur} ${total.toLocaleString('en-US')} quoted — check the breakup` };
}

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
const int = (v: unknown, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
const date = (v: unknown) => { const s = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null; };
const txt = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

/** Cost is shown, so: someone who handles rate requests and sees cost. */
function canRead(actor: Actor) { return (actor.isSuperAdmin || actor.has('vendors.requests')) && actor.fin.buyingView; }

export async function readQuote(actor: Actor, emailId: string) {
  if (!isUuid(emailId)) throw notFound('Email');
  if (!canRead(actor)) throw forbidden('Only people who handle rate requests and see cost can read vendor rates');
  const e = await one('select * from email_messages where id = $1', [emailId]);
  if (!e || !e.vendor_request_id || e.direction !== 'in') throw bad('This email is not a reply to a rate request');
  await loadFile(actor, e.job_file_id);                                   // may this person open the enquiry?
  const old = await one(`select * from ai_suggestions where email_id = $1 and kind = 'quote'`, [emailId]);
  if (old) return { suggestion: old };                                    // read once
  const r = await one(`select r.*, v.name vendor_name from vendor_requests r join vendors v on v.id = r.vendor_id where r.id = $1`, [e.vendor_request_id]);
  const f = await one('select enquiry_ref, job_no, mode, port_of_loading, port_of_discharge, origin, destination, gross_weight_kg, volume_cbm from job_files where id = $1', [e.job_file_id]);

  const body = (await emailText(e)).slice(0, 12000);
  const box = e.attachment_count && e.message_id
    ? await one('select ms_message_id from outlook_inbox where user_id = $1 and internet_message_id = $2 limit 1', [e.created_by, e.message_id]) : null;
  const att = box ? await readAttachments(e.created_by, box.ms_message_id).catch(() => ({ blocks: [], text: '', notes: [], names: [] }))
    : { blocks: [] as any[], text: '', notes: [] as string[], names: [] as string[] };
  const text = `Our rate request ${r.request_no} to ${r.vendor_name}: ${String(r.description ?? '').slice(0, 1500)}
Shipment: ${f?.mode ?? ''} ${[f?.origin || f?.port_of_loading, f?.destination || f?.port_of_discharge].filter(Boolean).join(' to ')}${f?.gross_weight_kg ? `, ${f.gross_weight_kg} kg` : ''}${f?.volume_cbm ? `, ${f.volume_cbm} CBM` : ''}

Their reply — from ${e.from_name ? `${e.from_name} <${e.from_addr}>` : e.from_addr}, subject: ${e.subject ?? ''}

${body || '(no text)'}`
    + (att.text ? `\n\n--- Attached files ---\n${att.text}` : '') + (att.blocks.length ? '\n\nThe attached PDF / pictures are included above: read them too.' : '');
  const { input: x, model } = await askWithTool(
    `You read an agent's or carrier's reply to a rate request from Reliance Freight Systems, a freight forwarder in Dubai, UAE.
Pick out the price they offer for this shipment. Use only what the email and attachments say; never guess a price or fill from general knowledge.
Our own request text is often quoted below their reply: prices only count when the VENDOR wrote them. Dates as YYYY-MM-DD (today is ${today()}; with no year, use the next such date).
If they give several options (e.g. two carriers), take the cheapest complete one and mention the others in the summary.
"All in 4500, breakup: 500 + 75 + 3925" → total 4500 and three charge lines (the all-in line is NOT a charge line).
Leave a field out when the email does not say it — never write "not stated", "N/A" or similar.`,
    att.blocks.length ? [...att.blocks, { type: 'text', text }] : text, TOOL, 1500, 9000);

  // checked here, never taken on trust
  const charges = (Array.isArray(x?.charges) ? x.charges : []).slice(0, 40).map((l: any) => ({
    section: CHARGE_SECTIONS.some(([k]) => k === l?.section) ? l.section : 'other', description: txt(l?.description, 200) ?? 'Charge', basis: txt(l?.basis, 60),
    quantity: num(l?.quantity) ?? 1, amount: num(l?.amount), currency: String(l?.currency ?? '').trim().toUpperCase().slice(0, 3) || null,
  })).filter((l: any) => l.amount !== null);
  const t = settleTotal(num(x?.total), String(x?.currency ?? '').trim().toUpperCase().slice(0, 3) || null, charges);
  const { total, currency } = t;
  const hasRate = !!x?.has_rate && total !== null;
  // our own numbers are not their reference; "not stated" is no answer
  const ours = [r.request_no, f?.enquiry_ref, f?.job_no].filter(Boolean).map((v: string) => v.toUpperCase());
  let ref = blank(txt(x?.vendor_reference, 80));
  if (ref && (ours.includes(ref.toUpperCase()) || /^(ENQ|VR|SI|SE|AI|AE)-/i.test(ref))) ref = null;
  const rate = hasRate ? {
    v: QUOTE_V, quoted_cost: total, currency, currency_ok: isCurrency(currency), charges: isCurrency(currency) ? t.lines : [], charges_seen: charges,
    transit_days: int(x?.transit_days, 365), free_days: int(x?.free_days, 365), etd: date(x?.etd), routing: blank(txt(x?.routing, 300)), carrier: lineOnly(blank(txt(x?.carrier, 120))),
    rate_valid_until: date(x?.valid_until), vendor_reference: ref, inclusions: blank(txt(x?.inclusions, 2000)), exclusions: blank(txt(x?.exclusions, 2000)),
    quote: txt(x?.quote, 200),
  } : { v: QUOTE_V };
  const summary = txt(x?.summary, 300) ?? '';
  const unclear = hasRate ? [...(t.note ? [{ note: t.note }] : []), ...att.notes.map((n: string) => ({ note: n }))]
    : [{ note: txt(x?.no_rate_reason, 200) ?? 'No price in this reply' }];
  const s = await one(`insert into ai_suggestions (job_file_id, email_id, kind, vendor_request_id, status, summary, answers, unclear, model, read_by)
      values ($1, $2, 'quote', $3, $4, $5, $6, $7, $8, $9)
    on conflict (email_id, kind) do nothing returning *`,
    [e.job_file_id, emailId, r.id, hasRate ? 'open' : 'nothing', summary, JSON.stringify(rate ?? {}), JSON.stringify(unclear), model, actor.id]);
  return { suggestion: s ?? await one(`select * from ai_suggestions where email_id = $1 and kind = 'quote'`, [emailId]) };
}

// ------------------------------------------------------------------ the box under "Rates and quotation"
export async function quoteBox(actor: Actor, fileId: string) {
  if (!isUuid(fileId)) throw notFound('Job File');
  if (!canRead(actor)) return { allowed: false };                          // rates are cost: nothing shown, nothing read
  await loadFile(actor, fileId);
  await linkOldReplies(fileId);
  // read the old way and not handled yet: read again (they show up as "not read yet" and the AI reads them by itself)
  await q(`delete from ai_suggestions where job_file_id = $1 and kind = 'quote' and status in ('open', 'nothing')
    and coalesce((answers->>'v')::int, 1) < ${QUOTE_V}`, [fileId]);
  const open = await q(`select s.id, s.email_id, s.summary, s.answers rate, s.unclear, s.created_at, e.from_name, e.from_addr, e.subject, e.sent_at,
      r.id request_id, r.request_no, r.status request_status, r.quoted_cost current_cost, r.currency current_currency, v.name vendor_name
    from ai_suggestions s join email_messages e on e.id = s.email_id join vendor_requests r on r.id = s.vendor_request_id join vendors v on v.id = r.vendor_id
    where s.job_file_id = $1 and s.kind = 'quote' and s.status = 'open' and r.status in ('requested', 'quoted') order by e.sent_at desc nulls last`, [fileId]);
  const noRate = await q(`select s.id, s.unclear, s.summary, e.sent_at, r.request_no, v.name vendor_name
    from ai_suggestions s join email_messages e on e.id = s.email_id join vendor_requests r on r.id = s.vendor_request_id join vendors v on v.id = r.vendor_id
    where s.job_file_id = $1 and s.kind = 'quote' and s.status = 'nothing' and r.status = 'requested'
      and not exists (select 1 from ai_suggestions s2 join email_messages e2 on e2.id = s2.email_id where s2.vendor_request_id = r.id and s2.kind = 'quote' and s2.id <> s.id and e2.sent_at > e.sent_at)
    order by e.sent_at desc`, [fileId]);
  const unread = await q(`select e.id, e.from_name, e.from_addr, e.subject, e.sent_at, r.request_no, v.name vendor_name
    from email_messages e join vendor_requests r on r.id = e.vendor_request_id join vendors v on v.id = r.vendor_id
    where e.job_file_id = $1 and e.direction = 'in' and r.status in ('requested', 'quoted')
      and not exists (select 1 from ai_suggestions s where s.email_id = e.id and s.kind = 'quote') order by e.sent_at desc nulls last limit 5`, [fileId]);
  return { allowed: true, configured: aiConfig().ready, open, no_rate: noRate, unread };
}

// ------------------------------------------------------------------ 3. Save rate / Dismiss
export async function applyQuote(actor: Actor, id: string, b: any) {
  if (!isUuid(id)) throw notFound('Suggestion');
  if (!canRead(actor)) throw forbidden('Only people who handle rate requests and see cost can save a rate');
  const s = await one(`select * from ai_suggestions where id = $1 and kind = 'quote'`, [id]);
  if (!s) throw notFound('Suggestion');
  if (s.status !== 'open') throw bad('This suggestion is already handled');
  const r = await one('select id, status, request_no from vendor_requests where id = $1', [s.vendor_request_id]);
  if (!['requested', 'quoted'].includes(r?.status)) throw new ApiError(409, 'VR_STATE', 'This rate request is no longer waiting for a rate');
  // what the person checked on the screen (they may have corrected the AI)
  const v = { ...(s.answers ?? {}), ...(b?.rate ?? {}) };
  if (num(v.quoted_cost) === null) throw bad('Enter the rate');
  if (!isCurrency(v.currency)) throw bad('Rate currency: AED, USD, EUR, INR or CNY');
  const fields: any = { quoted_cost: String(num(v.quoted_cost)), currency: String(v.currency).toUpperCase() };
  for (const k of ['transit_days', 'free_days']) fields[k] = v[k] === '' || v[k] === null || v[k] === undefined ? null : v[k];
  for (const k of ['etd', 'routing', 'carrier', 'rate_valid_until', 'vendor_reference', 'inclusions', 'exclusions']) fields[k] = v[k] ?? null;
  // the charge lines only when kept as the AI read them (one currency, adding up to the rate)
  const ch: any[] = Array.isArray(s.answers?.charges) ? s.answers.charges : [];
  const sum = Math.round(ch.reduce((t, l) => t + Number(l.quantity) * Number(l.amount) * 100, 0)) / 100;
  if (b?.use_charges && ch.length && sum === num(v.quoted_cost) && ch.every((l) => l.currency === fields.currency)) {
    fields.charges = ch.map((l) => ({ section: l.section, description: l.description, basis: l.basis, quantity: String(l.quantity), amount: String(l.amount), currency: l.currency, exchange_rate: '1' }));
    delete fields.quoted_cost;
  }
  const { vendorRequestAction } = await import('./vendorreqs');
  await tx(async (c) => {
    if (r.status === 'requested') await vendorRequestAction(actor, r.id, { status: 'quoted', ...fields }, c);
    else await vendorRequestAction(actor, r.id, { what: 'revise_rate', note: 'New rate from the vendor\'s email (AI suggestion, checked)', ...fields }, c);
    await c.query(`update ai_suggestions set status = 'applied', applied_keys = $2, decided_by = $3, decided_at = now() where id = $1`,
      [id, JSON.stringify(Object.keys(fields)), actor.id]);
    await c.query(`insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1, $2, $3, $4, $5)`,
      [r.id, 'Rate filled in from the vendor\'s email (AI suggestion, checked)', `${fields.currency} ${num(v.quoted_cost)}`, actor.id, actor.full_name]);
    await event(c, actor, s.job_file_id, { kind: 'note', title: `Rate saved from the vendor's email — ${r.request_no}`, new_value: 'AI suggestion, checked' });
  });
  return { ok: true };
}

export async function dismissQuote(actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Suggestion');
  if (!canRead(actor)) throw forbidden();
  const s = await one(`select * from ai_suggestions where id = $1 and kind = 'quote'`, [id]);
  if (!s) throw notFound('Suggestion');
  await loadFile(actor, s.job_file_id);
  if (!['open', 'nothing'].includes(s.status)) throw bad('This suggestion is already handled');
  await q(`update ai_suggestions set status = 'dismissed', decided_by = $2, decided_at = now() where id = $1`, [id, actor.id]);
  return { ok: true };
}
