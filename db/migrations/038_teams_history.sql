-- 038 — AI batch 2. Safe to run twice; only new tables and one new column.
--
-- 1. Vendor teams: one vendor, several departments (Sea FCL team, Air import team, Cross trade team…), each with its own email.
--    A rate request picks the team for its mode and direction (or the one chosen by hand) and the email goes to that team.
--    A team is switched off, never deleted, so old requests keep showing it.
create table if not exists vendor_teams (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id),
  name text not null,
  modes text[] not null default '{}',          -- sea_fcl, sea_lcl, air, road, courier (none = all)
  directions text[] not null default '{}',     -- import, export, cross_trade (none = all)
  contact_person text,
  email text,
  cc_emails text,                              -- more addresses for this team, comma separated
  phone text,
  note text,
  is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vendor_teams_vendor_idx on vendor_teams (vendor_id);
alter table vendor_teams enable row level security;
alter table vendor_requests add column if not exists team_id uuid references vendor_teams(id);

-- 2. Suggestions from past jobs of the same customer: what was accepted, edited or ignored (traceable; an ignored value is
--    not suggested again on that enquiry).
create table if not exists history_choices (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  field_key text not null,
  value text,
  action text not null check (action in ('accepted', 'edited', 'ignored')),
  from_jobs text,                              -- the past jobs it came from (their refs)
  user_id uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists history_choices_file_idx on history_choices (job_file_id);
alter table history_choices enable row level security;

insert into schema_migrations (name) values ('038_teams_history.sql') on conflict do nothing;
