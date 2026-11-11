-- 024 — Two more shipment modes: Courier and Others (the shipment types on the monthly sheet:
-- FCL / LCL / Air export and import, Cross Trade, Road Freight, Courier, Others).
-- Safe to run twice. Only the allowed list of modes is widened; nothing is changed or deleted.

alter table job_files drop constraint if exists job_files_mode_check;
alter table job_files add constraint job_files_mode_check check (mode in ('sea_fcl', 'sea_lcl', 'air', 'road', 'courier', 'other'));

insert into schema_migrations (name) values ('024_modes_reports.sql') on conflict do nothing;
