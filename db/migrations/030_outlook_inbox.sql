-- 030 — Outlook step 3: reading the pilot users' inbox (Release O). Safe to run twice; only new things, nothing deleted.
--
-- Every inbox email RFS CRM looks at is noted once per person (so it is never filed twice):
--   filed     — matched to a shipment (its [ENQ-…] / Job No. / Shipping Ref tag, or the same conversation) and copied
--               to that shipment's Emails tab
--   unmatched — from a known customer or agent, but no shipment found: waits on "Emails to file"
--   ignored   — someone pressed "Not for a shipment"
-- Emails from unknown senders (newsletters, personal mail) are not saved at all.
create table if not exists outlook_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  ms_message_id text not null,
  internet_message_id text,
  conversation_id text,
  from_addr text, from_name text, to_addrs text, cc_addrs text,
  subject text,
  received_at timestamptz,
  body_excerpt text,
  has_attachments boolean not null default false,
  web_link text,
  known_as text,                                          -- "Customer: Desert Retail" / "Agent: MSC"
  status text not null check (status in ('filed', 'unmatched', 'ignored')),
  job_file_id uuid references job_files(id),
  matched_by text,                                        -- tag / conversation / hand
  handled_by uuid references users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists outlook_inbox_uq on outlook_inbox (user_id, ms_message_id);
create index if not exists outlook_inbox_waiting_idx on outlook_inbox (user_id, received_at desc) where status = 'unmatched';
create index if not exists outlook_inbox_conv_idx on outlook_inbox (conversation_id) where job_file_id is not null;
alter table outlook_inbox enable row level security;

-- the shipment's Emails tab: a link to open the email in Outlook on the web
alter table email_messages add column if not exists web_link text;
create index if not exists em_conv_idx on email_messages (conversation_id) where conversation_id is not null;

-- how far the inbox was read: last check and how many emails were filed / waiting
alter table outlook_connections add column if not exists last_sync_result jsonb;

insert into schema_migrations (name) values ('030_outlook_inbox.sql') on conflict do nothing;
