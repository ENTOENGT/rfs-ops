-- 028 — Checklists the AI agent will follow (Release M). Safe to run twice; only new tables and columns.

-- ================================================================ Step 1: the enquiry checklist
-- Your own extra questions for a customer enquiry, on top of the built-in rules (Incoterm, addresses, cargo lines…).
-- Each item can apply to some divisions and / or modes only (empty = all). "ask_text" is how the question is put to the customer.
create table if not exists enquiry_checks (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  ask_text text not null,
  field_type text not null default 'text' check (field_type in ('text', 'yes_no', 'date', 'number')),
  divisions text[] not null default '{}',
  modes text[] not null default '{}',
  is_active boolean not null default true,
  sort integer not null default 100,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists enquiry_checks_label_uq on enquiry_checks (lower(label));
alter table enquiry_checks enable row level security;
insert into enquiry_checks (label, ask_text, field_type, sort, is_active) values
  ('HS code', 'the HS code of the goods', 'text', 10, true),
  ('Hazardous (DG) cargo', 'whether the cargo is hazardous (DG) — if yes, the MSDS and UN number', 'yes_no', 20, true),
  ('Cargo ready date', 'the date the cargo will be ready for pickup', 'date', 30, true),
  ('Stackable', 'whether the cargo can be stacked', 'yes_no', 40, false),
  ('Insurance required', 'whether you need cargo insurance', 'yes_no', 50, false),
  ('Temperature (reefer)', 'the temperature setting required for the cargo', 'text', 60, false)
on conflict do nothing;

-- the answers on each enquiry (check id → value), kept with the enquiry
alter table job_files add column if not exists enquiry_details jsonb not null default '{}';

-- ================================================================ Step 2: the agent quote checklist
-- What an agent's rate must include. Items with a field_key are read from what is already typed on the rate request
-- (the rate, validity, transit time, routing, carrier, free days, sailing date, origin / destination charges); items without
-- one are extra questions whose answers are kept on the request. Each item can apply to some modes only (empty = all).
create table if not exists quote_checks (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  ask_text text not null,
  field_key text,
  modes text[] not null default '{}',
  is_active boolean not null default true,
  sort integer not null default 100,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists quote_checks_label_uq on quote_checks (lower(label));
alter table quote_checks enable row level security;
insert into quote_checks (label, ask_text, field_key, modes, sort) values
  ('Freight rate', 'the freight rate', 'freight', '{}', 10),
  ('Currency', 'the currency of the rate', 'currency', '{}', 20),
  ('Validity', 'how long the rate is valid', 'rate_valid_until', '{}', 30),
  ('Transit time', 'the transit time', 'transit_days', '{}', 40),
  ('Routing (direct / via)', 'the routing — direct, or via which port', 'routing', '{}', 50),
  ('Carrier / airline', 'the carrier or airline', 'carrier', '{}', 60),
  ('Sailing / flight date', 'the next sailing or flight date', 'etd', '{}', 70),
  ('Free days', 'the free days at destination', 'free_days', '{sea_fcl,sea_lcl}', 80),
  ('Origin charges', 'the origin charges (THC, documentation and others)', 'origin', '{sea_fcl,sea_lcl}', 90),
  ('Destination charges', 'the destination charges', 'destination', '{sea_fcl,sea_lcl}', 100),
  ('Weight breaks', 'the rate per kg for each weight break', null, '{air}', 110),
  ('Fuel and security surcharges', 'the fuel and security surcharges', null, '{air}', 120),
  ('Chargeable weight used', 'the chargeable weight you used', null, '{air}', 130)
on conflict do nothing;

-- answers to the extra questions on each rate request (check id → value)
alter table vendor_requests add column if not exists quote_details jsonb not null default '{}';

-- ================================================================ Feedback 17 Nov: no duplicate job titles
-- The role already says Salesman / Coordinator / Driver / Customer Service; those job titles (added by an earlier 025 / 026)
-- are switched off where nobody uses them. Nothing is deleted; a title someone still has stays on.
update designations g set is_active = false
 where g.name in ('Salesman', 'Coordinator', 'Driver', 'Customer Service Executive') and g.is_active
   and not exists (select 1 from users u where u.designation_id = g.id and u.deleted_at is null);

insert into schema_migrations (name) values ('028_checklists.sql') on conflict do nothing;
