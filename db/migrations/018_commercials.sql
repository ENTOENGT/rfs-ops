-- 018 — Commercials Department workflow (Part E). Safe to run more than once. Only adds; nothing is deleted.
--
--   Commercials Department with divisions Imports / Exports / Cross Trade; roles Commercials Manager, Salesman,
--   Coordinator, Agent Coordinator; Salesman → Coordinator mapping (with history); customer owners.
--   One shipment record (job_files) carries three numbers: Enquiry Ref (made at enquiry), Shipping Ref (made at
--   customer confirmation) and the Job No. from the ERP (typed at handover, after the pre-alert is verified).
--   Full rate detail with source and versions; Salesman approval; quotation versions and customer responses;
--   booking, pre-alert and handover; history tables locked against edit and delete.

-- ---------- 1. Departments and divisions ----------------------------------------------------------
update departments set name = 'Commercials' where code = 'commercial' and name <> 'Commercials';
-- Sea/Air departments are retired: hidden for new users and records, kept for the history of old records
update departments set is_active = false where code in ('sea_import', 'sea_export', 'air_import', 'air_export') and is_active;

alter table users add column if not exists division text;
alter table users drop constraint if exists users_division_chk;
alter table users add constraint users_division_chk check (division is null or division in ('imports', 'exports', 'cross_trade'));
alter table users add column if not exists coordinator_id uuid references users(id);   -- a Salesman's dedicated Coordinator
create index if not exists users_coordinator_idx on users (coordinator_id) where coordinator_id is not null;

-- History of Salesman ↔ Coordinator mapping and division changes
create table if not exists user_assignments (
  id bigserial primary key,
  user_id uuid not null references users(id),            -- the Salesman (or the user whose division changed)
  field text not null check (field in ('coordinator', 'division')),
  old_value text, new_value text,                       -- coordinator user id or division code
  old_label text, new_label text,                       -- names, kept as they were
  reason text,
  changed_by uuid references users(id), changed_by_name text,
  at timestamptz not null default now()
);
create index if not exists ua_user_idx on user_assignments (user_id, at);

-- ---------- 2. Customer owners (which Salesmen own a customer) -------------------------------------
create table if not exists customer_salesmen (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  user_id uuid not null references users(id),
  is_main boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid references users(id)
);
create unique index if not exists cs_owner_uq on customer_salesmen (customer_id, user_id) where removed_at is null;
create unique index if not exists cs_owner_main_uq on customer_salesmen (customer_id) where removed_at is null and is_main;
create index if not exists cs_owner_user_idx on customer_salesmen (user_id) where removed_at is null;

-- ---------- 3. The shipment record: three numbers, owners, commercial stage -------------------------
create sequence if not exists enquiry_ref_seq start 1;
create sequence if not exists shipping_ref_seq start 1;
alter table job_files add column if not exists enquiry_ref text;
alter table job_files add column if not exists shipping_ref text;
alter table job_files add column if not exists division text;
alter table job_files drop constraint if exists job_files_division_chk;
alter table job_files add constraint job_files_division_chk check (division is null or division in ('imports', 'exports', 'cross_trade'));
alter table job_files add column if not exists salesman_id uuid references users(id);
alter table job_files add column if not exists coordinator_id uuid references users(id);
alter table job_files add column if not exists stage text;
alter table job_files drop constraint if exists job_files_stage_chk;
alter table job_files add constraint job_files_stage_chk check (stage is null or stage in (
  'enquiry', 'rates_requested', 'rates_received', 'quotation_draft', 'pending_approval', 'sent_to_customer',
  'customer_confirmed', 'booking_requested', 'booking_confirmed', 'prealert_awaited', 'prealert_received',
  'prealert_verified', 'handed_over', 'lost', 'cancelled'));
alter table job_files add column if not exists confirmed_at timestamptz;
alter table job_files add column if not exists confirmed_by uuid references users(id);
alter table job_files add column if not exists booking_vendor_request_id uuid references vendor_requests(id);
alter table job_files add column if not exists handed_over_at timestamptz;
alter table job_files add column if not exists handed_over_by uuid references users(id);
alter table job_files add column if not exists handover_notes text;

