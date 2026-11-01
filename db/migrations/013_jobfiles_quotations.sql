-- 013 — Freight + 3PL Part A: money-screens switch, warehouse side, new roles, customer contacts,
--        Job Files (one per shipment), quotations. Safe to run more than once.
--
-- Job File = one shipment, identified by the company's typed Job No. (one Job File per Job No. across the
-- company). Truck trips and PRO requests with the same Job No. link to it automatically (trigger below);
-- messenger runs link through the truck trip they belong to. Nothing financial is posted here: quotations
-- hold operational cost and selling rates for the ERP, never invoices or ledgers.

-- ---------- 1. Settings ------------------------------------------------------------------------
insert into settings (key, value) values
  ('money_screens', 'true'),                 -- false hides the Financials page and money reports
  ('quote_min_margin_pct', '10'),            -- quotations below this margin need approval
  ('quote_validity_days', '14')
on conflict (key) do nothing;

-- ---------- 2. Warehouse side (Part B builds the warehouse itself) -----------------------------
alter table departments drop constraint if exists departments_side_chk;
alter table departments add constraint departments_side_chk
  check (side in ('admin','operations','transport','messenger','finance','pro','warehouse'));
alter table roles drop constraint if exists roles_side_chk;
alter table roles add constraint roles_side_chk
  check (side is null or side in ('admin','operations','transport','messenger','finance','pro','warehouse'));
insert into departments (code, name, side) values ('warehouse', 'Warehouse', 'warehouse') on conflict (code) do nothing;

-- Selling price / revenue / profit / quotations can never reach Transport, Messengers, PRO — or Warehouse —
-- nor anyone on a phone-app role (drivers, messengers, PRO officers), whatever department they sit in.
create or replace function user_has_perm(p_user uuid, p_perm text) returns boolean
language sql stable as $$
  select exists (
    select 1 from users u
      join roles r on r.id = u.role_id
      join permissions p on p.code = p_perm
      left join departments d on d.id = u.department_id
    where u.id = p_user and u.deleted_at is null
      and (
        r.code = 'super_admin'
        or (
          not (p.sensitivity = 'commercial' and (coalesce(d.side, '') in ('transport', 'messenger', 'pro', 'warehouse') or coalesce(r.app_only, false)))
          and (
            exists (select 1 from user_permission_overrides o
                     where o.user_id = u.id and o.permission_code = p_perm and o.granted)
            or (exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_code = p_perm)
                and not exists (select 1 from user_permission_overrides o
                                 where o.user_id = u.id and o.permission_code = p_perm and not o.granted))
          )
        )
      )
  );
$$;
revoke execute on function user_has_perm(uuid, text) from public;

-- ---------- 3. Permissions ------------------------------------------------------------------------
insert into permissions (code, module, name, sensitivity) values
  ('jobfiles.view_all', 'Job Files', 'View all Job Files', 'general'),
  ('jobfiles.view_department', 'Job Files', 'View Job Files of own department', 'general'),
  ('jobfiles.create', 'Job Files', 'Create Job Files', 'general'),
  ('jobfiles.edit', 'Job Files', 'Edit Job Files, containers and milestones', 'general'),
  ('jobfiles.close', 'Job Files', 'Close or cancel Job Files', 'general'),
  ('quotes.view', 'Quotations', 'View quotations', 'commercial'),
  ('quotes.create', 'Quotations', 'Create and edit quotations', 'commercial'),
  ('quotes.approve', 'Quotations', 'Approve quotations below the minimum margin', 'commercial')
on conflict (code) do nothing;

-- ---------- 4. New roles from the brief ------------------------------------------------------------
insert into roles (code, name, description, is_system, side, is_manager) values
  ('sales', 'Sales', 'Enquiries and quotations; sees cost and selling rates. Creates Job Files from accepted quotations.', true, 'operations', false),
  ('customer_service', 'Customer Service', 'Follows every shipment for customers: Job Files, trips, PRO and messenger status. No prices.', true, 'operations', false),
  ('freight_ops', 'Freight Operations', 'Runs Job Files: booking, documents, milestones, trips, PRO and messenger requests.', true, 'operations', false),
  ('dispatcher', 'Dispatcher', 'Transport side: assigns drivers and vehicles and moves trips along. No prices.', true, 'transport', false),
  ('warehouse_manager', 'Warehouse Manager', 'Admin of the warehouse side. Warehouse screens arrive in Part B.', true, 'warehouse', true),
  ('warehouse_operator', 'Warehouse Operator', 'Warehouse staff. Warehouse screens arrive in Part B.', true, 'warehouse', false),
  ('erp_admin', 'ERP Integration Administrator', 'Looks after the data sent to the ERP (Part B). Read-only on operations.', true, 'finance', false)
