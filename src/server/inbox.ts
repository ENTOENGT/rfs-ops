/**
 * Outlook step 3 (migration 030) — reading a pilot user's Outlook inbox and filing emails on the right shipment.
 *
 *  - Read only: nothing in Outlook is moved, changed or deleted.
 *  - Microsoft "delta" reading: each check only fetches what is new since the last check. The first check looks back 7 days.
 *  - Matching, in this order: a tag in the subject ([ENQ-…], the Job No. or the Shipping Ref), then the same email
 *    conversation as an email already on a shipment.
 *  - Matched → copied to the shipment's Emails tab, noted in its history and the people handling it are told.
 *  - Not matched but from a known customer or agent → "Emails to file", where the person files it by hand or ignores it.
 *  - From anyone else (newsletters, personal mail) → not saved at all.
 */
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, notFound, one, q, tx } from './db';
import { canSend, graph } from './outlook';
import { aiConfig } from './ai';
import { event, loadFile } from './jobfiles';
import { notifyGroup } from './notify';

export const FIRST_LOOK_BACK_DAYS = 7;
const PAGES_PER_CHECK = 10;            // at most 10 pages of 25 per check; the rest on the next check
const PAGE_SIZE = 25;
const TIME_BUDGET_MS = 6000;           // no new page after 6 seconds (requests are cut at 10)
const SELECT = 'subject,from,toRecipients,ccRecipients,receivedDateTime,internetMessageId,conversationId,bodyPreview,hasAttachments,isDraft,webLink';
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'yandex.com', 'mail.com', 'gmx.com', 'zoho.com', 'emirates.net.ae', 'eim.ae', 'rediffmail.com']);
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const addr = (a: any) => String(a?.emailAddress?.address ?? '').trim().toLowerCase();
const addrs = (l: any[] | undefined) => (l ?? []).map(addr).filter(Boolean).join(', ') || null;

/** The shipment a subject points to: any [TAG] that is an Enquiry Ref, Job No. or Shipping Ref. */
export async function shipmentFromSubject(subject: string | null | undefined, db?: Db) {
  const tags = [...String(subject ?? '').matchAll(/\[([A-Za-z0-9][A-Za-z0-9\-\/]{3,40})\]/g)].map((m) => m[1].toUpperCase());
  for (const t of tags) {
    const f = await one(`select id from job_files where deleted_at is null and (upper(enquiry_ref) = $1 or upper(job_no) = $1 or upper(shipping_ref) = $1)
      order by created_at desc limit 1`, [t], db);
    if (f) return f.id as string;
  }
  return null;
}

/** "Customer: X" / "Agent: Y" when the sender is one of ours (the exact address, or the same company domain). */
export async function knownSender(email: string, db?: Db): Promise<string | null> {
  if (!email.includes('@')) return null;
  const exact = await one(`select label from (
      select 'Customer: ' || c.name label, 1 o from customers c where lower(c.email) = $1 and c.deleted_at is null
      union all select 'Customer: ' || c.name, 1 from customer_contacts k join customers c on c.id = k.customer_id
        where lower(k.email) = $1 and k.deleted_at is null and c.deleted_at is null
      union all select 'Agent: ' || v.name, 2 from vendors v where lower(v.email) = $1 and v.deleted_at is null) x order by o limit 1`, [email], db);
  if (exact) return exact.label;
  const domain = email.split('@')[1];
  if (!domain || PUBLIC_DOMAINS.has(domain)) return null;
  const dom = await one(`select label from (
      select 'Customer: ' || c.name label, 1 o from customers c where lower(c.email) like $1 and c.deleted_at is null
      union all select 'Customer: ' || c.name, 1 from customer_contacts k join customers c on c.id = k.customer_id
        where lower(k.email) like $1 and k.deleted_at is null and c.deleted_at is null
      union all select 'Agent: ' || v.name, 2 from vendors v where lower(v.email) like $1 and v.deleted_at is null) x order by o limit 1`, [`%@${domain}`], db);
  return dom?.label ?? null;
}

