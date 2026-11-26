-- 045 (26 Nov) — the Emirates air import card is called "Non-DG" like the other cards (was "general").
-- 26 Nov — also: vendor rate / booking replies and new-enquiry emails are read by the AI in the background (every 2 minutes),
-- so they are ready before anyone opens them; each is tried at most twice there (then it waits to be opened).
-- Safe to run twice; nothing is removed.
alter table email_messages add column if not exists ai_bg_tries smallint not null default 0;
alter table outlook_inbox add column if not exists ai_bg_tries smallint not null default 0;

update local_charge_cards set name = 'Air import – Emirates (Non-DG)', updated_at = now()
  where name = 'Air import – Emirates (general)'
    and not exists (select 1 from local_charge_cards x where x.name = 'Air import – Emirates (Non-DG)');

insert into schema_migrations (name) values ('045_option_and_labels.sql') on conflict do nothing;
