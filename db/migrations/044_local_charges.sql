-- 044 — our own local charges (clearance, transport, handling) as rate cards, added to quotations by themselves;
-- charges per BL / per document; "if applicable" lines (shown, not in the total). Safe to run twice; no data is removed.

-- 1. Quotation lines: two new ways of charging, and what kind of line it is
alter table quotation_lines drop constraint if exists quotation_lines_charge_unit_check;
alter table quotation_lines add constraint quotation_lines_charge_unit_check
  check (charge_unit in ('shipment', 'container', 'cbm', 'kg', 'trip', 'pallet', 'carton', 'day', 'lump_sum', 'bl', 'document'));
alter table quotation_lines add column if not exists section text not null default 'freight';     -- 'freight' (vendor rates…) or 'local' (our local charges)
alter table quotation_lines add column if not exists optional boolean not null default false;     -- "if applicable": shown to the customer, not in the total
alter table quotation_lines add column if not exists note text;                                   -- shown with the line, e.g. "as per receipt"
alter table quotation_lines add column if not exists internal_note text;                          -- staff only, e.g. what an all-in includes
alter table quotation_lines drop constraint if exists quotation_lines_section_chk;
alter table quotation_lines add constraint quotation_lines_section_chk check (section in ('freight', 'local'));

-- 2. The rate cards (our cost). One card per situation: mode, import / export, port / airport, airline, DG or not.
create table if not exists local_charge_cards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null,                      -- sea_fcl, sea_lcl, air, road…
  direction text not null check (direction in ('import', 'export')),
  places text,                             -- words of the port / airport it is for, e.g. "Jebel Ali, AEJEA"
  carriers text,                           -- words of the line / airline it is for ("Emirates, EK"); empty = any other
  dg text not null default 'no' check (dg in ('no', 'yes', 'any')),
  currency text not null default 'AED',
  notes text,
  is_active boolean not null default true,
  version int not null default 1,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  updated_by uuid references users(id), updated_at timestamptz not null default now()
);
create unique index if not exists local_charge_cards_name_uq on local_charge_cards (lower(name));
create table if not exists local_charge_lines (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references local_charge_cards(id),
  sort_order int not null default 0,
  description text not null,
  service text not null default 'clearance' check (service in ('clearance', 'transport', 'handling', 'other')),
  unit text not null check (unit in ('container', 'bl', 'document', 'kg', 'shipment', 'percent')),
  cost numeric(14,2),                      -- the amount (per unit); for containers when 20 / 40 ft are the same
  cost_20 numeric(14,2), cost_40 numeric(14,2),
  min_amount numeric(14,2),                -- e.g. per kg with a minimum
  dg_extra numeric(14,2),                  -- added per unit for DG cargo (e.g. THC +500 per container)
  tag text not null default 'always' check (tag in ('always', 'receipt', 'if_applicable')),
  sell_only boolean not null default false,-- our own selling charge (RFS handling): no cost, used when the customer has it
  note text
);
create index if not exists local_charge_lines_card on local_charge_lines (card_id, sort_order);
-- every saved version of a card, for "who changed what, when"
create table if not exists local_charge_history (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references local_charge_cards(id),
  version int not null, snapshot jsonb not null,
  user_id uuid references users(id), user_name text, at timestamptz not null default now()
);
alter table local_charge_cards enable row level security;
alter table local_charge_lines enable row level security;
alter table local_charge_history enable row level security;

-- 3. Who keeps the cards: admin (always), the commercial / operations / customer service team leaders, and anyone given the right one by one
insert into permissions (code, module, name, sensitivity, action) values
  ('local_charges.manage', 'Commercial', 'Manage the local charges rate cards (clearance, transport, handling)', 'commercial', 'manage')
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, 'local_charges.manage' from roles r where r.code in ('commercials_manager', 'operations_manager', 'customer_service_manager') and r.retired_at is null
on conflict do nothing;