/** Copy one inbox email onto a shipment: Emails tab, history, and tell the people handling it. */
export async function fileOnShipment(c: Db, actor: Actor, fileId: string, m: any, how: string) {
  const ins = await c.query(`insert into email_messages (job_file_id, direction, status, from_addr, from_name, to_addrs, cc_addrs, subject, sent_at, message_id,
      conversation_id, body_excerpt, attachment_count, source, created_by, created_by_name, web_link)
    values ($1, 'in', 'received', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'mailbox', $12, $13, $14)
    on conflict (job_file_id, message_id) where message_id is not null do nothing returning id`,
    [fileId, m.from_addr, m.from_name, m.to_addrs, m.cc_addrs, m.subject, m.received_at, m.internet_message_id, m.conversation_id,
      String(m.body_excerpt ?? '').slice(0, 2000), m.has_attachments ? 1 : 0, actor.id, actor.full_name, m.web_link]);
  if (!ins.rowCount) return;                                   // the same email is already on this shipment: no second history line
  // migration 033: the customer's sender and the people they copied stay on this shipment's later emails
  const box = await one('select ms_email from outlook_connections where user_id = $1', [actor.id], c);
  await (await import('./emailpeople')).learnFromReceived(c, fileId, m, box?.ms_email ?? null);
  const who = m.from_name || m.from_addr || 'someone';
  await event(c, actor, fileId, { kind: 'note', title: `Email received from ${who}`, new_value: `"${String(m.subject ?? '').slice(0, 200)}"${how === 'hand' ? ' — filed by hand' : ''}` });
  await notifyGroup(c, actor, fileId, 'email_saved', `from ${who}`);
}

/** The shipment an earlier email of the same conversation was filed on. */
async function shipmentFromConversation(conversationId: string | null, db?: Db) {
  if (!conversationId) return null;
  const r = await one(`select job_file_id from (
      select job_file_id, 1 o from outlook_inbox where conversation_id = $1 and job_file_id is not null
      union all select job_file_id, 2 from email_messages where conversation_id = $1) x order by o limit 1`, [conversationId], db);
  return (r?.job_file_id as string) ?? null;
}

/** Look at one email from Microsoft. Returns what happened to it. */
/** Automatic senders that are never enquiries (not kept, not sent to the AI). */
const AUTOMATIC = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|newsletters?|marketing|news|bounce|alerts?|updates?|info-noreply)[@+.-]/i;

