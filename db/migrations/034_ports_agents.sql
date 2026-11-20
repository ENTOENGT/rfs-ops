-- 034 — Ports, countries, regions and agent coverage (Release R). Safe to run twice; only new things, nothing deleted.
--
-- Ports & airports (UN/LOCODE) and countries are loaded by the app itself the first time someone searches a port
-- (about 25,000 rows — too big to paste here). Regions are your own groups of countries, editable in Settings.
-- Agent coverage says where each agent works (a port, a country or a region), so "Ask agents for a rate" can tick
-- every agent that covers the enquiry's origin or destination — e.g. all agents covering Germany.

create table if not exists countries (
  code text primary key,                      -- ISO 3166 two letters, e.g. DE
  name text not null
);
create table if not exists ports (
  code text primary key,                      -- UN/LOCODE, e.g. DEHAM; your own ports may use any 5-letter code
  name text not null,
  plain_name text,                            -- the name without accents, for searching
  country_code text not null,
  kind text not null check (kind in ('sea', 'air', 'both', 'inland')),
  iata text,                                  -- airports: the 3-letter code (DXB)
  is_custom boolean not null default false,   -- added by you, not from the UN list
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
-- roughly how big the place is (how many kinds of transport, +1 when officially approved): big ports come first in searches
alter table ports add column if not exists weight int not null default 0;
create index if not exists ports_country_idx on ports (country_code);
create index if not exists ports_name_idx on ports (lower(name) text_pattern_ops);
create index if not exists ports_plain_idx on ports (lower(plain_name) text_pattern_ops);
create index if not exists ports_iata_idx on ports (iata) where iata is not null;
alter table countries enable row level security;
alter table ports enable row level security;

create table if not exists regions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  countries text[] not null default '{}',
  is_active boolean not null default true,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists regions_name_uq on regions (lower(name));
alter table regions enable row level security;
-- a starting set; change them in Settings → Ports & regions
insert into regions (name, countries) values
  ('GCC', '{AE,SA,OM,QA,KW,BH}'),
  ('Middle East (other)', '{IQ,IR,JO,LB,SY,YE,IL,PS}'),
  ('Indian Subcontinent', '{IN,PK,BD,LK,NP,MV,BT}'),
  ('Far East', '{CN,HK,TW,KR,JP,MO,MN}'),
  ('South East Asia', '{SG,MY,TH,VN,ID,PH,KH,MM,LA,BN}'),
  ('North Europe', '{DE,NL,BE,FR,GB,IE,LU,DK,SE,NO,FI,PL,EE,LV,LT,IS,AT,CH,CZ,SK,HU}'),
  ('Mediterranean', '{ES,PT,IT,GR,MT,CY,TR,HR,SI,AL,ME,EG,MA,TN,DZ,LY}'),
  ('East Africa', '{KE,TZ,UG,ET,DJ,SO,SD,RW,MZ,MG,MU,SC}'),
  ('West Africa', '{NG,GH,CI,SN,TG,BJ,CM,GN,SL,LR,GM,GA,CG,AO}'),
  ('Southern Africa', '{ZA,NA,BW,ZW,ZM,MW,LS,SZ}'),
  ('North America', '{US,CA,MX}'),
  ('South America', '{BR,AR,CL,PE,CO,EC,UY,PY,VE,BO}'),
  ('Oceania', '{AU,NZ,FJ,PG}'),
  ('CIS & Central Asia', '{RU,KZ,UZ,TM,KG,TJ,AZ,GE,AM,UA,BY}')
on conflict do nothing;

-- the enquiry's ports as codes (the port names stay as they are) and the countries, for when the customer
-- knows the country but not the port ("collection anywhere in Germany")
alter table job_files add column if not exists pol_code text;
alter table job_files add column if not exists pod_code text;
alter table job_files add column if not exists origin_country text;
alter table job_files add column if not exists destination_country text;

-- where each agent works
create table if not exists agent_coverage (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id),
  scope text not null check (scope in ('port', 'country', 'region')),
  port_code text,
  country_code text,
  region_id uuid references regions(id),
  modes text[] not null default '{}',          -- empty = every mode
  side text not null default 'both' check (side in ('origin', 'destination', 'both')),
  priority int not null default 2 check (priority between 1 and 3),   -- 1 preferred, 2 normal, 3 backup
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check ((scope = 'port' and port_code is not null) or (scope = 'country' and country_code is not null) or (scope = 'region' and region_id is not null))
);
create index if not exists agent_coverage_vendor_idx on agent_coverage (vendor_id);
create index if not exists agent_coverage_port_idx on agent_coverage (port_code) where port_code is not null;
create index if not exists agent_coverage_country_idx on agent_coverage (country_code) where country_code is not null;
alter table agent_coverage enable row level security;

insert into schema_migrations (name) values ('034_ports_agents.sql') on conflict do nothing;
