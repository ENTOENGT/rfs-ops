-- 032 — AI agent part A (Release Q). Safe to run twice; only new things, nothing deleted.
--
-- The AI reads a received email and suggests answers to the enquiry's missing details. A suggestion is only a suggestion:
-- nothing changes on the enquiry until a person ticks the answers and presses Apply (then it is normal history, by that person).

-- the full text of a received email, fetched from Outlook when the AI first reads it
alter table email_messages add column if not exists body_text text;

create table if not exists ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  email_id uuid not null references email_messages(id),
  kind text not null check (kind in ('enquiry', 'quote')),
  vendor_request_id uuid references vendor_requests(id),
  status text not null default 'open' check (status in ('open', 'applied', 'dismissed', 'nothing')),
  summary text,
  answers jsonb not null default '[]',          -- [{ key, label, value, quote }]
  unclear jsonb not null default '[]',          -- [{ key, label, note }]
  applied_keys jsonb,
  model text,
  read_by uuid references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_suggestions_email_uq on ai_suggestions (email_id, kind);
create index if not exists ai_suggestions_open_idx on ai_suggestions (job_file_id) where status = 'open';
alter table ai_suggestions enable row level security;

insert into schema_migrations (name) values ('032_ai_agent.sql') on conflict do nothing;