on conflict (code) do nothing;

insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['jobs.view','jobs.view_department','customers.manage','locations.manage','reports.view','reports.export',
    'finance.selling.view','finance.selling.edit','finance.buying.view','finance.profit.view',
    'jobfiles.view_department','jobfiles.create','jobfiles.edit','quotes.view','quotes.create']) p where r.code = 'sales'
union all
  select r.id, p from roles r, unnest(array['jobs.view','jobs.view_all','pro.view_all','runs.view_all','reports.view',
    'customers.manage','jobfiles.view_all']) p where r.code = 'customer_service'
union all
  select r.id, p from roles r, unnest(array['jobs.view','jobs.view_department','jobs.create','jobs.edit','jobs.cancel','documents.upload',
    'pro.view_department','pro.create','runs.view_department','runs.create','runs.cancel','reports.view','reports.export','customers.manage','locations.manage',
    'jobfiles.view_department','jobfiles.create','jobfiles.edit','jobfiles.close']) p where r.code = 'freight_ops'
union all
  select (select id from roles where code = 'dispatcher'), rp.permission_code from role_permissions rp join roles r on r.id = rp.role_id
   where r.code = 'transport' and rp.permission_code not in ('finance.buying.edit')
union all
  select r.id, p from roles r, unnest(array['jobs.view','jobs.view_all','jobfiles.view_all','reports.view',
    'users.manage_department','roles.manage_department']) p where r.code = 'warehouse_manager'
union all
  select r.id, p from roles r, unnest(array['jobs.view','jobfiles.view_all']) p where r.code = 'warehouse_operator'
union all
  select r.id, p from roles r, unnest(array['jobs.view','jobs.view_all','jobfiles.view_all','reports.view','reports.export','finance.buying.view','finance.selling.view']) p
   where r.code = 'erp_admin'
-- existing roles get the new modules
union all
  select r.id, p from roles r, unnest(array['jobfiles.view_department','jobfiles.create','jobfiles.edit','jobfiles.close','quotes.view','quotes.create','quotes.approve']) p
   where r.code in ('operations_manager', 'documentation_manager')
union all
  select r.id, p from roles r, unnest(array['jobfiles.view_department','jobfiles.create','jobfiles.edit']) p where r.code = 'operations'
union all
  select r.id, p from roles r, unnest(array['jobfiles.view_all','quotes.view']) p where r.code = 'finance'
union all
  select r.id, 'jobfiles.view_all' from roles r where r.code in ('transport', 'transport_manager')
on conflict do nothing;

-- ---------- 5. Customer contacts (several per customer) -------------------------------------------
create table if not exists customer_contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  full_name text not null,
  role text,                                   -- e.g. Operations, Accounts, Escalation
  mobile text,
  email text,
  is_primary boolean not null default false,
  remarks text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists cc_customer_idx on customer_contacts (customer_id) where deleted_at is null;
alter table customers add column if not exists service_instructions text;   -- standing instructions for every shipment

