/**
 * Migration 033 — the people on a shipment's customer emails (To / CC), filled in by themselves:
 *   1. the people already on this shipment's emails: seen on the customer's own emails, or typed in by our team;
 *   2. the customer's contacts: marked To / CC (empty: the main contact in To; the others offered, not ticked);
 *   3. our side in CC: the salesman, coordinator and Customer Service handler of the shipment, and the company CC addresses.
 * Anyone removed (×) from a shipment stays off its emails. The sender never copies themselves.
 */
import { Actor } from './auth';
import { bad, Db, forbidden, getSetting, one, q } from './db';

export type Person = { name: string; email: string; role?: string | null; picked: boolean; place?: 'to' | 'cc'; side?: 'customer' | 'ours'; removable?: boolean };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'msn.com']);
const real = (e: unknown): e is string => typeof e === 'string' && EMAIL.test(e) && !/\.local$|@(users|drivers)\.app$/i.test(e);
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Our own addresses: a user's email, or the same company domain as our users / the company email (not Gmail etc.). */
/**
 * Our own company domains: the domain of a connected Outlook mailbox, the company email in Settings, or a domain that two or
 * more of our users share. One user logging in with another company's address (e.g. shamsheer@entoen.ae) does not make that
 * whole company "us" — that person's own address still counts as ours (isOurs checks users' exact emails).
 */
export async function ourDomains(db?: Db) {
  const rows = await q(`select d from (
      select lower(split_part(email, '@', 2)) d from users where deleted_at is null and email like '%@%' group by 1 having count(*) >= 2
      union select lower(split_part(ms_email, '@', 2)) from outlook_connections where ms_email like '%@%') x`, [], db);
  const set = new Set(rows.map((r) => r.d as string).filter((d) => d && !PUBLIC.has(d) && !d.endsWith('.local') && !/^(users|drivers)\.app$/.test(d)));
  const co = String(await getSetting('company_email', '', db)).toLowerCase();
  if (co.includes('@') && !PUBLIC.has(co.split('@')[1])) set.add(co.split('@')[1]);
  return set;
}
export async function isOurs(email: string, domains?: Set<string>, db?: Db) {
  const e = email.toLowerCase();
  if (await one('select 1 from users where lower(email) = $1 and deleted_at is null', [e], db)) return true;
  return (domains ?? await ourDomains(db)).has(e.split('@')[1]);
}

/** The To / CC list for an email to the customer (fileId: the shipment, when there is one). */
export async function customerPeople(actor: Actor, customerId: string, fileId?: string | null, extra?: string | null): Promise<Person[]> {
  const me = String((await one('select email from users where id = $1', [actor.id]))?.email ?? '').toLowerCase();
  const out: Person[] = [];
  const removed = new Set<string>();
  const add = (p: Person) => {
    const e = p.email.trim().toLowerCase();
    if (!real(e) || e === me || removed.has(e) || out.some((x) => x.email.toLowerCase() === e)) return;
    out.push({ ...p, email: p.email.trim() });
  };
  if (fileId) {
    const rows = await q(`select email, name, side, place, removed from job_file_email_people where job_file_id = $1 order by created_at`, [fileId]);
    for (const r of rows) if (r.removed) removed.add(String(r.email).toLowerCase());
    if (extra && real(extra.trim())) add({ name: 'Contact on this case', email: extra.trim(), picked: true, place: 'to', side: 'customer' });
    for (const r of rows) if (!r.removed) add({ name: r.name || r.email, email: r.email, role: r.side === 'ours' ? 'Our team' : 'On their emails', picked: true, place: r.place, side: r.side, removable: true });
  } else if (extra && real(extra.trim())) add({ name: 'Contact on this case', email: extra.trim(), picked: true, place: 'to', side: 'customer' });
  // the customer's contacts and main email
  const c = await one('select name, email, contact_person from customers where id = $1', [customerId]);
  const contacts = await q(`select full_name, role, email, is_primary, email_as from customer_contacts where customer_id = $1 and deleted_at is null and email is not null
    order by is_primary desc, full_name`, [customerId]);
  for (const k of contacts) {
    const as = k.email_as ?? (k.is_primary ? 'to' : 'none');
    add({ name: k.full_name, email: k.email, role: k.role, picked: as !== 'none', place: as === 'cc' ? 'cc' : 'to', side: 'customer', removable: !!fileId });
  }
  if (c?.email) add({ name: c.contact_person || c.name, email: c.email, role: 'Main email', picked: false, place: 'to', side: 'customer', removable: !!fileId });
  if (!out.some((p) => p.picked && p.place === 'to')) { const first = out.find((p) => p.side === 'customer' && p.place === 'to'); if (first) first.picked = true; }
  // our side: the people handling the shipment, and the company CC addresses
  if (fileId) {
    const team = await q(`select u.full_name, u.email, x.r from job_files f
        cross join lateral (values (f.salesman_id, 'Salesman'), (f.coordinator_id, 'Coordinator'), (f.cs_handler_id, 'Customer Service')) x(id, r)
        join users u on u.id = x.id and u.is_active and u.deleted_at is null where f.id = $1`, [fileId]);
    for (const t of team) add({ name: t.full_name, email: t.email, role: t.r, picked: true, place: 'cc', side: 'ours', removable: true });
  }
  for (const e of String(await getSetting('customer_email_cc', '')).split(/[,;\s]+/).filter(Boolean))
    add({ name: e, email: e, role: 'Company copy', picked: true, place: 'cc', side: 'ours', removable: !!fileId });
  return out;
}

