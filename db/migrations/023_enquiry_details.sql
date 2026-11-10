-- 023 — Enquiry details.
--  1. Cargo lines: package type, number of packages, length × width × height (cm / inch / m) and weight per line;
--     the shipment's packages, weight, CBM and chargeable weight are the totals of its lines.
--  2. Incoterm details: pickup (loading) address, handover place, delivery address with contacts, cargo value for insurance.
--  3. Exchange rates for the five currencies (Settings).
--  4. LCL department and the LCL Team role (LCL Management only).
-- Safe to run twice. Nothing is deleted; old shipments keep their typed totals and simply have no lines.

create table if not exists job_file_cargo_lines (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  line_no int not null check (line_no between 1 and 200),
  package_type text not null,
  package_other text,
  pieces int not null check (pieces > 0),
  length numeric(10,2) not null check (length > 0),
  width numeric(10,2) not null check (width > 0),
  height numeric(10,2) not null check (height > 0),
  dim_unit text not null check (dim_unit in ('cm', 'in', 'm')),
  weight_kg numeric(12,2) not null check (weight_kg > 0),
  cbm numeric(12,3) not null,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid references users(id)
);
create index if not exists jfcl_file_idx on job_file_cargo_lines (job_file_id) where removed_at is null;
alter table job_files add column if not exists package_type text;   -- "Cartons", "Pallets" … or "Mixed"

-- 2. Incoterm details (which ones are required depends on the Incoterm and the direction)
alter table job_files add column if not exists pickup_address text;
alter table job_files add column if not exists pickup_contact text;
alter table job_files add column if not exists named_place text;
alter table job_files add column if not exists delivery_address text;
alter table job_files add column if not exists delivery_contact text;
alter table job_files add column if not exists cargo_value numeric(14,2);
alter table job_files add column if not exists cargo_value_currency text;

-- 3. Currencies: AED, USD, EUR, INR, CNY on quotations, agent rates and cargo value. Exchange rates live in Settings as
--    "1 unit = x AED". USD is pegged (3.6725); EUR, INR and CNY are left for the admin to fill in. Existing values are kept.
insert into settings (key, value) values ('fx_USD', '3.6725') on conflict (key) do nothing;
insert into settings (key, value) values ('fx_EUR', 'null'), ('fx_INR', 'null'), ('fx_CNY', 'null') on conflict (key) do nothing;

-- 4. LCL team: its own department and role, with full access to LCL Management and nothing else
--    (consolidations, house shipments, receiving, stuffing, dispatch, registers and the LCL reports).
insert into departments (code, name, side) values ('lcl', 'LCL', 'operations') on conflict (code) do nothing;
insert into roles (code, name, description, is_system, side, is_manager, department_id)
  select 'lcl_team', 'LCL Team', 'Runs LCL consolidations end to end: containers, house shipments, receiving, stuffing, dispatch and the LCL reports. Sees no other module.',
         true, 'operations', false, d.id from departments d where d.code = 'lcl'
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['lcl.view', 'lcl.manage', 'lcl.receive', 'lcl.stuff']) p where r.code = 'lcl_team'
on conflict do nothing;

alter table job_file_cargo_lines enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on job_file_cargo_lines from anon, authenticated';
  end if;
end $$;

insert into schema_migrations (name) values ('023_enquiry_details.sql') on conflict do nothing;