-- ---------- 6. Job Files ------------------------------------------------------------------------------
create table if not exists job_files (
  id uuid primary key default gen_random_uuid(),
  job_no text not null,                         -- typed by the company, kept exactly as typed
  customer_id uuid not null references customers(id),
  department_id uuid references departments(id),
  created_by uuid not null references users(id),
  quotation_id uuid,                            -- the accepted quotation it came from (fk added below)
  direction text not null check (direction in ('import', 'export', 'cross_trade', 'domestic')),
  mode text not null check (mode in ('sea_fcl', 'sea_lcl', 'air', 'road')),
  status text not null default 'open'
    check (status in ('open', 'booked', 'in_transit', 'arrived', 'delivering', 'closed', 'cancelled')),
  needs_clearance boolean not null default false,
  needs_transport boolean not null default false,
  needs_warehouse boolean not null default false,
  customer_reference text,
  shipper text, consignee text, notify_party text,
  origin text, destination text, port_of_loading text, port_of_discharge text,
  carrier text, vessel_flight text, voyage text, booking_reference text,
  mbl_mawb text, hbl_hawb text, incoterm text,
  etd date, eta date, atd date, ata date,
  packages integer check (packages is null or packages >= 0),
  gross_weight_kg numeric(12,2) check (gross_weight_kg is null or gross_weight_kg >= 0),
  volume_cbm numeric(12,3) check (volume_cbm is null or volume_cbm >= 0),
  chargeable_weight_kg numeric(12,2) check (chargeable_weight_kg is null or chargeable_weight_kg >= 0),
  cargo_description text,
  remarks text,
  cancel_reason text,
  closed_at timestamptz,
  closed_by uuid references users(id),
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- One live Job File per Job No. across the company (a cancelled one frees the number)
create unique index if not exists jf_job_no_uq on job_files (upper(btrim(job_no))) where deleted_at is null and status <> 'cancelled';
create index if not exists jf_customer_idx on job_files (customer_id);
create index if not exists jf_dept_idx on job_files (department_id) where deleted_at is null;
create index if not exists jf_status_idx on job_files (status) where deleted_at is null;
create index if not exists jf_eta_idx on job_files (eta);
create index if not exists jf_search_trgm on job_files using gin (search_text gin_trgm_ops);

create table if not exists job_file_containers (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  container_no text not null,
  size_type text,
  seal_no text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists jfc_file_idx on job_file_containers (job_file_id) where deleted_at is null;
create unique index if not exists jfc_uq on job_file_containers (job_file_id, container_no) where deleted_at is null;

-- The milestone plan: each step has a planned and an actual date (filled in by hand, with who and when)
create table if not exists job_file_milestones (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  code text not null,
  name text not null,
  sort_order integer not null default 0,
  planned_date date,
  actual_at timestamptz,
  remarks text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists jfm_uq on job_file_milestones (job_file_id, code);

-- Every change on a Job File (status, edits, milestones, containers, links, notes)
create table if not exists job_file_events (
  id bigserial primary key,
  job_file_id uuid not null references job_files(id),
  kind text not null,                           -- created | edit | status | milestone | container | note | link
  title text not null,
  field text, old_value text, new_value text,
  user_id uuid references users(id),
  user_name text,
  at timestamptz not null default now()
);
create index if not exists jfe_file_idx on job_file_events (job_file_id, at);

-- ---------- 7. Links from existing work to the Job File ----------------------------------------------
alter table transport_requests add column if not exists job_file_id uuid references job_files(id);
alter table pro_requests add column if not exists job_file_id uuid references job_files(id);
alter table messenger_runs add column if not exists job_file_id uuid references job_files(id);
create index if not exists tr_job_file_idx on transport_requests (job_file_id);
create index if not exists pro_job_file_idx on pro_requests (job_file_id);
create index if not exists mr_job_file_idx on messenger_runs (job_file_id);

-- Trips and PRO requests find their Job File by Job No. when created or when the Job No. changes.
create or replace function link_job_file_by_job_no() returns trigger language plpgsql as $$
begin
  if new.job_no is not null and (tg_op = 'INSERT' or new.job_no is distinct from old.job_no or new.job_file_id is null) then
    new.job_file_id := (select f.id from job_files f where upper(btrim(f.job_no)) = upper(btrim(new.job_no))
                          and f.deleted_at is null and f.status <> 'cancelled' limit 1);
  end if;
  return new;
end $$;
drop trigger if exists tr_link_job_file on transport_requests;
create trigger tr_link_job_file before insert or update of job_no, job_file_id on transport_requests
  for each row execute function link_job_file_by_job_no();
drop trigger if exists pro_link_job_file on pro_requests;
create trigger pro_link_job_file before insert or update of job_no, job_file_id on pro_requests
  for each row execute function link_job_file_by_job_no();

-- Messenger runs follow the truck trip they are linked to.
create or replace function link_run_job_file() returns trigger language plpgsql as $$
begin
  if new.job_id is not null and new.job_file_id is null then
    new.job_file_id := (select t.job_file_id from transport_requests t where t.id = new.job_id);
  end if;
  return new;
end $$;
drop trigger if exists mr_link_job_file on messenger_runs;
create trigger mr_link_job_file before insert or update of job_id on messenger_runs
  for each row execute function link_run_job_file();

-- ---------- 8. Quotations -----------------------------------------------------------------------------
create sequence if not exists quote_no_seq start 1001;
create table if not exists quotations (
  id uuid primary key default gen_random_uuid(),
  quote_no text not null unique,                -- Q-1001
  customer_id uuid not null references customers(id),
  department_id uuid references departments(id),
  created_by uuid not null references users(id),
  enquiry_reference text,
  service_type text not null check (service_type in ('sea_fcl', 'sea_lcl', 'air', 'road', 'customs', 'transport', 'warehousing', 'door_to_door')),
  direction text not null default 'import' check (direction in ('import', 'export', 'cross_trade', 'domestic')),
  origin text, destination text,
  cargo_description text,
  packages integer check (packages is null or packages >= 0),
  gross_weight_kg numeric(12,2) check (gross_weight_kg is null or gross_weight_kg >= 0),
  volume_cbm numeric(12,3) check (volume_cbm is null or volume_cbm >= 0),
  chargeable_weight_kg numeric(12,2) check (chargeable_weight_kg is null or chargeable_weight_kg >= 0),
  currency text not null default 'AED',
  valid_until date not null,
  scope text, exclusions text, terms text,
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'cancelled')),
  approved_by uuid references users(id),
  approved_at timestamptz,
  decline_reason text,                          -- approval refused, or customer said no
  sent_at timestamptz,
  accepted_at timestamptz,
  job_file_id uuid references job_files(id),
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists q_customer_idx on quotations (customer_id);
create index if not exists q_status_idx on quotations (status) where deleted_at is null;
create index if not exists q_search_trgm on quotations using gin (search_text gin_trgm_ops);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'job_files_quotation_fk') then
    alter table job_files add constraint job_files_quotation_fk foreign key (quotation_id) references quotations(id);
  end if;
end $$;

create table if not exists quotation_lines (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references quotations(id),
  sort_order integer not null default 0,
  description text not null,
  charge_unit text not null check (charge_unit in ('shipment', 'container', 'cbm', 'kg', 'trip', 'pallet', 'carton', 'day', 'lump_sum')),
  quantity numeric(12,3) not null check (quantity > 0),
  cost_rate numeric(14,2) not null default 0 check (cost_rate >= 0),     -- what we pay (estimate)
  sell_rate numeric(14,2) not null default 0 check (sell_rate >= 0)      -- what the customer pays
);
create index if not exists ql_quote_idx on quotation_lines (quotation_id, sort_order);

create table if not exists quotation_events (
  id bigserial primary key,
  quotation_id uuid not null references quotations(id),
  title text not null,
  details text,
  user_id uuid references users(id),
  user_name text,
  at timestamptz not null default now()
);
create index if not exists qe_quote_idx on quotation_events (quotation_id, at);

-- ---------- 9. Notifications can point at a Job File or a quotation ---------------------------------
alter table notifications add column if not exists job_file_id uuid references job_files(id);
alter table notifications add column if not exists quotation_id uuid references quotations(id);

-- ---------- 10. Lock everything new away from Supabase's public API ----------------------------------
alter table customer_contacts enable row level security;
alter table job_files enable row level security;
alter table job_file_containers enable row level security;
alter table job_file_milestones enable row level security;
alter table job_file_events enable row level security;
alter table quotations enable row level security;
alter table quotation_lines enable row level security;
alter table quotation_events enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on customer_contacts, job_files, job_file_containers, job_file_milestones, job_file_events,
      quotations, quotation_lines, quotation_events from anon, authenticated';
    execute 'revoke all on sequence quote_no_seq, job_file_events_id_seq, quotation_events_id_seq from anon, authenticated';
    execute 'revoke execute on function user_has_perm(uuid, text), link_job_file_by_job_no(), link_run_job_file() from anon, authenticated';
  end if;
end $$;

-- Changed roles: everyone signs in again so new access applies.
update users set token_version = token_version + 1
  where role_id in (select id from roles where code in ('operations', 'operations_manager', 'documentation_manager', 'finance', 'transport', 'transport_manager'));

insert into schema_migrations (name) values ('013_jobfiles_quotations.sql') on conflict do nothing;