-- The Job No. comes from the ERP and is typed at handover: it may be empty while the shipment is still commercial.
alter table job_files alter column job_no drop not null;
-- …but a live (handed over / operational) record must have one. Old records already have one.
alter table job_files drop constraint if exists job_files_job_no_needed;
alter table job_files add constraint job_files_job_no_needed check (status in ('enquiry', 'cancelled') or nullif(btrim(job_no), '') is not null);

-- Existing records get their Enquiry Ref; files that are already live count as handed over
update job_files set enquiry_ref = 'ENQ-' || to_char(created_at at time zone 'Asia/Dubai', 'YY') || '-' || lpad(nextval('enquiry_ref_seq')::text, 5, '0')
  where enquiry_ref is null;
update job_files set stage = case when status = 'enquiry' then 'enquiry' when status = 'cancelled' then 'cancelled' else 'handed_over' end
  where stage is null;
create unique index if not exists jf_enquiry_ref_uq on job_files (enquiry_ref) where enquiry_ref is not null;
create unique index if not exists jf_shipping_ref_uq on job_files (shipping_ref) where shipping_ref is not null;
create index if not exists jf_salesman_idx on job_files (salesman_id) where deleted_at is null;
create index if not exists jf_coordinator_idx on job_files (coordinator_id) where deleted_at is null;
create index if not exists jf_stage_idx on job_files (stage) where deleted_at is null;
alter table job_file_events add column if not exists remarks text;

-- ---------- 4. Agents and rates --------------------------------------------------------------------
alter table vendors drop constraint if exists vendors_vendor_type_check;
alter table vendors add constraint vendors_vendor_type_check
  check (vendor_type in ('shipping_line', 'airline', 'freight_agent', 'overseas_agent', 'customs_broker', 'transporter', 'warehouse', 'courier', 'other'));
create table if not exists vendor_regions (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id),
  country text not null,
  port text,
  created_at timestamptz not null default now()
);
create index if not exists vreg_vendor_idx on vendor_regions (vendor_id);
create index if not exists vreg_country_idx on vendor_regions (lower(country));

alter table vendor_requests add column if not exists rate_source text;
alter table vendor_requests drop constraint if exists vendor_requests_rate_source_chk;
alter table vendor_requests add constraint vendor_requests_rate_source_chk
  check (rate_source is null or rate_source in ('shipping_line', 'airline', 'overseas_agent', 'agent_coordinator', 'other'));
alter table vendor_requests add column if not exists assigned_to uuid references users(id);       -- Agent Coordinator
alter table vendor_requests add column if not exists received_at timestamptz;
alter table vendor_requests add column if not exists transit_days integer check (transit_days is null or transit_days between 0 and 365);
alter table vendor_requests add column if not exists routing text;
alter table vendor_requests add column if not exists free_days integer check (free_days is null or free_days between 0 and 365);
alter table vendor_requests add column if not exists inclusions text;
alter table vendor_requests add column if not exists exclusions text;
alter table vendor_requests add column if not exists carrier text;                                -- line / airline behind an agent's rate
alter table vendor_requests add column if not exists etd date;
alter table vendor_requests add column if not exists rate_version integer not null default 1;
alter table vendor_requests add column if not exists previous_quoted_cost numeric(14,2);
alter table vendor_requests add column if not exists rate_request_id uuid references vendor_requests(id); -- a booking: the rate it books
create index if not exists vr_assigned_idx on vendor_requests (assigned_to) where assigned_to is not null;

-- Rate detail: freight, origin and destination charges. quoted_cost stays the total (in the request currency).
create table if not exists vendor_rate_charges (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references vendor_requests(id),
  rate_version integer not null default 1,
  section text not null check (section in ('freight', 'origin', 'destination', 'other')),
  description text not null,
  basis text,                                   -- per container, per kg, per shipment…
  quantity numeric(14,3) not null default 1 check (quantity >= 0),
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'AED',
  exchange_rate numeric(14,6) not null default 1 check (exchange_rate > 0),   -- to the request currency
  sort_order integer not null default 0
);
create index if not exists vrc_req_idx on vendor_rate_charges (request_id, rate_version);
-- old versions of a rate, kept when the vendor revises it
create table if not exists vendor_rate_versions (
  id bigserial primary key,
  request_id uuid not null references vendor_requests(id),
  rate_version integer not null,
  snapshot jsonb not null,
  replaced_by uuid references users(id), replaced_by_name text,
  at timestamptz not null default now()
);
create index if not exists vrv_req_idx on vendor_rate_versions (request_id, rate_version);

