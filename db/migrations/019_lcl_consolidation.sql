-- 019 — LCL consolidation (Part F). Safe to run more than once. Only adds; nothing is deleted.
--
--   ONE consolidation = one container, one carrier booking, one Master BL (MBL)
--     └─ many house shipments, each with its own House BL (HBL) and its own cargo owner:
--          own customer  → linked to its shipment record (Enquiry Ref / Shipping Ref / Job No., Salesman, Coordinator)
--          partner agent → the agent's vendor record; shipper / consignee written on the house shipment only
--          other party   → shipper / consignee written on the house shipment only
--   Cargo is received into an existing warehouse and bin (packages / weight / CBM — not the 3PL stock ledger),
--   partly if needed; declared figures stay, differences are recorded. Then verified → stuffed → sealed → dispatched.
--   Departure / arrival of the container fills the linked shipments' own dates only where they are still empty.

create sequence if not exists consolidation_ref_seq start 1;

-- capacity of each container type, for utilisation (editable later)
create table if not exists container_types (
  code text primary key,
  name text not null,
  capacity_cbm numeric(8,2) not null check (capacity_cbm > 0),
  max_payload_kg numeric(10,2) check (max_payload_kg is null or max_payload_kg > 0),
  sort_order integer not null default 0
);
insert into container_types (code, name, capacity_cbm, max_payload_kg, sort_order) values
  ('20GP', '20'' standard', 33.2, 28200, 1), ('40GP', '40'' standard', 67.7, 26600, 2),
  ('40HC', '40'' high cube', 76.3, 26500, 3), ('45HC', '45'' high cube', 86.0, 27600, 4)
on conflict (code) do nothing;

create table if not exists consolidations (
  id uuid primary key default gen_random_uuid(),
  con_ref text not null unique,                          -- CON-26-00001
  division text check (division is null or division in ('imports', 'exports', 'cross_trade')),
  direction text not null default 'export' check (direction in ('import', 'export', 'cross_trade')),
  origin text, destination text, pol text, pod text,
  carrier text,                                          -- shipping line name as on the booking
  carrier_vendor_id uuid references vendors(id),         -- the shipping line / co-loader as a vendor, if any
  carrier_booking_id text,
  container_type text references container_types(code),
  container_no text, seal_no text, mbl_no text,
  etd date, eta date, atd timestamptz, ata timestamptz,
  cutoff_date date,                                      -- consolidation cut-off
  receiving_deadline date,                               -- last day to receive cargo
  stuffing_date date,                                    -- planned
  warehouse_id uuid references warehouses(id),           -- where the cargo is received and stuffed
  status text not null default 'open' check (status in ('open', 'ready', 'stuffing', 'stuffed', 'sealed', 'dispatched', 'departed', 'arrived', 'closed', 'cancelled')),
  booking_confirmed_at timestamptz, stuffing_started_at timestamptz, stuffed_at timestamptz, stuffed_by uuid references users(id),
  sealed_at timestamptz, dispatched_at timestamptz, closed_at timestamptz,
  cancel_reason text, remarks text,
  search_text text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists con_status_idx on consolidations (status) where deleted_at is null;
create index if not exists con_etd_idx on consolidations (etd) where deleted_at is null;
-- the same container or MBL can't be in two live consolidations
create unique index if not exists con_mbl_uq on consolidations (upper(btrim(mbl_no))) where mbl_no is not null and status <> 'cancelled' and deleted_at is null;
create unique index if not exists con_container_uq on consolidations (upper(btrim(container_no))) where container_no is not null and status not in ('cancelled', 'closed') and deleted_at is null;

create table if not exists consolidation_shipments (
  id uuid primary key default gen_random_uuid(),
  consolidation_id uuid not null references consolidations(id),
  owner_type text not null check (owner_type in ('own_customer', 'partner_agent', 'other')),
  job_file_id uuid references job_files(id),             -- own customer: the shipment record
  customer_id uuid references customers(id),
  partner_vendor_id uuid references vendors(id),         -- partner agent
  shipper text, consignee text, notify_party text,
  hbl_no text,
  cargo_description text not null,
  packages integer not null check (packages > 0),
  package_type text,
  gross_weight_kg numeric(12,2) not null check (gross_weight_kg >= 0),
  volume_cbm numeric(10,3) not null check (volume_cbm >= 0),
  dimensions text, marks text, special_handling text, remarks text,
  expected_arrival date,
  receiving_status text not null default 'expected' check (receiving_status in ('expected', 'partial', 'received', 'discrepancy')),
  cargo_verified_at timestamptz, cargo_verified_by uuid references users(id),
  stuffing_status text not null default 'pending' check (stuffing_status in ('pending', 'stuffed', 'shut_out')),
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'delivered')),
  delivered_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid references users(id), removed_reason text,
  constraint cs_owner_chk check ((owner_type = 'own_customer' and customer_id is not null) or (owner_type = 'partner_agent' and partner_vendor_id is not null) or owner_type = 'other')
);
create index if not exists cshp_con_idx on consolidation_shipments (consolidation_id) where removed_at is null;
-- a shipment record is in one live consolidation only
create unique index if not exists cshp_file_uq on consolidation_shipments (job_file_id) where job_file_id is not null and removed_at is null;
-- an HBL number can't repeat for the same issuer (us, or the partner agent who issues it)
create unique index if not exists cshp_hbl_uq on consolidation_shipments (coalesce(partner_vendor_id::text, 'own'), upper(btrim(hbl_no))) where hbl_no is not null and removed_at is null;
create index if not exists cshp_hbl_idx on consolidation_shipments (upper(btrim(hbl_no))) where hbl_no is not null;

