-- 041 — the AI reads the customer's answer to a quotation that was sent (accepted / wants changes / declined / a question).
-- Kept with the other AI suggestions as kind 'quote_reply'. Safe to run twice; only widens one check.
alter table ai_suggestions drop constraint if exists ai_suggestions_kind_check;
alter table ai_suggestions add constraint ai_suggestions_kind_check check (kind in ('enquiry', 'quote', 'quote_reply'));
insert into schema_migrations (name) values ('041_quote_reply.sql') on conflict do nothing;
