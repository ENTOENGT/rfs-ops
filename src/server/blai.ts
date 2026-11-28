/**
 * 27 Nov (migration 048, flow test point 25): the AI on the BL draft.
 *   check  — reads the latest draft (PDF / picture) against the shipment: shipper, consignee, notify, ports, vessel, containers,
 *            packages, weight, cargo. Each difference is listed for the person; nothing is changed.
 *   reply  — reads the customer's answer after the draft went to them: confirmed, or the corrections in their words. It waits as a
 *            suggestion; "Record" uses the normal BL steps in the person's name.
 */
import { Actor } from './auth';
import { bad, forbidden, notFound, one, pool, q } from './db';
import { aiConfig, askWithTool } from './ai';
import { canEdit, loadFile } from './jobfiles';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const WITH_CUSTOMER = ['sent_to_customer', 'revised_sent'];

async function fileOk(actor: Actor, fileId: string) {
  if (!isUuid(fileId)) throw notFound('Job File');
  const f = await loadFile(actor, fileId);
  if (!canEdit(actor, f)) throw forbidden();
  return f;
}

/** What the BL panel shows: the AI check of the latest draft, and the customer's answer read by the AI. */
export async function blAiBox(actor: Actor, fileId: string) {
  const f = await fileOk(actor, fileId);
  const cur = await one('select id, version, ai_check, ai_checked_at, document_id from bl_drafts where job_file_id = $1 order by version desc limit 1', [fileId]);
  const replies = await q(`select s.id, s.status, s.summary, s.answers, e.from_name, e.from_addr, e.sent_at from ai_suggestions s join email_messages e on e.id = s.email_id
    where s.job_file_id = $1 and s.kind = 'bl_reply' and s.status = 'open' order by s.created_at desc limit 3`, [fileId]);
  return { configured: aiConfig().ready, bl_status: f.bl_status, draft: cur ?? null, replies };
}

const CHECK_TOOL = { name: 'bl_draft_check', description: 'Differences between the BL draft and the shipment record',
  input_schema: { type: 'object', properties: {
    differences: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, on_draft: { type: 'string' }, on_record: { type: 'string' } }, required: ['field'] },
      description: 'Each field where the draft and our record clearly differ (a typo in a name, another port, other container numbers, a different count or weight). Leave out what only differs in spelling of capitals or punctuation.' },
    not_on_draft: { type: 'array', items: { type: 'string' }, description: 'Important BL fields that are empty on the draft (shipper, consignee, notify party, ports, vessel, containers / seals, packages, weight, description).' },
    summary: { type: 'string', description: 'One short sentence.' },
  }, required: ['differences'] } };

/** "Check with AI": the latest draft against the shipment. */
export async function checkBlDraft(actor: Actor, fileId: string) {
  const f = await fileOk(actor, fileId);
  if (!aiConfig().ready) throw bad('The AI is not set up');
  const cur = await one(`select b.id, b.version, d.storage_path, d.mime_type, d.file_name from bl_drafts b join jf_documents d on d.id = b.document_id
    where b.job_file_id = $1 and d.deleted_at is null order by b.version desc limit 1`, [fileId]);
  if (!cur) throw bad('Save the BL draft first');
  const type = String(cur.mime_type).toLowerCase();
  if (!/pdf|image\/(png|jpe?g|gif|webp)/.test(type)) throw bad('The AI can read a PDF or a picture of the draft');
  const { fileStore } = await import('./storage');
  const data = (await fileStore().read(cur.storage_path)).toString('base64');
  const block = type.includes('pdf') ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: type.replace('jpg', 'jpeg'), data } };
  const conts = await q('select container_no, size_type, seal_no from job_file_containers where job_file_id = $1 and deleted_at is null order by container_no', [fileId]);
  const record = [['Shipper', f.shipper], ['Consignee', f.consignee], ['Notify party', f.notify_party], ['Port of loading', f.port_of_loading], ['Port of discharge', f.port_of_discharge],
    ['Vessel / voyage', [f.vessel_flight, f.voyage].filter(Boolean).join(' ')], ['Booking no.', f.booking_reference], ['Packages', f.packages], ['Gross weight (kg)', f.gross_weight_kg],
    ['Volume (CBM)', f.volume_cbm], ['Cargo', f.cargo_description], ['Containers', conts.map((k: any) => [k.container_no, k.size_type, k.seal_no && `seal ${k.seal_no}`].filter(Boolean).join(' ')).join('; ')]]
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
  const { input: x } = await askWithTool(`You check a draft Bill of Lading for Reliance Freight Systems, a freight forwarder in Dubai, against our shipment record.
List only real differences and empty important fields. Use only what the draft shows; never guess.`,
    [block, { type: 'text', text: `OUR SHIPMENT RECORD\n${record || '(little is recorded)'}` }], CHECK_TOOL as any, 1200, 9500);
  const clean = (s: unknown, n = 200) => String(s ?? '').slice(0, n);
  const result = {
    differences: (Array.isArray(x?.differences) ? x.differences : []).slice(0, 15).map((d: any) => ({ field: clean(d.field, 60), on_draft: clean(d.on_draft), on_record: clean(d.on_record) })),
    not_on_draft: (Array.isArray(x?.not_on_draft) ? x.not_on_draft : []).slice(0, 10).map((s: any) => clean(s, 80)),
    summary: clean(x?.summary, 300), version: cur.version,
  };
  await q('update bl_drafts set ai_check = $2, ai_checked_at = now() where id = $1', [cur.id, JSON.stringify(result)]);
  return blAiBox(actor, fileId);
}

