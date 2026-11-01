-- 012 — Safety foundations (start of the Freight + 3PL build). Safe to run more than once.
--  1. schema_migrations: a record of which migration files have been run, so none is skipped or forgotten.
--  2. login_attempts: failed sign-ins per network address, so one address cannot try password after
--     password across many accounts (the 5-tries lock in 001 only protects one account at a time).

-- ---------- 1. Which migrations have run ------------------------------------------------------
create table if not exists schema_migrations (
  name text primary key,                        -- the file name, e.g. '012_safety.sql'
  applied_at timestamptz not null default now()
);
-- Every earlier file must already have been run for this one to work, so record them all now.
insert into schema_migrations (name) values
  ('001_schema.sql'), ('002_seed.sql'), ('003_masters_assignment.sql'), ('004_pod_documents.sql'),
  ('005_departments_managers.sql'), ('006_messenger_runs.sql'), ('007_phone_app.sql'),
  ('008_request_docs_jobno.sql'), ('009_pro_clearance.sql'), ('010_rental_trucks.sql'),
  ('011_rental_rates.sql'), ('012_safety.sql')
on conflict (name) do nothing;

-- ---------- 2. Failed sign-ins per network address ---------------------------------------------
-- Only a one-way hash of the address is kept, never the address itself.
create table if not exists login_attempts (
  id bigserial primary key,
  source_key text not null,                     -- 'ip:<sha256>' — which address failed
  kind text not null default 'login' check (kind in ('login', 'app_link')),
  attempted_at timestamptz not null default now()
);
create index if not exists login_attempts_key_idx on login_attempts (source_key, attempted_at desc);
create index if not exists login_attempts_time_idx on login_attempts (attempted_at);

-- ---------- Lock both tables away from Supabase's public API (same rule as every other table) --
alter table schema_migrations enable row level security;
alter table login_attempts enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema_migrations, login_attempts from anon, authenticated';
    execute 'revoke all on sequence login_attempts_id_seq from anon, authenticated';
  end if;
end $$;
