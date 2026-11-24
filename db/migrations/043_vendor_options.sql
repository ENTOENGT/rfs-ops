-- 043 — a vendor quotes several options (two lines, direct and via, two loading ports…): each extra option can go on the
-- quotation as its own option. It is a route option of the enquiry with a short label ("MSC Agency: via Colombo, 22 days")
-- and its own rate. Safe to run twice; one new column only.
alter table enquiry_routes add column if not exists label text;

insert into schema_migrations (name) values ('043_vendor_options.sql') on conflict do nothing;