-- 4. The six cards from the rate sheets (24 Nov). Only added when a card of that name is not there yet.
do $$
declare c uuid;
begin
  if not exists (select 1 from local_charge_cards where lower(name) = lower('Sea import FCL – Jebel Ali clearance')) then
    insert into local_charge_cards (name, mode, direction, places, dg) values ('Sea import FCL – Jebel Ali clearance', 'sea_fcl', 'import', 'Jebel Ali, AEJEA, JEA', 'any') returning id into c;
    insert into local_charge_lines (card_id, sort_order, description, service, unit, cost, cost_20, cost_40, min_amount, dg_extra, tag, sell_only) values
      (c, 1,  'Terminal handling (THC)', 'clearance', 'container', null, 700, 1100, null, 500, 'receipt', false),
      (c, 2,  'Port handling', 'clearance', 'container', 314, null, null, null, null, 'always', false),
      (c, 3,  'DPC', 'clearance', 'document', 55, null, null, null, null, 'always', false),
      (c, 4,  'Delivery order', 'clearance', 'bl', 580, null, null, null, null, 'receipt', false),
      (c, 5,  'Import declaration (FZE)', 'clearance', 'document', 105, null, null, null, null, 'always', false),
      (c, 6,  'Token', 'clearance', 'container', 50, null, null, null, null, 'always', false),
      (c, 7,  'Container maintenance / washing', 'clearance', 'container', 445, null, null, null, null, 'receipt', false),
      (c, 8,  'Gate pass', 'clearance', 'document', 73.50, null, null, null, null, 'always', false),
      (c, 9,  'Transportation Jebel Ali port to DIC', 'transport', 'container', 1250, null, null, null, null, 'always', false),
      (c, 10, 'RFS handling', 'handling', 'bl', 250, null, null, null, null, 'always', true),
      (c, 11, 'Inspection charges', 'clearance', 'container', 200, null, null, null, null, 'if_applicable', false),
      (c, 12, 'Trucking from Khorfakkan to Jebel Ali port', 'transport', 'container', 4650, null, null, null, null, 'if_applicable', false),
      (c, 13, 'Drop-off container charges', 'transport', 'container', null, 3685, 7370, null, null, 'if_applicable', false);
  end if;
  if not exists (select 1 from local_charge_cards where lower(name) = lower('Sea import FCL – Khorfakkan clearance')) then
    insert into local_charge_cards (name, mode, direction, places, dg) values ('Sea import FCL – Khorfakkan clearance', 'sea_fcl', 'import', 'Khorfakkan, Khor Fakkan, AEKLF, KFK', 'any') returning id into c;
    insert into local_charge_lines (card_id, sort_order, description, service, unit, cost, cost_20, cost_40, min_amount, dg_extra, tag, sell_only) values
      (c, 1,  'Terminal handling (THC)', 'clearance', 'container', null, 800, 1250, null, 500, 'receipt', false),
      (c, 2,  'Port handling', 'clearance', 'container', 400, null, null, null, null, 'always', false),
      (c, 3,  'DPC', 'clearance', 'document', 55, null, null, null, null, 'always', false),
      (c, 4,  'Delivery order', 'clearance', 'bl', 580, null, null, null, null, 'receipt', false),
      (c, 5,  'Import declaration (FZE)', 'clearance', 'document', 105, null, null, null, null, 'always', false),
      (c, 6,  'Token', 'clearance', 'container', 50, null, null, null, null, 'always', false),
      (c, 7,  'Container maintenance / washing', 'clearance', 'container', 445, null, null, null, null, 'receipt', false),
      (c, 8,  'Gate pass', 'clearance', 'document', 73.50, null, null, null, null, 'always', false),
      (c, 9,  'Transportation Khorfakkan to Jebel Ali warehouse', 'transport', 'container', 4100, null, null, null, null, 'always', false),
      (c, 10, 'RFS handling', 'handling', 'bl', 500, null, null, null, null, 'always', true),
      (c, 11, 'Inspection charges', 'clearance', 'container', 250, null, null, null, null, 'if_applicable', false),
      (c, 12, 'Drop-off container charges', 'transport', 'container', 2211, null, null, null, null, 'if_applicable', false);
  end if;
  if not exists (select 1 from local_charge_cards where lower(name) = lower('Air import – DNATA (non-DG)')) then
    insert into local_charge_cards (name, mode, direction, places, carriers, dg, notes) values ('Air import – DNATA (non-DG)', 'air', 'import', 'Dubai, DXB', null, 'no',
      'Storage after 48 hours free: day 3 AED 0.36/kg, day 4 and 5 AED 0.72/kg, day 6 onwards AED 0.92/kg (per day).') returning id into c;
    insert into local_charge_lines (card_id, sort_order, description, service, unit, cost, min_amount, tag, note) values
      (c, 1, 'Delivery order', 'clearance', 'bl', 152, null, 'always', null),
      (c, 2, 'Handling (H/D)', 'clearance', 'kg', 0.17, 34, 'always', null),
      (c, 3, 'Bill of entry', 'clearance', 'document', 105, null, 'always', null),
      (c, 4, 'DPA', 'clearance', 'document', 73.50, null, 'always', null),
      (c, 5, 'Gate pass', 'clearance', 'shipment', 20, null, 'always', null),
      (c, 6, 'Transportation up to Jebel Ali', 'transport', 'shipment', 250, null, 'always', null),
      (c, 7, 'Storage from day 3 (48 hours free)', 'clearance', 'kg', 0.36, null, 'if_applicable', 'per day; day 4–5 AED 0.72/kg, day 6 onwards AED 0.92/kg');
  end if;
  if not exists (select 1 from local_charge_cards where lower(name) = lower('Air import – DNATA (DG)')) then
    insert into local_charge_cards (name, mode, direction, places, carriers, dg) values ('Air import – DNATA (DG)', 'air', 'import', 'Dubai, DXB', null, 'yes') returning id into c;
    insert into local_charge_lines (card_id, sort_order, description, service, unit, cost, min_amount, tag, note) values
      (c, 1, 'Delivery order', 'clearance', 'bl', 169, null, 'always', null),
      (c, 2, 'Handling', 'clearance', 'kg', 0.26, 52, 'always', null),
      (c, 3, 'Break bulk', 'clearance', 'shipment', 150, null, 'always', null),
      (c, 4, 'EDP', 'clearance', 'document', 75, null, 'always', null),
      (c, 5, 'Bill of entry', 'clearance', 'document', 75, null, 'always', null),
      (c, 6, 'Gate pass', 'clearance', 'shipment', 20, null, 'always', null),
      (c, 7, 'Transportation within Dubai city', 'transport', 'shipment', 250, null, 'always', null),
      (c, 8, 'Storage (48 hours free)', 'clearance', 'kg', 0.45, 90, 'if_applicable', null),
      (c, 9, 'Customs duty 5% of invoice value', 'clearance', 'percent', 5, null, 'if_applicable', 'FTA / VAT approval required');
  end if;
  if not exists (select 1 from local_charge_cards where lower(name) = lower('Air import – Emirates (general)')) then
    insert into local_charge_cards (name, mode, direction, places, carriers, dg) values ('Air import – Emirates (general)', 'air', 'import', 'Dubai, DXB', 'Emirates, SkyCargo, EK, 176-', 'no') returning id into c;
    insert into local_charge_lines (card_id, sort_order, description, service, unit, cost, min_amount, tag, note) values
      (c, 1, 'Delivery order', 'clearance', 'bl', 113, null, 'always', null),
      (c, 2, 'Handling (H/D)', 'clearance', 'kg', 0.15, 30, 'always', null),
      (c, 3, 'Break bulk', 'clearance', 'shipment', 60, null, 'always', null),
      (c, 4, 'EDP', 'clearance', 'document', 75, null, 'always', null),
      (c, 5, 'Bill of entry', 'clearance', 'document', 75, null, 'always', null),
      (c, 6, 'Transportation within Dubai city', 'transport', 'shipment', 200, null, 'always', null),
      (c, 7, 'Storage (48 hours free)', 'clearance', 'kg', 0.15, 30, 'if_applicable', null),
      (c, 8, 'Customs duty 5% of invoice value', 'clearance', 'percent', 5, null, 'if_applicable', 'FTA / VAT approval required');
  end if;
  if not exists (select 1 from local_charge_cards where lower(name) = lower('Air import – Emirates (DG)')) then
    insert into local_charge_cards (name, mode, direction, places, carriers, dg) values ('Air import – Emirates (DG)', 'air', 'import', 'Dubai, DXB', 'Emirates, SkyCargo, EK, 176-', 'yes') returning id into c;
    insert into local_charge_lines (card_id, sort_order, description, service, unit, cost, min_amount, tag, note) values
      (c, 1, 'Delivery order', 'clearance', 'bl', 113, null, 'always', null),
      (c, 2, 'Handling (H/D)', 'clearance', 'kg', 0.23, 50, 'always', null),
      (c, 3, 'Break bulk', 'clearance', 'shipment', 60, null, 'always', null),
      (c, 4, 'EDP', 'clearance', 'document', 75, null, 'always', null),
      (c, 5, 'Bill of entry', 'clearance', 'document', 75, null, 'always', null),
      (c, 6, 'Transportation within Dubai city', 'transport', 'shipment', 200, null, 'always', null),
      (c, 7, 'Storage (48 hours free)', 'clearance', 'kg', 0.24, 50, 'if_applicable', null),
      (c, 8, 'Customs duty 5% of invoice value', 'clearance', 'percent', 5, null, 'if_applicable', 'FTA / VAT approval required');
  end if;
end $$;

insert into schema_migrations (name) values ('044_local_charges.sql') on conflict do nothing;
