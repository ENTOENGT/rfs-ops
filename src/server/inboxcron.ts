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
      if (!r.busy && r.to_screen > 0 && budgetMs - (Date.now() - started) > 2500) screened = (await screenInbox(actor, 4)).screened ?? 0;
      done.push({ user: user_id, filed: r.filed ?? 0, screened });
    } catch (e: any) {
      done.push({ user: user_id, error: String(e?.message ?? e).slice(0, 200) });   // kept on My Outlook by syncInbox; carry on with the next person
    }
  }
  return { checked: done.length, due: due.length, more: done.length < due.length, done };
}
