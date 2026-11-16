/**
 * Release L step 11 (migration 027) — team chat on each shipment. Internal only.
 *  - Who: anyone who can open the job (its handlers, their managers, and teams that follow every job).
 *  - @mentions alert a person through the bell — only people who can open the job can be mentioned.
 *  - Messages are kept: no delete; the writer can correct a message for 5 minutes and the old words are kept.
 *  - A message that looks like it carries a price is hidden from people who may not see prices (e.g. Transport, Messengers).
 */
import { Actor, loadActor } from './auth';
import { ApiError, forbidden, notFound, one, pool, q, tx } from './db';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const bad = (m: string) => new ApiError(400, 'VALIDATION', m);
const CUR = '(AED|USD|EUR|INR|CNY|RMB|DHS?|\\$|€|₹|¥)';
const PRICE = new RegExp(`${CUR}\\s?\\d|\\d[\\d,.]*\\s?${CUR}|\\b(rate|price|selling|buying|cost|margin|profit|freight charges?)\\b[^\\n]{0,20}\\d`, 'i');
export const looksLikePrice = (s: string) => PRICE.test(s);
const EDIT_MINUTES = 5;
const mayPrices = (a: Actor) => a.isSuperAdmin || a.fin.sellingView;   // a price in chat may be a selling price

/** Can this person open the job? (The same rule as opening the shipment itself.) */
async function canOpen(a: Actor, fileId: string) {
  const { canSeeJobFiles, jfScope } = await import('./jobfiles');
  if (!canSeeJobFiles(a)) return false;
  const params: unknown[] = [fileId];
  return !!(await one(`select 1 from job_files f where f.id = $1 and f.deleted_at is null${jfScope(a, params)}`, params));
}

async function fileOf(actor: Actor, fileId: string) {
  if (!isUuid(fileId)) throw notFound('Job File');
  const { loadFile } = await import('./jobfiles');
  return loadFile(actor, fileId);
}

const shape = (actor: Actor, m: any) => {
  const hidden = m.has_price && !mayPrices(actor);
  return { id: m.id, user_id: m.user_id, user_name: m.user_name, mine: m.user_id === actor.id, created_at: m.created_at, edited_at: m.edited_at,
    body: hidden ? null : m.body, hidden, document: hidden || !m.document_id ? null : { id: m.document_id, file_name: m.file_name },
    can_edit: m.user_id === actor.id && Date.now() - new Date(m.created_at).getTime() < EDIT_MINUTES * 60_000, seen_by: m.seen_by ?? [] };
};

/** The chat of a job (all of it, or what came after `after`), the people in it, and "read up to now" for the viewer. */
export async function chatList(actor: Actor, fileId: string, p: Record<string, string> = {}) {
  const f: any = await fileOf(actor, fileId);
  const after = p.after && !Number.isNaN(Date.parse(p.after)) ? p.after : null;
  const msgs = await q(`select m.*, d.file_name,
      (select coalesce(array_agg(u.full_name order by u.full_name), '{}') from job_chat_reads r join users u on u.id = r.user_id
        where r.job_file_id = m.job_file_id and r.user_id <> m.user_id and r.read_at >= m.created_at) seen_by
    from job_chat_messages m left join jf_documents d on d.id = m.document_id
    where m.job_file_id = $1 ${after ? 'and (m.created_at > $2 or m.edited_at > $2)' : ''} order by m.created_at limit 500`, after ? [fileId, after] : [fileId]);
  await q(`insert into job_chat_reads (job_file_id, user_id, read_at) values ($1, $2, now())
    on conflict (job_file_id, user_id) do update set read_at = now()`, [fileId, actor.id]);
  const { presenceCols } = await import('./presence');
  const { handlingGroup } = await import('./notify');
  const ids = [...new Set([...(await handlingGroup(pool(), fileId)), f.cs_handler_id, f.ops_handler_id, f.docs_handler_id, actor.id].filter(Boolean))];
  const people = await q(`select u.id, u.full_name, r.name role_name, ${presenceCols('u')} from users u join roles r on r.id = u.role_id
    where u.id = any($1) and u.is_active order by u.full_name`, [ids]);
  const reads = await q(`select u.full_name name, r.read_at from job_chat_reads r join users u on u.id = r.user_id where r.job_file_id = $1 and r.user_id <> $2`, [fileId, actor.id]);
  return { messages: msgs.map((m) => shape(actor, m)), people, reads, now: new Date().toISOString(), may_prices: mayPrices(actor) };
}

/** People the writer may @mention: anyone active who can open this job. */
export async function mentionable(actor: Actor, fileId: string, search: string) {
  await fileOf(actor, fileId);
  const s = String(search ?? '').trim().toLowerCase();
  const rows = await q(`select u.id, u.full_name from users u join roles r on r.id = u.role_id
    where u.is_active and u.deleted_at is null and not r.app_only ${s ? 'and lower(u.full_name) like $1' : ''} order by u.full_name limit 30`, s ? [`%${s}%`] : []);
  const out = [];
  for (const r of rows) { const a = await loadActor(r.id); if (a && await canOpen(a, fileId)) out.push(r); if (out.length >= 10) break; }
  return out;
}

