-- 040 — a quotation in another currency (e.g. USD) keeps the rate to the company currency (AED) of the day it was saved,
-- so reports add up in AED with that day's rate (not whatever rate is in Settings when the report is run). Safe to run twice.
alter table quotations add column if not exists company_rate numeric(14,6);
insert into schema_migrations (name) values ('040_quote_company_rate.sql') on conflict do nothing;
