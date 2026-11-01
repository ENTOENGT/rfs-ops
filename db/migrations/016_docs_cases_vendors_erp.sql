-- 016 — Freight + 3PL Part C: Job File documents + checklists, customer service cases, vendor coordination,
--        ERP export (files for the ERP, with a log that never sends the same record twice). Safe to run more than once.
-- Nothing financial is booked here: the ERP stays the system of record for invoices and accounts.

-- =========================================================== permissions + roles
insert into permissions (code, module, name, sensitivity) values
  ('documents.approve', 'Documents', 'Approve / reject Job File documents and waive a required one', 'general'),
  ('cases.view_all', 'Customer service', 'View all customer service cases', 'general'),
  ('cases.manage', 'Customer service', 'Create and work on customer service cases', 'general'),
  ('cases.escalations', 'Customer service', 'Receive escalations of overdue cases', 'general'),
  ('vendors.manage', 'Vendors', 'Manage the vendor list (shipping lines, airlines, agents, brokers…)', 'general'),
  ('vendors.requests', 'Vendors', 'Create and follow vendor service requests and bookings', 'general'),
  ('erp.view', 'ERP', 'See what is ready for, and was sent to, the ERP', 'commercial'),
  ('erp.export', 'ERP', 'Create ERP export files and record the ERP result', 'commercial')
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['documents.approve','cases.manage','cases.escalations','vendors.manage','vendors.requests']) p
   where r.code in ('operations_manager','documentation_manager')
union all
  select r.id, p from roles r, unnest(array['cases.view_all','cases.manage','cases.escalations']) p where r.code = 'customer_service'
union all
  select r.id, p from roles r, unnest(array['cases.manage','vendors.requests']) p where r.code in ('operations','freight_ops','sales')
union all
  select r.id, 'documents.approve' from roles r where r.code = 'freight_ops'
union all
  select r.id, p from roles r, unnest(array['vendors.manage','vendors.requests']) p where r.code = 'transport_manager'
union all
  select r.id, p from roles r, unnest(array['erp.view','erp.export']) p where r.code in ('erp_admin','finance')
union all
  select r.id, 'cases.view_all' from roles r where r.code = 'finance'
on conflict do nothing;

-- =========================================================== A. Job File documents + checklists
-- Which documents a Job File needs, by direction / mode / service. Blank = applies to all.
create table if not exists doc_requirements (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null,                    -- key, e.g. bill_of_lading
  name text not null,                        -- label shown to people
  direction text,                            -- import / export / cross_trade / domestic, or null = any
  mode_group text check (mode_group is null or mode_group in ('sea', 'air', 'road')),
  needs text check (needs is null or needs in ('clearance', 'transport', 'warehouse')),
  sort_order integer not null default 0,
  is_active boolean not null default true
);
create unique index if not exists dr_uq on doc_requirements (doc_type, coalesce(direction, ''), coalesce(mode_group, ''), coalesce(needs, ''));
insert into doc_requirements (doc_type, name, direction, mode_group, needs, sort_order) values
  ('commercial_invoice', 'Commercial invoice', null, null, null, 10),
  ('packing_list', 'Packing list', null, null, null, 20),
  ('bill_of_lading', 'Bill of lading (BL)', null, 'sea', null, 30),
  ('air_waybill', 'Air waybill (AWB)', null, 'air', null, 30),
  ('cmr', 'Road consignment note (CMR)', null, 'road', null, 30),
  ('certificate_of_origin', 'Certificate of origin', 'import', null, 'clearance', 40),
  ('delivery_order', 'Delivery order', 'import', 'sea', null, 50),
  ('customs_declaration', 'Customs declaration / BOE', null, null, 'clearance', 60),
  ('pod', 'Proof of delivery', null, null, 'transport', 70)
on conflict do nothing;

create table if not exists jf_documents (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  doc_type text not null,
  file_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null,
  version integer not null default 1,
  replaces_id uuid references jf_documents(id),
  replaced_at timestamptz,
  issue_date date, expiry_date date,
  description text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_note text,
  reviewed_by uuid references users(id), reviewed_at timestamptz,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz, deleted_by uuid references users(id)
);
create index if not exists jfd_file_idx on jf_documents (job_file_id) where deleted_at is null;
-- A required document someone decided this file does not need (with who and why)
create table if not exists jf_doc_waivers (
  job_file_id uuid not null references job_files(id),
  doc_type text not null,
  reason text not null,
  waived_by uuid references users(id),
  waived_at timestamptz not null default now(),
  primary key (job_file_id, doc_type)
);
insert into settings (key, value) values ('jobfile_docs_required_to_close', 'true') on conflict (key) do nothing;

