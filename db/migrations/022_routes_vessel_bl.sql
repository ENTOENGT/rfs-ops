-- 022 — Part G2: route options (several loading ports in one enquiry), rates and quotation lines per option, the
-- customer's chosen option, booking details, vessel legs (direct / via), BL draft cycle with versions, final BL.
-- Safe to run twice. Nothing is deleted; old enquiries are shown as a single Option 1 without any data change.

-- ------------------------------------------------------------ route options
create table if not exists enquiry_routes (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  option_no int not null check (option_no between 1 and 20),
  origin_country text, origin_city text, pol text,
  destination_country text, destination_city text, pod text,
  final_delivery text,
  mode text,                 -- sea_fcl / sea_lcl / air / road (null = the shipment's mode)
  cargo_description text, packages int, gross_weight_kg numeric(12,2), volume_cbm numeric(12,3),
  notes text,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_reason text
);
create unique index if not exists er_file_option_uq on enquiry_routes (job_file_id, option_no);
alter table vendor_requests add column if not exists route_id uuid references enquiry_routes(id);
alter table quotation_lines add column if not exists route_id uuid references enquiry_routes(id);
alter table quotations add column if not exists selected_route_id uuid references enquiry_routes(id);
alter table job_files add column if not exists selected_route_id uuid references enquiry_routes(id);

-- ------------------------------------------------------------ booking details + vessel
alter table job_files add column if not exists booking_confirmed_on date;
alter table job_files add column if not exists booked_equipment text;            -- e.g. "2 x 40HC"
alter table job_files add column if not exists routing_type text check (routing_type in ('direct', 'via'));
alter table job_files add column if not exists vessel_status text not null default 'pending' check (vessel_status in ('pending', 'received', 'verified'));
alter table job_files add column if not exists vessel_verified_at timestamptz;
alter table job_files add column if not exists vessel_verified_by uuid references users(id);

create table if not exists shipment_legs (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  leg_no int not null check (leg_no between 1 and 9),
  vessel text, voyage text, from_port text, to_port text,
  etd date, eta date,
  updated_by uuid references users(id), updated_at timestamptz not null default now()
);
create unique index if not exists sl_file_leg_uq on shipment_legs (job_file_id, leg_no);

-- ------------------------------------------------------------ BL drafts + final BL
alter table job_files add column if not exists bl_status text not null default 'awaiting' check (bl_status in ('awaiting', 'received', 'under_review',
  'sent_to_customer', 'correction_required', 'correction_sent', 'revised_received', 'revised_sent', 'customer_confirmed'));
alter table job_files add column if not exists final_bl_no text;
alter table job_files add column if not exists final_bl_received_at timestamptz;
alter table job_files add column if not exists final_bl_document_id uuid references jf_documents(id);
alter table job_files add column if not exists handover_override_reason text;

create table if not exists bl_drafts (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  version int not null,
  bl_no text,
  document_id uuid not null references jf_documents(id),
  received_at timestamptz not null default now(),
  received_by uuid references users(id),
  reviewed_at timestamptz, reviewed_by uuid references users(id),
  sent_at timestamptz, sent_to text, sent_by uuid references users(id),
  customer_reply text check (customer_reply in ('confirmed', 'correction')),
  customer_reply_at timestamptz, correction_notes text,
  correction_sent_at timestamptz, correction_sent_to text,
  confirmed_by uuid references users(id), confirmation_evidence text, confirmation_document_id uuid references jf_documents(id),
  amendment_reason text,                          -- a change after the customer had confirmed an earlier version
  created_at timestamptz not null default now()
);
create unique index if not exists bl_file_version_uq on bl_drafts (job_file_id, version);

-- ------------------------------------------------------------ permissions + safety
alter table enquiry_routes enable row level security;
alter table shipment_legs enable row level security;
alter table bl_drafts enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on enquiry_routes, shipment_legs, bl_drafts from anon, authenticated';
  end if;
end $$;

insert into schema_migrations (name) values ('022_routes_vessel_bl.sql') on conflict do nothing;
