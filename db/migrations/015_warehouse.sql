-- 015 — Warehouse (3PL) core: warehouses and bins, customer-owned SKUs, goods receipts (GRN), put-away and bin
--        moves, stock ledger, adjustments, outbound orders (reserve → pick → pack → dispatch). Safe to run more than once.
--
-- Golden rule: stock_balances change ONLY together with a row in inventory_transactions (the ledger), inside one
-- database transaction, by the app's single posting function. The database itself refuses negative stock and
-- more reserved than on hand, and the ledger cannot be edited or deleted.
-- Stock quantities and records only — valuation and accounting stay in the ERP.

-- ---------- permissions + roles ------------------------------------------------------------------
insert into permissions (code, module, name, sensitivity) values
  ('warehouse.view', 'Warehouse', 'View stock, receipts and outbound orders', 'general'),
  ('warehouse.receive', 'Warehouse', 'Receive goods (GRN)', 'general'),
  ('warehouse.move', 'Warehouse', 'Put away and move stock between bins', 'general'),
  ('warehouse.dispatch', 'Warehouse', 'Pick, pack and dispatch outbound orders', 'general'),
  ('warehouse.adjust', 'Warehouse', 'Adjust stock and change its condition (damaged / quarantine)', 'general'),
  ('warehouse.configure', 'Warehouse', 'Set up warehouses, bins and SKUs', 'admin'),
  ('warehouse.orders.create', 'Warehouse', 'Create and cancel outbound orders for customers', 'general')
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['warehouse.view','warehouse.receive','warehouse.move','warehouse.dispatch','warehouse.adjust',
    'warehouse.configure','warehouse.orders.create']) p where r.code = 'warehouse_manager'
union all
  select r.id, p from roles r, unnest(array['warehouse.view','warehouse.receive','warehouse.move','warehouse.dispatch']) p where r.code = 'warehouse_operator'
union all
  select r.id, p from roles r, unnest(array['warehouse.view','warehouse.orders.create']) p
   where r.code in ('operations_manager','documentation_manager','operations','freight_ops','customer_service')
union all
  select r.id, 'warehouse.view' from roles r where r.code in ('finance','erp_admin','transport_manager')
on conflict do nothing;