-- =========================================================== B. Customer service cases
create sequence if not exists cs_case_no_seq start 1001;
create table if not exists cs_cases (
  id uuid primary key default gen_random_uuid(),
  case_no text not null unique,               -- CS-1001
  customer_id uuid not null references customers(id),
  job_file_id uuid references job_files(id),
  department_id uuid references departments(id),
  contact_name text, contact_detail text,
  channel text not null default 'phone' check (channel in ('phone', 'email', 'whatsapp', 'walk_in', 'portal', 'other')),
  kind text not null default 'enquiry' check (kind in ('enquiry', 'complaint', 'delay', 'damage', 'documents', 'other')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  subject text not null,
  description text,
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed')),
  owner_id uuid references users(id),
  due_at timestamptz not null,                -- SLA: when it must be resolved (moves while waiting for the customer)
  waiting_since timestamptz,
  first_response_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  escalated_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cs_status_idx on cs_cases (status, due_at);
create index if not exists cs_customer_idx on cs_cases (customer_id);
create table if not exists cs_case_events (
  id bigserial primary key,
  case_id uuid not null references cs_cases(id),
  title text not null, details text,
  user_id uuid references users(id), user_name text,
  at timestamptz not null default now()
);
create index if not exists cse_case_idx on cs_case_events (case_id, at);
insert into settings (key, value) values ('cs_sla_hours', '{"urgent": 4, "high": 8, "normal": 24, "low": 72}') on conflict (key) do nothing;
alter table notifications add column if not exists case_id uuid references cs_cases(id);

-- =========================================================== C. Vendors and vendor service requests
create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vendor_type text not null default 'other'
    check (vendor_type in ('shipping_line', 'airline', 'freight_agent', 'customs_broker', 'transporter', 'warehouse', 'courier', 'other')),
  contact_person text, contact_number text, email text, trn text, address text, remarks text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists vendors_name_uq on vendors (upper(btrim(name))) where deleted_at is null;
create sequence if not exists vendor_request_no_seq start 1001;
create table if not exists vendor_requests (
  id uuid primary key default gen_random_uuid(),
  request_no text not null unique,            -- VR-1001
  vendor_id uuid not null references vendors(id),
  job_file_id uuid references job_files(id),
  department_id uuid references departments(id),
  service text not null check (service in ('booking', 'trucking', 'customs', 'warehousing', 'courier', 'documentation', 'other')),
  description text not null,
  needed_by date,
  status text not null default 'requested'
    check (status in ('requested', 'quoted', 'confirmed', 'in_progress', 'completed', 'cancelled', 'disputed')),
  vendor_reference text,                      -- booking no., their quote no., AWB…
  quoted_cost numeric(14,2) check (quoted_cost is null or quoted_cost >= 0),   -- what we pay (cost) — cost viewers only
  currency text not null default 'AED',
  confirmed_at timestamptz,
  completed_at timestamptz,
  completion_note text,
  issue_note text,                            -- delay / dispute details
  cancel_reason text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vr_vendor_idx on vendor_requests (vendor_id, status);
create index if not exists vr_job_file_idx on vendor_requests (job_file_id);
create table if not exists vendor_request_events (
  id bigserial primary key,
  request_id uuid not null references vendor_requests(id),
  title text not null, details text,
  user_id uuid references users(id), user_name text,
  at timestamptz not null default now()
);
create index if not exists vre_req_idx on vendor_request_events (request_id, at);

-- =========================================================== D. ERP export
-- Each finished piece of work is exported at most once (unique source), unless the ERP rejected it.
create sequence if not exists erp_batch_no_seq start 1001;
create table if not exists erp_batches (
  id uuid primary key default gen_random_uuid(),
  batch_no text not null unique,              -- ERP-1001
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  record_count integer not null default 0,
  status text not null default 'exported' check (status in ('exported', 'confirmed', 'partly_rejected')),
  erp_reference text,                         -- the ERP's import / journal number, typed back by the user
  confirmed_by uuid references users(id), confirmed_at timestamptz,
  note text
);
create table if not exists erp_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references erp_batches(id),
  source_type text not null check (source_type in ('trip', 'pro', 'grn', 'dispatch', 'vendor')),
  source_id uuid not null,
  external_ref text not null,                 -- stable reference the ERP can match on, e.g. RFSOPS-TRIP-TR-1004
  status text not null default 'exported' check (status in ('exported', 'confirmed', 'rejected')),
  reject_reason text,
  payload jsonb not null,                     -- exactly what was in the file
  created_at timestamptz not null default now()
);
create unique index if not exists erp_items_live_uq on erp_items (source_type, source_id) where status <> 'rejected';
create index if not exists erp_items_batch_idx on erp_items (batch_id);

-- =========================================================== lock down
do $$
declare t text;
begin
  foreach t in array array['doc_requirements','jf_documents','jf_doc_waivers','cs_cases','cs_case_events','vendors','vendor_requests',
                           'vendor_request_events','erp_batches','erp_items'] loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on %I from anon, authenticated', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on sequence cs_case_no_seq, vendor_request_no_seq, erp_batch_no_seq, cs_case_events_id_seq, vendor_request_events_id_seq from anon, authenticated';
  end if;
end $$;

update users set token_version = token_version + 1
  where role_id in (select id from roles where code in ('operations_manager','documentation_manager','customer_service','operations','freight_ops',
    'sales','transport_manager','erp_admin','finance'));

insert into schema_migrations (name) values ('016_docs_cases_vendors_erp.sql') on conflict do nothing;
