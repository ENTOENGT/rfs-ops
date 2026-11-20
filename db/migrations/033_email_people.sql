-- 033 — Email people that follow the shipment (To / CC). Safe to run twice; only new things, nothing deleted.
--
-- On every email to the customer about a shipment, To and CC fill in by themselves:
--   the customer's contacts marked To / CC; our people handling the shipment in CC (+ the company CC addresses in Settings);
--   the people the customer had in To / CC on their own emails; the people our team typed in by hand.
-- Anyone can be removed from one shipment's emails with ×; they then stay off that shipment's emails.

-- how each customer contact gets emails by default (empty = the main contact goes in To, the others are offered unticked)
alter table customer_contacts add column if not exists email_as text;
do $$ begin
  alter table customer_contacts add constraint customer_contacts_email_as_check check (email_as in ('to', 'cc', 'none'));
exception when duplicate_object then null; end $$;

-- the people on one shipment's emails
create table if not exists job_file_email_people (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  email text not null,
  name text,
  side text not null check (side in ('customer', 'ours')),
  place text not null check (place in ('to', 'cc')),
  source text not null check (source in ('customer_email', 'added')),   -- seen on the customer's email / typed in by our team
  removed boolean not null default false,
  added_by uuid references users(id),
  removed_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists jfep_uq on job_file_email_people (job_file_id, lower(email));
alter table job_file_email_people enable row level security;

-- Settings: addresses always copied on emails to customers (e.g. a shared operations mailbox); empty by default
insert into settings (key, value) values ('customer_email_cc', '""') on conflict (key) do nothing;

insert into schema_migrations (name) values ('033_email_people.sql') on conflict do nothing;
