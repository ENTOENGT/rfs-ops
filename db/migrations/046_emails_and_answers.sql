-- 046 (26 Nov, commit 2 of 3) — emails and the customer's answer buttons. Safe to run twice; nothing is removed.

-- 1. A send that failed is kept, so the rates table shows "Failed" against that vendor.
alter table email_messages drop constraint if exists email_messages_status_check;
alter table email_messages add constraint email_messages_status_check check (status in ('prepared', 'received', 'sent', 'failed'));

-- 2. Each user's email signature (a picture), added to every email they send from RFS CRM.
create table if not exists user_signatures (
  user_id uuid primary key references users(id),
  mime text not null check (mime in ('image/png', 'image/jpeg')),
  data bytea not null,
  width integer not null check (width between 1 and 2000),
  height integer not null check (height between 1 and 2000),
  updated_at timestamptz not null default now()
);
alter table user_signatures enable row level security;

-- 3. The automatic "Enquiry received" email: sent once per enquiry.
alter table job_files add column if not exists ack_sent_at timestamptz;
alter table job_files add column if not exists ack_error text;

-- 4. The customer's answer buttons in the quotation email: one link per option, used once.
create table if not exists quote_answers (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references quotations(id),
  version_no integer not null,
  route_id uuid references enquiry_routes(id),
  token text not null unique,
  answer text check (answer in ('accepted', 'rejected', 'negotiate')),
  reason text, target_rate numeric(14,2), target_currency text, comment text,
  answered_at timestamptz, answered_ip text, handled_at timestamptz, handled_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists quote_answers_q on quote_answers (quotation_id);
-- one link per option and version (made when the email is prepared, reused after)
create unique index if not exists quote_answers_one on quote_answers (quotation_id, version_no, coalesce(route_id, '00000000-0000-0000-0000-000000000000'::uuid));
-- wrong links are limited per connection, like the app links
alter table login_attempts drop constraint if exists login_attempts_kind_check;
alter table login_attempts add constraint login_attempts_kind_check check (kind in ('login', 'app_link', 'quote_answer'));
alter table quote_answers enable row level security;

-- 5. Shipment details shown for each option on the quotation (PDF and email): line, transit, free days, ETD, ETA. They come from the
--    option's vendor quote by themselves; what is typed here (to fill a gap or correct it) is kept per option.
alter table quotations add column if not exists details jsonb not null default '{}';

insert into schema_migrations (name) values ('046_emails_and_answers.sql') on conflict do nothing;
