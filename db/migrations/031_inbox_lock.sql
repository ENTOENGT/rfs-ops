-- 031 — Outlook step 3 fix: "one inbox check at a time" kept as a time on the connection (clears itself after 2 minutes),
-- instead of a database session lock, which the shared connection pool on the live site could leave stuck. Safe to run twice.
alter table outlook_connections add column if not exists sync_started_at timestamptz;
insert into schema_migrations (name) values ('031_inbox_lock.sql') on conflict do nothing;
