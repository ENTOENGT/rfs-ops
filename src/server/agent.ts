/**
 * AI agent part A (migration 032): a customer's reply on an enquiry → suggested answers to its missing details.
 *
 *  1. The full email text is fetched once from the Outlook it arrived in (and kept on the email).
 *  2. Claude is given the enquiry's missing details (the same list the screen shows: built-in rules + your checklist)
 *     and the email, and must answer in a fixed shape: which details the sender answered, with the words they used.
 *  3. The answers are checked here (only real missing details, right type: yes / no, a date, a number…).
 *  4. They wait on the enquiry as a suggestion. A person ticks what is right and presses Apply → the normal enquiry update,
 *     in their name, with history. Or Dismiss. Then "Ask for what is still missing" drafts the next email.
 */
import { Actor } from './auth';
import { ApiError, bad, forbidden, notFound, one, q } from './db';
import { askWithTool, aiConfig } from './ai';
import { graph } from './outlook';
import { event, getJobFile, loadFile, updateJobFile } from './jobfiles';
import { INCOTERM_INFO } from '../lib/incotermRules';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const MAX_TEXT = 12000;
/** Built-in details that can be filled straight into the enquiry, and their kind. Cargo lines need sizes per package: by hand. */
const BUILT_IN: Record<string, 'text' | 'number' | 'incoterm' | 'by_hand'> = {
  pickup_address: 'text', delivery_address: 'text', named_place: 'text', port_of_loading: 'text', port_of_discharge: 'text',
  cargo_value: 'text', cargo_description: 'text', gross_weight_kg: 'number', incoterm: 'incoterm', cargo_lines: 'by_hand',
};

/** The email's full text: kept copy, else fetched from the Outlook it arrived in, else the short preview. */
async function emailText(e: any): Promise<string> {
  if (e.body_text) return e.body_text;
  if (e.source === 'mailbox' && e.message_id) {
    const box = await one(`select ms_message_id from outlook_inbox where user_id = $1 and internet_message_id = $2 limit 1`, [e.created_by, e.message_id]);
    if (box) {
      const m: any = await graph(e.created_by, `/me/messages/${encodeURIComponent(box.ms_message_id)}?$select=body`,
        { headers: { Prefer: 'outlook.body-content-type="text"' } }).catch((err) => {
        if (err instanceof ApiError && ['NOT_CONNECTED', 'RECONNECT'].includes(err.code))
          throw new ApiError(409, 'MAILBOX_OFF', `${e.created_by_name ?? 'The person'}'s Outlook is not connected, so the full email can't be read.`);
        throw err;
      });
      const text = String(m?.body?.content ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
      if (text) { await q('update email_messages set body_text = $2 where id = $1', [e.id, text]); return text; }
    }
  }
  return String(e.body_excerpt ?? '');
}

const TOOL = {
  name: 'record_answers',
  description: 'Record which of the missing enquiry details the sender answered in this email.',
  input_schema: {
    type: 'object',
    properties: {
      answers: { type: 'array', description: 'Only details the sender clearly answered.', items: { type: 'object', properties: {
        key: { type: 'string', description: 'The key of the missing detail, exactly as listed.' },
        value: { type: 'string', description: 'The answer in the format asked for that detail.' },
        quote: { type: 'string', description: 'The few words in the email that give this answer (copied, max 120 characters).' },
      }, required: ['key', 'value', 'quote'] } },
      unclear: { type: 'array', description: 'Details the sender mentioned but did not really answer (NA, not known yet, will advise, unclear).', items: { type: 'object', properties: {
        key: { type: 'string' }, note: { type: 'string', description: 'What they said, in a few words.' },
      }, required: ['key', 'note'] } },
      summary: { type: 'string', description: 'One short sentence: what this email says about the enquiry.' },
    },
    required: ['answers', 'unclear', 'summary'],
  },
};

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

/** Check one answer against the kind of detail. Returns the clean value, or null when it doesn't fit. */
function cleanValue(kind: string, v: string): string | null {
  const s = String(v ?? '').trim();
  if (!s || /^(n\/?a|na|nil|none|-|tbc|tba|not available|unknown)$/i.test(s)) return null;
  if (kind === 'yes_no') { const y = s.toLowerCase(); return y.startsWith('y') ? 'yes' : y.startsWith('n') ? 'no' : null; }
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
  if (kind === 'number') { const n = Number(s.replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0]); return Number.isFinite(n) && n > 0 ? String(n) : null; }
  if (kind === 'incoterm') { const t = s.toUpperCase().match(/\b[A-Z]{3}\b/)?.[0]; return t && INCOTERM_INFO[t] ? t : null; }
  return s.slice(0, 300);
}

