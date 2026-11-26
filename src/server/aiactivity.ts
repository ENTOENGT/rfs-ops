/**
 * 26 Nov (commit 3): what the AI is doing for me right now, and what it did lately — shown in the top bar on every page.
 * Mine = my Outlook emails, and shipments where I am the Salesman, Coordinator or the one who filed the email.
 */
import { Actor } from './auth';
import { q, one } from './db';
import { aiConfig } from './ai';

export async function aiActivity(actor: Actor) {
  if (!aiConfig()) return { working: 0, sorting: 0, drafting: 0, reading: 0, recent: [] };   // no AI key: nothing runs
  const mine = `(f.salesman_id = $1 or f.coordinator_id = $1 or e.created_by = $1)`;
  const w = await one(`select
      (select count(*)::int from outlook_inbox where user_id = $1 and ai_checked_at is null and status in ('screen', 'unmatched') and received_at > now() - interval '3 days') sorting,
      (select count(*)::int from outlook_inbox where user_id = $1 and status = 'unmatched' and ai_kind = 'new_enquiry' and ai_draft is null and ai_bg_tries < 2
         and received_at > now() - interval '3 days') drafting,
      (select count(*)::int from email_messages e join job_files f on f.id = e.job_file_id join vendor_requests r on r.id = e.vendor_request_id
        where ${mine} and e.direction = 'in' and e.created_at > now() - interval '3 days' and e.ai_bg_tries < 2 and r.status <> 'cancelled'
          and not exists (select 1 from ai_suggestions s where s.email_id = e.id)) reading`, [actor.id]);
  const recent = await q(`select * from (
      select s.created_at at, s.kind, coalesce(f.job_no, f.shipping_ref, f.enquiry_ref) ref, f.id file_id, s.summary, v.name vendor_name
        from ai_suggestions s join job_files f on f.id = s.job_file_id join email_messages e on e.id = s.email_id
        left join vendor_requests r on r.id = s.vendor_request_id left join vendors v on v.id = r.vendor_id
       where ${mine} and s.created_at > now() - interval '2 days'
      union all
      select a.answered_at, 'availability', coalesce(f.job_no, f.shipping_ref, f.enquiry_ref), f.id,
             case when a.status = 'confirmed' then 'Vendor confirmed availability' else 'Not available: ' || coalesce(a.reason, '') end, v.name
        from availability_checks a join job_files f on f.id = a.job_file_id left join vendor_requests r on r.id = a.vendor_request_id left join vendors v on v.id = r.vendor_id
       where a.answer_source = 'ai' and (f.salesman_id = $1 or f.coordinator_id = $1) and a.answered_at > now() - interval '2 days'
    ) x order by at desc limit 8`, [actor.id]);
  return { working: w.sorting + w.drafting + w.reading, sorting: w.sorting, drafting: w.drafting, reading: w.reading, recent };
}