-- ---------- 5. Quotations: Salesman approval, versions, customer responses ------------------------
alter table quotations add column if not exists version_no integer not null default 1;
alter table quotations add column if not exists salesman_id uuid references users(id);
alter table quotations add column if not exists salesman_decision text;
alter table quotations drop constraint if exists quotations_salesman_decision_chk;
alter table quotations add constraint quotations_salesman_decision_chk check (salesman_decision is null or salesman_decision in ('approved', 'rejected', 'returned'));
alter table quotations add column if not exists salesman_decided_by uuid references users(id);
alter table quotations add column if not exists salesman_decided_at timestamptz;
alter table quotations add column if not exists salesman_note text;
alter table quotations add column if not exists needs_manager boolean not null default false;
create table if not exists quotation_versions (
  id bigserial primary key,
  quotation_id uuid not null references quotations(id),
  version_no integer not null,
  reason text not null,                          -- why it was kept: revised / approved / confirmed
  snapshot jsonb not null,                       -- header + lines + totals as they stood
  made_by uuid references users(id), made_by_name text,
  at timestamptz not null default now()
);
create index if not exists qv_quote_idx on quotation_versions (quotation_id, version_no);
create table if not exists quotation_responses (
  id bigserial primary key,
  quotation_id uuid not null references quotations(id),
  version_no integer not null,
  response text not null check (response in ('accepted', 'revision_requested', 'declined', 'no_reply', 'note')),
  note text,
  document_id uuid,                             -- evidence (customer email / signed copy) in jf_documents
  user_id uuid references users(id), user_name text,
  at timestamptz not null default now()
);
create index if not exists qr_quote_idx on quotation_responses (quotation_id, at);

-- ---------- 6. Pre-alerts ---------------------------------------------------------------------------
create table if not exists prealerts (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  status text not null default 'awaited' check (status in ('awaited', 'received', 'correction', 'verified')),
  expected_date date,
  received_at timestamptz,
  source text check (source is null or source in ('shipping_line', 'airline', 'agent', 'other')),
  document_id uuid,                             -- the pre-alert file in jf_documents
  -- what the pre-alert says, checked against the booking
  vessel_flight text, voyage text, containers text, mbl_mawb text, hbl_hawb text, etd date, eta date,
  check_vessel boolean not null default false, check_voyage boolean not null default false,
  check_containers boolean not null default false, check_bl boolean not null default false,
  check_etd boolean not null default false, check_eta boolean not null default false,
  correction_note text,
  follow_up_date date,
  verified_by uuid references users(id), verified_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists prealert_file_uq on prealerts (job_file_id);

-- ---------- 7. Permissions and roles -----------------------------------------------------------------
insert into permissions (code, module, name, sensitivity) values
  ('commercial.manage', 'Commercials', 'Manage Commercials users, divisions and Salesman ↔ Coordinator mapping', 'commercial'),
  ('jobfiles.view_assigned', 'Job Files', 'View own enquiries and shipments (as Salesman, Coordinator or creator)', 'general'),
  ('jobfiles.view_handed_over', 'Job Files', 'View shipments handed over to Operations', 'general'),
  ('jobfiles.handover', 'Job Files', 'Create the operational job (type the ERP Job No.) and hand over to Operations', 'general'),
  ('quotes.salesman_approve', 'Quotations', 'Approve, reject or return quotations as the responsible Salesman', 'commercial'),
  ('rates.agent_coordination', 'Vendors', 'Work on rate requests assigned as Agent Coordinator', 'cost'),
  ('customers.view_all', 'Customers', 'See all customers (without it: only own or mapped Salesmen''s customers)', 'general')
on conflict (code) do nothing;

insert into roles (code, name, description, is_system, side, is_manager) values
  ('commercials_manager', 'Commercials Manager', 'Runs the Commercials Department: all divisions, user assignments, approvals and reports.', true, 'operations', true),
  ('coordinator', 'Coordinator', 'Enquiries, rate collection, quotations, bookings, pre-alerts and handover for mapped Salesmen.', true, 'operations', false),
  ('agent_coordinator', 'Agent Coordinator', 'Collects rates from overseas agents for the rate requests assigned to them.', true, 'operations', false)
on conflict (code) do nothing;
update roles set name = 'Salesman', description = 'Own customers, enquiries and quotations; approves quotations prepared by the Coordinator.'
  where code = 'sales' and name = 'Sales';

-- Everyone who sees customers today keeps seeing all of them — except Salesmen, Coordinators and Agent Coordinators,
-- who see their own (rule in the server).
insert into role_permissions (role_id, permission_code)
  select distinct rp.role_id, 'customers.view_all' from role_permissions rp join roles r on r.id = rp.role_id
   where rp.permission_code in ('customers.manage', 'jobfiles.view_all', 'jobfiles.view_department', 'jobs.view')
     and r.code not in ('sales', 'coordinator', 'agent_coordinator')
on conflict do nothing;
-- Salesman: own scope instead of department scope
delete from role_permissions where role_id = (select id from roles where code = 'sales') and permission_code = 'jobfiles.view_department';
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['jobfiles.view_assigned','quotes.salesman_approve']) p where r.code = 'sales'
union all
  select r.id, p from roles r, unnest(array['jobfiles.view_assigned','jobfiles.create','jobfiles.edit','jobfiles.handover','quotes.view','quotes.create',
    'vendors.requests','finance.buying.view','finance.selling.view','finance.selling.edit','finance.profit.view','documents.upload',
    'reports.view','reports.export','cases.manage']) p where r.code = 'coordinator'
