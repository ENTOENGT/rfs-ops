-- 017 — One Job No. from enquiry to closing. Safe to run more than once.
--
--   Customer enquiry → Job File created with its Job No., status "enquiry"
--   → vendor rate requests on that Job No. → vendor confirms the rate (cost)
--   → quotation on the same Job No., cost lines taken from the vendor rates, margin added
--   → customer accepts → the same Job File becomes "open" (no new Job No.), other open quotations on it are cancelled
--   → trips, PRO, warehouse, documents, ERP — all on that one Job No.

-- Job Files can start as an enquiry
alter table job_files drop constraint if exists job_files_status_check;
alter table job_files add constraint job_files_status_check
  check (status in ('enquiry', 'open', 'booked', 'in_transit', 'arrived', 'delivering', 'closed', 'cancelled'));

-- Vendors can be asked for a rate (before anything is booked); the rate can have a validity date
alter table vendor_requests drop constraint if exists vendor_requests_service_check;
alter table vendor_requests add constraint vendor_requests_service_check
  check (service in ('rate', 'booking', 'trucking', 'customs', 'warehousing', 'courier', 'documentation', 'other'));
alter table vendor_requests add column if not exists rate_valid_until date;

-- One rate request can go to several vendors at once: they share a rate_group, so their prices are compared side by side
-- and the system warns when a dearer vendor is chosen.
alter table vendor_requests add column if not exists rate_group uuid;
create index if not exists vr_rate_group_idx on vendor_requests (rate_group) where rate_group is not null;

-- Which vendor rate a quotation cost line came from
alter table quotation_lines add column if not exists vendor_request_id uuid references vendor_requests(id);
create index if not exists ql_vendor_req_idx on quotation_lines (vendor_request_id);
create index if not exists q_job_file_idx on quotations (job_file_id);

insert into schema_migrations (name) values ('017_enquiry_flow.sql') on conflict do nothing;