async function takeOne(actor: Actor, msg: any): Promise<'filed' | 'unmatched' | 'screen' | 'skipped'> {
  if (msg['@removed'] || msg.isDraft || !msg.id) return 'skipped';
  if (await one('select 1 from outlook_inbox where user_id = $1 and ms_message_id = $2', [actor.id, msg.id])) return 'skipped';
  const m = {
    ms_message_id: msg.id, internet_message_id: msg.internetMessageId ?? null, conversation_id: msg.conversationId ?? null,
    from_addr: addr(msg.from) || null, from_name: msg.from?.emailAddress?.name ?? null, to_addrs: addrs(msg.toRecipients), cc_addrs: addrs(msg.ccRecipients),
    subject: msg.subject ?? null, received_at: msg.receivedDateTime ?? null, body_excerpt: msg.bodyPreview ?? null,
    has_attachments: !!msg.hasAttachments, web_link: msg.webLink ?? null,
  };
  const byTag = await shipmentFromSubject(m.subject);
  // migration 035: the same email already made into an enquiry from another person's inbox (Salesman and Coordinator both get it)
  const sameEmail = !byTag && m.internet_message_id ? (await one(`select job_file_id from outlook_inbox where internet_message_id = $1 and job_file_id is not null limit 1`,
    [m.internet_message_id]))?.job_file_id ?? null : null;
  const fileId = byTag ?? sameEmail ?? await shipmentFromConversation(m.conversation_id);
  const known = !fileId && m.from_addr ? await knownSender(m.from_addr) : null;
  // an unknown sender: kept only for the AI to look at (new enquiry or not) — never automatic mail or our own colleagues
  let screen = false;
  if (!fileId && !known) {
    if (!m.from_addr || AUTOMATIC.test(m.from_addr) || !aiConfig().ready) return 'skipped';
    const { isOurs } = await import('./emailpeople');
    if (await isOurs(m.from_addr)) return 'skipped';
    screen = true;
  }
  return tx(async (c) => {
    const row = await one(`insert into outlook_inbox (user_id, ms_message_id, internet_message_id, conversation_id, from_addr, from_name, to_addrs, cc_addrs,
        subject, received_at, body_excerpt, has_attachments, web_link, known_as, status, job_file_id, matched_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      on conflict (user_id, ms_message_id) do nothing returning id`,
      [actor.id, m.ms_message_id, m.internet_message_id, m.conversation_id, m.from_addr, m.from_name, m.to_addrs, m.cc_addrs, m.subject, m.received_at,
        m.body_excerpt, m.has_attachments, m.web_link, known, fileId ? 'filed' : screen ? 'screen' : 'unmatched', fileId,
        fileId ? (byTag ? 'tag' : sameEmail ? 'same email' : 'conversation') : null], c);
    if (!row) return 'skipped' as const;
    if (fileId) await fileOnShipment(c, actor, fileId, m, byTag ? 'tag' : 'conversation');
    return fileId ? 'filed' as const : screen ? 'screen' as const : 'unmatched' as const;
  });
}

/**
 * "Check inbox": read what is new in this person's Outlook inbox since the last check and file it.
 * Only one check at a time per person: the start time is kept on the connection and clears itself after 2 minutes
 * (so a check stopped half-way never blocks the next). A second check at the same moment returns { busy: true }.
 * Each check stops after about 6 seconds (the hosting cuts requests at 10) and says "more" — the next check carries on.
 */
