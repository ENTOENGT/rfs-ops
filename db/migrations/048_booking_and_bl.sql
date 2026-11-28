-- 048 (27 Nov, fixes from the Import flow test, part B) — booking to BL. Safe to run twice; nothing is removed.

-- 1. The AI reads the customer's answer to a BL draft (confirmed / corrections) — a suggestion, applied by a person.
alter table ai_suggestions drop constraint if exists ai_suggestions_kind_check;
alter table ai_suggestions add constraint ai_suggestions_kind_check check (kind in ('enquiry', 'quote', 'quote_reply', 'booking', 'bl_reply'));
alter table ai_suggestions alter column vendor_request_id drop not null;

-- 2. The AI's check of a BL draft against the shipment (shipper, consignee, ports, vessel, containers, cargo…).
alter table bl_drafts add column if not exists ai_check jsonb;
alter table bl_drafts add column if not exists ai_checked_at timestamptz;

-- 3. The automatic "booking confirmed" email to the customer: sent once per booking.
alter table job_files add column if not exists booking_mail_at timestamptz;
alter table job_files add column if not exists booking_mail_error text;

insert into schema_migrations (name) values ('048_booking_and_bl.sql') on conflict do nothing;