-- what the warehouse actually received (one row per arrival; several rows = partial deliveries)
create table if not exists lcl_receipts (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references consolidation_shipments(id),
  inward_ref text,
  received_at timestamptz not null default now(),
  packages integer not null check (packages >= 0),
  weight_kg numeric(12,2) not null default 0 check (weight_kg >= 0),
  volume_cbm numeric(10,3) not null default 0 check (volume_cbm >= 0),
  condition text not null default 'good' check (condition in ('good', 'damaged', 'wet', 'short', 'other')),
  damage_note text,
  location_id uuid references warehouse_locations(id),
  remarks text,
  received_by uuid not null references users(id), received_by_name text
);
create index if not exists lclr_shp_idx on lcl_receipts (shipment_id);

create table if not exists consolidation_documents (
  id uuid primary key default gen_random_uuid(),
  consolidation_id uuid not null references consolidations(id),
  shipment_id uuid references consolidation_shipments(id),     -- an HBL draft / final belongs to one house shipment
  doc_type text not null,
  file_name text not null, storage_path text not null, mime_type text not null, size_bytes integer not null,
  version integer not null default 1, replaces_id uuid references consolidation_documents(id), replaced_at timestamptz,
  description text,
  uploaded_by uuid not null references users(id), uploaded_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists cdoc_con_idx on consolidation_documents (consolidation_id) where deleted_at is null;

create table if not exists consolidation_events (
  id bigserial primary key,
  consolidation_id uuid not null references consolidations(id),
  shipment_id uuid references consolidation_shipments(id),
  title text not null, field text, old_value text, new_value text, remarks text,
  user_id uuid references users(id), user_name text,
  at timestamptz not null default now()
);
create index if not exists cev_con_idx on consolidation_events (consolidation_id, at);

-- history only grows (function from 018)
do $$ declare t text; begin
  foreach t in array array['consolidation_events', 'lcl_receipts'] loop
    execute format('drop trigger if exists %I on %I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on %I for each row execute function history_is_append_only()', t || '_append_only', t);
  end loop;
end $$;

-- permissions: no prices in LCL, so these are not commercial
insert into permissions (code, module, name, sensitivity) values
  ('lcl.view', 'LCL', 'See LCL consolidations, house shipments and registers', 'general'),
  ('lcl.manage', 'LCL', 'Create and change consolidations; add or remove house shipments; milestones', 'general'),
  ('lcl.receive', 'LCL', 'Receive LCL cargo in the warehouse and record differences', 'general'),
  ('lcl.stuff', 'LCL', 'Stuff, seal and dispatch the container', 'general')
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['lcl.view','lcl.manage']) p where r.code in ('commercials_manager', 'coordinator', 'operations_manager', 'freight_ops', 'operations')
union all
  select r.id, p from roles r, unnest(array['lcl.view','lcl.receive','lcl.stuff']) p where r.code in ('warehouse_manager', 'warehouse_operator')
union all
  select r.id, p from roles r, unnest(array['lcl.receive','lcl.stuff']) p where r.code in ('operations_manager', 'freight_ops')
union all
  select r.id, 'lcl.view' from roles r where r.code in ('customer_service', 'documentation_manager')
on conflict do nothing;

alter table container_types enable row level security;
alter table consolidations enable row level security;
alter table consolidation_shipments enable row level security;
alter table lcl_receipts enable row level security;
alter table consolidation_documents enable row level security;
alter table consolidation_events enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on container_types, consolidations, consolidation_shipments, lcl_receipts, consolidation_documents, consolidation_events from anon, authenticated';
    execute 'revoke all on sequence consolidation_ref_seq, consolidation_events_id_seq from anon, authenticated';
  end if;
end $$;

insert into schema_migrations (name) values ('019_lcl_consolidation.sql') on conflict do nothing;
