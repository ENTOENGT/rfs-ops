-- 047 (26 Nov, commit 3 of 3) — granular permissions and the vendor availability check. Safe to run twice; nothing is removed.

-- 1. Finer permissions. The old "Manage" tick still means everything in its module; the new ticks give one action only.
--    Everyone who had "Manage" (or could create quotations) keeps exactly what they could do before.
insert into permissions (code, module, name, sensitivity, action) values
  ('local_charges.view',   'Local charges & rate cards', 'View local charges rate cards', 'commercial', 'view'),
  ('local_charges.create', 'Local charges & rate cards', 'Add new local charges rate cards', 'commercial', 'create'),
  ('local_charges.edit',   'Local charges & rate cards', 'Change local charges and their rates', 'commercial', 'edit'),
  ('vendors.view',   'Vendors', 'View vendors', 'general', 'view'),
  ('vendors.create', 'Vendors', 'Add vendors', 'general', 'create'),
  ('vendors.edit',   'Vendors', 'Change vendors', 'general', 'edit'),
  ('vendors.delete', 'Vendors', 'Remove vendors', 'general', 'delete'),
  ('customers.create', 'Customers', 'Add customers', 'general', 'create'),
  ('customers.edit',   'Customers', 'Change customers and their contacts', 'general', 'edit'),
  ('customers.delete', 'Customers', 'Remove customers', 'general', 'delete'),
  ('templates.view', 'Email templates & quotation terms', 'View email templates and quotation terms', 'general', 'view'),
  ('templates.edit', 'Email templates & quotation terms', 'Change email templates and quotation terms', 'general', 'edit'),
  ('quotes.edit',   'Customer quotations', 'Change, send and follow up quotations', 'commercial', 'edit'),
  ('quotes.cancel', 'Customer quotations', 'Cancel quotations', 'commercial', 'delete')
on conflict (code) do nothing;

-- the screen groups ticks by module: clearer names for the modules asked about
update permissions set module = 'Local charges & rate cards', name = 'Manage local charges (everything)' where code = 'local_charges.manage';
update permissions set module = 'Customers', name = 'Manage customers (everything)' where code = 'customers.manage';
update permissions set name = 'Manage vendors (everything)' where code = 'vendors.manage';
update permissions set module = 'Vendor rate requests' where code in ('vendors.requests', 'rates.agent_coordination');
update permissions set module = 'Email templates & quotation terms', name = 'Manage templates (everything)' where code = 'templates.manage';
update permissions set module = 'Customer quotations' where module = 'Quotations';
update permissions set module = 'Enquiries & Job Files' where module = 'Job Files';
update permissions set name = 'Create quotations and copies' where code = 'quotes.create';

-- keep everyone's access: roles and personal ticks with the broad right get the new fine ones
do $$
declare m record;
begin
  for m in select * from (values
      ('local_charges.manage', array['local_charges.view', 'local_charges.create', 'local_charges.edit']),
      ('vendors.manage', array['vendors.view', 'vendors.create', 'vendors.edit', 'vendors.delete']),
      ('customers.manage', array['customers.create', 'customers.edit', 'customers.delete']),
      ('templates.manage', array['templates.view', 'templates.edit']),
      ('quotes.create', array['quotes.edit', 'quotes.cancel'])) t(broad, fine)
  loop
    -- once only: a role the admin later narrows is not widened again on a second run
    if not exists (select 1 from schema_migrations where name = '047_permissions_and_booking.sql') then
      insert into role_permissions (role_id, permission_code)
        select rp.role_id, f from role_permissions rp, unnest(m.fine) f where rp.permission_code = m.broad
      on conflict do nothing;
      insert into user_permission_overrides (user_id, permission_code, granted)
        select o.user_id, f, o.granted from user_permission_overrides o, unnest(m.fine) f where o.permission_code = m.broad
      on conflict do nothing;
    end if;
  end loop;
end $$;

-- 2. The vendor availability check after the customer approves an option (Point 13). One row per check; a new check
--    (e.g. after the vendor offered the next sailing) is a new row, the old ones stay as history.
create table if not exists availability_checks (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  quotation_id uuid references quotations(id),
  route_id uuid references enquiry_routes(id),
  vendor_request_id uuid references vendor_requests(id),
  status text not null default 'to_send' check (status in ('to_send', 'sent', 'confirmed', 'unavailable', 'cancelled')),
  reason text,                         -- what the vendor said when it is not available
  alternative text,                    -- the next sailing / other routing the vendor offered, if any
  sent_at timestamptz, answered_at timestamptz, answered_by uuid references users(id), answer_source text,
  created_by uuid references users(id), created_at timestamptz not null default now()
);
create index if not exists availability_checks_file on availability_checks (job_file_id, created_at);
alter table availability_checks enable row level security;

insert into schema_migrations (name) values ('047_permissions_and_booking.sql') on conflict do nothing;