/** "Read with AI": read one received email on an enquiry and save the suggested answers. */
export async function readEmail(actor: Actor, emailId: string) {
  if (!isUuid(emailId)) throw notFound('Email');
  const e = await one('select * from email_messages where id = $1', [emailId]);
  if (!e) throw notFound('Email');
  const d: any = await getJobFile(actor, e.job_file_id);              // also: may this person open the shipment?
  if (!d.can?.edit) throw forbidden('Only the people handling this enquiry can ask the AI to read its emails');
  if (e.direction !== 'in') throw bad('Only received emails are read');
  const gaps: any[] = d.enquiry_gaps ?? [];
  const checks: any[] = d.enquiry_checks ?? [];
  const kindOf = (key: string) => BUILT_IN[key] ?? checks.find((c) => c.id === key)?.field_type ?? 'text';
  const old = await one(`select * from ai_suggestions where email_id = $1 and kind = 'enquiry'`, [emailId]);
  if (old && old.status !== 'open') return { suggestion: old };        // already read and decided
  if (!gaps.length) return { suggestion: null, nothing_missing: true };

  const text = (await emailText(e)).slice(0, MAX_TEXT);
  const asked = gaps.map((g) => `- key: ${g.key} | ${g.label} | answer format: ${({ yes_no: 'yes or no', date: 'date YYYY-MM-DD', number: 'number only (kg)', incoterm: '3-letter Incoterm code', by_hand: 'text' } as any)[kindOf(g.key)] ?? 'short text'} | we asked for: ${g.ask}`).join('\n');
  const system = `You read emails for Reliance Freight Systems, a freight forwarder in Dubai. An enquiry is missing some details and the customer has replied.
Find which of the missing details the SENDER answered in this email. Rules:
- Use only what the email says. Never guess or fill in from general knowledge.
- Customers often type their answers next to our questions inside the quoted text (for example "- The total cargo weight: 40 Kg"). Our question text on its own is not an answer; only what the sender wrote after it is.
- If the sender wrote NA, not available, will advise, or left it empty, put that detail under "unclear", not "answers".
- Format: yes/no details as "yes" or "no"; dates as YYYY-MM-DD (today is ${today()}; with no year, use the next such date); numbers as digits only; text short and as written.
- Use only the keys in the list. Ignore anything about prices.`;
  const user = `Enquiry ${d.enquiry_ref ?? ''}: ${d.direction ?? ''} ${d.mode ?? ''}, ${[d.origin || d.port_of_loading, d.destination || d.port_of_discharge].filter(Boolean).join(' to ') || 'route not known'}.

Missing details:
${asked}

Email from ${e.from_name ? `${e.from_name} <${e.from_addr}>` : e.from_addr}, received ${e.sent_at ? new Date(e.sent_at).toISOString().slice(0, 16).replace('T', ' ') : ''}
Subject: ${e.subject ?? ''}

${text || '(the email has no text)'}`;
  const { input, model } = await askWithTool(system, user, TOOL);

  // keep only real missing details, in the right format, once each
  const label = (k: string) => gaps.find((g) => g.key === k)?.label ?? k;
  const seen = new Set<string>();
  const answers: any[] = [], unclear: any[] = [];
  for (const a of Array.isArray(input?.answers) ? input.answers : []) {
    const key = String(a?.key ?? '');
    if (!gaps.some((g) => g.key === key) || seen.has(key)) continue;
    const value = cleanValue(kindOf(key), a.value);
    if (value === null) { unclear.push({ key, label: label(key), note: String(a.value ?? '').slice(0, 120) }); seen.add(key); continue; }
    answers.push({ key, label: label(key), value, quote: String(a.quote ?? '').slice(0, 160), by_hand: kindOf(key) === 'by_hand' });
    seen.add(key);
  }
  for (const u of Array.isArray(input?.unclear) ? input.unclear : []) {
    const key = String(u?.key ?? '');
    if (gaps.some((g) => g.key === key) && !seen.has(key)) { unclear.push({ key, label: label(key), note: String(u.note ?? '').slice(0, 160) }); seen.add(key); }
  }
  const summary = String(input?.summary ?? '').slice(0, 300);
  const status = answers.length ? 'open' : 'nothing';
  const s = await one(`insert into ai_suggestions (job_file_id, email_id, kind, status, summary, answers, unclear, model, read_by)
      values ($1, $2, 'enquiry', $3, $4, $5, $6, $7, $8)
    on conflict (email_id, kind) do update set status = excluded.status, summary = excluded.summary, answers = excluded.answers,
      unclear = excluded.unclear, model = excluded.model, read_by = excluded.read_by, created_at = now()
    returning *`, [e.job_file_id, emailId, status, summary, JSON.stringify(answers), JSON.stringify(unclear), model, actor.id]);
  return { suggestion: s };
}