union all
  select r.id, p from roles r, unnest(array['vendors.requests','rates.agent_coordination','finance.buying.view','reports.view']) p where r.code = 'agent_coordinator'
union all
  select r.id, p from roles r, unnest(array['commercial.manage','jobfiles.view_all','jobfiles.create','jobfiles.edit','jobfiles.close','jobfiles.handover',
    'quotes.view','quotes.create','quotes.approve','quotes.salesman_approve','vendors.manage','vendors.requests','customers.manage','customers.view_all',
    'finance.buying.view','finance.selling.view','finance.selling.edit','finance.profit.view','documents.upload','documents.approve',
    'reports.view','reports.export','cases.manage','cases.view_all','users.manage_department']) p where r.code = 'commercials_manager'
union all
  -- Operations keeps working on everything handed over to it
  select r.id, 'jobfiles.view_handed_over' from roles r where r.code in ('freight_ops', 'operations', 'documentation_manager')
union all
  select r.id, 'jobfiles.handover' from roles r where r.code in ('operations_manager', 'freight_ops')
on conflict do nothing;

-- ---------- 8. History can only grow: no edit, no delete ----------------------------------------------
create or replace function history_is_append_only() returns trigger language plpgsql as $$
begin raise exception '% is history: it cannot be changed or deleted', tg_table_name; end $$;
do $$ declare t text; begin
  foreach t in array array['job_file_events', 'quotation_events', 'vendor_request_events', 'cs_case_events', 'wh_events',
                           'user_assignments', 'vendor_rate_versions', 'quotation_versions', 'quotation_responses'] loop
    if to_regclass(t) is not null then
      execute format('drop trigger if exists %I on %I', t || '_append_only', t);
      execute format('create trigger %I before update or delete on %I for each row execute function history_is_append_only()', t || '_append_only', t);
    end if;
  end loop;
end $$;

-- ---------- 9. Lock the new tables like the rest (Supabase) ---------------------------------------------
alter table user_assignments enable row level security;
alter table customer_salesmen enable row level security;
alter table vendor_regions enable row level security;
alter table vendor_rate_charges enable row level security;
alter table vendor_rate_versions enable row level security;
alter table quotation_versions enable row level security;
alter table quotation_responses enable row level security;
alter table prealerts enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on user_assignments, customer_salesmen, vendor_regions, vendor_rate_charges, vendor_rate_versions,
             quotation_versions, quotation_responses, prealerts from anon, authenticated';
    execute 'revoke all on sequence enquiry_ref_seq, shipping_ref_seq, user_assignments_id_seq, vendor_rate_versions_id_seq,
             quotation_versions_id_seq, quotation_responses_id_seq from anon, authenticated';
  end if;
end $$;

insert into schema_migrations (name) values ('018_commercials.sql') on conflict do nothing;
