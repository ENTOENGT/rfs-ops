-- 026 — Your workflow (Release K). Safe to run twice; nothing is deleted except the Customer Service role's old "see every
-- shipment" right, which the role had while retired (no one holds it now) and is replaced by "the shipments given to me".

-- ================================================================ Step 6: Customer Service owns the shipment after confirmation
insert into departments (code, name, side) values ('customer_service', 'Customer Service', 'operations') on conflict (code) do nothing;

-- the retired Customer Service role comes back (the same row — no duplicate), now belonging to the Customer Service department
update roles set retired_at = null,
    department_id = (select id from departments where code = 'customer_service'),
    description = 'Owns confirmed shipments: booking with the agent, vessel, BL, pre-alert, handover; follows up with Ops, Documentation and Transport until delivery. Sees the selling price, not the profit.'
  where code = 'customer_service';
delete from role_permissions where permission_code = 'jobfiles.view_all' and role_id = (select id from roles where code = 'customer_service');
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['jobfiles.view_assigned', 'jobfiles.edit', 'jobfiles.handover', 'quotes.view', 'vendors.requests',
    'finance.buying.view', 'finance.selling.view', 'documents.upload', 'reports.view', 'reports.export', 'emails.view', 'lcl.view']) p
   where r.code = 'customer_service'
on conflict do nothing;

insert into roles (code, name, description, side, is_manager, department_id)
  select 'customer_service_manager', 'Customer Service Manager',
    'Runs Customer Service: sets the default handlers, gives confirmed shipments to the team, sees the whole team''s shipments.',
    'operations', true, (select id from departments where code = 'customer_service')
   where not exists (select 1 from roles where code = 'customer_service_manager');
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['jobfiles.view_assigned', 'jobfiles.view_team', 'jobfiles.edit', 'jobfiles.handover', 'quotes.view',
    'vendors.requests', 'finance.buying.view', 'finance.selling.view', 'documents.upload', 'reports.view', 'reports.export', 'emails.view', 'lcl.view',
    'jobs.view', 'jobs.view_all', 'pro.view_all', 'runs.view_all', 'customers.manage', 'customers.view_all', 'cases.view_all', 'cases.manage',
    'users.manage_department', 'roles.manage_department', 'users.view_team', 'users.manage_team']) p
   where r.code = 'customer_service_manager'
on conflict do nothing;
insert into role_assignable_roles (role_id, assignable_role_id)
  select m.id, r.id from roles m, roles r where m.code = 'customer_service_manager' and r.code = 'customer_service'
on conflict do nothing;
insert into designations (name, level) values ('Customer Service Executive', 60) on conflict do nothing;

-- who owns each confirmed shipment
alter table job_files add column if not exists cs_handler_id uuid references users(id);
alter table job_files add column if not exists cs_assigned_at timestamptz;
create index if not exists job_files_cs_idx on job_files (cs_handler_id) where deleted_at is null;

-- ---------------------------------------------------------------- default handlers (set once, not on every job)
-- one per team, and optionally one per customer of that team. A new job arriving in the team goes to the customer's handler,
-- else the team's handler, else it waits on the manager's "To assign" list.
create table if not exists default_handlers (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id),
  customer_id uuid references customers(id),
  user_id uuid not null references users(id),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists default_handlers_uq on default_handlers (department_id, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table default_handlers enable row level security;

-- ================================================================ Step 7: handover to the right Operations team, Ops and Documentation handlers
-- the four mode / direction teams come back (switched off in 018); Cross Trade gets its own team
update departments set is_active = true where code in ('sea_import', 'sea_export', 'air_import', 'air_export') and is_active is not true;
insert into departments (code, name, side) values ('cross_trade', 'Cross Trade', 'operations') on conflict (code) do nothing;

-- which team receives each kind of shipment at handover (Settings; the Super Admin can change it). mode null = any mode.
create table if not exists handover_routes (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('import', 'export', 'cross_trade', 'domestic')),
  mode text,
  department_id uuid not null references departments(id),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists handover_routes_uq on handover_routes (direction, coalesce(mode, '*'));
alter table handover_routes enable row level security;
insert into handover_routes (direction, mode, department_id)
  select x.dir, x.mode, d.id from (values
    ('import', 'sea_fcl', 'sea_import'), ('export', 'sea_fcl', 'sea_export'),
    ('import', 'sea_lcl', 'lcl'), ('export', 'sea_lcl', 'lcl'),
    ('import', 'air', 'air_import'), ('export', 'air', 'air_export'),
    ('cross_trade', null, 'cross_trade'),
    ('import', null, 'operations'), ('export', null, 'operations'), ('domestic', null, 'operations')
  ) x(dir, mode, dept) join departments d on d.code = x.dept
on conflict do nothing;

-- Documentation members: same rights as an Operations sub-user, in the Documentation team (they see jobs once the DO is in)
insert into roles (code, name, description, side, department_id)
  select 'documentation_executive', 'Documentation Executive', 'Customs bills (BOE), inspections with PRO, clearance — from the DO until cleared.',
    'operations', (select id from departments where code = 'documentations')
   where not exists (select 1 from roles where code = 'documentation_executive');
insert into role_permissions (role_id, permission_code)
  select d.id, rp.permission_code from roles d, role_permissions rp join roles o on o.id = rp.role_id
   where d.code = 'documentation_executive' and o.code = 'operations' and rp.permission_code <> 'jobfiles.view_handed_over'
on conflict do nothing;
insert into role_assignable_roles (role_id, assignable_role_id)
  select m.id, r.id from roles m, roles r where m.code = 'documentation_manager' and r.code = 'documentation_executive'
on conflict do nothing;

-- the Ops and Documentation owners of a job, and the dated handoffs between them
alter table job_files add column if not exists ops_handler_id uuid references users(id);
alter table job_files add column if not exists ops_assigned_at timestamptz;
alter table job_files add column if not exists docs_handler_id uuid references users(id);
alter table job_files add column if not exists docs_assigned_at timestamptz;
alter table job_files add column if not exists do_received_at timestamptz;      -- Ops: DO in hand → Documentation starts
alter table job_files add column if not exists docs_cleared_at timestamptz;     -- Documentation: cleared → back to Ops for collection / delivery
create index if not exists job_files_ops_idx on job_files (ops_handler_id) where deleted_at is null;
create index if not exists job_files_docs_idx on job_files (docs_handler_id) where deleted_at is null;

-- ================================================================ Step 8: Cross Trade agents, Clearance & Delivery jobs
-- the agent at each end of a shipment (a vendor), or "Ourselves" when RFS acts as the agent there
alter table job_files add column if not exists origin_agent_id uuid references vendors(id);
alter table job_files add column if not exists destination_agent_id uuid references vendors(id);
alter table job_files add column if not exists origin_is_us boolean not null default false;
alter table job_files add column if not exists destination_is_us boolean not null default false;
-- Clearance & Delivery: no freight; starts at Documentation (or with whoever it is given to, e.g. a Salesman), who clear it and raise the transport
alter table job_files add column if not exists job_type text not null default 'freight';
do $$ begin
  alter table job_files add constraint job_files_job_type_check check (job_type in ('freight', 'clearance_delivery'));
exception when duplicate_object then null; end $$;

insert into schema_migrations (name) values ('026_workflow.sql') on conflict do nothing;
