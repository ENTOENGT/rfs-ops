-- 027 — Live status and team chat (Release L). Safe to run twice; only new columns and tables.

-- ================================================================ Step 10: live status
-- Online / Away / Offline come from activity; Busy and On leave are set by the person (or their manager for leave).
alter table users add column if not exists last_seen_at timestamptz;      -- the app is open (a ping every minute)
alter table users add column if not exists last_active_at timestamptz;    -- the person did something (typed, clicked) recently
alter table users add column if not exists presence text not null default 'available';
alter table users add column if not exists presence_note text;
alter table users add column if not exists leave_until date;
do $$ begin
  alter table users add constraint users_presence_check check (presence in ('available', 'busy', 'leave'));
exception when duplicate_object then null; end $$;

-- ================================================================ Step 11: team chat on each shipment
-- Internal only, never shown to customers or agents. Messages are kept: no delete; a message can be corrected for 5 minutes,
-- and every correction keeps the old words.
create table if not exists job_chat_messages (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  user_id uuid not null references users(id),
  user_name text not null,
  body text not null check (length(body) between 1 and 4000),
  mentions uuid[] not null default '{}',
  document_id uuid references jf_documents(id),           -- an attached file, saved with the job's documents
  has_price boolean not null default false,               -- looks like it carries a price: hidden from people who may not see prices
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists job_chat_file_idx on job_chat_messages (job_file_id, created_at);
create table if not exists job_chat_edits (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references job_chat_messages(id),
  old_body text not null,
  edited_at timestamptz not null default now()
);
create table if not exists job_chat_reads (
  job_file_id uuid not null references job_files(id),
  user_id uuid not null references users(id),
  read_at timestamptz not null default now(),
  primary key (job_file_id, user_id)
);
alter table job_chat_messages enable row level security;
alter table job_chat_edits enable row level security;
alter table job_chat_reads enable row level security;
-- the old words of a corrected message can never be changed or removed
do $$ begin
  drop trigger if exists job_chat_edits_append_only on job_chat_edits;
  create trigger job_chat_edits_append_only before update or delete on job_chat_edits for each row execute function history_is_append_only();
end $$;

insert into schema_migrations (name) values ('027_status_chat.sql') on conflict do nothing;
