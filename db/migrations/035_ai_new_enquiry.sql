-- 035 — AI agent: new enquiries found in the Salesman's / Coordinator's inbox (Release R). Safe to run twice; nothing deleted.
--
-- An inbox email that matches no shipment is now looked at by the AI (subject, sender and the first lines only):
--   from a known customer or an unknown sender, it is either a NEW ENQUIRY (shown first on "Emails to file" with
--   "Create enquiry") or not. An unknown sender's email that is not an enquiry is not kept: its subject and text are wiped.
-- "Create enquiry" lets the AI fill a new enquiry (and a new customer when the sender is not one yet) from the whole email;
-- a person checks it and presses Save. The same email in the Salesman's and the Coordinator's inbox becomes ONE enquiry.

alter table outlook_inbox drop constraint if exists outlook_inbox_status_check;
alter table outlook_inbox add constraint outlook_inbox_status_check check (status in ('filed', 'unmatched', 'ignored', 'screen'));
--   screen = from an unknown sender, waiting for the AI to say whether it is an enquiry (not shown until then)

alter table outlook_inbox add column if not exists ai_kind text;               -- new_enquiry / reply / other
alter table outlook_inbox add column if not exists ai_summary text;
alter table outlook_inbox add column if not exists ai_checked_at timestamptz;
alter table outlook_inbox add column if not exists ai_draft jsonb;             -- what the AI filled in for "Create enquiry" (kept, so it is read once)
create index if not exists outlook_inbox_imid_idx on outlook_inbox (internet_message_id) where internet_message_id is not null;
create index if not exists outlook_inbox_screen_idx on outlook_inbox (user_id) where ai_checked_at is null and status in ('screen', 'unmatched');

insert into schema_migrations (name) values ('035_ai_new_enquiry.sql') on conflict do nothing;