export async function chatPost(actor: Actor, fileId: string, b: any) {
  const f: any = await fileOf(actor, fileId);
  const body = String(b.body ?? '').trim();
  if (!body && !b.document_id) throw bad('Type a message');
  if (body.length > 4000) throw bad('A message can be up to 4,000 characters');
  const mentions = [...new Set((Array.isArray(b.mentions) ? b.mentions : []).filter(isUuid))].filter((x) => x !== actor.id).slice(0, 20) as string[];
  for (const m of mentions) {
    const a = await loadActor(m);
    if (!a || !(await canOpen(a, fileId))) {
      const n = (await one('select full_name from users where id = $1', [m]))?.full_name ?? 'This person';
      throw bad(`${n} cannot open this job, so they cannot be mentioned`);
    }
  }
  let doc: string | null = null;
  if (b.document_id) {
    if (!isUuid(b.document_id) || !(await one('select 1 from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null', [b.document_id, fileId])))
      throw bad('The attached file was not found on this job');
    doc = b.document_id;
  }
  const text = body || 'Attached a file';
  const m = await tx(async (c) => {
    const row = await one(`insert into job_chat_messages (job_file_id, user_id, user_name, body, mentions, document_id, has_price)
      values ($1,$2,$3,$4,$5,$6,$7) returning *`, [fileId, actor.id, actor.full_name, text, mentions, doc, looksLikePrice(text)], c);
    await c.query(`insert into job_chat_reads (job_file_id, user_id, read_at) values ($1, $2, now())
      on conflict (job_file_id, user_id) do update set read_at = now()`, [fileId, actor.id]);
    const { notifyGroup } = await import('./notify');
    await notifyGroup(c, actor, fileId, 'chat', `from ${actor.full_name}`, { also: [f.cs_handler_id, f.ops_handler_id, f.docs_handler_id] });
    const ref = f.job_no ?? f.enquiry_ref ?? 'Shipment';
    for (const u of mentions)
      await c.query(`insert into notifications (user_id, type, event, title, job_file_id, actor_name) values ($1, 'direct', 'chat_mention', $2, $3, $4)`,
        [u, `${ref}: ${actor.full_name} mentioned you in the team chat`, fileId, actor.full_name]);
    return row;
  });
  return shape(actor, { ...m, file_name: null, seen_by: [] });
}

/** The writer corrects a message within 5 minutes; the old words are kept. */
export async function chatEdit(actor: Actor, fileId: string, msgId: string, b: any) {
  await fileOf(actor, fileId);
  if (!isUuid(msgId)) throw notFound('Message');
  const body = String(b.body ?? '').trim();
  if (!body) throw bad('Type a message');
  if (body.length > 4000) throw bad('A message can be up to 4,000 characters');
  return tx(async (c) => {
    const m = await one('select * from job_chat_messages where id = $1 and job_file_id = $2 for update', [msgId, fileId], c);
    if (!m) throw notFound('Message');
    if (m.user_id !== actor.id) throw forbidden('Only the writer can correct a message');
    if (Date.now() - new Date(m.created_at).getTime() > EDIT_MINUTES * 60_000) throw new ApiError(409, 'TOO_LATE', `A message can only be corrected within ${EDIT_MINUTES} minutes`);
    if (m.body === body) return shape(actor, m);
    await c.query('insert into job_chat_edits (message_id, old_body) values ($1, $2)', [msgId, m.body]);
    const r = await one('update job_chat_messages set body = $2, edited_at = now(), has_price = $3 where id = $1 returning *', [msgId, body, looksLikePrice(body)], c);
    return shape(actor, { ...r, seen_by: [] });
  });
}

/** "My chats": jobs I can open that have messages, newest first, with my unread count. */
export async function chatInbox(actor: Actor) {
  const { canSeeJobFiles, jfScope } = await import('./jobfiles');
  if (!canSeeJobFiles(actor)) return { rows: [], unread: 0 };
  const params: unknown[] = [actor.id];
  const rows = await q(`select f.id, f.job_no, f.enquiry_ref, c.name customer_name, lm.user_name last_by, lm.body last_body, lm.has_price last_price, lm.created_at last_at,
      (select count(*)::int from job_chat_messages x where x.job_file_id = f.id and x.user_id <> $1
         and x.created_at > coalesce((select r.read_at from job_chat_reads r where r.job_file_id = f.id and r.user_id = $1), '-infinity')) unread
    from job_files f join customers c on c.id = f.customer_id
      join lateral (select m.user_name, m.body, m.has_price, m.created_at from job_chat_messages m where m.job_file_id = f.id order by m.created_at desc limit 1) lm on true
    where f.deleted_at is null${jfScope(actor, params)} order by lm.created_at desc limit 50`, params);
  const may = mayPrices(actor);
  return { rows: rows.map((r) => ({ ...r, last_body: r.last_price && !may ? 'A message with prices — hidden for you' : String(r.last_body).slice(0, 120) })),
    unread: rows.reduce((s, r) => s + r.unread, 0) };
}
