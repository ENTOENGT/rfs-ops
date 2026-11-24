-- 042 — the AI reads the line's / agent's booking confirmation and later updates; tracking; reminders.
-- Safe to run twice; only new columns, one new table, one wider check.
--
-- 1. What a booking confirmation adds beyond the existing booking fields: the cut-offs, where to pick up the empty
--    container. When it actually sailed / arrived uses the existing atd / ata ("Actual departure / arrival").
alter table job_files add column if not exists cutoff_si timestamp;            -- documents / SI cut-off (the time as the line writes it, at the loading port)
alter table job_files add column if not exists cutoff_vgm timestamp;
alter table job_files add column if not exists cutoff_gate timestamp;          -- port / gate-in cut-off
alter table job_files add column if not exists empty_pickup text;

-- 2. The AI's reading of a booking email is kept with the other AI suggestions.
alter table ai_suggestions drop constraint if exists ai_suggestions_kind_check;
alter table ai_suggestions add constraint ai_suggestions_kind_check check (kind in ('enquiry', 'quote', 'quote_reply', 'booking'));

-- 3. Reminders sent (ETD passed without sailing, ETA in 2 days…): each once per date, never twice.
create table if not exists shipment_reminders (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  kind text not null,
  for_date date,
  created_at timestamptz not null default now()
);
create unique index if not exists shipment_reminders_uq on shipment_reminders (job_file_id, kind, coalesce(for_date, '1900-01-01'));
alter table shipment_reminders enable row level security;

-- 4. Tracking links per shipping line / airline (Settings → Tracking links). {number} = the booking / BL / container no.
insert into settings (key, value) values ('tracking_links', 'null') on conflict (key) do nothing;

insert into schema_migrations (name) values ('042_booking_tracking.sql') on conflict do nothing;
