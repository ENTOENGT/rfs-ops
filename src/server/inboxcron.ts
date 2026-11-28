/**
 * 24 Nov — the Outlook inboxes are also checked in the background, every 2 minutes
 * (netlify/functions/inbox-check.mjs → POST /api/cron/inbox-check), so a new enquiry comes in even when nobody has
 * RFS CRM open. The same check as the one the app does every minute while open (syncInbox, then the AI's quick look),
 * for every connected pilot user, the longest-waiting first. Someone checked in the last 90 seconds (their app is open)
 * is skipped. Each call stops after about 7 seconds (the hosting cuts requests at 10) and says "more"; the scheduled
 * function calls again.
 */
import { loadActor } from './auth';
import { q } from './db';
import { syncInbox } from './inbox';
import { screenInbox } from './newenquiry';

export async function runInboxChecks(budgetMs = 7000) {
  const started = Date.now();
  const due = await q(`select c.user_id from outlook_connections c join users u on u.id = c.user_id
      where u.outlook_pilot and u.is_active and u.deleted_at is null and c.last_error is null
        and (c.last_sync_at is null or c.last_sync_at < now() - interval '90 seconds')
        and (c.sync_started_at is null or c.sync_started_at < now() - interval '2 minutes')
      order by c.last_sync_at nulls first limit 50`);
  const done: { user: string; filed?: number; screened?: number; error?: string }[] = [];
  for (const { user_id } of due) {
    const left = budgetMs - (Date.now() - started);
    if (left < 2500) break;
    const actor = await loadActor(user_id);
    if (!actor) continue;
    try {
      const r: any = await syncInbox(actor, Math.min(4000, left - 2000));
      let screened = 0;
      if (!r.busy && r.to_screen > 0 && budgetMs - (Date.now() - started) > 2500) screened = (await screenInbox(actor, 6)).screened ?? 0;
      done.push({ user: user_id, filed: r.filed ?? 0, screened });
    } catch (e: any) {
      done.push({ user: user_id, error: String(e?.message ?? e).slice(0, 200) });   // kept on My Outlook by syncInbox; carry on with the next person
    }
  }
  return { checked: done.length, due: due.length, more: done.length < due.length, done };
}

/**
 * 26 Nov — the AI reads in the background (same 2-minute schedule, its own call): replies to our rate and booking requests
 * (read once, kept as suggestions, so the box on the enquiry is ready when opened) and the emails sorted as new enquiries
 * (the enquiry form is filled in advance, so "Create enquiry" opens at once). A few at the same time; each tried at most
 * twice here — if it still fails, it is read when someone opens it, as before. Nothing is saved on the shipment: a person
 * still checks and presses Save.
 */
export async function runBackgroundReads(n = 3) {
  const mails = await q(`select e.id, e.job_file_id, coalesce(e.created_by, f.coordinator_id) uid, r.service from email_messages e
      join vendor_requests r on r.id = e.vendor_request_id join job_files f on f.id = e.job_file_id
      where e.direction = 'in' and e.created_at > now() - interval '3 days' and e.ai_bg_tries < 2 and r.status <> 'cancelled'
        and ((r.service = 'rate' and r.status in ('requested', 'quoted')) or (r.service = 'booking' and f.booking_vendor_request_id = r.id))
        and not exists (select 1 from ai_suggestions s where s.email_id = e.id and s.kind in ('quote', 'booking'))
        and not exists (select 1 from availability_checks a where a.vendor_request_id = r.id and a.status = 'sent')   -- read as an availability answer
      order by e.created_at desc limit $1`, [n]);
  const drafts = await q(`select id, user_id from outlook_inbox where status = 'unmatched' and ai_kind = 'new_enquiry' and ai_draft is null and ai_bg_tries < 2
      and received_at > now() - interval '3 days' order by received_at desc limit $1`, [Math.max(0, n - mails.length)]);
  // 26 Nov (Point 13): vendor replies to the availability email
  const { availabilityReplies, readAvailability } = await import('./availability');
  const avail = await availabilityReplies(Math.max(1, n - mails.length));
  // 27 Nov: the customer's answer to a BL draft
  const { blReplies, readBlReply } = await import('./blai');
  const bls = await blReplies(2);
  if (bls.length) await q('update email_messages set ai_bg_tries = ai_bg_tries + 1 where id = any($1)', [bls.map((m: any) => m.id)]);
  // 27 Nov: the best-vendor comparison is made here as soon as a rate is saved, so it is ready when the person opens the enquiry
  const recs = await q(`select f.id, f.coordinator_id uid from job_files f where f.stage in ('enquiry', 'rates_requested', 'rates_received') and f.coordinator_id is not null
      and exists (select 1 from vendor_requests r where r.job_file_id = f.id and r.service = 'rate' and r.quoted_cost is not null and r.updated_at > now() - interval '30 minutes'   -- shortcut: retried for 30 min if the AI fails, then left to the person's Compare button
       
        and r.updated_at > coalesce((select max(v.created_at) from vendor_recommendations v where v.job_file_id = f.id), 'epoch'::timestamptz))
    order by f.updated_at desc limit 1`);
  if (avail.length) await q('update email_messages set ai_bg_tries = ai_bg_tries + 1 where id = any($1)', [avail.map((m: any) => m.id)]);
  if (mails.length) await q('update email_messages set ai_bg_tries = ai_bg_tries + 1 where id = any($1)', [mails.map((m: any) => m.id)]);
  if (drafts.length) await q('update outlook_inbox set ai_bg_tries = ai_bg_tries + 1 where id = any($1)', [drafts.map((m: any) => m.id)]);
  const { readQuote } = await import('./quotereader');
  const { readBooking } = await import('./bookingreader');
  const { draftEnquiry } = await import('./newenquiry');
  const jobs: (() => Promise<string>)[] = [
    ...mails.map((m: any) => async () => {
      const actor = m.uid ? await loadActor(m.uid) : null;
      if (!actor) return 'skipped';
      if (m.service === 'rate') await readQuote(actor, m.id); else await readBooking(actor, m.job_file_id, m.id);
      return m.service;
    }),
    ...avail.map((m: any) => async () => { const actor = m.uid ? await loadActor(m.uid) : null; if (!actor) return 'skipped'; await readAvailability(actor, m.id); return 'availability'; }),
    ...bls.map((m: any) => async () => { const actor = m.uid ? await loadActor(m.uid) : null; if (!actor) return 'skipped'; await readBlReply(actor, m.id); return 'bl_reply'; }),
    ...recs.map((m: any) => async () => { const actor = await loadActor(m.uid); if (!actor?.fin.buyingView) return 'skipped'; await (await import('./recommend')).runRecommend(actor, m.id); return 'compare'; }),
    ...drafts.map((m: any) => async () => { const actor = await loadActor(m.user_id); if (!actor) return 'skipped'; await draftEnquiry(actor, m.id); return 'enquiry'; }),
  ];
  const res = await Promise.all(jobs.map((j) => j().catch((e: any) => `failed: ${String(e?.message ?? e).slice(0, 80)}`)));
  return { read: res.filter((r) => !r.startsWith('failed') && r !== 'skipped').length, results: res };
}
