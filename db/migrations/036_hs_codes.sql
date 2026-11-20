-- 036 — HS code list (UAE customs tariff) and prohibitions / restrictions. Safe to run twice; only new tables.
--
-- Filled from Dubai Customs' "Tariff Report" Excel by uploading it on Commercials → HS codes (tabs "HSCode" and "PR");
-- upload a newer report any time. Every HS code on an enquiry is checked against it: duty %, Active / In Active,
-- prohibited or restricted (and by which authority) — or "not in our record".

create table if not exists hs_tariff (
  code text primary key,                       -- 8 digits (leading zeros put back: 1011010 → 01011010)
  description text,
  duty_pct numeric,
  original_duty_pct numeric,
  service_charge_pct numeric,
  status text,                                 -- Active / In Active
  effective_from date,
  effective_to date,
  is_vehicle boolean,
  grp text,
  last_updated timestamptz,
  loaded_at timestamptz not null default now()
);
alter table hs_tariff enable row level security;

create table if not exists hs_controls (
  id uuid primary key default gen_random_uuid(),
  code text not null,                          -- 8 digits
  description text,
  action_type text,                            -- P = prohibited, R = restricted
  fully_prohibited boolean,
  authority text,
  remarks text,
  start_date date,
  end_date date,
  status text,                                 -- A = active
  action_indicator text,
  loaded_at timestamptz not null default now()
);
create index if not exists hs_controls_code_idx on hs_controls (code);
alter table hs_controls enable row level security;

-- what was loaded last: file name, "as on" date from the report, counts, who and when
insert into settings (key, value) values ('hs_tariff_info', 'null') on conflict (key) do nothing;

insert into schema_migrations (name) values ('036_hs_codes.sql') on conflict do nothing;
