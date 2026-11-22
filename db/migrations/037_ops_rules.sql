-- 037 — AI batch 1 (operations rules). Safe to run twice; only adds two columns.
--
-- "Cargo ready for collection": set when the customer says the cargo is ready (by the AI, checked by a person, or ticked by
-- hand). The cargo ready date goes in the checklist as before (today when they give no date); this is the mark on the enquiry.
alter table job_files add column if not exists cargo_ready_confirmed boolean not null default false;
alter table job_files add column if not exists cargo_ready_confirmed_at timestamptz;

-- when it was marked (kept when it stays marked; cleared when unmarked)
create or replace function job_files_ready_at() returns trigger language plpgsql as $$
begin
  if new.cargo_ready_confirmed then new.cargo_ready_confirmed_at := coalesce(new.cargo_ready_confirmed_at, now());
  else new.cargo_ready_confirmed_at := null; end if;
  return new;
end $$;
drop trigger if exists job_files_ready_at on job_files;
create trigger job_files_ready_at before insert or update of cargo_ready_confirmed on job_files for each row execute function job_files_ready_at();

insert into schema_migrations (name) values ('037_ops_rules.sql') on conflict do nothing;
