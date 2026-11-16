/**
 * Release L step 10 (migration 027) — live status.
 *   online   the app is open and the person did something in the last 10 minutes
 *   away     the app is open, nothing done for 10 minutes
 *   busy     set by the person ("In a meeting", "On a call")
 *   leave    set by the person or their manager, with an optional return date
 *   offline  the app has not been open for 3 minutes ("last seen …")
 */
import { Actor } from './auth';
import { ApiError, forbidden, notFound, one, q } from './db';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const bad = (m: string) => new ApiError(400, 'VALIDATION', m);

/** SQL for one person's status, given the users alias (`u`). Leave ends by itself after its return date. */
export const presenceSql = (u = 'u') => `case
    when ${u}.presence = 'leave' and (${u}.leave_until is null or ${u}.leave_until >= (now() at time zone 'Asia/Dubai')::date) then 'leave'
    when ${u}.last_seen_at is null or ${u}.last_seen_at < now() - interval '3 minutes' then 'offline'
    when ${u}.presence = 'busy' then 'busy'
    when ${u}.last_active_at is null or ${u}.last_active_at < now() - interval '10 minutes' then 'away'
    else 'online' end`;
/** The columns a screen needs to draw a status dot and its tooltip. */
export const presenceCols = (u = 'u', prefix = '') =>
  `${presenceSql(u)} ${prefix}status, ${u}.presence_note ${prefix}status_note, ${u}.leave_until ${prefix}leave_until, ${u}.last_seen_at ${prefix}last_seen_at`;

/** The app pings every minute while it is open; `active` = the person did something since the last ping. */
export async function ping(actor: Actor, b: any) {
  await q(`update users set last_seen_at = now(), last_active_at = case when $2 then now() else last_active_at end where id = $1`, [actor.id, !!b?.active]);
  return me(actor);
}

export async function me(actor: Actor) {
  return one(`select ${presenceCols('u')}, u.presence from users u where u.id = $1`, [actor.id]);
}

/** Set Available / Busy / On leave — for yourself, or leave for someone in your team (a manager). */
export async function setPresence(actor: Actor, b: any) {
  const id = b.user_id || actor.id;
  if (!isUuid(id)) throw notFound('Person');
  const p = String(b.presence ?? '');
  if (!['available', 'busy', 'leave'].includes(p)) throw bad('Choose Available, Busy or On leave');
  if (id !== actor.id) {
    if (p !== 'leave' && p !== 'available') throw forbidden('You can only set leave for someone else');
    const t = await one('select department_id from users where id = $1 and deleted_at is null', [id]);
    if (!t) throw notFound('Person');
    const ok = actor.isSuperAdmin || actor.has('users.manage') || (actor.has('users.manage_department') && actor.department_id === t.department_id)
      || !!(await one('select 1 from user_team($1) x where x = $2', [actor.id, id]));
    if (!ok) throw forbidden('Only their manager can set leave for someone');
  }
  const note = String(b.note ?? '').trim().slice(0, 80) || null;
  let until: string | null = null;
  if (p === 'leave' && b.leave_until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.leave_until))) throw bad('Choose the return date');
    until = String(b.leave_until);
  }
  await q('update users set presence = $2, presence_note = $3, leave_until = $4 where id = $1', [id, p, p === 'available' ? null : note, until]);
  return one(`select ${presenceCols('u')} from users u where u.id = $1`, [id]);
}
