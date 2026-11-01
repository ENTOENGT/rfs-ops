-- 014 — Quotations: margin per line (% or amount → selling rate worked out from cost), and the company
--        details printed on the customer copy (PDF / Excel). Safe to run more than once.

-- How the selling rate of a line was set: typed by hand (null), or from the cost plus a margin.
--   percent: selling = cost ÷ (1 − margin%)   e.g. cost 1000, margin 20% → selling 1250 (margin is 20% of the selling price)
--   amount : selling = cost + margin           e.g. cost 1000, margin 250 → selling 1250
alter table quotation_lines add column if not exists margin_type text;
alter table quotation_lines drop constraint if exists ql_margin_type_chk;
alter table quotation_lines add constraint ql_margin_type_chk check (margin_type is null or margin_type in ('percent', 'amount'));
alter table quotation_lines add column if not exists margin_value numeric(14,2);
alter table quotation_lines drop constraint if exists ql_margin_value_chk;
alter table quotation_lines add constraint ql_margin_value_chk check (
  margin_type is null or (margin_value is not null and margin_value >= 0 and (margin_type <> 'percent' or margin_value < 100)));

-- Printed on the customer copy of a quotation
insert into settings (key, value) values
  ('company_address', '""'),
  ('company_phone', '""'),
  ('company_email', '""'),
  ('company_trn', '""'),
  ('quote_vat_note', '"All charges are exclusive of VAT. VAT will be applied at the prevailing rate where applicable."')
on conflict (key) do nothing;

insert into schema_migrations (name) values ('014_quote_margin_print.sql') on conflict do nothing;