/** After an email goes out: addresses typed in by hand stay on this shipment's later emails. */
export async function rememberTyped(db: Db, actor: Actor, fileId: string, known: Person[], to: string[], cc: string[]) {
  const knownSet = new Set(known.map((p) => p.email.toLowerCase()));
  const domains = await ourDomains(db);
  for (const [list, place] of [[to, 'to'], [cc, 'cc']] as const) for (const raw of list) {
    const e = String(raw).trim().toLowerCase();
    if (!real(e) || knownSet.has(e)) continue;
    await db.query(`insert into job_file_email_people (job_file_id, email, name, side, place, source, added_by) values ($1, $2, $2, $3, $4, 'added', $5)
      on conflict (job_file_id, lower(email)) do update set removed = false, place = excluded.place, added_by = excluded.added_by
      where job_file_email_people.removed`, [fileId, e, (await isOurs(e, domains, db)) ? 'ours' : 'customer', place, actor.id]);
  }
}

/** A customer's email filed on a shipment: its sender (To) and the people they copied stay on the shipment's emails. */
export async function learnFromReceived(db: Db, fileId: string, m: { from_addr?: string | null; from_name?: string | null; to_addrs?: string | null; cc_addrs?: string | null }, mailbox?: string | null) {
  const from = String(m.from_addr ?? '').toLowerCase();
  if (!real(from)) return;
  if (await one(`select 1 from vendors where lower(email) = $1 and deleted_at is null`, [from], db)) return;   // an agent's email: not the customer's people
  const domains = await ourDomains(db);
  if (await isOurs(from, domains, db)) return;                                                                 // our own colleague wrote it
  const put = async (email: string, name: string | null, side: 'customer' | 'ours', place: 'to' | 'cc') =>
    db.query(`insert into job_file_email_people (job_file_id, email, name, side, place, source) values ($1, $2, $3, $4, $5, 'customer_email')
      on conflict (job_file_id, lower(email)) do nothing`, [fileId, email, name, side, place]);
  await put(from, m.from_name ?? null, 'customer', 'to');
  const others = [...String(m.to_addrs ?? '').split(/,\s*/), ...String(m.cc_addrs ?? '').split(/,\s*/)].map((x) => x.trim().toLowerCase()).filter(real);
  for (const e of [...new Set(others)]) {
    if (e === from || e === String(mailbox ?? '').toLowerCase()) continue;
    await put(e, null, (await isOurs(e, domains, db)) ? 'ours' : 'customer', 'cc');
  }
}

/** × on a person: off this shipment's emails for good (until someone types them in again). */
export async function removePerson(actor: Actor, fileId: string, b: any) {
  if (!isUuid(fileId)) throw bad('Choose the shipment');
  const { loadFile, canEdit } = await import('./jobfiles');
  const f = await loadFile(actor, fileId);
  if (!canEdit(actor, f)) throw forbidden('You cannot change this shipment');
  const e = String(b?.email ?? '').trim().toLowerCase();
  if (!real(e)) throw bad('Choose the email address');
  await q(`insert into job_file_email_people (job_file_id, email, name, side, place, source, removed, removed_by, added_by)
      values ($1, $2, $2, 'customer', 'cc', 'added', true, $3, $3)
    on conflict (job_file_id, lower(email)) do update set removed = true, removed_by = $3`, [fileId, e, actor.id]);
  return { ok: true };
}