export async function syncInbox(actor: Actor, budgetMs = TIME_BUDGET_MS) {
  if (!(await canSend(actor.id))) throw new ApiError(409, 'NOT_CONNECTED', 'Connect your Outlook first (menu → My Outlook)');
  const got = await one(`update outlook_connections set sync_started_at = now()
      where user_id = $1 and (sync_started_at is null or sync_started_at < now() - interval '2 minutes') returning delta_link`, [actor.id]);
  if (!got) return { busy: true };
  const started = Date.now();
  try {
    const since = new Date(Date.now() - FIRST_LOOK_BACK_DAYS * 86400_000).toISOString().replace(/\.\d+Z$/, 'Z');
    let url: string | null = got.delta_link
      || `/me/mailFolders/inbox/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
    const n = { filed: 0, unmatched: 0, screen: 0, looked: 0 };
    let saveLink: string | null = got.delta_link ?? null, done = false;
    for (let page = 0; page < PAGES_PER_CHECK && url && (page === 0 || Date.now() - started < budgetMs); page++) {
      const r: any = await graph(actor.id, url, { headers: { Prefer: `odata.maxpagesize=${PAGE_SIZE}` } });
      for (const msg of r?.value ?? []) {
        n.looked++;
        const what = await takeOne(actor, msg);
        if (what !== 'skipped') n[what]++;
      }
      if (r?.['@odata.deltaLink']) { saveLink = r['@odata.deltaLink']; url = null; done = true; }
      else { url = r?.['@odata.nextLink'] ?? null; if (url) saveLink = url; }
    }
    const waiting = Number((await one(`select count(*) n from outlook_inbox where user_id = $1 and status = 'unmatched'`, [actor.id]))!.n);
    // migration 035: emails the AI has not looked at yet (new enquiry or not)
    const toScreen = aiConfig().ready ? Number((await one(`select count(*) n from outlook_inbox where user_id = $1 and ai_checked_at is null and status in ('screen', 'unmatched')`, [actor.id]))!.n) : 0;
    const result = { ...n, waiting, to_screen: toScreen, more: !done };
    await q(`update outlook_connections set delta_link = $2, last_sync_at = now(), last_sync_result = $3, last_error = null, updated_at = now() where user_id = $1`,
      [actor.id, saveLink, JSON.stringify(result)]);
    return result;
  } catch (e: any) {
    // Microsoft says the saved place in the inbox is too old: start again from the last 7 days next time
    if (e instanceof ApiError && e.code === 'MS_GRAPH' && /sync|delta/i.test(e.message))
      await q('update outlook_connections set delta_link = null where user_id = $1', [actor.id]).catch(() => {});
    throw e;
  } finally {
    await q('update outlook_connections set sync_started_at = null where user_id = $1', [actor.id]).catch(() => {});
  }
}

// ---------------------------------------------------------------- "Emails to file"
export async function listToFile(actor: Actor) {
  const rows = await q(`select id, from_addr, from_name, subject, received_at, body_excerpt, has_attachments, web_link, known_as, ai_kind, ai_summary, ai_checked_at
      from outlook_inbox where user_id = $1 and status = 'unmatched'
      order by (ai_kind = 'new_enquiry') desc nulls last, received_at desc nulls last limit 200`, [actor.id]);
  const c = await one('select last_sync_at, last_sync_result from outlook_connections where user_id = $1', [actor.id]);
  return { rows, last_sync_at: c?.last_sync_at ?? null, last_sync_result: c?.last_sync_result ?? null };
}

async function myWaiting(actor: Actor, id: string, c: Db) {
  if (!isUuid(id)) throw notFound('Email');
  const m = await one(`select * from outlook_inbox where id = $1 and user_id = $2 for update`, [id, actor.id], c);
  if (!m) throw notFound('Email');
  if (m.status !== 'unmatched') throw bad('This email is already handled');
  return m;
}

/** File a waiting email on a shipment by its reference (Enquiry Ref, Job No. or Shipping Ref). Later emails of the same conversation follow by themselves. */
export async function fileByHand(actor: Actor, id: string, b: any) {
  const ref = String(b?.ref ?? '').trim().toUpperCase();
  if (!ref) throw bad('Type the shipment reference (Enquiry Ref, Job No. or Shipping Ref)');
  return tx(async (c) => {
    const m = await myWaiting(actor, id, c);
    const f = await one(`select id from job_files where deleted_at is null and (upper(enquiry_ref) = $1 or upper(job_no) = $1 or upper(shipping_ref) = $1)
      order by created_at desc limit 1`, [ref], c);
    if (!f) throw bad(`No shipment found with the reference ${ref}`);
    await loadFile(actor, f.id, c).catch(() => { throw forbidden('You cannot open that shipment, so you cannot file emails on it'); });
    // this email and the others of the same conversation still waiting
    const same = await q(`select * from outlook_inbox where user_id = $1 and status = 'unmatched' and (id = $2 or (conversation_id is not null and conversation_id = $3))
      for update`, [actor.id, m.id, m.conversation_id], c);
    for (const x of same) {
      await fileOnShipment(c, actor, f.id, x, 'hand');
      await c.query(`update outlook_inbox set status = 'filed', job_file_id = $2, matched_by = 'hand', handled_by = $3, handled_at = now() where id = $1`, [x.id, f.id, actor.id]);
    }
    return { ok: true, job_file_id: f.id, filed: same.length };
  });
}

/** "Not for a shipment": hide it from the list (kept as a note so it is never brought back). */
export async function ignoreEmail(actor: Actor, id: string) {
  return tx(async (c) => {
    const m = await myWaiting(actor, id, c);
    await c.query(`update outlook_inbox set status = 'ignored', handled_by = $2, handled_at = now(), body_excerpt = null where id = $1`, [m.id, actor.id]);
    return { ok: true };
  });
}
