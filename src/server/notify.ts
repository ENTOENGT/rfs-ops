/**
 * Group notifications (Part G1). Every important event on a shipment tells its handling group inside RFS Ops:
 * the Salesman, the Coordinator, any Agent Coordinator working on one of its rate requests, and the Commercials
 * Managers of that division. The person who did the action is not told about it. The same event never reaches the
 * same person twice (same shipment, same event, same rate request / quotation, within two minutes).
 * The notifications table is the log: recipient, event, shipment, time sent, time read. Rows are never deleted.
 */
import { Actor } from './auth';
import { Db, q, one } from './db';

/** code, name — the events people can be told about (also the list on the Notifications page). */
export const EVENTS: [string, string][] = [
  ['new_enquiry', 'New enquiry created'], ['assigned', 'Enquiry assigned or reassigned'],
  ['rate_requested', 'Rate requested'], ['rate_received', 'Rate received'], ['rate_updated', 'Rate updated'],
  ['quotation_prepared', 'Quotation prepared'], ['quotation_submitted', 'Quotation submitted for approval'],
  ['quotation_approved', 'Quotation approved'], ['quotation_rejected', 'Quotation rejected'], ['quotation_returned', 'Quotation returned for revision'],
  ['quotation_sent', 'Quotation sent to customer'], ['customer_response', 'Customer response received'],
  ['customer_confirmed', 'Customer confirmed'], ['customer_declined', 'Customer declined / enquiry lost'],
  ['booking_requested', 'Booking requested'], ['booking_confirmed', 'Booking confirmed'],
  ['vessel_changed', 'Vessel details received or changed'], ['prealert_received', 'Pre-alert received'], ['prealert_verified', 'Pre-alert verified'],
  ['bl_draft_received', 'BL draft received'], ['bl_draft_sent', 'BL draft sent to customer'], ['bl_correction', 'Customer asks for BL correction'],
  ['bl_revised', 'Revised BL draft received or sent'], ['bl_confirmed', 'BL draft confirmed by customer'],
  ['handed_over', 'Operational job created and handed over'], ['email_saved', 'Email saved on the shipment'],
];
export const eventName = (c: string | null | undefined) => EVENTS.find(([k]) => k === c)?.[1] ?? c ?? '';

/** Stage changes that are events of their own (rate stages are told by the rate request itself, with its vendor). */
export const STAGE_EVENTS: Record<string, string> = {
  quotation_draft: 'quotation_prepared', pending_approval: 'quotation_submitted', sent_to_customer: 'quotation_sent',
  customer_confirmed: 'customer_confirmed', booking_requested: 'booking_requested', booking_confirmed: 'booking_confirmed',
  prealert_received: 'prealert_received', prealert_verified: 'prealert_verified', handed_over: 'handed_over', lost: 'customer_declined',
};

/** The people handling this shipment right now (user ids, active users only). */
export async function handlingGroup(db: Db, fileId: string): Promise<string[]> {
  const f = await one('select salesman_id, coordinator_id, division from job_files where id = $1', [fileId], db);
  if (!f) return [];
  const rows = await q(`select u.id from users u where u.is_active and u.deleted_at is null and (
      u.id = $2 or u.id = $3
      or u.id in (select r.assigned_to from vendor_requests r where r.job_file_id = $1 and r.assigned_to is not null and r.status in ('requested','quoted','confirmed','in_progress'))
      or (user_has_perm(u.id, 'commercial.manage') and ($4::text is null or u.division is null or u.division = $4)))`,
    [fileId, f.salesman_id, f.coordinator_id, f.division], db);
  return rows.map((r) => r.id as string);
}

/**
 * Tell the handling group (plus `also`) about an event. Titles never carry prices. Safe inside any transaction.
 */
export async function notifyGroup(db: Db, actor: Actor | null, fileId: string, event: string, detail?: string | null,
  o: { quotationId?: string | null; vendorRequestId?: string | null; also?: (string | null | undefined)[] } = {}) {
  const f = await one(`select f.enquiry_ref, f.job_no, f.shipping_ref, c.name customer_name from job_files f left join customers c on c.id = f.customer_id where f.id = $1`, [fileId], db);
  if (!f) return 0;
  const ref = f.job_no ?? f.shipping_ref ?? f.enquiry_ref ?? 'Shipment';
  const title = `${ref}${f.customer_name ? ` · ${f.customer_name}` : ''}: ${eventName(event)}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`;
  const ids = [...new Set([...(await handlingGroup(db, fileId)), ...(o.also ?? []).filter((x): x is string => !!x)])].filter((u) => u !== actor?.id);
  let sent = 0;
  for (const u of ids) {
    const r = await db.query(`insert into notifications (user_id, type, event, title, job_file_id, quotation_id, vendor_request_id, actor_name)
      select $1, 'group', $2, $3, $4, $5, $6, $7
      where not exists (select 1 from notifications n where n.user_id = $1 and n.job_file_id = $4 and n.event = $2
        and n.quotation_id is not distinct from $5 and n.vendor_request_id is not distinct from $6 and n.created_at > now() - interval '2 minutes')`,
      [u, event, title, fileId, o.quotationId ?? null, o.vendorRequestId ?? null, actor?.full_name ?? 'System']);
    sent += r.rowCount ?? 0;
  }
  return sent;
}

// ------------------------------------------------------------ the Notifications page
export async function notificationsPage(actor: Actor, p: Record<string, string>) {
  const params: unknown[] = [actor.id];
  let w = 'n.user_id = $1';
  if (p.unread === '1') w += ' and n.read_at is null';
  if (p.event && EVENTS.some(([k]) => k === p.event)) { params.push(p.event); w += ` and n.event = $${params.length}`; }
  const page = Math.max(1, Number(p.page) || 1);
  const rows = await q(`select n.id, n.type, n.event, n.title, n.actor_name, n.job_id, n.run_id, n.pro_id, n.job_file_id, n.quotation_id, n.case_id, n.vendor_request_id,
      n.read_at, n.created_at from notifications n where ${w} order by n.created_at desc limit 101 offset ${(page - 1) * 100}`, params);
  const c = await one(`select count(*) filter (where read_at is null)::int unread, count(*)::int total from notifications where user_id = $1`, [actor.id]);
  const prefs = await q('select event, email from notification_prefs where user_id = $1', [actor.id]);
  return { rows: rows.slice(0, 100).map((r) => ({ ...r, event_name: r.event ? eventName(r.event) : null })), more: rows.length > 100, page,
    unread: c.unread, total: c.total, events: EVENTS, email_prefs: Object.fromEntries(prefs.map((x) => [x.event, x.email])) };
}

export async function saveNotificationPref(actor: Actor, b: any) {
  const ev = String(b.event ?? '');
  if (!EVENTS.some(([k]) => k === ev)) throw new (await import('./db')).ApiError(400, 'VALIDATION', 'Unknown event');
  await q(`insert into notification_prefs (user_id, event, email) values ($1,$2,$3)
    on conflict (user_id, event) do update set email = excluded.email, updated_at = now()`, [actor.id, ev, !!b.email]);
  return { ok: true };
}
