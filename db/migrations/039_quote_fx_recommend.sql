-- 039 — AI batch 3. Safe to run twice; only new columns and new tables.
--
-- 1. A quotation cost line taken from a vendor rate remembers the vendor's own amount, currency and the exchange rate used, and
--    whether the vendor's charges were used as split-ups or as one all-in line. The vendor's breakdown itself stays untouched
--    on the rate request (vendor_rate_charges). Changing the quotation currency can then convert these costs again.
alter table quotation_lines add column if not exists cost_currency text;
alter table quotation_lines add column if not exists cost_original numeric(14,2);
alter table quotation_lines add column if not exists cost_fx numeric(14,6);
alter table quotation_lines add column if not exists rate_mode text;
do $$ begin
  alter table quotation_lines add constraint quotation_lines_rate_mode_chk check (rate_mode is null or rate_mode in ('split', 'all_in'));
exception when duplicate_object then null; end $$;

-- 2. The AI's comparison of the vendor rates on an enquiry: which one it recommends and why (kept; a new one when rates change).
create table if not exists vendor_recommendations (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  input_key text not null,                     -- the rates it compared (a new comparison when they change)
  result jsonb not null,
  model text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists vendor_recommendations_file_idx on vendor_recommendations (job_file_id, created_at desc);
alter table vendor_recommendations enable row level security;

-- 3. Mismatches in scope / clauses the AI found (customer vs vendor terms, a missing service, unclear responsibility): each is
--    asked of the customer, asked of the vendor, or solved internally — with who and when. Never silently accepted.
create table if not exists scope_issues (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  recommendation_id uuid references vendor_recommendations(id),
  vendor_request_id uuid references vendor_requests(id),
  issue text not null,
  question text,                               -- what to ask
  target text not null default 'internal' check (target in ('customer', 'vendor', 'internal')),
  status text not null default 'open' check (status in ('open', 'asked_customer', 'asked_vendor', 'resolved')),
  note text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists scope_issues_file_idx on scope_issues (job_file_id);
alter table scope_issues enable row level security;

insert into schema_migrations (name) values ('039_quote_fx_recommend.sql') on conflict do nothing;