/** The AI box on an enquiry: open suggestions, and received emails the AI has not read yet. */
export async function suggestionsFor(actor: Actor, fileId: string) {
  const f = await loadFile(actor, fileId);
  const rows = await q(`select s.*, e.from_name, e.from_addr, e.subject, e.sent_at from ai_suggestions s join email_messages e on e.id = s.email_id
     where s.job_file_id = $1 and s.status = 'open' order by e.sent_at desc nulls last`, [fileId]);
  // answers already filled in (e.g. by another email's suggestion) are not offered again; a suggestion with nothing left closes
  const gapKeys = rows.length ? new Set(((await getJobFile(actor, fileId)) as any).enquiry_gaps?.map((g: any) => g.key) ?? []) : new Set();
  const open: any[] = [];
  for (const s of rows) {
    const answers = (s.answers as any[]).filter((a) => gapKeys.has(a.key));
    if (!answers.length) { await q(`update ai_suggestions set status = 'nothing' where id = $1 and status = 'open'`, [s.id]); continue; }
    open.push({ ...s, answers, unclear: (s.unclear as any[]).filter((u) => gapKeys.has(u.key)) });
  }
  const unread = f.status === 'enquiry' ? await q(`select e.id, e.from_name, e.from_addr, e.subject, e.sent_at from email_messages e
     where e.job_file_id = $1 and e.direction = 'in' and not exists (select 1 from ai_suggestions s where s.email_id = e.id)
     order by e.sent_at desc nulls last limit 3`, [fileId]) : [];
  return { configured: aiConfig().ready, open, unread };
}

/** Apply the ticked answers: the normal enquiry update, in this person's name, then the suggestion is closed. */
export async function applySuggestion(actor: Actor, id: string, b: any) {
  if (!isUuid(id)) throw notFound('Suggestion');
  const s = await one('select * from ai_suggestions where id = $1', [id]);
  if (!s) throw notFound('Suggestion');
  if (s.status !== 'open') throw bad('This suggestion is already handled');
  const d: any = await getJobFile(actor, s.job_file_id);
  if (!d.can?.edit) throw forbidden('You cannot change this enquiry');
  const keys: string[] = Array.isArray(b?.keys) ? b.keys.map(String) : [];
  const gapKeys = new Set((d.enquiry_gaps ?? []).map((g: any) => g.key));
  const picked = (s.answers as any[]).filter((a) => keys.includes(a.key) && !a.by_hand && gapKeys.has(a.key));
  if (!picked.length) throw bad(keys.length ? 'These details are already filled in' : 'Tick at least one answer to fill in');
  const patch: Record<string, unknown> = {};
  const details: Record<string, string> = { ...(d.enquiry_details ?? {}) };
  for (const a of picked) { if (a.key in BUILT_IN) patch[a.key] = a.value; else details[a.key] = a.value; }
  if (picked.some((a) => !(a.key in BUILT_IN))) patch.enquiry_details = details;
  await updateJobFile(actor, s.job_file_id, patch);
  const { tx } = await import('./db');
  await tx(async (c) => {
    await c.query(`update ai_suggestions set status = 'applied', applied_keys = $2, decided_by = $3, decided_at = now() where id = $1`,
      [id, JSON.stringify(picked.map((a) => a.key)), actor.id]);
    await event(c, actor, s.job_file_id, { kind: 'note', title: 'Filled in from the customer\'s email (AI suggestion, checked)',
      new_value: picked.map((a) => a.label).join(', ') });
  });
  return { ok: true, applied: picked.length };
}

export async function dismissSuggestion(actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Suggestion');
  const s = await one('select * from ai_suggestions where id = $1', [id]);
  if (!s) throw notFound('Suggestion');
  const d: any = await getJobFile(actor, s.job_file_id);
  if (!d.can?.edit) throw forbidden('You cannot change this enquiry');
  if (s.status !== 'open') throw bad('This suggestion is already handled');
  await q(`update ai_suggestions set status = 'dismissed', decided_by = $2, decided_at = now() where id = $1`, [id, actor.id]);
  return { ok: true };
}