const REPLY_TOOL = { name: 'bl_customer_answer', description: 'What the customer answered about the BL draft we sent',
  input_schema: { type: 'object', properties: {
    answer: { type: 'string', enum: ['confirmed', 'corrections', 'other'], description: 'confirmed = the draft is OK / approved; corrections = they want something changed; other = anything else' },
    corrections: { type: 'string', description: 'When corrections: every change they ask for, in their words, one per line.' },
    quote: { type: 'string', description: 'The few words that show their answer (max 160 characters).' },
    summary: { type: 'string', description: 'One short sentence.' },
  }, required: ['answer'] } };

/** For the background reader: customer emails received after the draft went to them, not read yet. */
export async function blReplies(n: number) {
  return q(`select e.id, f.id file_id, coalesce(e.created_by, f.coordinator_id) uid from email_messages e join job_files f on f.id = e.job_file_id
      join lateral (select sent_at from bl_drafts b where b.job_file_id = f.id order by b.version desc limit 1) b on true
    where f.bl_status = any($2) and e.direction = 'in' and e.vendor_request_id is null and b.sent_at is not null and e.created_at > b.sent_at
      and e.created_at > now() - interval '5 days' and e.ai_bg_tries < 2
      and not exists (select 1 from ai_suggestions s where s.email_id = e.id and s.kind = 'bl_reply')
      and not exists (select 1 from vendors v where lower(v.email) = lower(e.from_addr))
    order by e.created_at desc limit $1`, [n, WITH_CUSTOMER]);
}

export async function readBlReply(actor: Actor, emailId: string) {
  if (!aiConfig().ready || !isUuid(emailId)) return { read: false };
  const e = await one('select * from email_messages where id = $1', [emailId]);
  if (!e?.job_file_id) return { read: false };
  const { emailText } = await import('./agent');
  const body = (await emailText(e)).slice(0, 8000);
  const { input: x, model } = await askWithTool(`You read a customer's email to Reliance Freight Systems, a freight forwarder in Dubai. We sent them a draft Bill of Lading to check.
Decide what THEY answered (our earlier email is often quoted below — ignore it). Use only what they wrote; never guess.`,
    `Their email — subject: ${e.subject ?? ''}\n\n${body || '(no text)'}`, REPLY_TOOL as any, 700, 9000);
  const answer = ['confirmed', 'corrections'].includes(x?.answer) ? x.answer : 'other';
  const answers = { answer, corrections: String(x?.corrections ?? '').slice(0, 2000) || null, quote: String(x?.quote ?? '').slice(0, 200) || null };
  await q(`insert into ai_suggestions (job_file_id, email_id, kind, status, summary, answers, model, read_by) values ($1, $2, 'bl_reply', $3, $4, $5, $6, $7)`,
    [e.job_file_id, emailId, answer === 'other' ? 'nothing' : 'open', String(x?.summary ?? '').slice(0, 300), JSON.stringify(answers), model, actor.id]);
  if (answer !== 'other') await (await import('./notify')).notifyGroup(pool(), actor, e.job_file_id, answer === 'confirmed' ? 'bl_confirmed' : 'bl_correction',
    answer === 'confirmed' ? 'the customer\'s email says the BL draft is OK — record it' : `the customer asks for corrections — ${answers.corrections ?? ''}`.slice(0, 160)).catch(() => {});
  return { read: true, answer };
}

/** "Record" / "Dismiss" on the customer's answer read by the AI. */
export async function blReplyAction(actor: Actor, fileId: string, b: any) {
  await fileOk(actor, fileId);
  if (!isUuid(b?.id)) throw notFound('Suggestion');
  const s = await one(`select s.*, e.from_name, e.from_addr, e.sent_at from ai_suggestions s join email_messages e on e.id = s.email_id
    where s.id = $1 and s.job_file_id = $2 and s.kind = 'bl_reply'`, [b.id, fileId]);
  if (!s || s.status !== 'open') throw bad('This answer is already handled');
  if (b.action !== 'dismiss') {
    const { blAction } = await import('./routing');
    const who = s.from_name ? `${s.from_name} <${s.from_addr}>` : s.from_addr;
    const when = new Date(s.sent_at ?? Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (s.answers.answer === 'confirmed') await blAction(actor, fileId, { step: 'confirm', evidence_note: `Confirmed by email from ${who} on ${when}: "${s.answers.quote ?? 'OK'}"` });
    else await blAction(actor, fileId, { step: 'correction', correction_notes: String(b.notes ?? s.answers.corrections ?? '').trim() || `See the email from ${who} on ${when}` });
  }
  await q(`update ai_suggestions set status = $2, decided_by = $3, decided_at = now() where id = $1`, [s.id, b.action === 'dismiss' ? 'dismissed' : 'applied', actor.id]);
  return blAiBox(actor, fileId);
}