-- ---------- where stock lives ------------------------------------------------------------------
create table if not exists warehouses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists warehouse_locations (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references warehouses(id),
  code text not null,                                   -- e.g. A-01-02 (zone-aisle-rack/bin)
  zone text,
  location_type text not null default 'storage'
    check (location_type in ('receiving', 'storage', 'dispatch', 'quarantine', 'damaged')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists wl_code_uq on warehouse_locations (warehouse_id, upper(code));

-- ---------- what is stored (each SKU belongs to one customer) -------------------------------------
create table if not exists skus (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  sku_code text not null,
  name text not null,
  barcode text,
  uom text not null default 'piece' check (uom in ('piece', 'carton', 'pallet', 'kg', 'litre', 'set')),
  units_per_carton integer check (units_per_carton is null or units_per_carton > 0),
  track_batch boolean not null default false,
  track_expiry boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists sku_code_uq on skus (customer_id, upper(btrim(sku_code)));
create index if not exists sku_barcode_idx on skus (barcode);

-- ---------- stock on hand: one row per bin + SKU + batch + expiry + condition ---------------------
create table if not exists stock_balances (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references warehouses(id),
  location_id uuid not null references warehouse_locations(id),
  sku_id uuid not null references skus(id),
  customer_id uuid not null references customers(id),
  batch_no text not null default '',
  expiry_date date,
  condition text not null default 'good' check (condition in ('good', 'damaged', 'quarantine')),
  qty_on_hand numeric(14,3) not null default 0,
  qty_reserved numeric(14,3) not null default 0,
  first_received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sb_no_negative check (qty_on_hand >= 0),
  constraint sb_reserved_ok check (qty_reserved >= 0 and qty_reserved <= qty_on_hand)
);
create unique index if not exists sb_key_uq on stock_balances (location_id, sku_id, batch_no, coalesce(expiry_date, '0001-01-01'::date), condition);
create index if not exists sb_sku_idx on stock_balances (sku_id);
create index if not exists sb_customer_idx on stock_balances (customer_id, warehouse_id);

-- ---------- the ledger: every movement, never changed ---------------------------------------------
create table if not exists inventory_transactions (
  id bigserial primary key,
  at timestamptz not null default now(),
  warehouse_id uuid not null references warehouses(id),
  location_id uuid not null references warehouse_locations(id),
  sku_id uuid not null references skus(id),
  customer_id uuid not null references customers(id),
  batch_no text not null default '',
  expiry_date date,
  condition text not null,
  qty_change numeric(14,3) not null check (qty_change <> 0),
  balance_after numeric(14,3) not null,
  kind text not null check (kind in ('receipt', 'move_out', 'move_in', 'adjust', 'condition_out', 'condition_in', 'dispatch')),
  source_type text not null check (source_type in ('grn', 'move', 'adjustment', 'order')),
  source_id text,
  reference text,                                       -- GRN-1001, WO-1001 …
  reason text,
  user_id uuid references users(id),
  user_name text
);
create index if not exists it_sku_idx on inventory_transactions (sku_id, at);
create index if not exists it_customer_idx on inventory_transactions (customer_id, at);
create index if not exists it_source_idx on inventory_transactions (source_type, source_id);
create or replace function inventory_ledger_immutable() returns trigger language plpgsql as $$
begin raise exception 'inventory_transactions is append-only'; end $$;
drop trigger if exists it_no_change on inventory_transactions;
create trigger it_no_change before update or delete on inventory_transactions for each row execute function inventory_ledger_immutable();

-- ---------- goods receipts (GRN) -------------------------------------------------------------------
create sequence if not exists grn_no_seq start 1001;
create table if not exists grns (
  id uuid primary key default gen_random_uuid(),
  grn_no text not null unique,
  warehouse_id uuid not null references warehouses(id),
  customer_id uuid not null references customers(id),
  job_file_id uuid references job_files(id),
  supplier text,
  reference text,                                       -- ASN / delivery note / container no.
  expected_date date,
  status text not null default 'expected' check (status in ('expected', 'received', 'cancelled')),
  remarks text,
  cancel_reason text,
  created_by uuid not null references users(id),
  received_by uuid references users(id),
  received_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists grn_status_idx on grns (status, warehouse_id);
create table if not exists grn_lines (
  id uuid primary key default gen_random_uuid(),
  grn_id uuid not null references grns(id),
  sku_id uuid not null references skus(id),
  expected_qty numeric(14,3) not null check (expected_qty >= 0),
  received_qty numeric(14,3) check (received_qty is null or received_qty >= 0),
  damaged_qty numeric(14,3) check (damaged_qty is null or damaged_qty >= 0),
  batch_no text, expiry_date date,
  location_id uuid references warehouse_locations(id),
  remarks text,
  sort_order integer not null default 0
);
create index if not exists grnl_grn_idx on grn_lines (grn_id);

-- ---------- outbound orders: reserve → pick → pack → dispatch ---------------------------------------
create sequence if not exists wh_order_no_seq start 1001;
create table if not exists wh_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,                        -- WO-1001
  warehouse_id uuid not null references warehouses(id),
  customer_id uuid not null references customers(id),
  job_file_id uuid references job_files(id),
  customer_reference text,
  ship_to_name text not null,
  ship_to_address text,
  ship_to_contact text,
  ship_to_phone text,
  required_date date,
  status text not null default 'open' check (status in ('open', 'reserved', 'picked', 'packed', 'dispatched', 'cancelled')),
  packages integer, gross_weight_kg numeric(12,2),
  dispatch_reference text,                              -- vehicle / courier AWB / TR no.
  cancel_reason text,
  remarks text,
  created_by uuid not null references users(id),
  picked_by uuid references users(id), picked_at timestamptz,
  packed_by uuid references users(id), packed_at timestamptz,
  dispatched_by uuid references users(id), dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists who_status_idx on wh_orders (status, warehouse_id);
create table if not exists wh_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references wh_orders(id),
  sku_id uuid not null references skus(id),
  qty numeric(14,3) not null check (qty > 0),
  sort_order integer not null default 0
);
create index if not exists whol_order_idx on wh_order_lines (order_id);
-- which stock row each line takes from (FEFO), and how much
create table if not exists wh_allocations (
  id uuid primary key default gen_random_uuid(),
  order_line_id uuid not null references wh_order_lines(id),
  balance_id uuid not null references stock_balances(id),
  qty numeric(14,3) not null check (qty > 0)
);
create index if not exists wha_line_idx on wh_allocations (order_line_id);

-- ---------- history of receipts and orders ------------------------------------------------------
create table if not exists wh_events (
  id bigserial primary key,
  grn_id uuid references grns(id),
  order_id uuid references wh_orders(id),
  title text not null,
  details text,
  user_id uuid references users(id),
  user_name text,
  at timestamptz not null default now()
);
create index if not exists whe_grn_idx on wh_events (grn_id, at);
create index if not exists whe_order_idx on wh_events (order_id, at);

-- a starting warehouse with the standard areas (rename or add more in Warehouse → Setup)
insert into warehouses (code, name) values ('WH1', 'Main warehouse') on conflict (code) do nothing;
insert into warehouse_locations (warehouse_id, code, zone, location_type)
  select w.id, x.code, x.zone, x.t from warehouses w,
    (values ('RECEIVING', 'Dock', 'receiving'), ('DISPATCH', 'Dock', 'dispatch'), ('QUARANTINE', 'Hold', 'quarantine'), ('DAMAGED', 'Hold', 'damaged')) as x(code, zone, t)
  where w.code = 'WH1'
on conflict do nothing;

-- ---------- lock away from Supabase's public API ---------------------------------------------------
alter table warehouses enable row level security;
alter table warehouse_locations enable row level security;
alter table skus enable row level security;
alter table stock_balances enable row level security;
alter table inventory_transactions enable row level security;
alter table grns enable row level security;
alter table grn_lines enable row level security;
alter table wh_orders enable row level security;
alter table wh_order_lines enable row level security;
alter table wh_allocations enable row level security;
alter table wh_events enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on warehouses, warehouse_locations, skus, stock_balances, inventory_transactions, grns, grn_lines,
      wh_orders, wh_order_lines, wh_allocations, wh_events from anon, authenticated';
    execute 'revoke all on sequence grn_no_seq, wh_order_no_seq, inventory_transactions_id_seq, wh_events_id_seq from anon, authenticated';
    execute 'revoke execute on function inventory_ledger_immutable() from anon, authenticated';
  end if;
end $$;

update users set token_version = token_version + 1
  where role_id in (select id from roles where code in ('warehouse_manager','warehouse_operator','operations_manager','documentation_manager',
    'operations','freight_ops','customer_service','finance','erp_admin','transport_manager'));

insert into schema_migrations (name) values ('015_warehouse.sql') on conflict do nothing;
